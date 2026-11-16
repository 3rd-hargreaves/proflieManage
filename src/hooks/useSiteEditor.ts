import { useCallback, useState } from 'react'
import type { SiteData, SiteEditDraft } from '../types/site'
import type { LeaveGuard } from './useGuardedNavigation'
import { useCharacterQuery } from './useSiteQuery'
import { useCharacterDraft } from './useCharacterDraft'
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

export function useSiteEditor({ characterId, signingOut, authBlocked, canWrite, onLeaveGuardChange, workLock, onDeleted }: SiteEditorOptions) {
    const [saved, setSaved] = useState(false)
    const [cleanupWarning, setCleanupWarning] = useState<string | null>(null)
    const editor = useCharacterDraft({ editorKey: characterId, blocked: signingOut || authBlocked, canWrite, onLeaveGuardChange, workLock })
    const { work, sortLock, getCurrent, accept, reset, isDirty } = editor
    const acceptCharacter = useCallback((site: SiteData | null) => {
        accept(site)
        setSaved(false)
    }, [accept])

    const { state: query, reload: reloadQuery } = useCharacterQuery(characterId, {
        onLoad: acceptCharacter,
        errorMessage: '수정할 정보를 불러오지 못했습니다.',
    })

    const reportError = work.reportError
    function change(next: SiteEditDraft) {
        if (editor.change(next)) setSaved(false)
    }
    function addSection() {
        if (editor.addSection()) setSaved(false)
    }

    const reload = useCallback(() => {
        if (workLock.getOwner() !== null || signingOut || sortLock.getOwner() !== null) return
        if (isDirty()
            && !window.confirm('편집 내용을 버리고 DB에서 다시 불러오시겠습니까?')) return
        reset()
        setSaved(false)
        reportError(null)
        reloadQuery()
    }, [signingOut, sortLock, reloadQuery, workLock, reportError, reset, isDirty])

    async function save() {
        const { draft, baseline } = getCurrent()
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
        const baseline = getCurrent().baseline
        if (!baseline) return
        await work.run('deleting', async guard => {
            if (!window.confirm('이 캐릭터와 모든 내용을 삭제하시겠습니까? 저장하지 않은 변경사항도 사라집니다.')) return
            if (!guard()) return
            const result = await deleteCharacter(characterId, baseline, guard)
            if (!work.isMounted()) return
            reset()
            onDeleted(result.cleanupWarning)
        })
    }

    const visible = query.status === 'ready'
    const baseline = visible ? editor.baseline : null
    const draft = visible ? editor.draft : null

    return {
        baseline,
        draft,
        loading: query.status === 'loading',
        loadError: query.status === 'error' ? query.message : null,
        notFound: query.status === 'ready' && query.data === null,
        focusedSection: visible ? editor.focusedSection : null,
        editorVersion: editor.editorVersion,
        sorting: editor.sorting,
        sortLock,
        editingDisabled: editor.editingDisabled,
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
