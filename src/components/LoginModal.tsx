import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { validateRequired } from '../utils/validation'
import { authConfigurationError } from '../lib/supabase'
import { signIn } from '../services/auth'
import Modal from './Modal'

interface LoginModalProps {
  isOpen: boolean
  onClose: () => void
  onLoginSuccess: () => Promise<void>
}

export default function LoginModal({ isOpen, onClose, onLoginSuccess }: LoginModalProps) {
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !validateRequired(passwordRef.current!)) return
    setError(null)
    if (authConfigurationError) return

    submitting.current = true
    setPending(true)
    try {
      await signIn(password)
      await onLoginSuccess()
      setPassword('')
    } catch (error) {
      setError(error instanceof Error ? error.message : '로그인하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  if (!isOpen) return null

  return (
    <Modal id="loginModal" label="관리자 로그인" onClose={onClose}>
      <form className="modal card pdLg flexColumn gapSm" noValidate onSubmit={login}>
        <input
          ref={passwordRef}
          className="widthFull h30 pdSide border borderRad"
          type="password"
          placeholder="비밀번호"
          aria-label="비밀번호"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          onChange={event => {
            setPassword(event.target.value)
            event.target.setCustomValidity('')
            setError(null)
          }}
        />
        {(authConfigurationError || error) && <p role="alert">{authConfigurationError || error}</p>}
        <button type="submit" className="btn h30 border borderRad widthFull" disabled={pending || !!authConfigurationError}>
          {pending ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </Modal>
  )
}
