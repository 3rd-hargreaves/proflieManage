import { useCallback, useRef, useState } from 'react'
import CharacterFields from '../components/CharacterFields'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useMainQuery } from '../hooks/useSiteQuery'
import { useCharacterDraft } from '../hooks/useCharacterDraft'
import { useEditorPage } from '../hooks/useEditorPage'
import type { MainData, SiteData, SiteTheme } from '../types/site'
import { MAX_FEED_IMAGES } from '../utils/uploadLimits'
import { createCharacter, createCharacterContext } from '../services/save'
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

function emptyCharacter(theme: SiteTheme): SiteData {
    return {
        profile: { id: 1, name: '', status_message: '', profile_image_path: null },
        theme,
        sections: [], keywords: [], feed: [],
    }
}

export default function NewCharacterPage({ onLeaveGuardChange, authBlocked, authNotice, workLock, canWrite, onRetryAuth, onReauthenticate, onExit, onBusyChange, onCreated }: NewCharacterPageProps) {
    const [creation] = useState(createCharacterContext)
    const form = useRef<HTMLFormElement>(null)
    const editor = useCharacterDraft({ editorKey: 'new', blocked: authBlocked, workLock, canWrite, onLeaveGuardChange })
    const { accept, getCurrent, change, addSection, focusedSection, sortLock, sorting, editingDisabled, work } = editor

    const initialize = useCallback((main: MainData) => {
        accept(emptyCharacter(main.theme))
    }, [accept])
    const { state: query, reload } = useMainQuery({ onLoad: initialize })

    const draft = query.status === 'ready' ? editor.draft : null
    useEditorPage({ title: '캐릭터 추가', theme: draft?.theme, busy: query.status === 'loading' || sorting || work.busy, onBusyChange })

    async function save() {
        const { draft } = getCurrent()
        if (!draft) return
        await work.run('saving', async guard => {
            const result = await createCharacter(draft, creation, guard)
            if (!work.isMounted()) return
            accept(result.site)
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
                    if (form.current && !editingDisabled && !sorting && reportDraftValidation(form.current, draft, 0, work.reportError)) void save()
                }}>
                    <fieldset className="editorFields flexColumn gapLg" disabled={editingDisabled}>
                        <CharacterFields draft={draft} change={change} addSection={addSection}
                            focusedSection={focusedSection} sorting={sorting} sortLock={sortLock}
                            editingDisabled={editingDisabled} maxFeedCount={MAX_FEED_IMAGES} saving={work.action === 'saving'} />
                    </fieldset>
                </form>
            )}
            {work.error && <p className="card pdLg text3" role="alert">{work.error}</p>}
            <ImageCleanupNotice workLock={workLock} sortLock={sortLock} canWrite={canWrite} blocked={authBlocked} />
        </main>
    )
}
