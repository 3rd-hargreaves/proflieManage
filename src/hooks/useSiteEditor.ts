import { useCallback, useEffect, useRef, useState } from 'react'
import { getPendingImageCleanupCount, imageCleanupWarning, retryImageCleanup, saveSite } from '../services/save'
import type { SiteData, SiteEditDraft } from '../types/site'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import type { LeaveGuard } from './useGuardedNavigation'
import { useSiteQuery } from './useSiteQuery'
import { useSortLock } from './useSortLock'

interface SiteEditorOptions {
    signingOut: boolean
    authBlocked: boolean
    canWrite: () => boolean
    onLeaveGuardChange: (guard: LeaveGuard) => void
}

export function useSiteEditor({ signingOut, authBlocked, canWrite, onLeaveGuardChange }: SiteEditorOptions) {
    const mounted = useRef(true)
    const savingRef = useRef(false)
    const cleaningRef = useRef(false)
    const current = useRef<{ baseline: SiteData | null, draft: SiteEditDraft | null }>({ baseline: null, draft: null })
    const { lock: sortLock, activeListId } = useSortLock()
    const [baseline, setBaseline] = useState<SiteData | null>(null)
    const [draft, setDraft] = useState<SiteEditDraft | null>(null)
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    const [cleanupWarning, setCleanupWarning] = useState<string | null>(() => imageCleanupWarning())
    const [cleaning, setCleaning] = useState(false)
    const [editorVersion, setEditorVersion] = useState(0)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(current.current.baseline, current.current.draft)
            || savingRef.current || cleaningRef.current || sortLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [onLeaveGuardChange, sortLock])

    const acceptSite = useCallback((site: SiteData) => {
        const nextDraft = toDraft(site)
        current.current = { baseline: site, draft: nextDraft }
        setBaseline(site)
        setDraft(nextDraft)
        setFocusedSection(null)
        setEditorVersion(version => version + 1)
    }, [])

    const { state: query, reload: reloadQuery } = useSiteQuery({
        onLoad: acceptSite,
        errorMessage: '로드 실패',
    })

    const canStart = useCallback(() => {
        // The refs and sort lock close the gap before disabled controls render.
        return mounted.current && !savingRef.current && !cleaningRef.current
            && sortLock.getOwner() === null && !signingOut && !authBlocked && canWrite()
    }, [sortLock, signingOut, authBlocked, canWrite])

    const canSave = useCallback(() => {
        return canStart() && current.current.draft !== null && current.current.baseline !== null
    }, [canStart])

    const change = useCallback((next: SiteEditDraft) => {
        current.current.draft = next
        setDraft(next)
        setSaved(false)
    }, [])

    const addSection = useCallback(() => {
        const draft = current.current.draft
        if (!draft || !canStart()) return
        const id = crypto.randomUUID()
        change({ ...draft, sections: [...draft.sections, { id, title: '', content: '' }] })
        setFocusedSection(id)
    }, [canStart, change])

    const reload = useCallback(() => {
        if (!canStart()) return
        setSaveError(null)
        setSaved(false)
        setDraft(null)
        setBaseline(null)
        current.current = { baseline: null, draft: null }
        setFocusedSection(null)
        reloadQuery()
    }, [canStart, reloadQuery])

    const save = useCallback(async () => {
        const { draft, baseline } = current.current
        if (!draft || !baseline || !canStart()) return
        savingRef.current = true
        setSaving(true)
        setSaveError(null)
        setSaved(false)
        try {
            const result = await saveSite(draft, baseline)
            if (!mounted.current) return
            acceptSite(result.site)
            setCleanupWarning(result.cleanupWarning)
            setSaved(true)
        } catch (error) {
            if (mounted.current) {
                setSaveError(error instanceof Error ? error.message : '저장하지 못했습니다. 다시 시도해 주세요.')
                if (getPendingImageCleanupCount() > 0) setCleanupWarning(imageCleanupWarning('미저장 이미지 정리가 남아 있습니다. 다시 시도해 주세요.'))
            }
        } finally {
            savingRef.current = false
            if (mounted.current) setSaving(false)
        }
    }, [canStart, acceptSite])

    const retryCleanup = useCallback(async () => {
        if (!canStart()) return
        cleaningRef.current = true
        setCleaning(true)
        try {
            const complete = await retryImageCleanup()
            if (mounted.current) setCleanupWarning(complete ? null : imageCleanupWarning('일부 이전 이미지 정리 존재. 재시도 요망.'))
        } catch {
            if (mounted.current) setCleanupWarning('이미지 정리 완료 실패. 재시도 요망.')
        } finally {
            cleaningRef.current = false
            if (mounted.current) setCleaning(false)
        }
    }, [canStart])

    return {
        baseline,
        draft,
        dirty: isEditorDirty(baseline, draft),
        loading: query.status === 'loading',
        loadError: query.status === 'error' ? query.message : null,
        focusedSection,
        saving,
        saveError,
        saved,
        cleanupWarning,
        cleaning,
        editorVersion,
        sorting: activeListId !== null,
        sortLock,
        editingDisabled: saving || signingOut || cleaning || authBlocked,
        pendingCleanupCount: getPendingImageCleanupCount(),
        change,
        addSection,
        reload,
        canSave,
        save,
        retryCleanup,
        reportError: setSaveError,
    }
}
