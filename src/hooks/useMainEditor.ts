import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MainData, ThemeColors } from '../types/site'
import type { SortLock } from '../utils/sortLock'
import { themeFields, toThemeColors } from '../utils/theme'
import { saveCharacterOrder, saveMainTheme } from '../services/main'
import type { LeaveGuard } from './useGuardedNavigation'
import { useEditorWork } from './useEditorWork'
import { useMainQuery } from './useSiteQuery'

interface MainEditor {
    baseline: MainData
    order: number[]
    theme: ThemeColors
}

interface Feedback {
    saved: boolean
    error: string | null
}

function orderChanged(editor: MainEditor): boolean {
    return editor.order.length !== editor.baseline.characters.length
        || editor.order.some((id, index) => id !== editor.baseline.characters[index]?.id)
}

function themeChanged(editor: MainEditor): boolean {
    return themeFields.some(({ key, column }) => editor.theme[key].trim() !== editor.baseline.theme[column].trim())
}

function dirty(editor: MainEditor | null): boolean {
    return !!editor && (orderChanged(editor) || themeChanged(editor))
}

function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : '저장하지 못했습니다. 변경한 내용은 유지됩니다. 다시 시도해 주세요.'
}

export function useMainEditor({ isAdmin, signingOut, workLock, sortLock, canWrite, onLeaveGuardChange }: {
    isAdmin: boolean
    signingOut: boolean
    workLock: SortLock
    sortLock: SortLock
    canWrite: () => boolean
    onLeaveGuardChange: (guard: LeaveGuard) => void
}) {
    const current = useRef<MainEditor | null>(null)
    const [editor, setEditor] = useState<MainEditor | null>(null)
    const [orderFeedback, setOrderFeedback] = useState<Feedback>({ saved: false, error: null })
    const [themeFeedback, setThemeFeedback] = useState<Feedback>({ saved: false, error: null })
    const [saving, setSaving] = useState<'order' | 'theme' | null>(null)
    const sortOwner = useSyncExternalStore(sortLock.subscribe, sortLock.getOwner, sortLock.getOwner)
    const work = useEditorWork({ workLock, sortLock, canWrite, blocked: !isAdmin || signingOut })

    const acceptMain = useCallback((data: MainData) => {
        const next = { baseline: data, order: data.characters.map(character => character.id), theme: toThemeColors(data.theme) }
        current.current = next
        setEditor(next)
        setOrderFeedback({ saved: false, error: null })
        setThemeFeedback({ saved: false, error: null })
    }, [])
    const { state: query, reload: reloadQuery } = useMainQuery({ onLoad: acceptMain })

    useEffect(() => {
        onLeaveGuardChange(() => dirty(current.current) || sortLock.getOwner() !== null || workLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [onLeaveGuardChange, sortLock, workLock])

    function changeOrder(order: number[]) {
        if (!current.current || !work.canContinue() || workLock.getOwner() !== null) return
        current.current = { ...current.current, order }
        setEditor(current.current)
        setOrderFeedback(previous => ({ ...previous, saved: false }))
    }

    function changeTheme(key: keyof ThemeColors, value: string) {
        if (!current.current || !work.canStart()) return
        current.current = { ...current.current, theme: { ...current.current.theme, [key]: value } }
        setEditor(current.current)
        setThemeFeedback(previous => ({ ...previous, saved: false }))
    }

    async function saveOrder() {
        const snapshot = current.current
        if (!snapshot || !orderChanged(snapshot)) return
        await work.run('saving', async guard => {
            setSaving('order')
            setOrderFeedback({ saved: false, error: null })
            try {
                const order = await saveCharacterOrder(snapshot.order, snapshot.baseline.characters.map(character => character.id), guard)
                if (!work.isMounted() || !current.current) return
                const characters = new Map(snapshot.baseline.characters.map(character => [character.id, character]))
                const next = {
                    ...current.current,
                    baseline: { ...current.current.baseline, characters: order.map((id, index) => ({ ...characters.get(id)!, sort_order: index + 1 })) },
                    order,
                }
                current.current = next
                setEditor(next)
                setOrderFeedback({ saved: true, error: null })
            } catch (error) {
                if (work.isMounted()) setOrderFeedback({ saved: false, error: failureMessage(error) })
            } finally {
                if (work.isMounted()) setSaving(null)
            }
        })
    }

    async function saveTheme() {
        const snapshot = current.current
        if (!snapshot || !themeChanged(snapshot)) return
        await work.run('saving', async guard => {
            setSaving('theme')
            setThemeFeedback({ saved: false, error: null })
            try {
                const theme = await saveMainTheme(snapshot.theme, snapshot.baseline.theme, guard)
                if (!work.isMounted() || !current.current) return
                const next = { ...current.current, baseline: { ...current.current.baseline, theme }, theme: toThemeColors(theme) }
                current.current = next
                setEditor(next)
                setThemeFeedback({ saved: true, error: null })
            } catch (error) {
                if (work.isMounted()) setThemeFeedback({ saved: false, error: failureMessage(error) })
            } finally {
                if (work.isMounted()) setSaving(null)
            }
        })
    }

    function reload() {
        if (workLock.getOwner() !== null || sortLock.getOwner() !== null || signingOut) return
        if (dirty(current.current) && !window.confirm('편집 내용을 버리고 DB에서 다시 불러오시겠습니까?')) return
        current.current = null
        setEditor(null)
        setOrderFeedback({ saved: false, error: null })
        setThemeFeedback({ saved: false, error: null })
        reloadQuery()
    }

    const visible = query.status === 'ready' ? editor : null
    const characters = visible?.baseline.characters ?? []
    const byId = new Map(characters.map(character => [character.id, character]))

    return {
        query,
        characters: isAdmin && visible ? visible.order.map(id => byId.get(id)!) : characters,
        savedTheme: visible?.baseline.theme ?? null,
        theme: visible?.theme ?? null,
        orderDirty: visible ? orderChanged(visible) : false,
        themeDirty: visible ? themeChanged(visible) : false,
        dirty: dirty(visible),
        orderFeedback,
        themeFeedback,
        saving,
        busy: work.busy,
        sorting: sortOwner !== null,
        disabled: !isAdmin || signingOut || work.busy || sortOwner !== null,
        canStart: work.canStart,
        changeOrder,
        changeTheme,
        saveOrder,
        saveTheme,
        reload,
    }
}
