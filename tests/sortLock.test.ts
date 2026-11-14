import assert from 'node:assert/strict'
import test from 'node:test'
import { createSortLock } from '../src/utils/sortLock.ts'

test('only one list can acquire the lock before a render occurs', () => {
    const lock = createSortLock()
    assert.equal(lock.tryStart('sections'), true)
    assert.equal(lock.tryStart('feed'), false)
    assert.equal(lock.tryStart('sections'), false)
    assert.equal(lock.getOwner(), 'sections')
})

test('another list cannot release the active list', () => {
    const lock = createSortLock()
    lock.tryStart('sections')
    assert.equal(lock.end('feed'), false)
    assert.equal(lock.getOwner(), 'sections')
    assert.equal(lock.end('sections'), true)
    assert.equal(lock.getOwner(), null)
    assert.equal(lock.tryStart('feed'), true)
})

test('a stale end from the previous owner does not clear the next drag', () => {
    const lock = createSortLock()
    lock.tryStart('sections')
    lock.end('sections')
    lock.tryStart('feed')
    assert.equal(lock.end('sections'), false)
    assert.equal(lock.getOwner(), 'feed')
})

test('subscribers only observe real ownership changes and can unsubscribe', () => {
    const lock = createSortLock()
    const changes: (string | null)[] = []
    const unsubscribe = lock.subscribe(() => changes.push(lock.getOwner()))
    assert.equal(lock.tryStart(''), false)
    lock.tryStart('sections')
    lock.tryStart('feed')
    lock.end('feed')
    lock.end('sections')
    unsubscribe()
    lock.tryStart('feed')
    assert.deepEqual(changes, ['sections', null])
})
