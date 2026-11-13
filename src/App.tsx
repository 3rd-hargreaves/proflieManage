import { useCallback, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import MainPage from './pages/MainPage'
import EditPage from './pages/EditPage'
import { authConfigurationError, supabase } from './lib/supabase'
import { getAdminUser, signOut } from './services/auth'

interface AuthState {
  user: User | null
  loading: boolean
  error: string | null
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  const [auth, setAuth] = useState<AuthState>({ user: null, loading: !authConfigurationError, error: null })
  const [signingOut, setSigningOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const normalizedPath = path.replace(/\/$/, '')
  const isEdit = normalizedPath === '/edit' || normalizedPath === '/manage.html'

  const navigate = useCallback((destination: string, replace = false) => {
    if (window.location.pathname !== destination) {
      if (replace) window.history.replaceState(null, '', destination)
      else window.history.pushState(null, '', destination)
    }
    setPath(destination)
  }, [])

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!supabase || authConfigurationError) return
    let active = true
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    async function verifyUser() {
      const request = ++revision
      try {
        const user = await getAdminUser()
        if (active && request === revision) setAuth({ user, loading: false, error: null })
      } catch (error) {
        if (active && request === revision) {
          setAuth({ user: null, loading: false, error: errorMessage(error) })
        }
      }
    }

    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'INITIAL_SESSION') return
      revision++
      clearTimeout(timer)
      if (event === 'SIGNED_OUT') {
        setAuth({ user: null, loading: false, error: null })
        return
      }
      timer = setTimeout(() => void verifyUser(), 0)
    })

    void verifyUser()
    return () => {
      active = false
      revision++
      clearTimeout(timer)
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (isEdit && !auth.loading && !auth.user && !auth.error && !authConfigurationError) {
      window.location.replace('/')
    }
  }, [isEdit, auth])

  async function onLoginSuccess() {
    const user = await getAdminUser()
    if (!user) throw new Error('관리자 로그인 상태를 확인해 주세요.')
    setAuth({ user, loading: false, error: null })
    navigate('/edit')
  }

  async function logout() {
    if (signingOut) return
    setSigningOut(true)
    setLogoutError(null)
    try {
      await signOut()
      setAuth({ user: null, loading: false, error: null })
      navigate('/', true)
    } catch (error) {
      setLogoutError(errorMessage(error))
    } finally {
      setSigningOut(false)
    }
  }

  if (!isEdit) {
    return <MainPage isAdmin={!!auth.user} onOpenEditor={() => navigate('/edit')} onLoginSuccess={onLoginSuccess} />
  }

  if (!auth.user) {
    const message = authConfigurationError || auth.error || '로그인 상태를 확인하고 있습니다.'
    return (
      <main>
        <div className="card pdLg flexColumn gapMd">
          <p role="status">{message}</p>
          {auth.error && (
            <button type="button" className="btn h30 border borderRad" onClick={() => window.location.reload()}>
              다시 시도
            </button>
          )}
          <a href="/">메인으로</a>
        </div>
      </main>
    )
  }

  return <EditPage onLogout={logout} signingOut={signingOut} logoutError={logoutError} />
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'
}
