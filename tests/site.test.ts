import { beforeEach, expect, it, vi } from 'vitest'
import type { MainData, SiteData } from '../src/types/site'

const api = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: api.rpc } }))
import { loadCharacter, loadMain } from '../src/services/site'

function fixture(): SiteData {
    return {
        profile: { id: 1, name: '이름', status_message: '상태', profile_image_path: null },
        theme: { id: 1, main_color: '#123', background_color: '#fff', card_background_color: '#fff', typo_color: '#222' },
        sections: [{ id: 12, sort_order: 1, title: '섹션', content: ' *원문*\n| 표 | ' }],
        keywords: [{ id: 23, sort_order: 1, content: '키워드' }],
        feed: [{ id: 34, sort_order: 1, image_path: 'feed/photo.png' }],
    }
}

beforeEach(() => {
    api.rpc.mockReset().mockReturnValue({ abortSignal: api.abortSignal })
    api.abortSignal.mockReset().mockResolvedValue({ data: fixture(), error: null })
})

it('loads a complete character through exactly one RPC with the caller cancellation signal', async () => {
    const signal = new AbortController().signal
    const site = fixture()
    api.abortSignal.mockResolvedValue({ data: site, error: null })

    expect(await loadCharacter(1, signal)).toBe(site)
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_character', { p_character_id: 1 })
    expect(api.abortSignal).toHaveBeenCalledExactlyOnceWith(signal)
})

it('preserves server order, IDs, raw section markup, and all rows beyond the former page size', async () => {
    const site = fixture()
    site.sections = Array.from({ length: 1503 }, (_, index) => ({
        id: 2000 - index, sort_order: index + 1, title: `제목 ${index}`, content: '  *원문*\r\n| 표 | ',
    }))
    api.abortSignal.mockResolvedValue({ data: site, error: null })

    const result = await loadCharacter(1, new AbortController().signal)

    expect(result).toEqual(site)
    expect(result?.sections).toHaveLength(1503)
    expect(api.rpc).toHaveBeenCalledTimes(1)
})

it('accepts empty lists and an absent profile image', async () => {
    const site = { ...fixture(), sections: [], keywords: [], feed: [] }
    api.abortSignal.mockResolvedValue({ data: site, error: null })
    expect(await loadCharacter(1, new AbortController().signal)).toEqual(site)
})

