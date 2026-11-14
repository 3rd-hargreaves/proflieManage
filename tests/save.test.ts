import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteData, SiteEditDraft } from '../src/types/site'

const api = vi.hoisted(() => ({
    rpc: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
    from: vi.fn(),
    readSite: vi.fn(),
}))

vi.mock('../src/lib/supabase', () => ({
    supabase: { rpc: api.rpc, storage: { from: api.from } },
}))

vi.mock('../src/services/site', () => ({ loadSite: api.readSite }))

type SavePayload = {
    p_expected: SiteData
    p_data: {
        profile: Omit<SiteData['profile'], 'id'>
        theme: Omit<SiteData['theme'], 'id'>
        sections: { id: number | null, title: string, content: string }[]
        keywords: { id: number | null, content: string }[]
        feed: { id: number | null, image_path: string }[]
    }
}

function fixture(): { expected: SiteData, draft: SiteEditDraft } {
    return {
        expected: {
            profile: { id: 1, name: '이름', status_message: '상태', profile_image_path: 'profile/old.png' },
            theme: { id: 1, main_color: '#123', background_color: '#fff', card_background_color: '#fff', typo_color: '#222' },
            sections: [{ id: 10, sort_order: 1, title: 'A', content: '*원문*' }, { id: 11, sort_order: 2, title: 'B', content: '두 번째' }],
            keywords: [{ id: 30, sort_order: 1, content: '키워드' }],
            feed: [{ id: 20, sort_order: 1, image_path: 'feed/first.png' }, { id: 21, sort_order: 2, image_path: 'feed/second.png' }],
        },
        draft: {
            profile: { name: '이름', statusMessage: '상태', imagePath: 'profile/old.png', file: null },
            theme: { mainColor: '#123', backgroundColor: '#fff', cardBackgroundColor: '#fff', typoColor: '#222' },
            sections: [{ id: 'section-a', databaseId: 10, title: 'A', content: '*원문*' }, { id: 'section-b', databaseId: 11, title: 'B', content: '두 번째' }],
            keywords: '키워드',
            feed: [{ id: 'feed-a', databaseId: 20, name: 'first.png', path: 'feed/first.png' }, { id: 'feed-b', databaseId: 21, name: 'second.png', path: 'feed/second.png' }],
        },
    }
}

function png(name = '새 이미지.png'): File {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')
    return new File([bytes], name, { type: 'image/png' })
}

function memoryStorage() {
    const values = new Map<string, string>()
    return {
        values,
        get length() { return values.size },
        key: (index: number) => Array.from(values.keys())[index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
        removeItem: vi.fn((key: string) => { values.delete(key) }),
    }
}

function unreferencedSite(): SiteData {
    const { expected } = fixture()
    return { ...expected, profile: { ...expected.profile, profile_image_path: null }, feed: [] }
}

function feedFixture(count: number): ReturnType<typeof fixture> {
    const state = fixture()
    state.expected.feed = Array.from({ length: count }, (_, index) => ({
        id: 20 + index,
        sort_order: index + 1,
        image_path: `feed/existing-${index + 1}.png`,
    }))
    state.draft.feed = state.expected.feed.map(row => ({
        id: `feed-${row.id}`,
        databaseId: row.id,
        name: row.image_path.split('/').at(-1)!,
        path: row.image_path,
    }))
    return state
}

// The server result is a test fixture. SQL atomicity/idempotency is covered by
// supabase/save.test.sql; these tests verify the client sends/reuses the request.
function serverResult(payload: SavePayload): SiteData {
    const data = payload.p_data
    let nextId = 100
    return {
        profile: { id: 1, ...data.profile },
        theme: { id: 1, ...data.theme },
        sections: data.sections.map((row, index) => ({ ...row, id: row.id ?? nextId++, sort_order: index + 1 })),
        keywords: data.keywords.map((row, index) => ({ ...row, id: row.id ?? nextId++, sort_order: index + 1 })),
        feed: data.feed.map((row, index) => ({ ...row, id: row.id ?? nextId++, sort_order: index + 1 })),
    }
}

beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(api)) mock.mockReset()
    vi.stubEnv('VITE_SUPABASE_STORAGE_BUCKET', 'site-images')
    vi.stubEnv('VITE_SUPABASE_URL', 'https://cleanup-test.example')
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    api.from.mockReturnValue({ upload: api.upload, remove: api.remove })
    api.upload.mockResolvedValue({ data: {}, error: null })
    api.remove.mockResolvedValue({ data: [], error: null })
    api.rpc.mockImplementation(async (_name: string, payload: SavePayload) => ({ data: serverResult(payload), error: null }))
    api.readSite.mockResolvedValue(unreferencedSite())
})
afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

