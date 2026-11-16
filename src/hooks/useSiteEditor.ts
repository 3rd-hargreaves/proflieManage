import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SiteData, SiteEditDraft } from '../types/site'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import type { LeaveGuard } from './useGuardedNavigation'
import { useCharacterQuery } from './useSiteQuery'
import { useSortLock } from './useSortLock'
import { useEditorWork } from './useEditorWork'
import { deleteCharacter, saveCharacter } from '../services/save'
import type { SortLock } from '../utils/sortLock'

interface SiteEditorOptions {
    characterId: number
    signingOut: boolean
    authBlocked: boolean
    canWrite: () => boolean
    onLeaveGuardChange: (guard: LeaveGuard) => void
    workLock: SortLock
    onDeleted: (warning: string | null) => void
}

interface EditorData {
    characterId: number
    baseline: SiteData | null
    draft: SiteEditDraft | null
}

export function useSiteEditor({ characterId, signingOut, authBlocked, canWrite, onLeaveGuardChange, workLock, onDeleted }: SiteEditorOptions) {
    const current = useRef<EditorData>({ characterId, baseline: null, draft: null })
    const [editor, setEditor] = useState<EditorData>(() => ({ characterId, baseline: null, draft: null }))
    const { lock: sortLock, activeListId } = useSortLock()
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const [editorVersion, setEditorVersion] = useState(0)
    const [saved, setSaved] = useState(false)
    const [cleanupWarning, setCleanupWarning] = useState<string | null>(null)
    const work = useEditorWork({ workLock, sortLock, blocked: signingOut || authBlocked, canWrite })

    useLayoutEffect(() => {
        current.current = { characterId, baseline: null, draft: null }
    }, [characterId])

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(current.current.baseline, current.current.draft)
            || sortLock.getOwner() !== null || workLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [onLeaveGuardChange, sortLock, workLock])

    const acceptCharacter = useCallback((site: SiteData | null) => {
        const next = { characterId, baseline: site, draft: site ? toDraft(site) : null }
        current.current = next
        setEditor(next)
        setFocusedSection(null)
        setEditorVersion(version => version + 1)
        setSaved(false)
    }, [characterId])

    const { state: query, reload: reloadQuery } = useCharacterQuery(characterId, {
        onLoad: acceptCharacter,
        errorMessage: '수정할 정보를 불러오지 못했습니다.',
    })

    const canContinue = work.canContinue
    const reportError = work.reportError
    const canEdit = useCallback(() => current.current.characterId === characterId
        && canContinue() && workLock.getOwner() === null, [characterId, canContinue, workLock])

    const change = useCallback((next: SiteEditDraft) => {
        if (!canEdit() || !current.current.baseline) return
        current.current = { ...current.current, draft: next }
        setEditor(current.current)
        setSaved(false)
    }, [canEdit])

    const addSection = useCallback(() => {
        const draft = current.current.draft
        if (!draft || !canEdit() || sortLock.getOwner() !== null) return
        const id = crypto.randomUUID()
        change({ ...draft, sections: [...draft.sections, { id, title: '', content: '' }] })
        setFocusedSection(id)
    }, [canEdit, change, sortLock])

    const reload = useCallback(() => {
        if (workLock.getOwner() !== null || signingOut || sortLock.getOwner() !== null) return
        if (isEditorDirty(current.current.baseline, current.current.draft)
            && !window.confirm('편집 내용을 버리고 DB에서 다시 불러오시겠습니까?')) return
        current.current = { characterId, baseline: null, draft: null }
        setEditor(current.current)
        setSaved(false)
        reportError(null)
        reloadQuery()
    }, [characterId, signingOut, sortLock, reloadQuery, workLock, reportError])

    async function save() {
        const { draft, baseline } = current.current
        if (!draft || !baseline) return
        await work.run('saving', async guard => {
            const result = await saveCharacter(characterId, draft, baseline, guard)
            if (!work.isMounted()) return
            acceptCharacter(result.site)
            setCleanupWarning(result.cleanupWarning)
            setSaved(true)
        })
    }

    async function remove() {
        const baseline = current.current.baseline
        if (!baseline) return
        await work.run('deleting', async guard => {
            if (!window.confirm('이 캐릭터와 모든 내용을 삭제하시겠습니까? 저장하지 않은 변경사항도 사라집니다.')) return
            if (!guard()) return
            const result = await deleteCharacter(characterId, baseline, guard)
            if (!work.isMounted()) return
            current.current = { characterId, baseline: null, draft: null }
            onDeleted(result.cleanupWarning)
        })
    }

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
        editingDisabled: signingOut || authBlocked || work.busy,
        busy: work.busy,
        saving: work.action === 'saving',
        deleting: work.action === 'deleting',
        saveError: work.error,
        reportError: work.reportError,
        cleanupWarning,
        clearCleanupWarning: () => setCleanupWarning(null),
        saved,
        save,
        remove,
        change,
        addSection,
        reload,
    }
}
