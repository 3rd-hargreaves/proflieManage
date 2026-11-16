import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import MainPage from './pages/MainPage'
import CharacterPage from './pages/CharacterPage'
import SiteHeader from './components/SiteHeader'
import LoginModal from './components/LoginModal'
import { useGuardedNavigation } from './hooks/useGuardedNavigation'
import { useAdminSession } from './hooks/useAdminSession'
import type { LeaveGuard } from './hooks/useGuardedNavigation'
import { createSortLock } from './utils/sortLock'
import type { SiteData } from './types/site'
import ImageCleanupNotice from './components/ImageCleanupNotice'
import { getPendingImageCleanupCount } from './services/storage'
import { characterEditPath, characterPath, isEditorPath, resolveRoute } from './utils/routes'

const EditPage = lazy(() => import('./pages/EditPage'))
const NewCharacterPage = lazy(() => import('./pages/NewCharacterPage'))

export default function App() {
    const session = useAdminSession()
    const { auth, configurationError, isAdmin, canWrite, signingOut, logoutError, editorAuth } = session
    const [workLock] = useState(createSortLock)
    const [mainSortLock] = useState(createSortLock)
    const [mainVersion, setMainVersion] = useState(0)
    const workOwner = useSyncExternalStore(workLock.subscribe, workLock.getOwner, workLock.getOwner)
    const mainSortOwner = useSyncExternalStore(mainSortLock.subscribe, mainSortLock.getOwner, mainSortLock.getOwner)
    const pageGuard = useRef<LeaveGuard>(null)
    const [cleanupNotice, setCleanupNotice] = useState<string | null>(null)
    const { path, navigate, confirmLeave, setLeaveGuard: setNavigationGuard, getLocationKey } = useGuardedNavigation(session.onPathChange)
    const setLeaveGuard = useCallback((guard: LeaveGuard) => { pageGuard.current = guard }, [])
    useEffect(() => {
        setNavigationGuard(() => workLock.getOwner() !== null || !!pageGuard.current?.())
        return () => setNavigationGuard(null)
    }, [workLock, setNavigationGuard])
    const [editorBusy, setEditorBusy] = useState(false)
    const [loadedCharacter, setLoadedCharacter] = useState<number | null>(null)
    const isEdit = isEditorPath(path)
    const route = resolveRoute(path)
    useEffect(() => {
        if (isEdit && auth.status === 'signedOut' && !auth.user && !configurationError) navigate('/', true, true)
    }, [isEdit, auth.status, auth.user, configurationError, navigate])

    function logout() {
        void session.logout(
            () => workLock.getOwner() === null && mainSortLock.getOwner() === null && confirmLeave(),
            () => { setMainVersion(version => version + 1); navigate('/', true, true) },
        )
    }

    const notFound = route.page === 'notFound'
    function onCreated(site: SiteData, warning: string | null) {
        setCleanupNotice(warning)
        navigate(characterPath(site.profile.id), true, true)
    }
    function onDeleted(warning: string | null) {
        setCleanupNotice(warning)
        navigate('/', true, true)
    }
    function content() {
        if (notFound) return <main><p className="card pdLg text3">캐릭터를 찾을 수 없습니다.</p></main>
        if (route.page === 'main') return (
            <MainPage key={`main-${mainVersion}`} isAdmin={isAdmin} signingOut={signingOut} navigate={navigate}
                workLock={workLock} sortLock={mainSortLock} canWrite={canWrite} onLeaveGuardChange={setLeaveGuard}
                {...editorAuth} />
        )
        if (route.page === 'character') return <CharacterPage key={`character-${route.characterId}`} characterId={route.characterId} onLoaded={setLoadedCharacter} />
        if (!auth.user) return (
            <main>
                <div className="card pdLg flexColumn gapMd">
                    <p role="status">{configurationError || auth.error || '로그인 상태를 확인하고 있습니다.'}</p>
                    {auth.error && <button type="button" className="btn h30 border borderRad" onClick={editorAuth.onRetryAuth}>다시 확인</button>}
                    <button type="button" className="btn h30 border borderRad" onClick={() => { navigate('/') }}>메인으로</button>
                </div>
            </main>
        )
        return (
            <Suspense fallback={<main><p className="card pdLg text3" role="status">수정 화면을 불러오는 중…</p></main>}>
                {route.page === 'new' ? (
                    <NewCharacterPage key="new" authBlocked={!isAdmin || signingOut} onLeaveGuardChange={setLeaveGuard}
                        {...editorAuth} workLock={workLock} canWrite={canWrite} onCreated={onCreated}
                        onExit={() => { navigate('/') }} onBusyChange={setEditorBusy} />
                ) : route.page === 'edit' ? (
                    <EditPage key={`edit-${route.characterId}`} characterId={route.characterId}
                        signingOut={signingOut} onBusyChange={setEditorBusy}
                        workLock={workLock} onDeleted={onDeleted}
                        {...editorAuth} onExit={() => { navigate('/') }}
                        onLeaveGuardChange={setLeaveGuard} canWrite={canWrite} />
                ) : null}
            </Suspense>
        )
    }

    return (
        <>
            <SiteHeader isAdmin={isAdmin} editHref={route.page === 'character' && loadedCharacter === route.characterId ? characterEditPath(route.characterId) : undefined}
                busy={auth.status === 'checking' || workOwner !== null || mainSortOwner !== null || (isEdit && editorBusy)} signingOut={signingOut}
                navigate={navigate} onLogin={session.openLogin} onLogout={logout} />
            {logoutError && <p className="card pdLg" role="alert">{logoutError}</p>}
            {isAdmin && !isEdit && (cleanupNotice || getPendingImageCleanupCount() > 0) && (
                <div className="globalNotice">
                    <ImageCleanupNotice message={cleanupNotice} workLock={workLock} sortLock={route.page === 'main' ? mainSortLock : undefined}
                        canWrite={canWrite} blocked={!isAdmin || signingOut} onCleared={() => setCleanupNotice(null)} />
                </div>
            )}
            {content()}
            <LoginModal isOpen={session.loginOpen} onClose={session.closeLogin} onLoginSuccess={() => session.completeLogin(getLocationKey)} />
        </>
    )
}
