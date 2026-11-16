import { useEffect } from 'react'
import type { ThemeColors } from '../types/site'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { isHexColor } from '../utils/validation'

export function useEditorPage({ title, theme, characterId = 1, busy, onBusyChange }: {
    title: string
    theme: ThemeColors | null | undefined
    characterId?: number
    busy: boolean
    onBusyChange?: (busy: boolean) => void
}) {
    useEffect(() => {
        onBusyChange?.(busy)
        return () => onBusyChange?.(false)
    }, [onBusyChange, busy])
    useEffect(() => {
        const previousTitle = document.title
        document.title = title
        return () => { document.title = previousTitle }
    }, [title])
    useEffect(() => {
        if (!theme || !themeFields.every(({ key }) => isHexColor(theme[key]))) return
        return applyTheme({ id: characterId, ...toThemeData(theme) })
    }, [characterId, theme])
}
