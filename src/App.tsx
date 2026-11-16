import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import HomePage from './pages/HomePage'
import ProfilePage from './pages/ProfilePage'
import Header from './components/common/Header'
import LoginModal from './components/auth/LoginModal'
import { useNavigation } from './hooks/common/useNavigation'
import { useSession } from './hooks/common/useSession'
import type { LeaveGuard } from './hooks/common/useNavigation'
import { createSortLock } from './utils/sortLock'
import type { Character } from './types/models'
import CleanupNotice from './components/editor/CleanupNotice'
import { cleanupCount } from './services/storage'
import { editPath, characterPath, isEditorPath, resolveRoute } from './utils/routes'

const EditPage = lazy(() => import('./pages/EditPage'))
const NewPage = lazy(() => import('./pages/NewPage'))

export default function App() {
    const session = useSession()
    const { auth, configError, isAdmin, canWrite, signingOut, logoutError, editorAuth } = session
    const [workLock] = useState(createSortLock)
    const [mainSortLock] = useState(createSortLock)
    const [mainVersion, setMainVersion] = useState(0)
    const workOwner = useSyncExternalStore(workLock.subscribe, workLock.getOwner, workLock.getOwner)
    const mainSortOwner = useSyncExternalStore(mainSortLock.subscribe, mainSortLock.getOwner, mainSortLock.getOwner)
    const pageGuard = useRef<LeaveGuard>(null)
    const [cleanupNotice, setCleanupNotice] = useState<string | null>(null)
    const { path, navigate, confirmLeave, setLeaveGuard: setRouteGuard, getLocationKey } = useNavigation(session.onPathChange)
    const setLeaveGuard = useCallback((guard: LeaveGuard) => { pageGuard.current = guard }, [])
    useEffect(() => {
        setRouteGuard(() => workLock.getOwner() !== null || !!pageGuard.current?.())
        return () => setRouteGuard(null)
    }, [workLock, setRouteGuard])
    const [editBusy, setEditBusy] = useState(false)
    const [loadedCharacter, setLoadedCharacter] = useState<number | null>(null)
    const isEdit = isEditorPath(path)
    const route = resolveRoute(path)
    useEffect(() => {
        if (isEdit && auth.status === 'signedOut' && !auth.user && !configError) navigate('/', true, true)
    }, [isEdit, auth.status, auth.user, configError, navigate])

    function logout() {
        void session.logout(
            () => workLock.getOwner() === null && mainSortLock.getOwner() === null && confirmLeave(),
            () => { setMainVersion(version => version + 1); navigate('/', true, true) },
        )
    }

    const notFound = route.page === 'notFound'
    function onCreated(site: Character, warning: string | null) {
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
            <HomePage key={`main-${mainVersion}`} isAdmin={isAdmin} signingOut={signingOut} navigate={navigate}
                workLock={workLock} sortLock={mainSortLock} canWrite={canWrite} setLeaveGuard={setLeaveGuard}
                {...editorAuth} />
        )
        if (route.page === 'character') return <ProfilePage key={`character-${route.characterId}`} characterId={route.characterId} onLoaded={setLoadedCharacter} />
        if (!auth.user) return (
            <main>
                <div className="card pdLg flexColumn gapMd">
                    <p role="status">{configError || auth.error || '로그인 상태를 확인하고 있습니다.'}</p>
                    {auth.error && <button type="button" className="btn h30 border borderRad" onClick={editorAuth.onRetryAuth}>다시 확인</button>}
                    <button type="button" className="btn h30 border borderRad" onClick={() => { navigate('/') }}>메인으로</button>
                </div>
            </main>
        )
        return (
            <Suspense fallback={<main><p className="card pdLg text3" role="status">수정 화면을 불러오는 중…</p></main>}>
                {route.page === 'new' ? (
                    <NewPage key="new" authBlocked={!isAdmin || signingOut} setLeaveGuard={setLeaveGuard}
                        {...editorAuth} workLock={workLock} canWrite={canWrite} onCreated={onCreated}
                        onExit={() => { navigate('/') }} setBusy={setEditBusy} />
                ) : route.page === 'edit' ? (
                    <EditPage key={`edit-${route.characterId}`} characterId={route.characterId}
                        signingOut={signingOut} setBusy={setEditBusy}
                        workLock={workLock} onDeleted={onDeleted}
                        {...editorAuth} onExit={() => { navigate('/') }}
                        setLeaveGuard={setLeaveGuard} canWrite={canWrite} />
                ) : null}
            </Suspense>
        )
    }

    return (
        <>
            <Header isAdmin={isAdmin} editHref={route.page === 'character' && loadedCharacter === route.characterId ? editPath(route.characterId) : undefined}
                busy={auth.status === 'checking' || workOwner !== null || mainSortOwner !== null || (isEdit && editBusy)} signingOut={signingOut}
                navigate={navigate} onLogin={session.openLogin} onLogout={logout} />
            {logoutError && <p className="card pdLg" role="alert">{logoutError}</p>}
            {isAdmin && !isEdit && (cleanupNotice || cleanupCount() > 0) && (
                <div className="globalNotice">
                    <CleanupNotice message={cleanupNotice} workLock={workLock} sortLock={route.page === 'main' ? mainSortLock : undefined}
                        canWrite={canWrite} blocked={!isAdmin || signingOut} onCleared={() => setCleanupNotice(null)} />
                </div>
            )}
            {content()}
            <LoginModal isOpen={session.loginOpen} onClose={session.closeLogin} onLoginSuccess={() => session.finishLogin(getLocationKey)} />
        </>
    )
}
