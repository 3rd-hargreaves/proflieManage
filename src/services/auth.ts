import type { SupabaseClient, User } from '@supabase/supabase-js'
import { adminEmail, adminUserId, authConfigurationError, supabase } from '../lib/supabase'

function getAuthClient(): SupabaseClient {
    if (authConfigurationError || !supabase) {
        throw new Error(authConfigurationError ?? 'Supabase 연결 설정 완료 요망')
    }
    return supabase
}

export function isAdmin(user: User | null): boolean {
    return !authConfigurationError
        && !!user
        && user.id.toLowerCase() === adminUserId
        && user.email?.toLowerCase() === adminEmail
}

export async function signIn(password: string): Promise<void> {
    const client = getAuthClient()
    const { data, error } = await client.auth.signInWithPassword({ email: adminEmail, password })

    if (error) {
        if (error.code === 'invalid_credentials') {
            throw new Error('비밀번호 불일치')
        }
        if (error.code === 'email_not_confirmed') {
            throw new Error('관리자 계정 메일 인증 확인 요망')
        }
        if (error.status === 429) {
            throw new Error('요청량 과다. 잠시 후 재시도 요망.')
        }
        throw new Error('로그인 실패. 연결 상태 확인 후 재시도 요망.')
    }

    if (!data.session || !isAdmin(data.user)) {
        await client.auth.signOut({ scope: 'local' })
        throw new Error('사이트 관리자 계정 설정 확인 요망')
    }
}

export async function signOut(): Promise<void> {
    const client = getAuthClient()
    const { error } = await client.auth.signOut({ scope: 'local' })
    if (error) {
        throw new Error('로그아웃 실패. 연결 상태 확인 후 재시도 요망.')
    }
}

export async function getAdminUser(): Promise<User | null> {
    if (authConfigurationError || !supabase) return null

    const { data, error } = await supabase.auth.getUser()
    if (error) {
        if (error.name === 'AuthSessionMissingError') return null
        const invalidSession = error.status === 401 || error.status === 403 || [
            'bad_jwt',
            'user_not_found',
            'session_not_found',
            'session_expired',
            'refresh_token_not_found',
            'refresh_token_already_used',
        ].includes(error.code ?? '')
        if (invalidSession) {
            await supabase.auth.signOut({ scope: 'local' })
            return null
        }
        throw new Error('로그인 상태 확인 실패. 연결 상태 확인 후 재시도 요망.')
    }

    if (!isAdmin(data.user)) {
        await supabase.auth.signOut({ scope: 'local' })
        return null
    }
    return data.user
}
