import type { SupabaseClient, User } from '@supabase/supabase-js'
import { adminEmail, adminUserId, authConfigurationError, supabase } from '../lib/supabase'

function getAuthClient(): SupabaseClient {
  if (authConfigurationError || !supabase) {
    throw new Error(authConfigurationError ?? 'Supabase 연결 설정을 완료해 주세요.')
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
      throw new Error('비밀번호를 확인해 주세요.')
    }
    if (error.code === 'email_not_confirmed') {
      throw new Error('관리자 계정의 이메일 인증을 확인해 주세요.')
    }
    if (error.status === 429) {
      throw new Error('로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.')
    }
    throw new Error('로그인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.')
  }

  if (!data.session || !isAdmin(data.user)) {
    await client.auth.signOut({ scope: 'local' })
    throw new Error('이 사이트의 관리자 계정 설정을 확인해 주세요.')
  }
}

export async function signOut(): Promise<void> {
  const client = getAuthClient()
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) {
    throw new Error('로그아웃하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.')
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
    throw new Error('로그인 상태를 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.')
  }

  if (!isAdmin(data.user)) {
    await supabase.auth.signOut({ scope: 'local' })
    return null
  }
  return data.user
}
