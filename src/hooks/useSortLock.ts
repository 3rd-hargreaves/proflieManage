import { useState, useSyncExternalStore } from 'react'
import { createSortLock } from '../utils/sortLock'

export function useSortLock() {
    const [lock] = useState(createSortLock)
    const activeListId = useSyncExternalStore(lock.subscribe, lock.getOwner, lock.getOwner)
    return { lock, activeListId }
}
