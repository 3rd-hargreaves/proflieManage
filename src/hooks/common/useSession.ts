import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import type { AuthInfo } from '../../components/auth/AuthNotice'
import { authConfigError, supabase } from '../../lib/supabase'
import { getAdminUser, signOut } from '../../services/auth'
import { isEditorPath } from '../../utils/routes'

interface AuthState {
    // Retain the last verified owner while an open editor is locked for recovery.
    user: User | null
    status: 'checking' | 'authenticated' | 'signedOut' | 'error'
    error: string | null
}

export function useSession() {
    const [auth, setAuth] = useState<AuthState>({ user: null, status: authConfigError ? 'signedOut' : 'checking', error: null })
    const [loginOpen, setLoginOpen] = useState(false)
    const [signingOut, setSigningOut] = useState(false)
    const [logoutError, setLogoutError] = useState<string | null>(null)
    const active = useRef(false)
    const epoch = useRef(0)
    const verification = useRef<{ epoch: number, promise: Promise<User | null> } | null>(null)
    const logoutPending = useRef(false)
    const writeAllowed = useRef(false)
    const editing = useRef(isEditorPath(location.pathname))
    const canWrite = useCallback(() => writeAllowed.current, [])
    const openLogin = useCallback(() => setLoginOpen(true), [])
    const closeLogin = useCallback(() => setLoginOpen(false), [])
    const onPathChange = useCallback((nextPath: string) => {
        // Track accepted routes so canceled history changes keep the editor owner.
        editing.current = isEditorPath(nextPath)
        if (!editing.current) {
            setLoginOpen(false)
            setAuth(previous => previous.status === 'authenticated' ? previous : { ...previous, user: null })
        }
    }, [])
    const invalidate = useCallback(() => {
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
                    user: user ?? (editing.current ? previous.user : null),
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
    }, [])

    useEffect(() => {
        if (!supabase || authConfigError) return
        active.current = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const { data } = supabase.auth.onAuthStateChange(event => {
            if (event === 'INITIAL_SESSION') return
            invalidate()
            clearTimeout(timer)
            if (event === 'SIGNED_OUT') {
                setAuth(previous => ({ user: editing.current ? previous.user : null, status: 'signedOut', error: null }))
                return
            }
            setAuth(previous => ({ ...previous, status: 'checking', error: null }))
            timer = setTimeout(() => void verifyUser(), 0)
        })
        void verifyUser()
        return () => {
            active.current = false
            invalidate()
            clearTimeout(timer)
            data.subscription.unsubscribe()
        }
    }, [verifyUser, invalidate])

    async function finishLogin(getLocationKey: () => string) {
        const locationKey = getLocationKey()
        const user = await verifyUser()
        if (!active.current || getLocationKey() !== locationKey) return
        if (!user) throw new Error('관리자 로그인 상태를 다시 확인해 주세요.')
        setLoginOpen(false)
        setLogoutError(null)
    }

    async function logout(canStart: () => boolean, onSuccess: () => void) {
        if (logoutPending.current || !canStart()) return
        logoutPending.current = true
        writeAllowed.current = false
        setSigningOut(true)
        setLogoutError(null)
        try {
            await signOut()
            invalidate()
            setAuth({ user: null, status: 'signedOut', error: null })
            onSuccess()
        } catch (error) {
            setLogoutError(errorMessage(error))
            void verifyUser()
        } finally {
            logoutPending.current = false
            setSigningOut(false)
        }
    }

    const authNotice: AuthInfo | null = auth.status === 'authenticated' ? null : {
        checking: auth.status === 'checking',
        requiresLogin: auth.status === 'signedOut',
        message: auth.status === 'checking'
            ? '로그인 상태를 확인하는 중입니다. 입력한 내용은 유지됩니다.'
            : auth.status === 'signedOut'
                ? '로그인이 만료되었거나 로그아웃되었습니다. 입력한 내용을 유지하고 있습니다. 다시 로그인해 주세요.'
                : `${auth.error} 입력한 내용은 유지됩니다. 다시 확인해 주세요.`,
    }
    return {
        auth, configError: authConfigError,
        isAdmin: auth.status === 'authenticated' && !!auth.user,
        canWrite, onPathChange, loginOpen, openLogin, closeLogin, finishLogin,
        signingOut, logoutError, logout,
        editorAuth: { authNotice, onRetryAuth: () => { void verifyUser() }, onLogin: openLogin },
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'
}
