import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SiteData, SiteEditDraft } from '../types/site'
import type { SortLock } from '../utils/sortLock'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import type { LeaveGuard } from './useGuardedNavigation'
import { useSortLock } from './useSortLock'
import { useEditorWork } from './useEditorWork'

type EditorKey = number | 'new'
interface CharacterDraft {
    key: EditorKey
    baseline: SiteData | null
    draft: SiteEditDraft | null
    focusedSection: string | null
    version: number
}

const emptyDraft = (key: EditorKey): CharacterDraft => ({ key, baseline: null, draft: null, focusedSection: null, version: 0 })

export function useCharacterDraft({ editorKey, blocked, workLock, canWrite, onLeaveGuardChange }: {
    editorKey: EditorKey
    blocked: boolean
    workLock: SortLock
    canWrite: () => boolean
    onLeaveGuardChange: (guard: LeaveGuard) => void
}) {
    const [editor, setEditor] = useState(() => emptyDraft(editorKey))
    const current = useRef(editor)
    const { lock: sortLock, activeListId } = useSortLock()
    const work = useEditorWork({ workLock, sortLock, blocked, canWrite })
    const canContinue = work.canContinue
    const getCurrent = useCallback((): Readonly<CharacterDraft> => current.current, [])
    const publish = useCallback((next: CharacterDraft) => {
        current.current = next
        setEditor(next)
    }, [])

    useLayoutEffect(() => { current.current = emptyDraft(editorKey) }, [editorKey])
    const isDirty = useCallback(() => current.current.key === editorKey
        && isEditorDirty(current.current.baseline, current.current.draft), [editorKey])
    useEffect(() => {
        onLeaveGuardChange(() => isDirty() || sortLock.getOwner() !== null || workLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [onLeaveGuardChange, isDirty, sortLock, workLock])

    const accept = useCallback((site: SiteData | null) => publish({
        key: editorKey, baseline: site, draft: site ? toDraft(site) : null,
        focusedSection: null, version: current.current.version + 1,
    }), [editorKey, publish])
    const reset = useCallback(() => publish({ ...current.current, key: editorKey, baseline: null, draft: null }), [editorKey, publish])
    const canEdit = useCallback(() => current.current.key === editorKey
        && canContinue() && workLock.getOwner() === null, [editorKey, canContinue, workLock])
    const change = useCallback((draft: SiteEditDraft): boolean => {
        if (!canEdit() || !current.current.baseline) return false
        publish({ ...current.current, draft })
        return true
    }, [canEdit, publish])
    const addSection = useCallback((): boolean => {
        const snapshot = current.current
        if (!snapshot.draft || !canEdit() || sortLock.getOwner() !== null) return false
        const id = crypto.randomUUID()
        publish({ ...snapshot, focusedSection: id, draft: {
            ...snapshot.draft, sections: [...snapshot.draft.sections, { id, title: '', content: '' }],
        } })
        return true
    }, [canEdit, sortLock, publish])

    const visible = editor.key === editorKey
    return {
        baseline: visible ? editor.baseline : null,
        draft: visible ? editor.draft : null,
        focusedSection: visible ? editor.focusedSection : null,
        editorVersion: editor.version,
        sorting: activeListId !== null,
        editingDisabled: blocked || work.busy,
        sortLock, work, getCurrent, accept, reset, isDirty, change, addSection,
    }
}
