import type { SiteTheme } from '../types/site'
import { isHexColor } from './validation'

const colorVariables = [
  ['main_color', '--main-color'],
  ['background_color', '--sub-color'],
  ['card_background_color', '--background-color'],
  ['typo_color', '--typo-color'],
] as const

export function applyTheme(theme: SiteTheme): () => void {
  if (colorVariables.some(([column]) => !isHexColor(theme[column]))) {
    throw new Error('저장된 테마 색상을 확인해 주세요.')
  }

  const style = document.documentElement.style
  const previousValues = colorVariables.map(([, variable]) => ({
    variable,
    value: style.getPropertyValue(variable),
    priority: style.getPropertyPriority(variable),
  }))

  for (const [column, variable] of colorVariables) {
    style.setProperty(variable, theme[column].trim())
  }

  return () => {
    for (const { variable, value, priority } of previousValues) {
      style.setProperty(variable, value, priority)
    }
  }
}
