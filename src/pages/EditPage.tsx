import { useRef } from 'react'
import Fields from '../components/editor/Fields'
import { feedLimit } from '../utils/images/limits'
import type { LeaveGuard } from '../hooks/common/useNavigation'
import { useEditor } from '../hooks/editor/useEditor'
import { usePage } from '../hooks/editor/usePage'
import type { SortLock } from '../utils/sortLock'
import { validateForm } from '../utils/character/form'
import AuthNotice from '../components/auth/AuthNotice'
import CleanupNotice from '../components/editor/CleanupNotice'

interface EditPageProps {
    characterId: number
    signingOut: boolean
    authNotice: { message: string, checking: boolean, requiresLogin: boolean } | null
    onRetryAuth: () => void
    onLogin: () => void
    onExit: () => void
    setLeaveGuard: (guard: LeaveGuard) => void
    canWrite: () => boolean
    setBusy?: (busy: boolean) => void
    workLock: SortLock
    onDeleted: (warning: string | null) => void
}

export default function EditPage({ characterId, signingOut, authNotice, onRetryAuth, onLogin, onExit, setLeaveGuard, canWrite, setBusy, workLock, onDeleted }: EditPageProps) {
    const form = useRef<HTMLFormElement>(null)
    const {
        baseline, draft, loading, loadError, notFound, focusId, formVersion,
        sorting, sortLock, disabled, change, addSection, reload,
        busy, saving, deleting, saveError, reportError, saved, cleanupWarning, clearCleanupWarning, save, remove,
    } = useEditor({ characterId, signingOut, authBlocked: !!authNotice, canWrite, setLeaveGuard, workLock, onDeleted })

    usePage({ title: '관리자', theme: draft?.theme, characterId, busy: loading || sorting || busy, setBusy })

    return (
        <main className="flexColumn gapLg" aria-busy={loading || busy}>
            <AuthNotice notice={authNotice} disabled={busy || sorting || signingOut} onRetry={onRetryAuth} onLogin={onLogin} onExit={onExit} />
            {loading && <p className="card pdLg text3" role="status">수정할 정보를 불러오는 중…</p>}
            {loadError && (
                <div className="card pdLg flexColumn gapMd">
                    <p role="alert">{loadError}</p>
                    <button className="btn h30 border borderRad" type="button" onClick={reload}>다시 시도</button>
                </div>
            )}
            {notFound && <p className="card pdLg text3" role="status">캐릭터를 찾을 수 없습니다.</p>}
            {draft && !loading && (
                <>
                    <form ref={form} className="flexColumn gapLg" noValidate onSubmit={event => {
                        event.preventDefault()
                        if (form.current && !disabled && !sorting && validateForm(form.current, draft, baseline?.feed.length ?? 0, reportError)) void save()
                    }}>
                        <fieldset className="editorFields flexColumn gapLg" disabled={disabled} key={formVersion}>
                            <Fields draft={draft} change={change} addSection={addSection}
                                focusId={focusId} sorting={sorting} sortLock={sortLock}
                                disabled={disabled} maxFeedCount={feedLimit(baseline?.feed.length ?? 0)} saving={saving} />
                        </fieldset>
                    </form>
                    {saved && <p role="status">저장 성공</p>}
                    {saveError && <div className="card pdLg flexColumn gapSm">
                        <p role="alert">{saveError}</p>
                        <button className="btn border borderRad pdSm" type="button" disabled={disabled || sorting} onClick={reload}>편집 내용을 버리고 DB에서 다시 불러오기</button>
                    </div>}
                    <CleanupNotice message={cleanupWarning} workLock={workLock} sortLock={sortLock} canWrite={canWrite} blocked={!!authNotice || signingOut} onCleared={clearCleanupWarning} />
                    <button className="btn h30 border borderRad widthFull" type="button" disabled={disabled || sorting} onClick={() => void remove()}>
                        {deleting ? '삭제 중…' : '캐릭터 삭제'}
                    </button>
                </>
            )}
        </main>
    )
}
