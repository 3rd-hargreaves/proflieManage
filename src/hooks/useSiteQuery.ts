import { useCallback, useEffect, useRef, useState } from 'react'
import { loadSite } from '../services/site'
import type { SiteData } from '../types/site'

export type SiteQueryState =
    | { status: 'loading' }
    | { status: 'error', message: string }
    | { status: 'ready', data: SiteData }

interface SiteQueryOptions {
    onLoad?: (site: SiteData) => void | (() => void)
    errorMessage?: string
}

export function useSiteQuery({ onLoad, errorMessage = '로드 실패' }: SiteQueryOptions = {}) {
    const [state, setState] = useState<SiteQueryState>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)
    const activeRequest = useRef<AbortController | null>(null)
    const options = useRef({ onLoad, errorMessage })

    useEffect(() => {
        options.current = { onLoad, errorMessage }
    }, [onLoad, errorMessage])

    const reload = useCallback(() => {
        // Invalidate the old response before React commits the retry render.
        activeRequest.current?.abort()
        setState({ status: 'loading' })
        setAttempt(value => value + 1)
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        activeRequest.current = controller
        let restore: (() => void) | undefined

        async function load() {
            try {
                const data = await loadSite(controller.signal)
                if (controller.signal.aborted) return
                const cleanup = options.current.onLoad?.(data)
                if (typeof cleanup === 'function') restore = cleanup
                setState({ status: 'ready', data })
            } catch (error) {
                if (controller.signal.aborted) return
                controller.abort()
                setState({
                    status: 'error',
                    message: error instanceof Error ? error.message : options.current.errorMessage,
                })
            }
        }

        void load()
        return () => {
            controller.abort()
            if (activeRequest.current === controller) activeRequest.current = null
            restore?.()
        }
    }, [attempt])

    return { state, reload }
}
