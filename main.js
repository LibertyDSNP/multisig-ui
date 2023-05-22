import { blake2AsHex, checkAddress, decodeAddress } from 'https://cdn.jsdelivr.net/npm/@polkadot/util-crypto@10.2.2/+esm';
import { encodeAddress, createKeyMulti } from 'https://cdn.jsdelivr.net/npm/@polkadot/util-crypto@11.1.3/+esm';
import { web3Accounts, web3Enable, web3FromAddress } from 'https://cdn.jsdelivr.net/npm/@polkadot/extension-dapp@0.45.5/+esm';
import { loadApi, getIsConnected, initConnection, toDecimalUnit, getPrefix, getProviderUrl, getUnit, getCurrentRelayChainBlockNumber } from './api.js';
import { getParameterByName, setUrlParameter } from './url.js';

// Simple loading and button blocker
function inProgress(isInProgress) {
    const spinners = document.querySelectorAll(".connectionLoader");
    const submitButton = document.getElementById("submitForm");
    if (isInProgress) {
        submitButton.disabled = true;
        spinners.forEach(x => x.style.display = "block");
    } else {
        submitButton.disabled = false;
        spinners.forEach(x => x.style.display = "none");
    }
    document.querySelectorAll(".hideProcessing").forEach(e => e.style.display = isInProgress ? "none" : "block");
}

function displaySchedule(schedule, destination, relayBlockNumber) {
    if (schedule.periodCount > 1) {
        const unsupported = document.createElement("span");
        unsupported.innerHTML = "Unsupported per period value";
        return unsupported;
    }
    const template = document.querySelector('#schedule-template');
    const scheduleEl = template.content.cloneNode(true);
    scheduleEl.querySelector(".balanceResultTokens").innerHTML = toDecimalUnit(schedule.perPeriod.toString()) + " " + getUnit();
    const unlockRelayBlock = (schedule.start + schedule.period);
    scheduleEl.querySelector(".unlockRelayBlock").innerHTML = unlockRelayBlock.toLocaleString();

    const untilUnlock = (unlockRelayBlock - relayBlockNumber) * 6 * 1000;
    const unlockEstimate = new Date(Date.now() + untilUnlock);
    scheduleEl.querySelector(".estimatedUnlock").innerHTML = unlockEstimate.toLocaleString();

    scheduleEl.querySelector(".destination").innerHTML = destination;

    return scheduleEl;
}

function multisigProcess(showError = false) {
    const element = document.getElementById("multisigSignatories")
    element.setCustomValidity("");
    const multisigThreshold = parseInt(document.getElementById("multisigThreshold").value);
    const multisigSignatories = document.getElementById("multisigSignatories").value.split("\n").map(x => x.trim()).filter(x => !!x);
    if (multisigThreshold > multisigSignatories.length) {
        if (showError) element.setCustomValidity(`Multisig setup is invalid. Wrong threshold or bad signatories.`);
        return null;
    }
    try {
        for (const signatory of multisigSignatories) {
            try {
                const check = checkAddress(encodeAddress(signatory, getPrefix()), getPrefix());
                if (!check[0]) {
                    if (showError) element.setCustomValidity(`Signatory address "${signatory}" is invalid: ${check[1] || "unknown"}`);
                    return null;
                }
            } catch (e) {
                if (showError) element.setCustomValidity(`Signatory address "${signatory}" is invalid: ${e.message || "unknown"}`);
                return null;
            }
        }

        const multisigAddress = encodeAddress(createKeyMulti(multisigSignatories, multisigThreshold), getPrefix());
        return [multisigAddress, multisigThreshold, multisigSignatories.map(a => encodeAddress(a, getPrefix()))];
    } catch (e) {
        if (showError) element.setCustomValidity(`Multisig setup is invalid. Wrong threshold or bad signatories: ${e.toString()}`);
        return null;
    }
}

async function displayPendingMultisigTransaction(tx) {
    const template = document.querySelector('#multisig-template');
    const el = template.content.cloneNode(true);
    await pendingTransactionUpdate(tx, el);
    return el;
}

