import type { SiteTheme, ThemeColors } from '../types/site'
import { isHexColor } from './validation'

export const themeFields = [
    { key: 'mainColor', column: 'main_color', variable: '--main-color', label: '메인' },
    { key: 'backgroundColor', column: 'background_color', variable: '--sub-color', label: '배경' },
    { key: 'cardBackgroundColor', column: 'card_background_color', variable: '--background-color', label: '카드 배경' },
    { key: 'typoColor', column: 'typo_color', variable: '--typo-color', label: '글자' },
] as const satisfies readonly { key: keyof ThemeColors, column: keyof Omit<SiteTheme, 'id'>, variable: string, label: string }[]

export function toThemeColors(theme: SiteTheme): ThemeColors {
    return Object.fromEntries(themeFields.map(({ key, column }) => [key, theme[column]])) as unknown as ThemeColors
}

export function toThemeData(theme: ThemeColors): Omit<SiteTheme, 'id'> {
    return Object.fromEntries(themeFields.map(({ key, column }) => [column, theme[key].trim()])) as Omit<SiteTheme, 'id'>
}

export function applyTheme(theme: SiteTheme): () => void {
    if (themeFields.some(({ column }) => !isHexColor(theme[column]))) {
        throw new Error('저장된 테마 색상을 확인해 주세요.')
    }

    const style = document.documentElement.style
    const previousValues = themeFields.map(({ variable }) => ({
        variable,
        value: style.getPropertyValue(variable),
        priority: style.getPropertyPriority(variable),
    }))

    for (const { column, variable } of themeFields) {
        style.setProperty(variable, theme[column].trim())
    }

    return () => {
        for (const { variable, value, priority } of previousValues) {
            style.setProperty(variable, value, priority)
        }
    }
}
