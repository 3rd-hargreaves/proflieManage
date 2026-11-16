import { supabase } from '../lib/supabase'
import type { Theme, ThemeColors } from '../types/models'
import { isCharacterId, isTheme } from '../utils/character/guards'
import { themeFields, toThemeData } from '../utils/theme'
import { isHexColor } from '../utils/validation'
import { allowWrite, ensureWrite, writeError } from './write'
import type { WriteGuard } from './write'

function isOrder(value: unknown): value is number[] {
    return Array.isArray(value) && Array.from(value).every(isCharacterId) && new Set(value).size === value.length
}

function sameOrder(first: number[], second: number[]): boolean {
    return first.length === second.length && first.every((id, index) => id === second[index])
}

export async function saveOrder(order: number[], expected: number[], canWrite: WriteGuard = allowWrite): Promise<number[]> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite, '순서')
    if (!isOrder(order) || !isOrder(expected) || order.length !== expected.length) throw new Error('캐릭터 순서와 목록을 확인해 주세요.')
    const membership = new Set(expected)
    if (order.some(id => !membership.has(id))) throw new Error('캐릭터 순서와 목록을 확인해 주세요.')

    const requested = [...order]
    const baseline = [...expected]
    try {
        ensureWrite(canWrite, '순서')
        const { data, error } = await supabase.rpc('save_character_order', { p_expected: baseline, p_order: requested })
        if (error) throw error
        if (!isOrder(data) || !sameOrder(data, requested)) throw new Error('invalid_order_response')
        // The RPC has committed. A later auth change must not turn its confirmed
        // result into an ambiguous failure or discard the caller's saved state.
        return [...data]
    } catch (error) {
        throw writeError(error, '순서')
    }
}

export async function saveTheme(theme: ThemeColors, expected: Theme, canWrite: WriteGuard = allowWrite): Promise<Theme> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite, '메인 테마')
    if (!isTheme(expected) || expected.id !== 1) throw new Error('저장된 메인 테마를 확인해 주세요.')
    if (!theme || themeFields.some(({ key }) => typeof theme[key] !== 'string' || !isHexColor(theme[key]))) throw new Error('메인 테마 색상은 올바른 헥스코드로 입력해 주세요.')

    const requested = toThemeData(theme)
    const baseline = { id: 1, ...Object.fromEntries(themeFields.map(({ column }) => [column, expected[column]])) } as Theme
    try {
        ensureWrite(canWrite, '메인 테마')
        const { data, error } = await supabase.rpc('save_main_theme', { p_expected: baseline, p_data: requested })
        if (error) throw error
        if (!isTheme(data) || data.id !== 1 || themeFields.some(({ column }) => data[column] !== requested[column])) throw new Error('invalid_theme_response')
        return { ...data }
    } catch (error) {
        throw writeError(error, '메인 테마')
    }
}
