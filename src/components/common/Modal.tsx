import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface ModalProps {
    id: string
    label: string
    onClose: () => void
    closeDisabled?: boolean
    children: ReactNode
}

interface ModalEntry {
    element: HTMLDialogElement
    returnTargets: HTMLElement[]
}

const activeModals: ModalEntry[] = []
let scrollLocks = 0
let restoreScroll: (() => void) | null = null

function lockScroll(): () => void {
    if (scrollLocks === 0) {
        const { scrollX, scrollY } = window
        const style = document.body.style
        const properties = ['position', 'top', 'left', 'width', 'overflow-x', 'overflow-y', 'padding-right']
        const previous = properties.map(property => ({
            property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
        }))
        const scrollbar = window.innerWidth - document.documentElement.clientWidth
        const padding = getComputedStyle(document.body).paddingRight
        style.setProperty('position', 'fixed')
        style.setProperty('top', `${-scrollY}px`)
        style.setProperty('left', `${-scrollX}px`)
        style.setProperty('width', '100%')
        style.setProperty('overflow-x', 'hidden')
        style.setProperty('overflow-y', 'hidden')
        if (scrollbar > 0) style.setProperty('padding-right', `calc(${padding} + ${scrollbar}px)`)

        restoreScroll = () => {
            for (const { property, value, priority } of previous) style.setProperty(property, value, priority)
            // Explicitly restore the saved position even when the page uses smooth scrolling.
            window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' })
        }
    }
    scrollLocks += 1
    let released = false
    return () => {
        if (released) return
        released = true
        scrollLocks -= 1
        if (scrollLocks === 0) {
            restoreScroll?.()
            restoreScroll = null
        }
    }
}

function focusableFields(modal: HTMLDialogElement): HTMLElement[] {
    return Array.from(modal.querySelectorAll<HTMLElement>(
        'input, button, textarea, select, a[href], [tabindex], [contenteditable="true"]',
    )).filter(field => field.tabIndex >= 0 && !field.matches(':disabled')
        && !field.closest('[inert]') && field.getClientRects().length > 0
        && getComputedStyle(field).visibility !== 'hidden')
}

function focusInside(modal: HTMLDialogElement): void {
    const fields = focusableFields(modal)
    const preferred = fields.find(field => field.hasAttribute('data-modal-autofocus'))
    const target = preferred ?? fields[0] ?? modal
    target.focus({ preventScroll: true })
}

export default function Modal({ id, label, onClose, closeDisabled = false, children }: ModalProps) {
    const modalRef = useRef<HTMLDialogElement>(null)

    useLayoutEffect(() => {
        const opener = document.activeElement
        const modal = modalRef.current!
        const entry: ModalEntry = {
            element: modal,
            returnTargets: [opener, ...activeModals.flatMap(active => active.returnTargets)]
                .filter((element): element is HTMLElement => element instanceof HTMLElement),
        }
        const unlockScroll = lockScroll()
        activeModals.push(entry)
        modal.showModal()
        focusInside(modal)

        function handleKeyDown(event: KeyboardEvent) {
            if (activeModals.at(-1) !== entry || event.key !== 'Tab'
                || event.ctrlKey || event.altKey || event.metaKey) return
            const fields = focusableFields(modal)
            const first = fields[0]
            const last = fields[fields.length - 1]
            const outside = !modal.contains(document.activeElement) || document.activeElement === modal

            if (!first) {
                event.preventDefault()
                modal.focus({ preventScroll: true })
            } else if (event.shiftKey && (document.activeElement === first || outside)) {
                event.preventDefault()
                last.focus({ preventScroll: true })
            } else if (!event.shiftKey && (document.activeElement === last || outside)) {
                event.preventDefault()
                first.focus({ preventScroll: true })
            }
        }

        document.addEventListener('keydown', handleKeyDown, true)
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true)
            const wasTop = activeModals.at(-1) === entry
            const index = activeModals.indexOf(entry)
            if (index !== -1) activeModals.splice(index, 1)
            // Do not route native close events back to onClose: StrictMode also closes here.
            modal.close()
            unlockScroll()
            if (!wasTop) return
            const remaining = activeModals.at(-1)?.element
            const target = entry.returnTargets.find(element => element.isConnected
                && !element.matches(':disabled') && (!remaining || remaining.contains(element)))
            if (target) target.focus({ preventScroll: true })
            else if (remaining) focusInside(remaining)
        }
    }, [])

    useLayoutEffect(() => {
        const modal = modalRef.current
        if (modal?.open && activeModals.at(-1)?.element === modal
            && !modal.contains(document.activeElement)) focusInside(modal)
    }, [closeDisabled])

    return (
        <dialog
            ref={modalRef}
            id={id}
            className="modalOveray widthFull justifyCenter alignCenter"
            role="dialog"
            aria-label={label}
            aria-modal="true"
            onCancel={event => {
                event.preventDefault()
                if (!closeDisabled) onClose()
            }}
            onClick={event => {
                if (!closeDisabled && event.target === event.currentTarget) onClose()
            }}
        >
            {children}
        </dialog>
    )
}
