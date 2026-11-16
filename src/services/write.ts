export type WriteGuard = () => boolean
type WriteTarget = '캐릭터' | '순서' | '메인 테마'

export const allowWrite = () => true

export function ensureWrite(canWrite: WriteGuard, target: WriteTarget = '캐릭터'): void {
    if (!canWrite()) throw new Error(`로그인 상태가 변경되었습니다. ${target === '캐릭터' ? '입력한' : '변경한'} 내용은 유지됩니다. 다시 로그인해 주세요.`)
}

function errorMessage(error: unknown, target: WriteTarget): string {
    const character = target === '캐릭터'
    const retained = `${character ? '입력한' : '변경한'} 내용은 유지됩니다.`
    const fallback = character
        ? `저장 결과를 확인하지 못했습니다. ${retained} 연결 상태를 확인한 뒤 같은 내용으로 다시 시도해 주세요.`
        : `${target} 저장 결과를 확인하지 못했습니다. ${retained} 연결 상태를 확인한 뒤 다시 시도해 주세요.`
    if (!error || typeof error !== 'object') return fallback
    const message = 'message' in error && typeof error.message === 'string' ? error.message : null
    if (character && message === null) return fallback
    const rawCode = 'code' in error ? error.code : undefined
    const code = String(rawCode)
    const exactCode = character ? rawCode : code

    if (character && message?.includes('feed_limit_exceeded')) return '피드 이미지 등록 한도를 초과했습니다. 최신 목록을 확인하고 사진 수를 줄여 다시 저장해 주세요.'
    if (message?.includes('conflict')) return character
        ? `다른 창에서 내용이 변경되었거나 이전 저장 결과와 충돌했습니다. ${retained} 최신 내용을 확인한 뒤 다시 시도해 주세요.`
        : `${target}가 다른 창에서 변경되었습니다. ${retained} 최신 내용을 확인한 뒤 다시 시도해 주세요.`
    if (character && message?.includes('character_not_found')) return `캐릭터가 삭제되었거나 존재하지 않습니다. ${retained}`
    if (message?.includes('writes_disabled')) return `현재 저장 기능이 일시 중지되어 있습니다. ${retained} 잠시 후 다시 시도해 주세요.`
    if (message?.includes('admin_required') || exactCode === '42501') return character
        ? '저장 권한이 없습니다. 관리자 계정으로 다시 로그인해 주세요.'
        : `저장 권한이 없습니다. ${retained} 관리자 계정으로 다시 로그인해 주세요.`
    if (!character && message?.includes('main_theme_not_found')) return `메인 테마가 존재하지 않습니다. ${retained} 최신 정보를 확인해 주세요.`
    const invalid = ['22023', '23514', '23503', '23505'].includes(code)
    if ((character && message?.includes('invalid_character')) || invalid) return character
        ? '저장할 내용이나 이미지가 올바르지 않습니다. 입력값을 확인한 뒤 다시 저장해 주세요.'
        : `저장할 ${target}가 올바르지 않습니다. ${retained} 입력값을 확인해 주세요.`
    if (exactCode === 'PGRST202') return `데이터베이스 저장 기능이 아직 준비되지 않았습니다. ${retained}`
    return fallback
}

export function writeError(error: unknown, target: WriteTarget = '캐릭터'): Error {
    return new Error(errorMessage(error, target), { cause: error })
}
