import { useEffect } from 'react'
import CharacterFields from '../components/CharacterFields'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { isHexColor } from '../utils/validation'
import { feedImageLimit } from '../utils/uploadLimits'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useSiteEditor } from '../hooks/useSiteEditor'

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
}

export default function EditPage({ characterId, signingOut, authNotice, onRetryAuth, onReauthenticate, onExit, onLeaveGuardChange, canWrite, onBusyChange }: EditPageProps) {
    const {
        baseline, draft, loading, loadError, notFound, focusedSection, editorVersion,
        sorting, sortLock, editingDisabled, change, addSection, reload,
    } = useSiteEditor({ characterId, signingOut, authBlocked: !!authNotice, canWrite, onLeaveGuardChange })

    useEffect(() => {
        onBusyChange?.(loading || sorting)
        return () => onBusyChange?.(false)
    }, [onBusyChange, loading, sorting])

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
        <main className="flexColumn gapLg" aria-busy={loading}>
            {authNotice && (
                <div className="card pdLg flexColumn gapSm">
                    <p role={authNotice.checking ? 'status' : 'alert'}>{authNotice.message}</p>
                    <button className="btn h30 border borderRad" type="button"
                        disabled={authNotice.checking || sorting || signingOut}
                        onClick={authNotice.requiresLogin ? onReauthenticate : onRetryAuth}>
                        {authNotice.checking ? '로그인 확인 중…' : authNotice.requiresLogin ? '다시 로그인' : '다시 확인'}
                    </button>
                    <button className="btn h30 border borderRad" type="button" disabled={sorting || signingOut} onClick={onExit}>메인으로</button>
                </div>
            )}
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
                    <p className="card pdLg text3" id="characterSaveNotice">캐릭터 저장은 준비 중입니다.</p>
                    <form className="flexColumn gapLg" noValidate onSubmit={event => event.preventDefault()} aria-describedby="characterSaveNotice">
                        <fieldset className="editorFields flexColumn gapLg" disabled={editingDisabled} key={editorVersion}>
                            <CharacterFields draft={draft} change={change} addSection={addSection}
                                focusedSection={focusedSection} sorting={sorting} sortLock={sortLock}
                                editingDisabled={editingDisabled} maxFeedCount={feedImageLimit(baseline?.feed.length ?? 0)} saveDisabled />
                        </fieldset>
                    </form>
                    <div className="flexColumn gapSm">
                        <p className="text3" id="characterDeleteNotice">캐릭터 삭제는 준비 중입니다.</p>
                        <button className="btn h30 border borderRad widthFull" type="button" disabled aria-describedby="characterDeleteNotice">캐릭터 삭제</button>
                    </div>
                </>
            )}
        </main>
    )
}
