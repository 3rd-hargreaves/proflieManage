import { useEffect } from 'react'
import type { ThemeColors } from '../../types/models'
import { applyTheme, themeFields, toThemeData } from '../../utils/theme'
import { isHexColor } from '../../utils/validation'

export function usePage({ title, theme, characterId = 1, busy, setBusy }: {
    title: string
    theme: ThemeColors | null | undefined
    characterId?: number
    busy: boolean
    setBusy?: (busy: boolean) => void
}) {
    useEffect(() => {
        setBusy?.(busy)
        return () => setBusy?.(false)
    }, [setBusy, busy])
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
