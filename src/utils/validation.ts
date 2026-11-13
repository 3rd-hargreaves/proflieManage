const hexColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function isHexColor(value: string): boolean {
  return hexColorPattern.test(value.trim())
}

export function validateRequired(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  field.setCustomValidity(field.value.trim() ? '' : `${field.placeholder} 항목을 입력해 주세요.`)
  return field.reportValidity()
}
