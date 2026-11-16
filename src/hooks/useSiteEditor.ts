import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SiteData, SiteEditDraft } from '../types/site'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import type { LeaveGuard } from './useGuardedNavigation'
import { useCharacterQuery } from './useSiteQuery'
import { useSortLock } from './useSortLock'

interface SiteEditorOptions {
    characterId: number
    signingOut: boolean
    authBlocked: boolean
    canWrite: () => boolean
    onLeaveGuardChange: (guard: LeaveGuard) => void
}

interface EditorData {
    characterId: number
    baseline: SiteData | null
    draft: SiteEditDraft | null
}

export function useSiteEditor({ characterId, signingOut, authBlocked, canWrite, onLeaveGuardChange }: SiteEditorOptions) {
    const current = useRef<EditorData>({ characterId, baseline: null, draft: null })
    const [editor, setEditor] = useState<EditorData>(() => ({ characterId, baseline: null, draft: null }))
    const { lock: sortLock, activeListId } = useSortLock()
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const [editorVersion, setEditorVersion] = useState(0)

    useLayoutEffect(() => {
        current.current = { characterId, baseline: null, draft: null }
    }, [characterId])

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(current.current.baseline, current.current.draft) || sortLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [onLeaveGuardChange, sortLock])

    const acceptCharacter = useCallback((site: SiteData | null) => {
        const next = { characterId, baseline: site, draft: site ? toDraft(site) : null }
        current.current = next
        setEditor(next)
        setFocusedSection(null)
        setEditorVersion(version => version + 1)
    }, [characterId])

    const { state: query, reload: reloadQuery } = useCharacterQuery(characterId, {
        onLoad: acceptCharacter,
        errorMessage: '수정할 정보를 불러오지 못했습니다.',
    })

    const canEdit = useCallback(() => current.current.characterId === characterId
        && !signingOut && !authBlocked && canWrite(), [characterId, signingOut, authBlocked, canWrite])

    const change = useCallback((next: SiteEditDraft) => {
        if (!canEdit() || !current.current.baseline) return
        current.current = { ...current.current, draft: next }
        setEditor(current.current)
    }, [canEdit])

    const addSection = useCallback(() => {
        const draft = current.current.draft
        if (!draft || !canEdit() || sortLock.getOwner() !== null) return
        const id = crypto.randomUUID()
        change({ ...draft, sections: [...draft.sections, { id, title: '', content: '' }] })
        setFocusedSection(id)
    }, [canEdit, change, sortLock])

    const reload = useCallback(() => {
        if (signingOut || sortLock.getOwner() !== null) return
        current.current = { characterId, baseline: null, draft: null }
        reloadQuery()
    }, [characterId, signingOut, sortLock, reloadQuery])

    const visible = query.status === 'ready' && editor.characterId === characterId
    const baseline = visible ? editor.baseline : null
    const draft = visible ? editor.draft : null

    return {
        baseline,
        draft,
        dirty: isEditorDirty(baseline, draft),
        loading: query.status === 'loading',
        loadError: query.status === 'error' ? query.message : null,
        notFound: query.status === 'ready' && query.data === null,
        focusedSection: visible ? focusedSection : null,
        editorVersion,
        sorting: activeListId !== null,
        sortLock,
        editingDisabled: signingOut || authBlocked,
        change,
        addSection,
        reload,
    }
}
