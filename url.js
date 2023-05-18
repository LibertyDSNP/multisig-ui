export function getParameterByName(name, array = false) {
    const url = new URL(window.location.href);
    const searchParams = url.searchParams;

    const values = searchParams.getAll(name + (array ? "[]" : ""));
    if (array) return values;

    if (values.length === 0) return null;
    if (values.length === 1) return values[0];
    return values;
}

export function setUrlParameter(name, values) {
    const url = new URL(window.location.href);
    const searchParams = url.searchParams;

    // Remove existing parameters with the same name
    searchParams.delete(name + '[]');
    searchParams.delete(name);

    if (Array.isArray(values)) {
        values.forEach(value => {
            searchParams.append(name + '[]', value);
        });
    } else {
        searchParams.append(name, values);
    }

    const newUrl = url.origin + url.pathname + '?' + searchParams.toString();

    history.replaceState(null, '', newUrl);
}
