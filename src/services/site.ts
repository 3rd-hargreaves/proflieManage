import { supabase } from '../lib/supabase'
import type { SiteData } from '../types/site'
import { isSiteData } from '../utils/siteData'

const loadErrorMessage = '사이트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'

export async function loadSite(signal: AbortSignal): Promise<SiteData> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    signal.throwIfAborted()

    // One RPC reads all five tables using a single database statement snapshot.
    // Separate table requests and offset pages could mix concurrent saves.
    let result
    try {
        result = await supabase.rpc('load_site').abortSignal(signal)
    } catch (error) {
        signal.throwIfAborted()
        throw new Error(loadErrorMessage, { cause: error })
    }

    signal.throwIfAborted()
    if (result.error || !isSiteData(result.data)) {
        throw new Error(loadErrorMessage, { cause: result.error ?? new Error('invalid_site_response') })
    }
    return result.data
}