describe('site save transaction boundary', () => {
    it('uploads new images before RPC and deletes only replaced paths after success', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        const events: string[] = []
        draft.profile.file = png('프로필.png')
        const feedFile = png('새 피드.png')
        draft.feed = [draft.feed[1], { id: 'new-feed', name: feedFile.name, file: feedFile }]
        api.upload.mockImplementation(async (path: string) => { events.push(`upload:${path}`); return { error: null } })
        api.rpc.mockImplementation(async (_name: string, payload: SavePayload) => {
            events.push('rpc')
            return { data: serverResult(payload), error: null }
        })
        api.remove.mockImplementation(async () => { events.push('delete'); return { error: null } })

        const result = await saveSite(draft, expected)

        expect(events.map(event => event.split(':')[0])).toEqual(['upload', 'upload', 'rpc', 'delete'])
        expect(api.rpc).toHaveBeenCalledWith('save_site', expect.objectContaining({ p_expected: expected }))
        expect(api.remove).toHaveBeenCalledTimes(1)
        expect(api.remove).toHaveBeenCalledWith(['feed/first.png', 'profile/old.png'])
        expect(result.site.feed[0]).toMatchObject({ id: 21, image_path: 'feed/second.png' })
        expect(result.site.feed[1].image_path).toBe(api.upload.mock.calls[1][0])
        expect(result.cleanupWarning).toBeNull()
    })

    it('saves text and reordered IDs without uploading or deleting unchanged images', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.name = '수정 이름'
        draft.sections.reverse()
        draft.feed.reverse()
        const originalDraft = structuredClone(draft)
        const originalExpected = structuredClone(expected)

        await saveSite(draft, expected)

        const payload = api.rpc.mock.calls[0][1] as SavePayload
        expect(payload.p_data.sections.map(row => row.id)).toEqual([11, 10])
        expect(payload.p_data.feed.map(row => row.id)).toEqual([21, 20])
        expect(api.upload).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        expect(draft).toEqual(originalDraft)
        expect(expected).toEqual(originalExpected)
    })

    it('keeps section markup, indentation and line endings in the RPC source', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        const content = '  *원문*\r\n| 가 | 나 |\r\n\n'
        draft.sections[0].content = content
        await saveSite(draft, expected)
        expect(api.rpc.mock.calls[0][1].p_data.sections[0].content).toBe(content)
    })

    it('recovers a lost committed response using the same image paths and server IDs', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        let committed: SiteData
        let sent: SavePayload
        api.rpc.mockImplementationOnce(async (_name: string, payload: SavePayload) => {
            sent = structuredClone(payload)
            committed = serverResult(payload)
            throw new TypeError('Response connection lost after commit')
        }).mockImplementationOnce(async (_name: string, payload: SavePayload) => {
            expect(payload).toEqual(sent)
            return { data: committed, error: null }
        })

        await expect(saveSite(draft, expected)).rejects.toThrow('저장 결과를 확인하지 못했습니다')
        expect(api.remove).not.toHaveBeenCalled()
        const recovered = await saveSite(draft, expected)

        expect(api.upload).toHaveBeenCalledTimes(1)
        expect(recovered.site).toEqual(committed!)
        expect(api.remove).toHaveBeenCalledTimes(1)
        expect(api.remove).toHaveBeenCalledWith(['profile/old.png'])
    })

    it('preserves draft, Files and existing paths when the server rejects a stale snapshot', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        const file = png()
        draft.profile.file = file
        draft.feed.reverse()
        const expectedCopy = structuredClone(expected)
        api.rpc.mockResolvedValue({ data: null, error: { message: 'site_conflict', code: 'P0001' } })

        await expect(saveSite(draft, expected)).rejects.toThrow('다른 창')

        expect(draft.profile.file).toBe(file)
        expect(draft.feed.map(row => row.databaseId)).toEqual([21, 20])
        expect(expected).toEqual(expectedCopy)
        expect(api.remove).not.toHaveBeenCalled()
    })

    it('cleans only uncommitted partial uploads and reuploads Files whose paths were deleted', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png('프로필.png')
        draft.feed.push({ id: 'new', name: '추가.png', file: png('추가.png') })
        api.upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'upload failure' } })

        await expect(saveSite(draft, expected)).rejects.toThrow('업로드 실패')
        const firstProfilePath = api.upload.mock.calls[0][0]
        const failedFeedPath = api.upload.mock.calls[1][0]
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.remove).toHaveBeenCalledTimes(1)
        expect(api.remove).toHaveBeenCalledWith([failedFeedPath, firstProfilePath])

        await saveSite(draft, expected)

        expect(api.upload).toHaveBeenCalledTimes(4)
        expect(api.upload.mock.calls[2][0]).not.toBe(firstProfilePath)
        expect(api.rpc.mock.calls[0][1].p_data.profile.profile_image_path).toBe(api.upload.mock.calls[2][0])
    })

    it('does not clean cached uploads from an earlier ambiguous save after a later partial failure', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png('보존.png')
        api.rpc.mockRejectedValueOnce(new TypeError('Unknown commit result'))
        await expect(saveSite(draft, expected)).rejects.toThrow('저장 결과')
        const ambiguousPath = api.upload.mock.calls[0][0]
        draft.feed.push({ id: 'next', name: '다음.png', file: png('다음.png') })
        api.upload.mockResolvedValueOnce({ error: { message: 'second upload failed' } })

        await expect(saveSite(draft, expected)).rejects.toThrow('업로드 실패')

        expect(api.rpc).toHaveBeenCalledTimes(1)
        expect(api.remove.mock.calls.flatMap(call => call[0])).not.toContain(ambiguousPath)
        expect(api.upload).toHaveBeenCalledTimes(2)
    })

    it.each(['returned', 'thrown'])('reports committed DB success separately from a %s cleanup failure and retries the queue', async failure => {
        const { saveSite, retryImageCleanup, getPendingImageCleanupCount } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        if (failure === 'returned') api.remove.mockResolvedValueOnce({ error: { message: 'delete unavailable' } })
        else api.remove.mockRejectedValueOnce(new TypeError('Connection lost while deleting'))

        const result = await saveSite(draft, expected)

        expect(result.site.profile.profile_image_path).toBe(api.upload.mock.calls[0][0])
        expect(result.cleanupWarning).toContain('내용은 저장됐지만')
        expect(getPendingImageCleanupCount()).toBe(1)
        expect(await retryImageCleanup()).toBe(true)
        expect(getPendingImageCleanupCount()).toBe(0)
        expect(api.remove.mock.calls.map(call => call[0])).toEqual([['profile/old.png'], ['profile/old.png']])
        expect(api.rpc).toHaveBeenCalledTimes(1)
    })

    it('treats a malformed RPC success response as ambiguous and retains new images for retry', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        api.rpc.mockResolvedValueOnce({ data: { profile: null }, error: null })

        await expect(saveSite(draft, expected)).rejects.toThrow('저장 결과')
        expect(api.remove).not.toHaveBeenCalled()
        await saveSite(draft, expected)
        expect(api.upload).toHaveBeenCalledTimes(1)
    })

    it('rejects an unsupported File before any upload or RPC', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = new File(['not an image'], 'document.pdf', { type: 'application/pdf' })

        await expect(saveSite(draft, expected)).rejects.toThrow('지원하지 않는 형식')
        expect(api.upload).not.toHaveBeenCalled()
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
    })

    it('checks every selected File before uploading an otherwise valid profile image', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        draft.feed.push({
            id: 'invalid', name: 'document.pdf',
            file: new File(['not an image'], 'document.pdf', { type: 'application/pdf' }),
        })

        await expect(saveSite(draft, expected)).rejects.toThrow('지원하지 않는 형식')
        expect(api.upload).not.toHaveBeenCalled()
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
    })
})

