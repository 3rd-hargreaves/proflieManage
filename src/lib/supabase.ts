import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

const projectUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

export const adminEmail = import.meta.env.VITE_ADMIN_EMAIL?.trim().toLowerCase() ?? ''
export const adminUserId = import.meta.env.VITE_ADMIN_USER_ID?.trim().toLowerCase() ?? ''

function createSupabaseClient(): SupabaseClient | null {
    if (!projectUrl || !publishableKey) return null

    try {
        const url = new URL(projectUrl)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

        return createClient(projectUrl, publishableKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
            },
        })
    } catch {
        return null
    }
}

export const supabase = createSupabaseClient()

const hasAdminEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)
const hasAdminUserId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(adminUserId)
    && adminUserId !== '00000000-0000-0000-0000-000000000000'

export const authConfigurationError: string | null = !supabase
    ? 'Supabase 연결 설정을 완료해 주세요.'
    : !hasAdminEmail || !hasAdminUserId
        ? '관리자 계정 설정을 완료해 주세요.'
        : null