async function pendingTransactionUpdate(tx, el) {
    if (tx.callDataJson.method) {
        const { method, section } = tx.callDataJson;
        el.querySelector(".extrinsic").innerHTML = `${method}.${section}`;
    } else {
        el.querySelector(".extrinsic").innerHTML = "Unknown";
    }
    const isApproved = tx.approvals.length >= Number(document.getElementById("multisigThreshold").value);

    const approvedAddresses = tx.approvals.map(a => encodeAddress(a, getPrefix()));
    el.querySelector(".approvals").innerHTML = (isApproved ? "<b>Threshold Reached:</b> " : "") + approvedAddresses.join(", ");

    const callDataInput = el.querySelector("input.callData");
    if (tx.hexCallData) {
        callDataInput.value = tx.hexCallData;
    }
    callDataInput.addEventListener("focusout", async (input) => {
        const value = input.target.value;
        inProgress(true);
        const callData = value ? [processRawCallData(value)] : [];
        const newTx = await processMultisigEntry(callData)(tx.original);
        await pendingTransactionUpdate(newTx, input.target.closest(".pending-multisig"));
        updateUrlCallData();
        inProgress(false);
    }, { once: true });

    if (tx.hash) {
        el.querySelector(".callHash").innerHTML = tx.hash;
    }

    // This is a Time Release Transfer
    const timeReleaseEl = el.querySelector(".multisig-time-release");
    if (tx.callDataJson?.callIndex === "0x2801" && tx.callDataJson?.args?.schedule) {
        timeReleaseEl.innerHTML = "";
        timeReleaseEl.append(displaySchedule(tx.callDataJson.args.schedule, encodeAddress(tx.callDataJson.args.dest.id, getPrefix()), await getCurrentRelayChainBlockNumber()))
    } else {
        timeReleaseEl.innerHTML = "Not a Time Release Transaction"
    }

    const signingSection = el.querySelector(".signingSection");
    // Filter to just accounts in the wallet and ones that have not signed it
    const walletSigningAccounts = (await getAccounts(true)).filter(x => isApproved || !approvedAddresses.includes(x.address));
    if (walletSigningAccounts.length > 0) {
        const sender = walletSigningAccounts[0].address;
        const buttonExe = signingSection.querySelector(".countersignExe");
        if (tx.hexCallData) {
            buttonExe.dataset.sender = sender;
            buttonExe.dataset.txHash = tx.hash;
            buttonExe.dataset.callData = tx.hexCallData;
            buttonExe.dataset.when = JSON.stringify(tx.when);
            buttonExe.setAttribute("title", `With Account: ${sender}`);
            buttonExe.disabled = false;
        } else {
            buttonExe.disabled = true;
        }

        const buttonAuth = signingSection.querySelector(".countersignAuth");
        buttonAuth.dataset.sender = sender;
        buttonAuth.dataset.txHash = tx.hash;
        buttonAuth.dataset.when = JSON.stringify(tx.when);
        buttonAuth.setAttribute("title", `With Account: ${sender}`);
        buttonAuth.disabled = isApproved;
        buttonAuth.classList.remove("small")
        if (tx.hexCallData) buttonAuth.classList.add("small");

        signingSection.style.display = "block";
    } else {
        signingSection.style.display = "none";
    }
}

// Sort addresses by hex.
const multisigSort = (a, b) => {
    const decodedA = decodeAddress(a);
    const decodedB = decodeAddress(b);
    for (let i = 0; i < decodedA.length; i++) {
        if (decodedA[i] < decodedB[i]) return -1;
        if (decodedA[i] > decodedB[i]) return 1;
    }
    return 0;
}

