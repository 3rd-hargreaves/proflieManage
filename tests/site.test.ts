import { beforeEach, expect, it, vi } from 'vitest'
import type { SiteData } from '../src/types/site'

const api = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: api.rpc } }))
import { loadSite } from '../src/services/site'

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

it('loads a complete site through exactly one RPC with the caller cancellation signal', async () => {
    const signal = new AbortController().signal
    const site = fixture()
    api.abortSignal.mockResolvedValue({ data: site, error: null })

    expect(await loadSite(signal)).toBe(site)
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('load_site')
    expect(api.abortSignal).toHaveBeenCalledExactlyOnceWith(signal)
})

it('preserves server order, IDs, raw section markup, and all rows beyond the former page size', async () => {
    const site = fixture()
    site.sections = Array.from({ length: 1503 }, (_, index) => ({
        id: 2000 - index, sort_order: index + 1, title: `제목 ${index}`, content: '  *원문*\r\n| 표 | ',
    }))
    api.abortSignal.mockResolvedValue({ data: site, error: null })

    const result = await loadSite(new AbortController().signal)

    expect(result).toEqual(site)
    expect(result.sections).toHaveLength(1503)
    expect(api.rpc).toHaveBeenCalledTimes(1)
})

it('accepts empty lists and an absent profile image', async () => {
    const site = { ...fixture(), sections: [], keywords: [], feed: [] }
    api.abortSignal.mockResolvedValue({ data: site, error: null })
    expect(await loadSite(new AbortController().signal)).toEqual(site)
})

it.each([
    null,
    { ...fixture(), profile: null },
    { ...fixture(), theme: null },
    { ...fixture(), sections: [{ id: 1, title: '순서 없음', content: '내용' }] },
    { ...fixture(), feed: [{ id: 1, sort_order: 1, image_path: null }] },
])('rejects an incomplete RPC snapshot instead of exposing partial content: %j', async data => {
    api.abortSignal.mockResolvedValue({ data, error: null })
    await expect(loadSite(new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
    expect(api.rpc).toHaveBeenCalledTimes(1)
})

it('reports a database error without returning its partial data', async () => {
    const error = { code: 'PGRST202', message: 'Function unavailable' }
    api.abortSignal.mockResolvedValue({ data: fixture(), error })
    await expect(loadSite(new AbortController().signal)).rejects.toMatchObject({ cause: error })
})

it('reports a rejected network request as a load failure', async () => {
    api.abortSignal.mockRejectedValue(new TypeError('Network unavailable'))
    await expect(loadSite(new AbortController().signal)).rejects.toThrow('사이트 정보를 불러오지 못했습니다')
})

it('does not send a request after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadSite(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.rpc).not.toHaveBeenCalled()
})

it('discards a successful response that arrives after cancellation', async () => {
    const controller = new AbortController()
    let respond!: (value: unknown) => void
    api.abortSignal.mockReturnValue(new Promise(resolve => { respond = resolve }))
    const request = loadSite(controller.signal)
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
    await expect(loadSite(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
