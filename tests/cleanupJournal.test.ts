import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCleanupJournal, isCleanupPath } from '../src/utils/cleanupJournal'

function memoryStorage() {
    const values = new Map<string, string>()
    return {
        values,
        get length() { return values.size },
        key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
        removeItem: vi.fn((key: string) => { values.delete(key) }),
    }
}

const scope = 'https://project.example|site-images'
const recordKey = (path: string, namespace = scope) => `profileManage:cleanup:v1:${encodeURIComponent(namespace)}:${encodeURIComponent(path)}`

afterEach(() => vi.restoreAllMocks())

describe('cleanup path validation', () => {
    it('accepts only profile/feed object paths within the UTF-8 byte limit', () => {
        for (const path of ['profile/a.png', 'feed/nested/b.png', 'feed/한글 이름.png', `profile/${'a'.repeat(1016)}`]) {
            expect(isCleanupPath(path), path).toBe(true)
        }
        expect(isCleanupPath(`profile/${'a'.repeat(1017)}`)).toBe(false)
        expect(isCleanupPath(`profile/${'한'.repeat(339)}`)).toBe(false)
    })

    it('rejects unrelated prefixes, empty/traversal segments, backslashes and control characters', () => {
        for (const path of ['', 'other/a.png', '/feed/a.png', 'feed/', 'profile//a.png', 'feed/./a.png', 'feed/../a.png', 'feed/a/..', 'feed/a\\b.png', 'feed/a\nb.png', 'feed/a\0b.png', 'feed/a\u007fb.png']) {
            expect(isCleanupPath(path), JSON.stringify(path)).toBe(false)
        }
    })
})

