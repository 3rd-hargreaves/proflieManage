import { useCallback, useRef, useState } from 'react'
import Fields from '../components/editor/Fields'
import type { LeaveGuard } from '../hooks/common/useNavigation'
import { useMainQuery } from '../hooks/common/useQuery'
import { useDraft } from '../hooks/editor/useDraft'
import { usePage } from '../hooks/editor/usePage'
import type { MainData, Character, Theme } from '../types/models'
import { MAX_FEED_IMAGES } from '../utils/images/limits'
import { createCharacter, createContext } from '../services/save'
import { validateForm } from '../utils/character/form'
import type { SortLock } from '../utils/sortLock'
import AuthNotice from '../components/auth/AuthNotice'
import type { AuthInfo } from '../components/auth/AuthNotice'
import CleanupNotice from '../components/editor/CleanupNotice'

interface NewPageProps {
    setLeaveGuard: (guard: LeaveGuard) => void
    authBlocked: boolean
    authNotice: AuthInfo | null
    workLock: SortLock
    canWrite: () => boolean
    onRetryAuth: () => void
    onLogin: () => void
    onExit: () => void
    setBusy: (busy: boolean) => void
    onCreated: (site: Character, warning: string | null) => void
}

function emptyCharacter(theme: Theme): Character {
    return {
        profile: { id: 1, name: '', status_message: '', profile_image_path: null },
        theme,
        sections: [], keywords: [], feed: [],
    }
}

export default function NewPage({ setLeaveGuard, authBlocked, authNotice, workLock, canWrite, onRetryAuth, onLogin, onExit, setBusy, onCreated }: NewPageProps) {
    const [creation] = useState(createContext)
    const form = useRef<HTMLFormElement>(null)
    const editor = useDraft({ editorKey: 'new', blocked: authBlocked, workLock, canWrite, setLeaveGuard })
    const { accept, getCurrent, change, addSection, focusId, sortLock, sorting, disabled, work } = editor

    const initialize = useCallback((main: MainData) => {
        accept(emptyCharacter(main.theme))
    }, [accept])
    const { state: query, reload } = useMainQuery({ onLoad: initialize })

    const draft = query.status === 'ready' ? editor.draft : null
    usePage({ title: '캐릭터 추가', theme: draft?.theme, busy: query.status === 'loading' || sorting || work.busy, setBusy })

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
            <AuthNotice notice={authNotice} disabled={work.busy || sorting} onRetry={onRetryAuth} onLogin={onLogin} onExit={onExit} />
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
                    if (form.current && !disabled && !sorting && validateForm(form.current, draft, 0, work.reportError)) void save()
                }}>
                    <fieldset className="editorFields flexColumn gapLg" disabled={disabled}>
                        <Fields draft={draft} change={change} addSection={addSection}
                            focusId={focusId} sorting={sorting} sortLock={sortLock}
                            disabled={disabled} maxFeedCount={MAX_FEED_IMAGES} saving={work.action === 'saving'} />
                    </fieldset>
                </form>
            )}
            {work.error && <p className="card pdLg text3" role="alert">{work.error}</p>}
            <CleanupNotice workLock={workLock} sortLock={sortLock} canWrite={canWrite} blocked={authBlocked} />
        </main>
    )
}