// Function for after the transaction has been submitted
const postTransaction = (section) => (status) => {
    const completed = (disabled) => {
        section.querySelector(".loader").style.display = "none";
        section.querySelectorAll("button").forEach(x => x.disabled = disabled);
    }

    let msg;

    if (typeof status === "string") {
        msg = status;
        completed(false);
    } else if (status.isInBlock) {
        msg = "In Block";
    } else if (status.isFinalized) {
        const finalizedBlock = status.status.asFinalized.toHuman();
        msg = `Finalized: <a target="_blank" title="Block Details" href="https://polkadot.js.org/apps/?rpc=${getProviderUrl()}#/explorer/query/${finalizedBlock}">${finalizedBlock}</a>`;
        completed(true);
    } else if (status.isError) {
        msg = `Error: ${status.status.toHuman()}`;
        completed(false);
    } else if (status.status.isReady) {
        msg = "Sent";
    } else if (status.status.isBroadcast) {
        msg = "Broadcast";
    } else {
        msg = typeof status.status.toHuman() === "string" ? status.status.toHuman() : JSON.stringify(status.status.toHuman());
    }

    const p = document.createElement("p");
    p.innerHTML = (new Date()).toLocaleString() + ": " + msg;
    section.append(p);
}

async function signTransaction(section, sender, txHash, timepoint, callData) {
    const api = await loadApi();
    const multisigResult = multisigProcess(false);
    if (!multisigResult) {
        alert("Invalid Multisig Configuration");
        return;
    }
    section.querySelectorAll("button").forEach(x => x.disabled = true);
    section.querySelector(".loader").style.display = "block";

    const [_multisigAddress, multisigThreshold, multisigSignatories] = multisigResult;
    // We need to remove the sender and sort correctly before asMulti can be used.
    const senderEncoded = encodeAddress(sender, getPrefix());
    const sortedOthers = multisigSignatories.filter(x => x !== senderEncoded).sort(multisigSort);
    const maxWeight = { refTime: 250_000_000 };

    const injector = await web3FromAddress(sender);

    let tx;
    if (callData) {
        tx = api.tx.multisig.asMulti(multisigThreshold, sortedOthers, timepoint, callData, maxWeight);
    } else {
        tx = api.tx.multisig.approveAsMulti(multisigThreshold, sortedOthers, timepoint, txHash, maxWeight);
    }

    try {
        await tx.signAndSend(sender, { signer: injector.signer }, postTransaction(section));
    } catch (e) {
        postTransaction(section)(e.message);
    }
}

async function processSubmission() {
    inProgress(true);
    const pendingTransactions = document.getElementById("pendingTransactions");
    pendingTransactions.innerHTML = "Loading...";

    // Generate Multisig

    const multisigResult = multisigProcess(false);
    if (multisigResult === null) {
        pendingTransactions.innerHTML = "...";
        inProgress(false);
        return;
    }

    const [multisigAddress, _multisigThreshold, _multisigSignatories] = multisigResult;

    document.getElementById("resultAddress").innerHTML = multisigAddress;

    const balanceData = await getBalanceNoChecks(multisigAddress);

    const transactions = await getPendingMultisigTransactions(multisigAddress);

    if (transactions) {
        pendingTransactions.innerHTML = "";
        for (const tx of transactions) {
            pendingTransactions.append(await displayPendingMultisigTransaction(tx));
        }
    } else {
        pendingTransactions.innerHTML = "None Found";
    }

    document.getElementById("resultBalanceTokens").innerHTML = balanceData.decimal + " " + getUnit();
    document.getElementById("resultBalancePlancks").innerHTML = balanceData.plancks;
    document.getElementById("resultReserved").innerHTML = balanceData.reserved;
    inProgress(false);
}

async function getBalanceNoChecks(lookupAddress) {
    const api = await loadApi();

    const resp = await api.query.system.account(lookupAddress);
    const total = BigInt(resp.data.free.toJSON()) + BigInt(resp.data.reserved.toJSON());

    return {
        decimal: toDecimalUnit(total),
        plancks: BigInt(total).toLocaleString(),
        free: resp.data.free.toHuman(),
        reserved: resp.data.reserved.toHuman(),
    };
}

const processRawCallData = (cd) => ({
    callData: cd,
    callHash: blake2AsHex(cd),
});