describe('image upload limits at the save boundary', () => {
    it('rejects 51 feed images before any storage request or RPC', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft } = feedFixture(51)
        const { expected } = fixture()
        draft.profile.file = png()

        await expect(saveSite(draft, expected)).rejects.toThrow('피드 이미지 수량 제한(50)')

        expect(api.from).not.toHaveBeenCalled()
        expect(api.upload).not.toHaveBeenCalled()
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
    })

    it.each([
        { reason: 'oversized', makeFile: () => new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }), message: '용량 제한 초과' },
        { reason: 'empty', makeFile: () => new File([], 'empty.png', { type: 'image/png' }), message: '비어 있는 파일' },
        { reason: 'unsupported MIME', makeFile: () => new File(['document'], 'disguised.png', { type: 'application/pdf' }), message: '지원하지 않는 형식' },
    ])('checks a later $reason feed File before uploading any earlier valid File', async ({ makeFile, message }) => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        const profileFile = png('valid-profile.png')
        const firstFeedFile = png('valid-feed.png')
        const rejectedFile = makeFile()
        draft.profile.file = profileFile
        draft.feed.push(
            { id: 'valid-new', name: firstFeedFile.name, file: firstFeedFile },
            { id: 'invalid-new', name: rejectedFile.name, file: rejectedFile },
        )

        await expect(saveSite(draft, expected)).rejects.toThrow(message)

        expect(api.from).not.toHaveBeenCalled()
        expect(api.upload).not.toHaveBeenCalled()
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        expect(draft.profile.file).toBe(profileFile)
        expect(draft.feed.at(-1)?.file).toBe(rejectedFile)
    })

    it.each(['reorder', 'replace', 'reduce'])('allows an existing 51-image feed to %s without growing', async action => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = feedFixture(51)
        if (action === 'reorder') draft.feed.reverse()
        if (action === 'replace') draft.feed[0] = { ...draft.feed[0], name: 'replacement.png', file: png('replacement.png') }
        if (action === 'reduce') draft.feed.pop()

        const result = await saveSite(draft, expected)

        expect(api.rpc).toHaveBeenCalledTimes(1)
        expect(result.site.feed).toHaveLength(action === 'reduce' ? 50 : 51)
        expect(api.upload).toHaveBeenCalledTimes(action === 'replace' ? 1 : 0)
        if (action === 'reorder') {
            expect(result.site.feed.map(row => row.id)).toEqual(expected.feed.map(row => row.id).reverse())
            expect(api.remove).not.toHaveBeenCalled()
        } else {
            const removedPath = action === 'replace' ? expected.feed[0].image_path : expected.feed[50].image_path
            expect(api.remove).toHaveBeenCalledWith([removedPath])
            if (action === 'replace') {
                expect(result.site.feed[0]).toMatchObject({ id: expected.feed[0].id, image_path: api.upload.mock.calls[0][0] })
            }
        }
    })

    it('rejects growth from an existing 51-image feed to 52 before any network request', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = feedFixture(51)
        draft.profile.file = png()
        draft.feed.push({ id: 'extra', name: 'extra.png', file: png('extra.png') })

        await expect(saveSite(draft, expected)).rejects.toThrow('피드 이미지 수량 제한(51)')

        expect(api.from).not.toHaveBeenCalled()
        expect(api.upload).not.toHaveBeenCalled()
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
    })

    it('passes original profile and feed Files to the SDK and fills a missing MIME type', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        const profileFile = png('original-profile.png')
        const feedFile = new File([png()], 'original-feed.PNG', { lastModified: 123456789 })
        draft.profile.file = profileFile
        draft.feed.push({ id: 'new', name: feedFile.name, file: feedFile })

        await saveSite(draft, expected)

        expect(api.upload).toHaveBeenCalledTimes(2)
        expect(api.upload.mock.calls[0][1]).toBe(profileFile)
        expect(api.upload.mock.calls[1][1]).toBe(feedFile)
        expect(api.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/png', upsert: false })
        expect(api.upload.mock.calls[1][2]).toMatchObject({ contentType: 'image/png', upsert: false })
        expect(feedFile.type).toBe('')
        expect(feedFile.lastModified).toBe(123456789)
    })

    it('explains the server feed limit in Korean without deleting existing images', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        api.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'site_feed_limit_exceeded' } })

        await expect(saveSite(draft, expected)).rejects.toThrow('피드 이미지 등록 한도를 초과했습니다. 최신 목록을 확인하고 사진 수를 줄여 다시 저장해 주세요.')

        expect(api.rpc).toHaveBeenCalledTimes(1)
        expect(api.upload).toHaveBeenCalledTimes(1)
        expect(api.remove).not.toHaveBeenCalled()
        expect(draft.profile.imagePath).toBe(expected.profile.profile_image_path)
    })
})

