import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import MainPage from './pages/MainPage'
import LoginModal from './components/LoginModal'
import { useGuardedNavigation } from './hooks/useGuardedNavigation'
import { authConfigurationError, supabase } from './lib/supabase'
import { getAdminUser, signOut } from './services/auth'

const EditPage = lazy(() => import('./pages/EditPage'))
type AuthStatus = 'checking' | 'authenticated' | 'signedOut' | 'error'
interface AuthState {
    // Retain the last verified owner while an open editor is locked for recovery.
    user: User | null
    status: AuthStatus
    error: string | null
}
const isEditorPath = (path: string) => ['/edit', '/manage.html'].includes(path.replace(/\/$/, ''))

export default function App() {
    const [auth, setAuth] = useState<AuthState>({ user: null, status: authConfigurationError ? 'signedOut' : 'checking', error: null })
    const [reauthOpen, setReauthOpen] = useState(false)
    const onPathChange = useCallback((nextPath: string) => {
        if (!isEditorPath(nextPath)) {
            setReauthOpen(false)
            setAuth(previous => previous.status === 'authenticated' ? previous : { ...previous, user: null })
        }
    }, [])
    const { path, navigate, confirmLeave, setLeaveGuard, getCurrentPath, getLocationKey } = useGuardedNavigation(onPathChange)
    const [signingOut, setSigningOut] = useState(false)
    const [logoutError, setLogoutError] = useState<string | null>(null)
    const active = useRef(false)
    const epoch = useRef(0)
    const verification = useRef<{ epoch: number, promise: Promise<User | null> } | null>(null)
    const logoutPending = useRef(false)
    const writeAllowed = useRef(false)
    const canWrite = useCallback(() => writeAllowed.current, [])
    const isEdit = isEditorPath(path)
    const invalidateVerification = useCallback(() => {
        writeAllowed.current = false
        epoch.current++
        verification.current = null
    }, [])

    const verifyUser = useCallback((): Promise<User | null> => {
        if (verification.current?.epoch === epoch.current) return verification.current.promise
        writeAllowed.current = false
        const request = epoch.current
        setAuth(previous => ({ ...previous, status: 'checking', error: null }))
        const promise = (async () => {
            try {
                const user = await getAdminUser()
                if (!active.current || request !== epoch.current) return null
                writeAllowed.current = !!user
                setAuth(previous => ({
                    user: user ?? (isEditorPath(getCurrentPath()) ? previous.user : null),
                    status: user ? 'authenticated' : 'signedOut', error: null,
                }))
                return user
            } catch (error) {
                if (active.current && request === epoch.current) {
                    setAuth(previous => ({ ...previous, status: 'error', error: errorMessage(error) }))
                }
                return null
            } finally {
                if (verification.current?.epoch === request) verification.current = null
            }
        })()
        verification.current = { epoch: request, promise }
        return promise
    }, [getCurrentPath])

    useEffect(() => {
        if (!supabase || authConfigurationError) return
        active.current = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const { data } = supabase.auth.onAuthStateChange(event => {
            if (event === 'INITIAL_SESSION') return
            invalidateVerification()
            clearTimeout(timer)
            if (event === 'SIGNED_OUT') {
                setAuth(previous => ({
                    user: isEditorPath(getCurrentPath()) ? previous.user : null,
                    status: 'signedOut', error: null,
                }))
                return
            }
            setAuth(previous => ({ ...previous, status: 'checking', error: null }))
            timer = setTimeout(() => void verifyUser(), 0)
        })
        void verifyUser()
        return () => {
            active.current = false
            invalidateVerification()
            clearTimeout(timer)
            data.subscription.unsubscribe()
        }
    }, [getCurrentPath, verifyUser, invalidateVerification])

    useEffect(() => {
        if (isEdit && auth.status === 'signedOut' && !auth.user && !authConfigurationError) navigate('/', true, true)
    }, [isEdit, auth.status, auth.user, navigate])

    async function onLoginSuccess() {
        const locationKey = getLocationKey()
        const user = await verifyUser()
        if (!active.current || getLocationKey() !== locationKey) return
        if (!user) throw new Error('관리자 로그인 상태를 다시 확인해 주세요.')
        setReauthOpen(false)
        setLogoutError(null)
        if (!isEditorPath(getCurrentPath())) navigate('/edit')
    }

    async function logout() {
        if (logoutPending.current || !confirmLeave()) return
        logoutPending.current = true
        writeAllowed.current = false
        setSigningOut(true)
        setLogoutError(null)
        try {
            await signOut()
            invalidateVerification()
            setAuth({ user: null, status: 'signedOut', error: null })
            navigate('/', true, true)
        } catch (error) {
            setLogoutError(errorMessage(error))
            void verifyUser()
        } finally {
            logoutPending.current = false
            setSigningOut(false)
        }
    }

    if (!isEdit) {
        return <MainPage isAdmin={auth.status === 'authenticated' && !!auth.user} onOpenEditor={() => { navigate('/edit') }} onLoginSuccess={onLoginSuccess} />
    }
    if (!auth.user) {
        return (
            <main>
                <div className="card pdLg flexColumn gapMd">
                    <p role="status">{authConfigurationError || auth.error || '로그인 상태를 확인하고 있습니다.'}</p>
                    {auth.error && <button type="button" className="btn h30 border borderRad" onClick={() => void verifyUser()}>다시 확인</button>}
                    <button type="button" className="btn h30 border borderRad" onClick={() => { navigate('/') }}>메인으로</button>
                </div>
            </main>
        )
    }

    const authNotice = auth.status === 'authenticated' ? null : {
        checking: auth.status === 'checking',
        requiresLogin: auth.status === 'signedOut',
        message: auth.status === 'checking'
            ? '로그인 상태를 확인하는 중입니다. 입력한 내용은 유지됩니다.'
            : auth.status === 'signedOut'
                ? '로그인이 만료되었거나 로그아웃되었습니다. 입력한 내용을 유지하고 있습니다. 다시 로그인해 주세요.'
                : `${auth.error} 입력한 내용은 유지됩니다. 다시 확인해 주세요.`,
    }
    return (
        <>
            <Suspense fallback={<main><p className="card pdLg text3" role="status">수정 화면을 불러오는 중…</p></main>}>
                <EditPage onLogout={logout} signingOut={signingOut} logoutError={logoutError}
                    authNotice={authNotice} onRetryAuth={() => void verifyUser()}
                    onReauthenticate={() => setReauthOpen(true)} onExit={() => { navigate('/') }}
                    onLeaveGuardChange={setLeaveGuard} canWrite={canWrite} />
            </Suspense>
            <LoginModal isOpen={reauthOpen} onClose={() => setReauthOpen(false)} onLoginSuccess={onLoginSuccess} />
        </>
    )
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'
}
