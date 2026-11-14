interface JournalStorage {
    readonly length: number
    key(index: number): string | null
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

interface CleanupRecord {
    path: string
    queuedAt: number
}

export function isCleanupPath(path: string): boolean {
    return /^(profile|feed)\/.+/.test(path)
        && new TextEncoder().encode(path).length <= 1024
        && !Array.from(path).some(character => character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

// One key per immutable path prevents tabs from overwriting each other's queue.
// Only confirmed cleanup candidates belong here; uncertain RPC uploads do not.
export function createCleanupJournal(scope: string, getStorage: () => JournalStorage | null) {
    const prefix = `profileManage:cleanup:v1:${encodeURIComponent(scope)}:`
    const pending = new Map<string, CleanupRecord>()
    const unsaved = new Set<string>()
    const failedRemovals = new Set<string>()
    let readFailed = false

    function read() {
        try {
            const storage = getStorage()
            if (!storage) { readFailed = true; return }
            for (let index = 0; index < storage.length; index++) {
                const key = storage.key(index)
                if (!key?.startsWith(prefix)) continue
                const raw = storage.getItem(key)
                try {
                    const record: unknown = JSON.parse(raw ?? 'null')
                    if (!record || typeof record !== 'object' || !('path' in record) || !('queuedAt' in record)) continue
                    if (typeof record.path !== 'string' || !isCleanupPath(record.path)
                        || !Number.isSafeInteger(record.queuedAt) || (record.queuedAt as number) < 0
                        || key !== prefix + encodeURIComponent(record.path)) continue
                    pending.set(record.path, { path: record.path, queuedAt: record.queuedAt as number })
                    unsaved.delete(record.path)
                } catch {
                    // Ignore malformed entries rather than treating them as files.
                }
            }
            readFailed = false
        } catch {
            readFailed = true
        }
    }

    function persist(path: string) {
        try {
            const storage = getStorage()
            if (!storage) throw new Error('Cleanup history unavailable')
            storage.setItem(prefix + encodeURIComponent(path), JSON.stringify(pending.get(path)))
            unsaved.delete(path)
        } catch {
            unsaved.add(path)
        }
    }

    return {
        add(path: string) {
            if (!isCleanupPath(path)) return
            if (!pending.has(path)) pending.set(path, { path, queuedAt: Date.now() })
            persist(path)
        },
        remove(path: string) {
            pending.delete(path)
            unsaved.delete(path)
            try {
                getStorage()?.removeItem(prefix + encodeURIComponent(path))
                failedRemovals.delete(path)
            } catch {
                failedRemovals.add(path)
            }
        },
        paths(): string[] {
            read()
            return Array.from(pending.keys())
        },
        retryPersistence() {
            for (const path of unsaved) persist(path)
        },
        hasPersistenceError(): boolean {
            return readFailed || unsaved.size > 0 || failedRemovals.size > 0
        },
    }
}
