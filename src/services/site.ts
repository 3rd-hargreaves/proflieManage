import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { SiteData, SiteFeedImage, SiteKeyword, SiteProfile, SiteSection, SiteTheme } from '../types/site'

const loadErrorMessage = '사이트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'

async function loadOrderedList<Row>(
  client: SupabaseClient,
  table: string,
  columns: string,
  signal: AbortSignal,
): Promise<Row[]> {
  const rows: Row[] = []
  const pageSize = 100

  while (true) {
    signal.throwIfAborted()
    const { data, count, error } = await client.from(table)
      .select(columns, { count: 'exact' })
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .range(rows.length, rows.length + pageSize - 1)
      .abortSignal(signal)
      .returns<Row[]>()

    signal.throwIfAborted()
    if (error || !data) throw new Error(loadErrorMessage, { cause: error })
    rows.push(...data)
    if (data.length === 0 || (count !== null && rows.length >= count)) return rows
  }
}

export async function loadSite(signal: AbortSignal): Promise<SiteData> {
  if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
  signal.throwIfAborted()

  const [profile, theme, sections, keywords, feed] = await Promise.all([
    supabase.from('profile')
      .select('id, name, status_message, profile_image_path')
      .eq('id', 1)
      .abortSignal(signal)
      .single<SiteProfile>(),
    supabase.from('theme')
      .select('id, main_color, background_color, card_background_color, typo_color')
      .eq('id', 1)
      .abortSignal(signal)
      .single<SiteTheme>(),
    loadOrderedList<SiteSection>(supabase, 'sections', 'id, sort_order, title, content', signal),
    loadOrderedList<SiteKeyword>(supabase, 'keywords', 'id, sort_order, content', signal),
    loadOrderedList<SiteFeedImage>(supabase, 'feed_images', 'id, image_path, sort_order', signal),
  ])

  signal.throwIfAborted()
  for (const result of [profile, theme]) {
    if (result.error) {
      throw new Error(loadErrorMessage, { cause: result.error })
    }
  }

  if (!profile.data || !theme.data) {
    throw new Error(loadErrorMessage)
  }

  return {
    profile: profile.data,
    theme: theme.data,
    sections,
    keywords,
    feed,
  }
}
