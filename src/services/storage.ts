import { supabase } from '../lib/supabase'

const imageBucket = import.meta.env.VITE_SUPABASE_STORAGE_BUCKET?.trim() || 'site-images'

type ImageFolder = 'profile' | 'feed'

interface CachedUpload {
  path: string
  reusable: boolean
}

export interface UploadedImage {
  path: string
  newlyUploaded: boolean
}

const uploadedFiles = new WeakMap<File, Partial<Record<ImageFolder, CachedUpload>>>()
const uploadsByPath = new Map<string, CachedUpload>()
const pendingCleanup = new Set<string>()
let cleanupInFlight: Promise<boolean> | null = null

export function getImageUrl(path: string | null): string | undefined {
  if (!path || !supabase) return undefined
  return supabase.storage.from(imageBucket).getPublicUrl(path).data.publicUrl
}

// Storage keys do not allow percent signs or arbitrary Unicode. Preserve the
// original UTF-8 filename with reversible _HH escapes, including underscores.
function encodedFileName(name: string): string {
  return Array.from(new TextEncoder().encode(name || 'image'), (byte) => {
    const character = String.fromCharCode(byte)
    return /^[a-z0-9.-]$/i.test(character)
      ? character
      : `_${byte.toString(16).padStart(2, '0').toUpperCase()}`
  }).join('')
}

export function imageFileName(path: string): string {
  const name = path.split('/').at(-1) || path
  const encoded = name.match(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}--(.*)$/i)?.[1]
  try {
    return decodeURIComponent(encoded === undefined ? name : encoded.replace(/_([\da-f]{2})/gi, '%$1'))
  } catch {
    return encoded ?? name
  }
}

export function validateImageFile(file: File, folder: ImageFolder): void {
  if (!/\.(?:jpe?g|png)$/i.test(file.name) || (file.type && !/^image\/(?:jpeg|png)$/i.test(file.type))) {
    throw new Error(`이미지 “${file.name}”는 지원하지 않는 형식입니다. JPG, JPEG, PNG 파일을 선택해 주세요.`)
  }
  // Keys contain ASCII only, so string length equals the UTF-8 byte length.
  if (`${folder}/${'0'.repeat(36)}--${encodedFileName(file.name)}`.length > 1024) {
    throw new Error('이미지 파일 이름이 너무 깁니다. 파일 이름을 줄인 뒤 다시 선택해 주세요.')
  }
}

export function queueImageCleanup(paths: Iterable<string>): void {
  for (const path of paths) {
    pendingCleanup.add(path)
    const cached = uploadsByPath.get(path)
    if (cached) cached.reusable = false
    uploadsByPath.delete(path)
  }
}

export function getPendingImageCleanupCount(): number {
  return pendingCleanup.size
}

export async function retryImageCleanup(): Promise<boolean> {
  if (cleanupInFlight) return cleanupInFlight
  if (!pendingCleanup.size) return true
  if (!supabase) return false

  const client = supabase
  cleanupInFlight = (async () => {
    const paths = Array.from(pendingCleanup)
    for (let start = 0; start < paths.length; start += 100) {
      const batch = paths.slice(start, start + 100)
      try {
        const { error } = await client.storage.from(imageBucket).remove(batch)
        if (!error) for (const path of batch) pendingCleanup.delete(path)
      } catch {
        // A failed delete is safe to retry, including after a lost response.
      }
    }
    return pendingCleanup.size === 0
  })()

  try {
    return await cleanupInFlight
  } finally {
    cleanupInFlight = null
  }
}

export async function uploadImage(file: File, folder: ImageFolder): Promise<UploadedImage> {
  if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
  validateImageFile(file, folder)
  const cached = uploadedFiles.get(file)?.[folder]
  if (cached?.reusable) return { path: cached.path, newlyUploaded: false }

  const path = `${folder}/${crypto.randomUUID()}--${encodedFileName(file.name)}`
  try {
    const { error } = await supabase.storage.from(imageBucket).upload(path, file, {
      upsert: false,
      contentType: file.type || (/\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg'),
      cacheControl: '31536000',
    })
    if (error) throw error
  } catch (error) {
    // No RPC can reference this path yet, even if the upload response was lost.
    queueImageCleanup([path])
    throw new Error(`이미지 “${file.name}”를 업로드하지 못했습니다. 연결과 이미지 업로드 권한을 확인하고 다시 시도해 주세요.`, { cause: error })
  }

  const entry = { path, reusable: true }
  const fileUploads = uploadedFiles.get(file) ?? {}
  fileUploads[folder] = entry
  uploadedFiles.set(file, fileUploads)
  uploadsByPath.set(path, entry)
  return { path, newlyUploaded: true }
}
