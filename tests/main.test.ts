import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteTheme, ThemeColors } from '../src/types/site'

const api = vi.hoisted(() => ({ rpc: vi.fn(), available: true }))
vi.mock('../src/lib/supabase', () => ({ get supabase() { return api.available ? { rpc: api.rpc } : null } }))
import { saveCharacterOrder, saveMainTheme } from '../src/services/main'

function themeFixture(): SiteTheme {
    return { id: 1, main_color: '#123456', background_color: '#fafafa', card_background_color: '#ffffff', typo_color: '#222222' }
}

function draftFixture(): ThemeColors {
    return { mainColor: '#abcdef', backgroundColor: '#123', cardBackgroundColor: '#ffcc00', typoColor: '#000000' }
}

function themePayload(): Omit<SiteTheme, 'id'> {
    return { main_color: '#abcdef', background_color: '#123', card_background_color: '#ffcc00', typo_color: '#000000' }
}

beforeEach(() => {
    api.available = true
    api.rpc.mockReset()
})

describe('character order writes', () => {
    it('saves only the ID order with an independent membership baseline', async () => {
        api.rpc.mockResolvedValue({ data: [3, 1, 2], error: null })
        const order = [3, 1, 2]
        const expected = [1, 2, 3]
        const result = await saveCharacterOrder(order, expected)
        expect(result).toEqual(order)
        expect(result).not.toBe(order)
        expect(api.rpc).toHaveBeenCalledExactlyOnceWith('save_character_order', { p_expected: [1, 2, 3], p_order: [3, 1, 2] })
        expect(order).toEqual([3, 1, 2])
        expect(expected).toEqual([1, 2, 3])
    })

    it.each([{ order: [] }, { order: [7] }])('accepts a valid empty or single-item collection: %j', async ({ order }) => {
        api.rpc.mockResolvedValue({ data: order, error: null })
        expect(await saveCharacterOrder(order, order)).toEqual(order)
    })

    it.each([
        [[1, 1], [1, 2]],
        [[1, 2], [1, 1]],
        [[1], [1, 2]],
        [[1, 2, 3], [1, 2]],
        [[1, 3], [1, 2]],
        [[0, 2], [0, 2]],
        [[-1], [-1]],
        [[1.5], [1.5]],
        [[Number.MAX_SAFE_INTEGER + 1], [Number.MAX_SAFE_INTEGER + 1]],
        [[NaN], [NaN]],
        [[Infinity], [Infinity]],
        [Array<number>(1), Array<number>(1)],
    ])('rejects duplicate, foreign, missing, or unsafe IDs before I/O: %j', async (order, expected) => {
        await expect(saveCharacterOrder(order, expected)).rejects.toThrow('순서와 목록')
        expect(api.rpc).not.toHaveBeenCalled()
    })

    it.each([null, {}, [1, 2], [2, 2], [2, 3], ['2', 1]].map(data => ({ data })))('rejects a malformed or different saved order: %j', async ({ data }) => {
        api.rpc.mockResolvedValue({ data, error: null })
        await expect(saveCharacterOrder([2, 1], [1, 2])).rejects.toThrow('저장 결과')
    })

    it('freezes the RPC snapshot while the caller continues editing', async () => {
        let respond!: (value: unknown) => void
        api.rpc.mockReturnValue(new Promise(resolve => { respond = resolve }))
        const order = [2, 1]
        const expected = [1, 2]
        const request = saveCharacterOrder(order, expected)
        order.reverse()
        expected.push(3)
        expect(api.rpc.mock.calls[0][1]).toEqual({ p_expected: [1, 2], p_order: [2, 1] })
        respond({ data: [2, 1], error: null })
        expect(await request).toEqual([2, 1])
    })

    it('replays the same baseline and intended order after an unknown response', async () => {
        api.rpc.mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValueOnce({ data: [2, 1], error: null })
        await expect(saveCharacterOrder([2, 1], [1, 2])).rejects.toThrow('결과')
        expect(await saveCharacterOrder([2, 1], [1, 2])).toEqual([2, 1])
        expect(api.rpc.mock.calls[0]).toEqual(api.rpc.mock.calls[1])
    })

    it('retains the confirmed result when auth changes after the commit', async () => {
        let permitted = true
        api.rpc.mockImplementation(async () => {
            permitted = false
            return { data: [2, 1], error: null }
        })
        expect(await saveCharacterOrder([2, 1], [1, 2], () => permitted)).toEqual([2, 1])
    })
})