describe('storage cleanup lifecycle', () => {
    it('batches deletion and retains only failed paths for the next retry', async () => {
        const { queueImageCleanup, retryImageCleanup, getPendingImageCleanupCount } = await import('../src/services/storage')
        const paths = Array.from({ length: 205 }, (_, index) => `feed/old-${index}.png`)
        queueImageCleanup(paths)
        api.remove.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'retry this batch' } }).mockResolvedValueOnce({ error: null })

        expect(await retryImageCleanup()).toBe(false)
        expect(api.remove.mock.calls.map(call => call[0].length)).toEqual([100, 100, 5])
        expect(getPendingImageCleanupCount()).toBe(100)
        expect(await retryImageCleanup()).toBe(true)
        expect(api.remove.mock.calls[3][0]).toEqual(paths.slice(100, 200))
    })

    it('deduplicates concurrent cleanup retries instead of deleting a batch twice', async () => {
        const { queueImageCleanup, retryImageCleanup } = await import('../src/services/storage')
        queueImageCleanup(['feed/one.png'])
        let finish!: (value: { error: null }) => void
        api.remove.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))

        const first = retryImageCleanup()
        const second = retryImageCleanup()
        expect(api.readSite).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1))
        expect(api.remove).toHaveBeenCalledTimes(1)
        finish({ error: null })
        expect(await Promise.all([first, second])).toEqual([true, true])
    })
})

