import { useCallback, useEffect, useRef, useState } from 'react'

export type LeaveGuard = (() => boolean) | null
const indexKey = 'profileManageNavigationIndex'
const leaveMessage = '저장하지 않은 변경사항이 있거나 저장 작업이 진행 중입니다. 이 페이지를 떠나시겠습니까?'
const currentUrl = () => location.pathname + location.search + location.hash
function historyIndex(state: unknown): number | null {
    if (!state || typeof state !== 'object' || !(indexKey in state)) return null
    const value = (state as Record<string, unknown>)[indexKey]
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export function useGuardedNavigation(onPathChange: (path: string) => void) {
    const [path, setPath] = useState(location.pathname)
    const guard = useRef<LeaveGuard>(null)
    const accepted = useRef({ url: currentUrl(), index: historyIndex(history.state) ?? 0, state: history.state })
    const restoring = useRef(false)
    const beforeUnload = useCallback((event: BeforeUnloadEvent) => {
        if (!guard.current?.()) return
        event.preventDefault()
        event.returnValue = ''
    }, [])
    const setLeaveGuard = useCallback((next: LeaveGuard) => {
        guard.current = next
        if (next) window.addEventListener('beforeunload', beforeUnload)
        else window.removeEventListener('beforeunload', beforeUnload)
    }, [beforeUnload])
    const confirmLeave = useCallback(() => {
        return !restoring.current && (!guard.current?.() || window.confirm(leaveMessage))
    }, [])

    useEffect(() => {
        const entry = accepted.current
        entry.state = { ...history.state, [indexKey]: entry.index }
        history.replaceState(entry.state, '', entry.url)
        function onPopState() {
            const targetUrl = currentUrl()
            const targetIndex = historyIndex(history.state)
            if (restoring.current) {
                restoring.current = false
                return
            }
            if (location.pathname !== pathFromUrl(accepted.current.url) && !confirmLeave()) {
                if (targetIndex !== null && targetIndex !== accepted.current.index) {
                    restoring.current = true
                    history.go(accepted.current.index - targetIndex)
                } else history.replaceState(accepted.current.state, '', accepted.current.url)
                return
            }
            accepted.current = { url: targetUrl, index: targetIndex ?? accepted.current.index, state: history.state }
            onPathChange(location.pathname)
            setPath(location.pathname)
        }
        window.addEventListener('popstate', onPopState)
        return () => {
            window.removeEventListener('popstate', onPopState)
            window.removeEventListener('beforeunload', beforeUnload)
        }
    }, [beforeUnload, confirmLeave, onPathChange])

    const navigate = useCallback((destination: string, replace = false, approved = false): boolean => {
        const target = new URL(destination, location.href)
        if (target.origin !== location.origin) throw new Error('사이트 내부 주소만 이동할 수 있습니다.')
        const url = target.pathname + target.search + target.hash
        if (url === accepted.current.url) return true
        if (!approved && !confirmLeave()) return false
        const index = accepted.current.index + (replace ? 0 : 1)
        const state = { [indexKey]: index }
        if (replace) history.replaceState(state, '', url)
        else history.pushState(state, '', url)
        accepted.current = { url, index, state }
        onPathChange(target.pathname)
        setPath(target.pathname)
        return true
    }, [confirmLeave, onPathChange])
    const getCurrentPath = useCallback(() => pathFromUrl(accepted.current.url), [])
    const getLocationKey = useCallback(() => `${accepted.current.index}:${accepted.current.url}`, [])
    return { path, navigate, confirmLeave, setLeaveGuard, getCurrentPath, getLocationKey }
}

function pathFromUrl(url: string): string {
    return new URL(url, location.origin).pathname
}
