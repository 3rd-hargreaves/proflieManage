import { useCallback, useEffect, useRef, useState } from 'react'
import CharacterFields from '../components/CharacterFields'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useMainQuery } from '../hooks/useSiteQuery'
import { useSortLock } from '../hooks/useSortLock'
import type { MainData, SiteData, SiteEditDraft, SiteTheme } from '../types/site'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { MAX_FEED_IMAGES } from '../utils/uploadLimits'
import { isHexColor } from '../utils/validation'
import { createCharacter, createCharacterContext } from '../services/save'
import { useEditorWork } from '../hooks/useEditorWork'
import { reportDraftValidation } from '../utils/formValidation'
import type { SortLock } from '../utils/sortLock'
import EditorAuthNotice from '../components/EditorAuthNotice'
import type { AuthNotice } from '../components/EditorAuthNotice'
import ImageCleanupNotice from '../components/ImageCleanupNotice'

interface NewCharacterPageProps {
    onLeaveGuardChange: (guard: LeaveGuard) => void
    authBlocked: boolean
    authNotice: AuthNotice | null
    workLock: SortLock
    canWrite: () => boolean
    onRetryAuth: () => void
    onReauthenticate: () => void
    onExit: () => void
    onBusyChange: (busy: boolean) => void
    onCreated: (site: SiteData, warning: string | null) => void
}

interface NewEditor {
    baseline: SiteData
    draft: SiteEditDraft
}

function emptyCharacter(theme: SiteTheme): SiteData {
    return {
        profile: { id: 1, name: '', status_message: '', profile_image_path: null },
        theme,
        sections: [], keywords: [], feed: [],
    }
}

export default function NewCharacterPage({ onLeaveGuardChange, authBlocked, authNotice, workLock, canWrite, onRetryAuth, onReauthenticate, onExit, onBusyChange, onCreated }: NewCharacterPageProps) {
    const [editor, setEditor] = useState<NewEditor | null>(null)
    const currentEditor = useRef<NewEditor | null>(null)
    const [creation] = useState(createCharacterContext)
    const form = useRef<HTMLFormElement>(null)
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const { lock, activeListId } = useSortLock()
    const sorting = activeListId !== null
    const work = useEditorWork({ workLock, sortLock: lock, blocked: authBlocked, canWrite })

    const initialize = useCallback((main: MainData) => {
        const baseline = emptyCharacter(main.theme)
        const next = { baseline, draft: toDraft(baseline) }
        currentEditor.current = next
        setEditor(next)
    }, [])
    const { state: query, reload } = useMainQuery({ onLoad: initialize })

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(currentEditor.current?.baseline ?? null, currentEditor.current?.draft ?? null)
            || lock.getOwner() !== null || workLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [lock, onLeaveGuardChange, workLock])

    useEffect(() => {
        onBusyChange(query.status === 'loading' || sorting || work.busy)
        return () => onBusyChange(false)
    }, [onBusyChange, query.status, sorting, work.busy])

    useEffect(() => {
        const previousTitle = document.title
        document.title = '캐릭터 추가'
        return () => { document.title = previousTitle }
    }, [])

    const draft = query.status === 'ready' ? editor?.draft : null
    const theme = draft?.theme
    useEffect(() => {
        if (!theme || !themeFields.every(({ key }) => isHexColor(theme[key]))) return
        return applyTheme({ id: 1, ...toThemeData(theme) })
    }, [theme])

    function change(next: SiteEditDraft) {
        if (!work.canContinue() || workLock.getOwner() !== null || !currentEditor.current) return
        const value = { ...currentEditor.current, draft: next }
        currentEditor.current = value
        setEditor(value)
    }

    function addSection() {
        if (!work.canStart() || !currentEditor.current) return
        const id = crypto.randomUUID()
        const draft = currentEditor.current.draft
        change({ ...draft, sections: [...draft.sections, { id, title: '', content: '' }] })
        setFocusedSection(id)
    }

    async function save() {
        const editor = currentEditor.current
        if (!editor) return
        await work.run('saving', async guard => {
            const result = await createCharacter(editor.draft, creation, guard)
            if (!work.isMounted()) return
            currentEditor.current = { baseline: result.site, draft: toDraft(result.site) }
            onCreated(result.site, result.cleanupWarning)
        })
    }

    return (
        <main className="flexColumn gapLg" aria-busy={query.status === 'loading' || work.busy}>
            <h1 className="text2 mainColorText bold">캐릭터 추가</h1>
            <EditorAuthNotice notice={authNotice} disabled={work.busy || sorting} onRetry={onRetryAuth} onLogin={onReauthenticate} onExit={onExit} />
            {query.status === 'loading' && <p className="card pdLg text3" role="status">기본 테마를 불러오는 중…</p>}
            {query.status === 'error' && (
                <div className="card pdLg flexColumn gapSm">
                    <p role="alert">{query.message}</p>
                    <button className="btn h30 border borderRad" type="button" onClick={reload}>다시 시도</button>
                </div>
            )}
            {draft && (
                <form ref={form} className="flexColumn gapLg" noValidate onSubmit={event => {
                    event.preventDefault()
                    if (form.current && !authBlocked && !work.busy && !sorting && reportDraftValidation(form.current, draft, 0, work.reportError)) void save()
                }}>
                    <fieldset className="editorFields flexColumn gapLg" disabled={authBlocked || work.busy}>
                        <CharacterFields draft={draft} change={change} addSection={addSection}
                            focusedSection={focusedSection} sorting={sorting} sortLock={lock}
                            editingDisabled={authBlocked || work.busy} maxFeedCount={MAX_FEED_IMAGES} saving={work.action === 'saving'} />
                    </fieldset>
                </form>
            )}
            {work.error && <p className="card pdLg text3" role="alert">{work.error}</p>}
            <ImageCleanupNotice workLock={workLock} sortLock={lock} canWrite={canWrite} blocked={authBlocked} />
        </main>
    )
}
