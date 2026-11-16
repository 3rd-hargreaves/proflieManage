import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Character, Draft } from '../../types/models'
import type { SortLock } from '../../utils/sortLock'
import { hasChanges } from '../../utils/character/dirty'
import { toDraft } from '../../utils/character/draft'
import type { LeaveGuard } from '../common/useNavigation'
import { useSortLock } from '../common/useSortLock'
import { useWork } from './useWork'

type EditorKey = number | 'new'
interface CharacterDraft {
    key: EditorKey
    baseline: Character | null
    draft: Draft | null
    focusId: string | null
    version: number
}

const emptyDraft = (key: EditorKey): CharacterDraft => ({ key, baseline: null, draft: null, focusId: null, version: 0 })

export function useDraft({ editorKey, blocked, workLock, canWrite, setLeaveGuard }: {
    editorKey: EditorKey
    blocked: boolean
    workLock: SortLock
    canWrite: () => boolean
    setLeaveGuard: (guard: LeaveGuard) => void
}) {
    const [editor, setEditor] = useState(() => emptyDraft(editorKey))
    const current = useRef(editor)
    const { lock: sortLock, activeListId } = useSortLock()
    const work = useWork({ workLock, sortLock, blocked, canWrite })
    const canContinue = work.canContinue
    const getCurrent = useCallback((): Readonly<CharacterDraft> => current.current, [])
    const publish = useCallback((next: CharacterDraft) => {
        current.current = next
        setEditor(next)
    }, [])

    useLayoutEffect(() => { current.current = emptyDraft(editorKey) }, [editorKey])
    const isDirty = useCallback(() => current.current.key === editorKey
        && hasChanges(current.current.baseline, current.current.draft), [editorKey])
    useEffect(() => {
        setLeaveGuard(() => isDirty() || sortLock.getOwner() !== null || workLock.getOwner() !== null)
        return () => setLeaveGuard(null)
    }, [setLeaveGuard, isDirty, sortLock, workLock])

    const accept = useCallback((site: Character | null) => publish({
        key: editorKey, baseline: site, draft: site ? toDraft(site) : null,
        focusId: null, version: current.current.version + 1,
    }), [editorKey, publish])
    const reset = useCallback(() => publish({ ...current.current, key: editorKey, baseline: null, draft: null }), [editorKey, publish])
    const canEdit = useCallback(() => current.current.key === editorKey
        && canContinue() && workLock.getOwner() === null, [editorKey, canContinue, workLock])
    const change = useCallback((draft: Draft): boolean => {
        if (!canEdit() || !current.current.baseline) return false
        publish({ ...current.current, draft })
        return true
    }, [canEdit, publish])
    const addSection = useCallback((): boolean => {
        const snapshot = current.current
        if (!snapshot.draft || !canEdit() || sortLock.getOwner() !== null) return false
        const id = crypto.randomUUID()
        publish({ ...snapshot, focusId: id, draft: {
            ...snapshot.draft, sections: [...snapshot.draft.sections, { id, title: '', content: '' }],
        } })
        return true
    }, [canEdit, sortLock, publish])

    const visible = editor.key === editorKey
    return {
        baseline: visible ? editor.baseline : null,
        draft: visible ? editor.draft : null,
        focusId: visible ? editor.focusId : null,
        formVersion: editor.version,
        sorting: activeListId !== null,
        disabled: blocked || work.busy,
        sortLock, work, getCurrent, accept, reset, isDirty, change, addSection,
    }
}
