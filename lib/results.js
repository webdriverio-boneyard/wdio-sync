export const isElements = function (result) {
    return (
        typeof result.selector === 'string' &&
        Array.isArray(result.value) && result.value.length &&
        typeof result.value[0].ELEMENT !== 'undefined'
    )
}

export const is$$ = function (result) {
    return Array.isArray(result) && !!result.length && !!result[0] && result[0].ELEMENT !== undefined
}
