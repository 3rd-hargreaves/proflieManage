export interface SortLock {
    getOwner: () => string | null
    subscribe: (listener: () => void) => () => void
    tryStart: (listId: string) => boolean
    end: (listId: string) => boolean
}

export function createSortLock(): SortLock {
    let owner: string | null = null
    const listeners = new Set<() => void>()
    const notify = () => { for (const listener of listeners) listener() }

    return {
        getOwner: () => owner,
        subscribe(listener) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        tryStart(listId) {
            if (!listId || owner !== null) return false
            owner = listId
            notify()
            return true
        },
        end(listId) {
            if (owner !== listId) return false
            owner = null
            notify()
            return true
        },
    }
}
