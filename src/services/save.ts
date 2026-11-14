import { supabase } from '../lib/supabase'
import type { SiteData, SiteEditDraft } from '../types/site'
import { isHexColor } from '../utils/validation'
import { queueImageCleanup, retryImageCleanup, uploadImage, validateImageFile } from './storage'

export { getPendingImageCleanupCount, imageFileName, retryImageCleanup } from './storage'

interface SaveResult {
  site: SiteData
  cleanupWarning: string | null
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    if (error.message.includes('site_conflict')) {
      return '다른 창에서 사이트 내용이 변경되었습니다. 입력한 내용은 유지됩니다. 최신 내용을 다시 불러온 뒤 수정해 주세요.'
    }
    if (error.message.includes('site_admin_required')) {
      return '저장 권한이 없습니다. 관리자 계정으로 다시 로그인해 주세요.'
    }
    if (error.message.includes('invalid_site_data') || ('code' in error && error.code === '23514')) {
      return '저장할 내용이 올바르지 않습니다. 입력값을 확인한 뒤 다시 저장해 주세요.'
    }
    if ('code' in error && error.code === 'PGRST202') {
      return '데이터베이스 저장 기능이 아직 설정되지 않았습니다. Supabase에 저장 SQL을 먼저 적용해 주세요.'
    }
  }
  return '저장 결과를 확인하지 못했습니다. 입력한 내용은 유지됩니다. 연결 상태를 확인한 뒤 같은 내용으로 다시 저장해 주세요.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSiteData(value: unknown): value is SiteData {
  if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.theme)) return false
  const { profile, theme } = value
  return typeof profile.id === 'number'
    && typeof profile.name === 'string'
    && typeof profile.status_message === 'string'
    && (profile.profile_image_path === null || typeof profile.profile_image_path === 'string')
    && typeof theme.id === 'number'
    && ['main_color', 'background_color', 'card_background_color', 'typo_color'].every((key) => typeof theme[key] === 'string')
    && Array.isArray(value.sections)
    && value.sections.every((row) => isRecord(row) && typeof row.id === 'number' && typeof row.sort_order === 'number' && typeof row.title === 'string' && typeof row.content === 'string')
    && Array.isArray(value.keywords)
    && value.keywords.every((row) => isRecord(row) && typeof row.id === 'number' && typeof row.sort_order === 'number' && typeof row.content === 'string')
    && Array.isArray(value.feed)
    && value.feed.every((row) => isRecord(row) && typeof row.id === 'number' && typeof row.sort_order === 'number' && typeof row.image_path === 'string')
}

function imagePaths(site: SiteData): Set<string> {
  const paths = new Set(site.feed.map((image) => image.image_path))
  if (site.profile.profile_image_path) paths.add(site.profile.profile_image_path)
  return paths
}

export async function saveSite(draft: SiteEditDraft, expected: SiteData): Promise<SaveResult> {
  if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')

  const name = draft.profile.name.trim()
  const statusMessage = draft.profile.statusMessage.trim()
  const keywords = draft.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean)
  if (!name || !statusMessage) throw new Error('이름과 상태 메시지를 입력해 주세요.')
  if (!Object.values(draft.theme).every(isHexColor)) throw new Error('올바른 색상코드를 입력해 주세요.')
  if (draft.sections.some((section) => !section.title.trim() || !section.content.trim())) {
    throw new Error('섹션 제목과 내용을 입력해 주세요.')
  }
  if (!keywords.length) throw new Error('키워드를 하나 이상 입력해 주세요.')
  if (draft.feed.some((image) => !image.file && !image.path)) throw new Error('피드 이미지를 선택해 주세요.')
  if (draft.profile.file) validateImageFile(draft.profile.file, 'profile')
  for (const image of draft.feed) if (image.file) validateImageFile(image.file, 'feed')

  const newPaths: string[] = []
  let profilePath = draft.profile.imagePath
  const feed: { id: number | null; image_path: string }[] = []
  try {
    if (draft.profile.file) {
      const uploaded = await uploadImage(draft.profile.file, 'profile')
      profilePath = uploaded.path
      if (uploaded.newlyUploaded) newPaths.push(uploaded.path)
    }
    for (const image of draft.feed) {
      let path = image.path!
      if (image.file) {
        const uploaded = await uploadImage(image.file, 'feed')
        path = uploaded.path
        if (uploaded.newlyUploaded) newPaths.push(uploaded.path)
      }
      feed.push({ id: image.databaseId ?? null, image_path: path })
    }
  } catch (error) {
    // These files have never been sent to the RPC. Cached uploads from an
    // earlier ambiguous save are deliberately excluded from this cleanup.
    queueImageCleanup(newPaths)
    const cleaned = await retryImageCleanup()
    const message = error instanceof Error ? error.message : '이미지를 업로드하지 못했습니다.'
    throw new Error(cleaned ? message : `${message} 미저장 이미지 정리도 완료되지 않았습니다. 이미지 정리를 다시 시도해 주세요.`, { cause: error })
  }

  let site: SiteData
  try {
    const { data, error } = await supabase.rpc('save_site', {
      p_expected: expected,
      p_data: {
        profile: { name, status_message: statusMessage, profile_image_path: profilePath },
        theme: {
          main_color: draft.theme.mainColor.trim(),
          background_color: draft.theme.backgroundColor.trim(),
          card_background_color: draft.theme.cardBackgroundColor.trim(),
          typo_color: draft.theme.typoColor.trim(),
        },
        sections: draft.sections.map((section) => ({
          id: section.databaseId ?? null,
          title: section.title.trim(),
          content: section.content,
        })),
        keywords: keywords.map((content, index) => ({ id: expected.keywords[index]?.id ?? null, content })),
        feed,
      },
    })
    if (error) throw error
    if (!isSiteData(data)) throw new Error('invalid_save_response')
    site = data
  } catch (error) {
    // The transaction may already have committed when its response is lost.
    // Retain File-to-path entries so retrying sends the same immutable paths.
    throw new Error(errorMessage(error), { cause: error })
  }

  const retainedPaths = imagePaths(site)
  queueImageCleanup(Array.from(imagePaths(expected)).filter((path) => !retainedPaths.has(path)))
  const cleaned = await retryImageCleanup()
  return {
    site,
    cleanupWarning: cleaned ? null : '내용은 저장됐지만 이전 이미지 정리가 완료되지 않았습니다. 이미지 정리를 다시 시도해 주세요.',
  }
}
