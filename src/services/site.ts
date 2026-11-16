import { supabase } from '../lib/supabase'
import type { CharacterId, MainData, SiteData } from '../types/site'
import { isCharacterId, isMainData, isSiteData } from '../utils/siteData'

const loadErrorMessage = '사이트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'

async function readRpc(name: 'load_main' | 'load_character', signal: AbortSignal, args?: { p_character_id: CharacterId }): Promise<unknown> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    signal.throwIfAborted()
    let result
    try {
        result = await (args ? supabase.rpc(name, args) : supabase.rpc(name)).abortSignal(signal)
    } catch (error) {
        signal.throwIfAborted()
        throw new Error(loadErrorMessage, { cause: error })
    }
    signal.throwIfAborted()
    if (result.error) throw new Error(loadErrorMessage, { cause: result.error })
    return result.data
}

export async function loadMain(signal: AbortSignal): Promise<MainData> {
    const data = await readRpc('load_main', signal)
    if (!isMainData(data)) throw new Error(loadErrorMessage, { cause: new Error('invalid_main_response') })
    return data
}

export async function loadCharacter(characterId: CharacterId, signal: AbortSignal): Promise<SiteData | null> {
    signal.throwIfAborted()
    if (!isCharacterId(characterId)) throw new Error('캐릭터 주소를 확인해 주세요.')
    const data = await readRpc('load_character', signal, { p_character_id: characterId })
    if (data === null) return null
    if (!isSiteData(data) || data.profile.id !== characterId) {
        throw new Error(loadErrorMessage, { cause: new Error('invalid_character_response') })
    }
    return data
}
