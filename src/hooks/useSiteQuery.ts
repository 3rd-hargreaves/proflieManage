import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { loadCharacter, loadMain } from '../services/site'
import type { MainData, SiteData } from '../types/site'

export type SiteQueryState<T> =
    | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'ready', data: T }

interface QueryCallbacks<T> {
    onLoad?: (data: T) => void | (() => void)
    errorMessage?: string
}

interface SiteQueryOptions<T> extends QueryCallbacks<T> {
    queryKey: string
    load: (signal: AbortSignal) => Promise<T>
}

interface ActiveQuery {
    controller: AbortController
    restore?: () => void
}

export function useSiteQuery<T>({ queryKey, load, onLoad, errorMessage = '로드 실패' }: SiteQueryOptions<T>) {
    const [result, setResult] = useState<{ key: string, attempt: number, state: SiteQueryState<T> }>(
        () => ({ key: queryKey, attempt: 0, state: { status: 'loading' } }),
    )
    const [attempt, setAttempt] = useState(0)
    const activeQuery = useRef<ActiveQuery | null>(null)
    const options = useRef({ load, onLoad, errorMessage })

    useLayoutEffect(() => {
        options.current = { load, onLoad, errorMessage }
    }, [load, onLoad, errorMessage])

    const stopActiveQuery = useCallback(() => {
        const active = activeQuery.current
        if (!active) return
        activeQuery.current = null
        active.controller.abort()
        active.restore?.()
        active.restore = undefined
    }, [])

    // Restore theme effects and invalidate the old request before a new key paints.
    useLayoutEffect(() => () => stopActiveQuery(), [queryKey, attempt, stopActiveQuery])

    const reload = useCallback(() => {
        stopActiveQuery()
        setAttempt(value => value + 1)
    }, [stopActiveQuery])

    useEffect(() => {
        const active: ActiveQuery = { controller: new AbortController() }
        activeQuery.current = active
        const { signal } = active.controller
        const loader = options.current.load
        const publish = (state: SiteQueryState<T>) => {
            if (signal.aborted || activeQuery.current !== active) return
            setResult({ key: queryKey, attempt, state })
        }

        async function run() {
            try {
                const data = await loader(signal)
                if (signal.aborted || activeQuery.current !== active) return
                const restore = options.current.onLoad?.(data)
                if (typeof restore === 'function') active.restore = restore
                publish({ status: 'ready', data })
            } catch (error) {
                if (signal.aborted || activeQuery.current !== active) return
                active.restore?.()
                active.restore = undefined
                publish({ status: 'error', message: error instanceof Error ? error.message : options.current.errorMessage })
            }
        }

        void run()
        return () => {
            active.controller.abort()
            if (activeQuery.current === active) stopActiveQuery()
        }
    }, [queryKey, attempt, stopActiveQuery])

    const state: SiteQueryState<T> = result.key === queryKey && result.attempt === attempt
        ? result.state : { status: 'loading' }
    return { state, reload }
}

export function useMainQuery(options: QueryCallbacks<MainData> = {}) {
    return useSiteQuery({ ...options, queryKey: 'main', load: loadMain })
}

export function useCharacterQuery(characterId: number, options: QueryCallbacks<SiteData | null> = {}) {
    return useSiteQuery({ ...options, queryKey: `character:${characterId}`, load: signal => loadCharacter(characterId, signal) })
}
