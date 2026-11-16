import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SortLock } from '../utils/sortLock'

type EditorAction = 'saving' | 'deleting' | 'cleaning'

export function useEditorWork({ workLock, sortLock, blocked, canWrite }: {
    workLock: SortLock
    sortLock: SortLock
    blocked: boolean
    canWrite: () => boolean
}) {
    const mounted = useRef(false)
    const options = useRef({ blocked, canWrite })
    const [action, setAction] = useState<EditorAction | null>(null)
    const [error, setError] = useState<string | null>(null)
    const owner = useSyncExternalStore(workLock.subscribe, workLock.getOwner, workLock.getOwner)
    useLayoutEffect(() => { options.current = { blocked, canWrite } }, [blocked, canWrite])
    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])
    const isMounted = useCallback(() => mounted.current, [])
    const canContinue = useCallback(() => mounted.current && !options.current.blocked && options.current.canWrite(), [])
    const canStart = useCallback(() => canContinue() && workLock.getOwner() === null && sortLock.getOwner() === null,
        [canContinue, workLock, sortLock])

    async function run(next: EditorAction, task: (guard: () => boolean) => Promise<void>) {
        if (!canStart() || !workLock.tryStart(next)) return
        setAction(next)
        setError(null)
        try {
            await task(canContinue)
        } catch (failure) {
            if (mounted.current) setError(failure instanceof Error ? failure.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.')
        } finally {
            workLock.end(next)
            if (mounted.current) setAction(null)
        }
    }

    return { action, busy: owner !== null, error, reportError: setError, run, canStart, canContinue, isMounted }
}
