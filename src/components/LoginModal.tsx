import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { validateRequired } from '../utils/validation'
import Modal from './Modal'

interface LoginModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const [password, setPassword] = useState('')
  const passwordRef = useRef<HTMLInputElement>(null)

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    validateRequired(passwordRef.current!)
  }

  if (!isOpen) return null

  return (
    <Modal id="loginModal" label="관리자 로그인" onClose={onClose}>
      <form className="modal card pdLg flexColumn gapSm" noValidate onSubmit={login}>
        <input
          ref={passwordRef}
          className="widthFull h30 pdSide border"
          type="password"
          placeholder="비밀번호"
          aria-label="비밀번호"
          autoComplete="current-password"
          value={password}
          onChange={event => {
            setPassword(event.target.value)
            event.target.setCustomValidity('')
          }}
        />
        <button type="submit" className="btn h30 border borderRad widthFull">로그인</button>
      </form>
    </Modal>
  )
}