describe('confirmed cleanup journal persistence', () => {
    it('stores one record per immutable path and keeps its original queued timestamp', () => {
        const storage = memoryStorage()
        const journal = createCleanupJournal(scope, () => storage)
        vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)

        journal.add('feed/old.png')
        journal.add('feed/old.png')

        expect(journal.paths()).toEqual(['feed/old.png'])
        expect(storage.values.size).toBe(1)
        expect(JSON.parse(storage.values.get(recordKey('feed/old.png'))!)).toEqual({ path: 'feed/old.png', queuedAt: 1000 })
        expect(journal.hasPersistenceError()).toBe(false)
    })

    it('recovers confirmed paths when a new journal instance opens the same project and bucket', () => {
        const storage = memoryStorage()
        const original = createCleanupJournal(scope, () => storage)
        original.add('profile/replaced.png')
        original.add('feed/uncommitted.png')

        const reopened = createCleanupJournal(scope, () => storage)

        expect(reopened.paths()).toEqual(['profile/replaced.png', 'feed/uncommitted.png'])
        expect(reopened.hasPersistenceError()).toBe(false)
    })

    it('isolates projects and buckets even when object paths match', () => {
        const storage = memoryStorage()
        const first = createCleanupJournal(scope, () => storage)
        const otherProject = createCleanupJournal('https://other.example|site-images', () => storage)
        const otherBucket = createCleanupJournal('https://project.example|private-images', () => storage)
        first.add('feed/shared.png')
        otherProject.add('feed/other-project.png')
        otherBucket.add('feed/other-bucket.png')
        otherProject.add('feed/shared.png')

        first.remove('feed/shared.png')

        expect(first.paths()).toEqual([])
        expect(otherProject.paths()).toEqual(['feed/other-project.png', 'feed/shared.png'])
        expect(otherBucket.paths()).toEqual(['feed/other-bucket.png'])
    })

    it('merges independent tab additions without replacing the other tab records', () => {
        const storage = memoryStorage()
        const firstTab = createCleanupJournal(scope, () => storage)
        const secondTab = createCleanupJournal(scope, () => storage)
        firstTab.add('feed/first.png')
        secondTab.add('feed/second.png')

        expect(firstTab.paths()).toEqual(['feed/first.png', 'feed/second.png'])
        expect(secondTab.paths().sort()).toEqual(['feed/first.png', 'feed/second.png'])
        firstTab.remove('feed/first.png')

        expect(createCleanupJournal(scope, () => storage).paths()).toEqual(['feed/second.png'])
    })

    it('ignores invalid input paths without writing any storage records', () => {
        const storage = memoryStorage()
        const journal = createCleanupJournal(scope, () => storage)
        journal.add('other/file.png')
        journal.add('feed/../file.png')
        journal.add(`profile/${'한'.repeat(339)}`)

        expect(journal.paths()).toEqual([])
        expect(storage.setItem).not.toHaveBeenCalled()
    })

    it('ignores malformed records, path/key mismatches and unrelated localStorage data', () => {
        const storage = memoryStorage()
        storage.values.set(recordKey('feed/bad-json.png'), '{')
        storage.values.set(recordKey('feed/null.png'), 'null')
        storage.values.set(recordKey('feed/array.png'), '[]')
        storage.values.set(recordKey('feed/missing.png'), JSON.stringify({ path: 'feed/missing.png' }))
        storage.values.set(recordKey('feed/mismatch.png'), JSON.stringify({ path: 'feed/different.png', queuedAt: 1000 }))
        storage.values.set(recordKey('other/unrelated.png'), JSON.stringify({ path: 'other/unrelated.png', queuedAt: 1000 }))
        storage.values.set('some-other-feature', JSON.stringify({ path: 'feed/foreign.png', queuedAt: 1000 }))
        storage.values.set(recordKey('feed/valid.png'), JSON.stringify({ path: 'feed/valid.png', queuedAt: 1000 }))

        const journal = createCleanupJournal(scope, () => storage)

        expect(journal.paths()).toEqual(['feed/valid.png'])
        expect(journal.hasPersistenceError()).toBe(false)
        expect(storage.removeItem).not.toHaveBeenCalled()
    })

    it('ignores unsafe, negative, fractional and nonnumeric timestamps', () => {
        const storage = memoryStorage()
        for (const [index, queuedAt] of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1000', null].entries()) {
            const path = `feed/bad-time-${index}.png`
            storage.values.set(recordKey(path), JSON.stringify({ path, queuedAt }))
        }
        storage.values.set(recordKey('feed/epoch.png'), JSON.stringify({ path: 'feed/epoch.png', queuedAt: 0 }))

        expect(createCleanupJournal(scope, () => storage).paths()).toEqual(['feed/epoch.png'])
    })

    it('retains new paths in memory when storage is absent and persists them after recovery', () => {
        const storage = memoryStorage()
        let available = false
        const journal = createCleanupJournal(scope, () => available ? storage : null)
        journal.add('feed/recover.png')

        expect(journal.paths()).toEqual(['feed/recover.png'])
        expect(journal.hasPersistenceError()).toBe(true)
        available = true
        journal.retryPersistence()

        expect(journal.paths()).toEqual(['feed/recover.png'])
        expect(journal.hasPersistenceError()).toBe(false)
        expect(createCleanupJournal(scope, () => storage).paths()).toEqual(['feed/recover.png'])
    })

    it('retains candidates when accessing localStorage throws and recovers without losing them', () => {
        const storage = memoryStorage()
        let blocked = true
        const journal = createCleanupJournal(scope, () => {
            if (blocked) throw new Error('SecurityError')
            return storage
        })
        journal.add('profile/recover.png')

        expect(journal.paths()).toEqual(['profile/recover.png'])
        expect(journal.hasPersistenceError()).toBe(true)
        blocked = false
        journal.retryPersistence()

        expect(journal.paths()).toEqual(['profile/recover.png'])
        expect(journal.hasPersistenceError()).toBe(false)
    })

    it('retries quota-failed writes and merges previously persisted paths', () => {
        const storage = memoryStorage()
        storage.values.set(recordKey('feed/already-persisted.png'), JSON.stringify({ path: 'feed/already-persisted.png', queuedAt: 1 }))
        storage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError') })
        const journal = createCleanupJournal(scope, () => storage)
        journal.add('feed/new.png')

        expect(journal.paths().sort()).toEqual(['feed/already-persisted.png', 'feed/new.png'])
        expect(journal.hasPersistenceError()).toBe(true)
        journal.retryPersistence()

        expect(journal.hasPersistenceError()).toBe(false)
        expect(createCleanupJournal(scope, () => storage).paths().sort()).toEqual(['feed/already-persisted.png', 'feed/new.png'])
    })

    it('marks storage reads as failed without discarding memory candidates and clears the error on recovery', () => {
        const storage = memoryStorage()
        const journal = createCleanupJournal(scope, () => storage)
        journal.add('feed/retained.png')
        storage.key.mockImplementationOnce(() => { throw new Error('Read failure') })

        expect(journal.paths()).toEqual(['feed/retained.png'])
        expect(journal.hasPersistenceError()).toBe(true)
        expect(journal.paths()).toEqual(['feed/retained.png'])
        expect(journal.hasPersistenceError()).toBe(false)
    })

    it('reports getItem access failures separately from malformed JSON and retries the read', () => {
        const storage = memoryStorage()
        storage.values.set(recordKey('feed/stored.png'), JSON.stringify({ path: 'feed/stored.png', queuedAt: 1 }))
        storage.getItem.mockImplementationOnce(() => { throw new Error('Read failure') })
        const journal = createCleanupJournal(scope, () => storage)

        expect(journal.paths()).toEqual([])
        expect(journal.hasPersistenceError()).toBe(true)
        expect(journal.paths()).toEqual(['feed/stored.png'])
        expect(journal.hasPersistenceError()).toBe(false)
    })

    it('retains a record after a failed persistent removal and removes it after recovery', () => {
        const storage = memoryStorage()
        const journal = createCleanupJournal(scope, () => storage)
        journal.add('feed/deleted.png')
        storage.removeItem.mockImplementationOnce(() => { throw new Error('Removal failure') })

        journal.remove('feed/deleted.png')

        expect(journal.hasPersistenceError()).toBe(true)
        expect(journal.paths()).toEqual(['feed/deleted.png'])
        expect(journal.hasPersistenceError()).toBe(true)
        journal.remove('feed/deleted.png')
        expect(journal.paths()).toEqual([])
        expect(journal.hasPersistenceError()).toBe(false)
        expect(createCleanupJournal(scope, () => storage).paths()).toEqual([])
    })

    it('cancels a memory-only candidate without re-persisting it when storage recovers', () => {
        const storage = memoryStorage()
        let available = false
        const journal = createCleanupJournal(scope, () => available ? storage : null)
        journal.add('feed/cancelled.png')
        journal.remove('feed/cancelled.png')
        available = true
        journal.retryPersistence()

        expect(journal.paths()).toEqual([])
        expect(storage.values.size).toBe(0)
    })
})
