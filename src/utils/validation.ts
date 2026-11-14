const hexColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function isHexColor(value: string): boolean {
    return hexColorPattern.test(value.trim())
}

export function requiredMessage(value: string, label: string): string {
    return value.trim() ? '' : `${label} 항목을 입력해 주세요.`
}

export function hexColorMessage(value: string): string {
    return requiredMessage(value, '헥스코드') || (isHexColor(value) ? '' : '올바른 색상코드를 입력해 주세요.')
}

export function validateRequired(field: HTMLInputElement | HTMLTextAreaElement): boolean {
    field.setCustomValidity(requiredMessage(field.value, field.placeholder))
    return field.reportValidity()
}
