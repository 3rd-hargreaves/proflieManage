import { useEffect, useRef } from 'react'
import CharacterFields from '../components/CharacterFields'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { isHexColor } from '../utils/validation'
import { feedImageLimit } from '../utils/uploadLimits'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useSiteEditor } from '../hooks/useSiteEditor'
import type { SortLock } from '../utils/sortLock'
import { reportDraftValidation } from '../utils/formValidation'
import EditorAuthNotice from '../components/EditorAuthNotice'
import ImageCleanupNotice from '../components/ImageCleanupNotice'

interface EditPageProps {
    characterId: number
    signingOut: boolean
    authNotice: { message: string, checking: boolean, requiresLogin: boolean } | null
    onRetryAuth: () => void
    onReauthenticate: () => void
    onExit: () => void
    onLeaveGuardChange: (guard: LeaveGuard) => void
    canWrite: () => boolean
    onBusyChange?: (busy: boolean) => void
    workLock: SortLock
    onDeleted: (warning: string | null) => void
}

export default function EditPage({ characterId, signingOut, authNotice, onRetryAuth, onReauthenticate, onExit, onLeaveGuardChange, canWrite, onBusyChange, workLock, onDeleted }: EditPageProps) {
    const form = useRef<HTMLFormElement>(null)
    const {
        baseline, draft, loading, loadError, notFound, focusedSection, editorVersion,
        sorting, sortLock, editingDisabled, change, addSection, reload,
        busy, saving, deleting, saveError, reportError, saved, cleanupWarning, clearCleanupWarning, save, remove,
    } = useSiteEditor({ characterId, signingOut, authBlocked: !!authNotice, canWrite, onLeaveGuardChange, workLock, onDeleted })

    useEffect(() => {
        onBusyChange?.(loading || sorting || busy)
        return () => onBusyChange?.(false)
    }, [onBusyChange, loading, sorting, busy])

    useEffect(() => {
        const previousTitle = document.title
        document.title = '관리자'
        return () => { document.title = previousTitle }
    }, [])

    const theme = draft?.theme
    useEffect(() => {
        if (!theme || !themeFields.every(({ key }) => isHexColor(theme[key]))) return
        return applyTheme({ id: characterId, ...toThemeData(theme) })
    }, [characterId, theme])

    return (
        <main className="flexColumn gapLg" aria-busy={loading || busy}>
            <EditorAuthNotice notice={authNotice} disabled={busy || sorting || signingOut} onRetry={onRetryAuth} onLogin={onReauthenticate} onExit={onExit} />
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
                        if (form.current && !editingDisabled && !sorting && reportDraftValidation(form.current, draft, baseline?.feed.length ?? 0, reportError)) void save()
                    }}>
                        <fieldset className="editorFields flexColumn gapLg" disabled={editingDisabled} key={editorVersion}>
                            <CharacterFields draft={draft} change={change} addSection={addSection}
                                focusedSection={focusedSection} sorting={sorting} sortLock={sortLock}
                                editingDisabled={editingDisabled} maxFeedCount={feedImageLimit(baseline?.feed.length ?? 0)} saving={saving} />
                        </fieldset>
                    </form>
                    {saved && <p role="status">저장 성공</p>}
                    {saveError && <div className="card pdLg flexColumn gapSm">
                        <p role="alert">{saveError}</p>
                        <button className="btn border borderRad pdSm" type="button" disabled={editingDisabled || sorting} onClick={reload}>편집 내용을 버리고 DB에서 다시 불러오기</button>
                    </div>}
                    <ImageCleanupNotice message={cleanupWarning} workLock={workLock} sortLock={sortLock} canWrite={canWrite} blocked={!!authNotice || signingOut} onCleared={clearCleanupWarning} />
                    <button className="btn h30 border borderRad widthFull" type="button" disabled={editingDisabled || sorting} onClick={() => void remove()}>
                        {deleting ? '삭제 중…' : '캐릭터 삭제'}
                    </button>
                </>
            )}
        </main>
    )
}
