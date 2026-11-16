import { supabase } from '../lib/supabase'
import type { SiteTheme, ThemeColors } from '../types/site'
import { isCharacterId, isSiteTheme } from '../utils/siteData'
import { themeFields, toThemeData } from '../utils/theme'
import { isHexColor } from '../utils/validation'

type WriteGuard = () => boolean
const allowed = () => true

function ensureWrite(canWrite: WriteGuard): void {
    if (!canWrite()) throw new Error('로그인 상태가 변경되었습니다. 변경한 내용은 유지됩니다. 다시 로그인해 주세요.')
}

function isOrder(value: unknown): value is number[] {
    return Array.isArray(value) && Array.from(value).every(isCharacterId) && new Set(value).size === value.length
}

function sameOrder(first: number[], second: number[]): boolean {
    return first.length === second.length && first.every((id, index) => id === second[index])
}

function writeError(error: unknown, target: '순서' | '메인 테마'): string {
    if (error && typeof error === 'object') {
        const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
        const code = 'code' in error ? String(error.code) : ''
        if (message.includes('conflict')) return `${target}가 다른 창에서 변경되었습니다. 변경한 내용은 유지됩니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.`
        if (message.includes('writes_disabled')) return '현재 저장 기능이 일시 중지되어 있습니다. 변경한 내용은 유지됩니다. 잠시 후 다시 시도해 주세요.'
        if (message.includes('admin_required') || code === '42501') return '저장 권한이 없습니다. 변경한 내용은 유지됩니다. 관리자 계정으로 다시 로그인해 주세요.'
        if (message.includes('main_theme_not_found')) return '메인 테마가 존재하지 않습니다. 변경한 내용은 유지됩니다. 최신 정보를 확인해 주세요.'
        if (code === 'PGRST202') return '데이터베이스 저장 기능이 아직 준비되지 않았습니다. 변경한 내용은 유지됩니다.'
        if (['22023', '23514', '23503', '23505'].includes(code)) return `저장할 ${target}가 올바르지 않습니다. 변경한 내용은 유지됩니다. 입력값을 확인해 주세요.`
    }
    return `${target} 저장 결과를 확인하지 못했습니다. 변경한 내용은 유지됩니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.`
}

export async function saveCharacterOrder(order: number[], expected: number[], canWrite: WriteGuard = allowed): Promise<number[]> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    if (!isOrder(order) || !isOrder(expected) || order.length !== expected.length) throw new Error('캐릭터 순서와 목록을 확인해 주세요.')
    const membership = new Set(expected)
    if (order.some(id => !membership.has(id))) throw new Error('캐릭터 순서와 목록을 확인해 주세요.')

    const requested = [...order]
    const baseline = [...expected]
    try {
        ensureWrite(canWrite)
        const { data, error } = await supabase.rpc('save_character_order', { p_expected: baseline, p_order: requested })
        if (error) throw error
        if (!isOrder(data) || !sameOrder(data, requested)) throw new Error('invalid_order_response')
        // The RPC has committed. A later auth change must not turn its confirmed
        // result into an ambiguous failure or discard the caller's saved state.
        return [...data]
    } catch (error) {
        throw new Error(writeError(error, '순서'), { cause: error })
    }
}

export async function saveMainTheme(theme: ThemeColors, expected: SiteTheme, canWrite: WriteGuard = allowed): Promise<SiteTheme> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    if (!isSiteTheme(expected) || expected.id !== 1) throw new Error('저장된 메인 테마를 확인해 주세요.')
    if (!theme || themeFields.some(({ key }) => typeof theme[key] !== 'string' || !isHexColor(theme[key]))) throw new Error('메인 테마 색상은 올바른 헥스코드로 입력해 주세요.')

    const requested = toThemeData(theme)
    const baseline = { id: 1, ...Object.fromEntries(themeFields.map(({ column }) => [column, expected[column]])) } as SiteTheme
    try {
        ensureWrite(canWrite)
        const { data, error } = await supabase.rpc('save_main_theme', { p_expected: baseline, p_data: requested })
        if (error) throw error
        if (!isSiteTheme(data) || data.id !== 1 || themeFields.some(({ column }) => data[column] !== requested[column])) throw new Error('invalid_theme_response')
        return { ...data }
    } catch (error) {
        throw new Error(writeError(error, '메인 테마'), { cause: error })
    }
}
