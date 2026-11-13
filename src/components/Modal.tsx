import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface ModalProps {
  id: string
  label: string
  onClose: () => void
  children: ReactNode
}

export default function Modal({ id, label, onClose, children }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement
    const modal = modalRef.current!
    const focusTarget = modal.querySelector<HTMLInputElement>('input') || modal
    focusTarget.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key !== 'Tab') return

      const fields = Array.from(modal.querySelectorAll<HTMLElement>(
        'input, button, textarea, select, a[href], [tabindex="0"]',
      )).filter(field => !field.hasAttribute('disabled') && field.getClientRects().length > 0)
      const first = fields[0]
      const last = fields[fields.length - 1]

      if (!first) {
        event.preventDefault()
        modal.focus()
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modal)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [onClose])

  return (
    <div
      ref={modalRef}
      id={id}
      className="modalOveray widthFull flex justifyCenter alignCenter"
      style={{ display: 'flex' }}
      role="dialog"
      aria-label={label}
      aria-modal="true"
      tabIndex={-1}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {children}
    </div>
  )
}