it.each([
    { ...fixture(), profile: null },
    { ...fixture(), theme: null },
    { ...fixture(), sections: [{ id: 1, title: '순서 없음', content: '내용' }] },
    { ...fixture(), feed: [{ id: 1, sort_order: 1, image_path: null }] },
])('rejects an incomplete RPC snapshot instead of exposing partial content: %j', async data => {
    api.abortSignal.mockResolvedValue({ data, error: null })
    await expect(loadCharacter(1, new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
    expect(api.rpc).toHaveBeenCalledTimes(1)
})

it('reports a database error without returning its partial data', async () => {
    const error = { code: 'PGRST202', message: 'Function unavailable' }
    api.abortSignal.mockResolvedValue({ data: fixture(), error })
    await expect(loadCharacter(1, new AbortController().signal)).rejects.toMatchObject({ cause: error })
})

it('reports a rejected network request as a load failure', async () => {
    api.abortSignal.mockRejectedValue(new TypeError('Network unavailable'))
    await expect(loadCharacter(1, new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
})

it('does not send a request after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadCharacter(1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.rpc).not.toHaveBeenCalled()
})

it('discards a successful response that arrives after cancellation', async () => {
    const controller = new AbortController()
    let respond!: (value: unknown) => void
    api.abortSignal.mockReturnValue(new Promise(resolve => { respond = resolve }))
    const request = loadCharacter(1, controller.signal)
    controller.abort()
    respond({ data: fixture(), error: null })
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
})

it('preserves cancellation when the SDK resolves with an abort error', async () => {
    const controller = new AbortController()
    api.abortSignal.mockImplementation(() => {
        controller.abort()
        return Promise.resolve({ data: null, error: { message: 'Aborted' } })
    })
    await expect(loadCharacter(1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

function characterFixture(id = 2): SiteData {
    const site = fixture()
    return { ...site, profile: { ...site.profile, id, name: `캐릭터 ${id}` }, theme: { ...site.theme, id } }
}

function mainFixture(): MainData {
    return {
        characters: [
            { ...characterFixture(2).profile, sort_order: 3 },
            { ...characterFixture(1).profile, sort_order: 9 },
        ],
        theme: { ...fixture().theme, main_color: '#abcdef' },
    }
}

it('loads the full ordered collection and independent main theme through load_main only', async () => {
    const data = mainFixture()
    api.abortSignal.mockResolvedValue({ data, error: null })
    const signal = new AbortController().signal
    expect(await loadMain(signal)).toBe(data)
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_main')
    expect(api.abortSignal).toHaveBeenCalledExactlyOnceWith(signal)
    expect(data.characters.map(character => character.id)).toEqual([2, 1])
})

it('accepts an empty collection while retaining its main theme', async () => {
    const data = { ...mainFixture(), characters: [] }
    api.abortSignal.mockResolvedValue({ data, error: null })
    expect(await loadMain(new AbortController().signal)).toEqual(data)
})

it.each([
    null,
    { ...mainFixture(), theme: { ...fixture().theme, id: 2 } },
    { ...mainFixture(), theme: { ...fixture().theme, main_color: 'red' } },
    { ...mainFixture(), characters: [{ ...characterFixture(1).profile, sort_order: 1 }, { ...characterFixture(1).profile, sort_order: 2 }] },
    { ...mainFixture(), characters: [{ ...characterFixture(1).profile, sort_order: 2 }, { ...characterFixture(2).profile, sort_order: 1 }] },
    { ...mainFixture(), characters: [{ ...characterFixture(1).profile, sort_order: 1 }, { ...characterFixture(2).profile, sort_order: 1 }] },
    { ...mainFixture(), characters: [{ ...characterFixture(1).profile, id: Number.MAX_SAFE_INTEGER + 1, sort_order: 1 }] },
    { ...mainFixture(), characters: [{ ...characterFixture(1).profile, status_message: null, sort_order: 1 }] },
])('rejects malformed collection snapshots without legacy fallback: %j', async data => {
    api.abortSignal.mockResolvedValue({ data, error: null })
    await expect(loadMain(new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_main')
})

it('loads the requested character with its own theme and untouched raw contents', async () => {
    const data = characterFixture(2)
    api.abortSignal.mockResolvedValue({ data, error: null })
    const signal = new AbortController().signal
    expect(await loadCharacter(2, signal)).toBe(data)
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_character', { p_character_id: 2 })
    expect(api.abortSignal).toHaveBeenCalledExactlyOnceWith(signal)
    expect(data.sections[0].content).toBe(' *원문*\n| 표 | ')
})

it('returns null for an absent character instead of substituting the first profile', async () => {
    api.abortSignal.mockResolvedValue({ data: null, error: null })
    expect(await loadCharacter(2, new AbortController().signal)).toBeNull()
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_character', { p_character_id: 2 })
})

it.each([
    fixture(),
    { ...characterFixture(2), theme: fixture().theme },
    { ...characterFixture(2), sections: [{ id: 10, sort_order: 1, title: 'A', content: '원문' }, { id: 10, sort_order: 2, title: 'B', content: '다른 원문' }] },
    { ...characterFixture(2), feed: [{ id: 1, sort_order: 1.5, image_path: 'feed/a.png' }] },
    { ...characterFixture(2), profile: { ...characterFixture(2).profile, profile_image_path: 'feed/foreign.png' } },
])('rejects a mismatched or malformed target snapshot: %j', async data => {
    api.abortSignal.mockResolvedValue({ data, error: null })
    await expect(loadCharacter(2, new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_character', { p_character_id: 2 })
})

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('does not request an unsafe character ID: %s', async id => {
    await expect(loadCharacter(id, new AbortController().signal)).rejects.toThrow('캐릭터 주소')
    expect(api.rpc).not.toHaveBeenCalled()
})

const readers = [
    { name: 'main', read: (signal: AbortSignal) => loadMain(signal), data: mainFixture() },
    { name: 'character', read: (signal: AbortSignal) => loadCharacter(2, signal), data: characterFixture(2) },
]
for (const { name, read, data } of readers) {
    it(`${name} does not fall back when the new RPC is not installed`, async () => {
        const error = { code: 'PGRST202', message: 'Function unavailable' }
        api.abortSignal.mockResolvedValue({ data, error })
        await expect(read(new AbortController().signal)).rejects.toMatchObject({ cause: error })
        expect(api.rpc).toHaveBeenCalledTimes(1)
        expect(api.rpc).not.toHaveBeenCalledWith('load_site')
    })

    it(`${name} reports network rejection and preserves an explicit cancellation`, async () => {
        api.abortSignal.mockRejectedValue(new TypeError('Offline'))
        await expect(read(new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
        const controller = new AbortController()
        controller.abort()
        api.rpc.mockClear()
        await expect(read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(api.rpc).not.toHaveBeenCalled()
    })

    it(`${name} ignores a response received after its route request was cancelled`, async () => {
        const controller = new AbortController()
        let respond!: (value: unknown) => void
        api.abortSignal.mockReturnValue(new Promise(resolve => { respond = resolve }))
        const request = read(controller.signal)
        controller.abort()
        respond({ data, error: null })
        await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    })
}