describe('recovered cleanup reference protection', () => {
    it('recovers confirmed candidates after a module reload and waits for explicit cleanup', async () => {
        const original = await import('../src/services/storage')
        original.queueImageCleanup(['profile/replaced.png', 'feed/never-committed.png'])
        expect(original.getPendingImageCleanupCount()).toBe(2)

        vi.resetModules()
        const reopened = await import('../src/services/storage')

        expect(reopened.getPendingImageCleanupCount()).toBe(2)
        expect(api.readSite).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        expect(await reopened.retryImageCleanup()).toBe(true)
        expect(api.readSite).toHaveBeenCalledTimes(1)
        expect(api.remove).toHaveBeenCalledWith(['profile/replaced.png', 'feed/never-committed.png'])
        expect(reopened.getPendingImageCleanupCount()).toBe(0)
        expect(window.localStorage.length).toBe(0)
    })

    it('cancels current profile/feed references and deletes only unreferenced candidates', async () => {
        const storage = await import('../src/services/storage')
        const { expected } = fixture()
        api.readSite.mockResolvedValueOnce(expected)
        storage.queueImageCleanup(['profile/old.png', 'feed/first.png', 'feed/unreferenced.png'])

        expect(await storage.retryImageCleanup()).toBe(true)

        expect(api.readSite).toHaveBeenCalledTimes(1)
        expect(api.readSite.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
        expect(api.remove).toHaveBeenCalledTimes(1)
        expect(api.remove).toHaveBeenCalledWith(['feed/unreferenced.png'])
        expect(api.rpc).not.toHaveBeenCalled()
        expect(api.upload).not.toHaveBeenCalled()
        expect(storage.getPendingImageCleanupCount()).toBe(0)
        vi.resetModules()
        expect((await import('../src/services/storage')).getPendingImageCleanupCount()).toBe(0)
    })

    it('makes no storage request when every recovered candidate is currently referenced', async () => {
        const storage = await import('../src/services/storage')
        const { expected } = fixture()
        api.readSite.mockResolvedValueOnce(expected)
        storage.queueImageCleanup(['profile/old.png', 'feed/first.png', 'feed/second.png'])

        expect(await storage.retryImageCleanup()).toBe(true)

        expect(api.readSite).toHaveBeenCalledTimes(1)
        expect(api.from).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        expect(storage.getPendingImageCleanupCount()).toBe(0)
    })

    it('keeps the queue without deleting when the reference lookup fails and retries after recovery', async () => {
        const storage = await import('../src/services/storage')
        storage.queueImageCleanup(['feed/awaiting-check.png'])
        api.readSite.mockRejectedValueOnce(new Error('Database unavailable'))

        expect(await storage.retryImageCleanup()).toBe(false)

        expect(api.readSite).toHaveBeenCalledTimes(1)
        expect(api.from).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        expect(storage.getPendingImageCleanupCount()).toBe(1)
        vi.resetModules()
        const reopened = await import('../src/services/storage')
        expect(reopened.getPendingImageCleanupCount()).toBe(1)
        expect(await reopened.retryImageCleanup()).toBe(true)
        expect(api.readSite).toHaveBeenCalledTimes(2)
        expect(api.remove).toHaveBeenCalledTimes(1)
        expect(api.remove).toHaveBeenCalledWith(['feed/awaiting-check.png'])
        expect(reopened.getPendingImageCleanupCount()).toBe(0)
    })

    it('waits for reference verification before deletion and shares one lookup between concurrent retries', async () => {
        const storage = await import('../src/services/storage')
        storage.queueImageCleanup(['feed/verified-first.png'])
        let completeLookup!: (site: SiteData) => void
        api.readSite.mockImplementationOnce(() => new Promise(resolve => { completeLookup = resolve }))

        const first = storage.retryImageCleanup()
        const second = storage.retryImageCleanup()

        expect(api.readSite).toHaveBeenCalledTimes(1)
        expect(api.from).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        completeLookup(unreferencedSite())
        expect(await Promise.all([first, second])).toEqual([true, true])
        expect(api.remove).toHaveBeenCalledTimes(1)
    })

    it('does not persist ambiguous RPC uploads as safe cleanup candidates', async () => {
        const { saveSite, getPendingImageCleanupCount } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        api.rpc.mockRejectedValueOnce(new TypeError('Response lost after a possible commit'))

        await expect(saveSite(draft, expected)).rejects.toThrow('저장 결과를 확인하지 못했습니다')

        expect(api.rpc).toHaveBeenCalledTimes(1)
        expect(api.upload).toHaveBeenCalledTimes(1)
        expect(api.readSite).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
        expect(getPendingImageCleanupCount()).toBe(0)
        expect(window.localStorage.length).toBe(0)
        vi.resetModules()
        const reopened = await import('../src/services/storage')
        expect(reopened.getPendingImageCleanupCount()).toBe(0)
        expect(await reopened.retryImageCleanup()).toBe(true)
        expect(api.readSite).not.toHaveBeenCalled()
        expect(api.remove).not.toHaveBeenCalled()
    })

    it('persists only replaced paths after committed DB success when deletion fails', async () => {
        const { saveSite } = await import('../src/services/save')
        const { draft, expected } = fixture()
        draft.profile.file = png()
        api.remove.mockResolvedValueOnce({ error: { message: 'Temporary delete failure' } })

        const result = await saveSite(draft, expected)

        expect(result.cleanupWarning).toContain('내용은 저장됐지만')
        expect(api.rpc).toHaveBeenCalledTimes(1)
        const storedPaths = Array.from({ length: window.localStorage.length }, (_, index) => {
            return JSON.parse(window.localStorage.getItem(window.localStorage.key(index)!)!).path
        })
        expect(storedPaths).toEqual(['profile/old.png'])
        expect(storedPaths).not.toContain(result.site.profile.profile_image_path)
        vi.resetModules()
        const reopened = await import('../src/services/storage')
        expect(reopened.getPendingImageCleanupCount()).toBe(1)
        expect(await reopened.retryImageCleanup()).toBe(true)
        expect(api.rpc).toHaveBeenCalledTimes(1)
        expect(api.remove.mock.calls.map(call => call[0])).toEqual([['profile/old.png'], ['profile/old.png']])
    })

    it('shows memory-only cleanup guidance after persistence failure and clears it after recovery', async () => {
        const localStorage = memoryStorage()
        localStorage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError') })
        vi.stubGlobal('window', { localStorage })
        const storage = await import('../src/services/storage')
        storage.queueImageCleanup(['feed/memory-only.png'])

        expect(storage.getPendingImageCleanupCount()).toBe(1)
        expect(storage.imageCleanupWarning()).toContain('정리 기록 보관 실패')
        expect(await storage.retryImageCleanup()).toBe(true)
        expect(api.remove).toHaveBeenCalledWith(['feed/memory-only.png'])
        expect(storage.imageCleanupWarning()).toBeNull()
    })
})