const processMultisigEntry = (callDatas) => async (entry) => {
    const [address, callHash] = entry[0].toHuman();
    const multisigEntry = {
        ...(entry[1]).toJSON(),
        address,
        callHash,
        original: entry,
    };

    const record = callDatas.filter((r) => r.callHash === multisigEntry.callHash);
    if (!record || record.length === 0) {
        return { ...multisigEntry, callDataJson: {}, meta: {}, hash: multisigEntry.callHash };
    }
    try {
        const api = await loadApi();
        const callData = api.registry.createType('Call', record[0].callData);
        const { section, method } = api.registry.findMetaCall(callData.callIndex);
        const callDataJson = { ...callData.toJSON(), section, method };
        const hexCallData = callData.toHex();
        const meta = api?.tx[callDataJson?.section][callDataJson.method].meta.toJSON();

        return {
            ...multisigEntry,
            callDataJson,
            callData,
            meta,
            hash: multisigEntry.callHash,
            hexCallData,
            approveRecords: record[0].approveRecords,
        };
    } catch (_e) {
        return { ...multisigEntry, callDataJson: {}, meta: {}, hash: multisigEntry.callHash };
    }
}

async function getPendingMultisigTransactions(address) {
    const api = await loadApi();
    const multisigEntries = await api.query.multisig.multisigs.entries(address);
    const callDatas = getParameterByName("calldata", true).map(processRawCallData);

    const result = Promise.all(multisigEntries.map(processMultisigEntry(callDatas)));

    return result;
}

let cachedAccounts = null;
let cachedAccountsMs = null;
const getAccounts = async (multisigCheck = false) => {
    if (!cachedAccounts) cachedAccounts = await web3Accounts();

    if (!multisigCheck) return cachedAccounts;
    if (cachedAccountsMs) return cachedAccountsMs;

    const addresses = multisigProcess(false);

    if (!addresses || !addresses[2]) return [];

    const msSet = new Set(addresses[2].map(x => encodeAddress(x, getPrefix())));
    return cachedAccountsMs = cachedAccounts.filter(x => msSet.has(encodeAddress(x.address, getPrefix())));
}

// Post node connection, connect to the wallet
async function postConnect() {
    await web3Enable("Multisig dApp");
    await getAccounts();
    setFromUrl();
}

function updateUrlCallData() {
    const callDatas = [...document.querySelectorAll("input.callData")].map(x => x.value).filter(x => !!x);
    setUrlParameter("calldata", callDatas);
}

function updateUrl() {
    if (!getIsConnected()) return;

    // get the multisig information
    const multisigThreshold = parseInt(document.getElementById("multisigThreshold").value);
    const multisigSignatories = document.getElementById("multisigSignatories").value.split("\n").map(x => x.trim()).filter(x => !!x);

    setUrlParameter("threshold", multisigThreshold);
    setUrlParameter("signatories", multisigSignatories);
}

function setFromUrl() {
    const multisigThreshold = getParameterByName("threshold");
    const multisigSignatories = getParameterByName("signatories", true);

    if (multisigThreshold) {
        document.getElementById("multisigThreshold").value = multisigThreshold;
    }

    if (multisigSignatories) {
        document.getElementById("multisigSignatories").value = multisigSignatories.join("\n");
    }
}

// Start this up with event listeners
function init() {
    document.getElementById("multisigForm").addEventListener("submit", (e) => {
        e.preventDefault();
        updateUrl();
        processSubmission();
    });

    document.getElementById("multisigSignatories").addEventListener("blur", () => multisigProcess(true));

    document.addEventListener("click", async (e) => {
        if (!e.target.classList.contains("countersign")) return;
        e.preventDefault();
        if (!e.target.dataset.sender) return;

        const {
            sender,
            txHash,
            callData,
            when,
        } = e.target.dataset;

        const section = e.target.closest(".signingSection");
        await signTransaction(section, sender, txHash, JSON.parse(when), callData);
    });

    initConnection(postConnect);
}

init();