describe('independent main theme writes', () => {
    it('uses only main_theme colors and its own expected snapshot', async () => {
        const expected = themeFixture()
        const draft = draftFixture()
        api.rpc.mockResolvedValue({ data: { id: 1, ...themePayload() }, error: null })
        expect(await saveMainTheme(draft, expected)).toEqual({ id: 1, ...themePayload() })
        expect(api.rpc).toHaveBeenCalledExactlyOnceWith('save_main_theme', { p_expected: expected, p_data: themePayload() })
        expect(expected).toEqual(themeFixture())
        expect(draft).toEqual(draftFixture())
    })

    it('trims the submitted colors without altering the exact baseline', async () => {
        api.rpc.mockResolvedValue({ data: { id: 1, ...themePayload() }, error: null })
        const draft = { ...draftFixture(), mainColor: '  #abcdef  ' }
        const expected = { ...themeFixture(), main_color: ' #123456 ' }
        expect(await saveMainTheme(draft, expected)).toEqual({ id: 1, ...themePayload() })
        expect(api.rpc.mock.calls[0][1].p_expected.main_color).toBe(' #123456 ')
        expect(api.rpc.mock.calls[0][1].p_data.main_color).toBe('#abcdef')
        expect(draft.mainColor).toBe('  #abcdef  ')
    })

    it.each([
        { ...themeFixture(), id: 2 },
        { ...themeFixture(), main_color: 'red' },
    ])('rejects a character theme or malformed expected theme before I/O: %j', async expected => {
        await expect(saveMainTheme(draftFixture(), expected)).rejects.toThrow('저장된 메인 테마')
        expect(api.rpc).not.toHaveBeenCalled()
    })

    it.each(['', 'red', '#12', '#12345', '#1234567', 'var(--main-color)', '#fff; color:red'])('rejects invalid color input before I/O: %s', async mainColor => {
        await expect(saveMainTheme({ ...draftFixture(), mainColor }, themeFixture())).rejects.toThrow('헥스코드')
        expect(api.rpc).not.toHaveBeenCalled()
    })

    it.each([
        null,
        {},
        { id: 2, ...themePayload() },
        { id: 1, ...themePayload(), main_color: 'red' },
        { id: 1, ...themePayload(), main_color: '#000000' },
        { id: 1, main_color: '#abcdef' },
    ])('rejects wrong target, partial, or different saved colors: %j', async data => {
        api.rpc.mockResolvedValue({ data, error: null })
        await expect(saveMainTheme(draftFixture(), themeFixture())).rejects.toThrow('저장 결과')
    })

    it('copies the draft and baseline before awaiting the RPC response', async () => {
        let respond!: (value: unknown) => void
        api.rpc.mockReturnValue(new Promise(resolve => { respond = resolve }))
        const draft = draftFixture()
        const expected = themeFixture()
        const request = saveMainTheme(draft, expected)
        draft.mainColor = '#111111'
        expected.main_color = '#222222'
        expect(api.rpc.mock.calls[0][1]).toEqual({ p_expected: themeFixture(), p_data: themePayload() })
        respond({ data: { id: 1, ...themePayload() }, error: null })
        expect(await request).toEqual({ id: 1, ...themePayload() })
    })

    it('replays an identical isolated theme write after a lost response', async () => {
        api.rpc.mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValueOnce({ data: { id: 1, ...themePayload() }, error: null })
        await expect(saveMainTheme(draftFixture(), themeFixture())).rejects.toThrow('결과')
        expect(await saveMainTheme(draftFixture(), themeFixture())).toEqual({ id: 1, ...themePayload() })
        expect(api.rpc.mock.calls[0]).toEqual(api.rpc.mock.calls[1])
    })
})

describe('authorization and write failures', () => {
    const actions = [
        { name: 'order', run: (guard?: () => boolean) => saveCharacterOrder([2, 1], [1, 2], guard) },
        { name: 'theme', run: (guard?: () => boolean) => saveMainTheme(draftFixture(), themeFixture(), guard) },
    ]

    for (const action of actions) {
        it(`${action.name}: does not call any RPC when the live auth guard denies writing`, async () => {
            await expect(action.run(() => false)).rejects.toThrow('로그인 상태')
            expect(api.rpc).not.toHaveBeenCalled()
        })

        it(`${action.name}: rechecks the live guard immediately before the write`, async () => {
            const guard = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
            await expect(action.run(guard)).rejects.toThrow('유지')
            expect(api.rpc).not.toHaveBeenCalled()
        })

        it(`${action.name}: reports missing configuration before I/O`, async () => {
            api.available = false
            await expect(action.run()).rejects.toThrow('연결 설정')
            expect(api.rpc).not.toHaveBeenCalled()
        })

        it.each([
            [{ code: 'P0001', message: 'character_order_conflict' }, '다른 창'],
            [{ code: 'P0001', message: 'main_theme_conflict' }, '다른 창'],
            [{ code: 'P0001', message: 'character_writes_disabled' }, '일시 중지'],
            [{ code: '42501', message: 'permission denied' }, '권한'],
            [{ code: 'P0001', message: 'admin_required' }, '권한'],
            [{ code: 'PGRST202', message: 'Function unavailable' }, '아직 준비'],
            [{ code: '22023', message: 'invalid_input' }, '올바르지'],
            [{ code: 'P0001', message: 'main_theme_not_found' }, '존재하지'],
        ])(`${action.name}: keeps the caller draft on server rejection %j`, async (error, text) => {
            api.rpc.mockResolvedValue({ data: null, error })
            await expect(action.run()).rejects.toThrow(text)
            await expect(action.run()).rejects.toMatchObject({ cause: error })
        })

        it(`${action.name}: rejects partial success data when the RPC reports an error`, async () => {
            api.rpc.mockResolvedValue({ data: { id: 1, ...themePayload() }, error: { code: '42501', message: 'denied' } })
            await expect(action.run()).rejects.toThrow('권한')
        })
    }
})
