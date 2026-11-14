import { supabase } from '../lib/supabase'
import { validateImageUpload } from '../utils/uploadLimits'
import { createCleanupJournal } from '../utils/cleanupJournal'
import { loadSite } from './site'

export { imageFileName } from '../utils/imageFileName'

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
const pendingCleanup = createCleanupJournal(`${import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''}/${imageBucket}`, () => {
    return typeof window === 'undefined' ? null : window.localStorage
})
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

export function validateImageFile(file: File, folder: ImageFolder): void {
    validateImageUpload(file)
    // Keys contain ASCII only, so string length equals the UTF-8 byte length.
    if (`${folder}/${'0'.repeat(36)}--${encodedFileName(file.name)}`.length > 1024) {
        throw new Error('파일명 줄인 후 재시도 요망')
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
    return pendingCleanup.paths().length
}

export function imageCleanupWarning(message = '이전 이미지 정리가 남아 있음. 재시도 요망.'): string | null {
    if (!getPendingImageCleanupCount()) return null
    return pendingCleanup.hasPersistenceError()
        ? `${message} 정리 기록 보관 실패. 이 화면에서 정리 재시도 완료 요망.`
        : message
}

export async function retryImageCleanup(): Promise<boolean> {
    if (cleanupInFlight) return cleanupInFlight
    if (!getPendingImageCleanupCount()) return true
    if (!supabase) return false

    const client = supabase
    cleanupInFlight = (async () => {
        pendingCleanup.retryPersistence()
        const paths = pendingCleanup.paths()
        // A recovered queue can be stale. Fail closed if references are unknown.
        let retained: Set<string>
        try {
            const site = await loadSite(AbortSignal.timeout(10000))
            retained = new Set(site.feed.map(image => image.image_path))
            if (site.profile.profile_image_path) retained.add(site.profile.profile_image_path)
        } catch {
            return false
        }
        for (const path of paths) if (retained.has(path)) pendingCleanup.remove(path)
        const removable = paths.filter(path => !retained.has(path))
        for (let start = 0; start < removable.length; start += 100) {
            const batch = removable.slice(start, start + 100)
            try {
                const { error } = await client.storage.from(imageBucket).remove(batch)
                if (!error) for (const path of batch) pendingCleanup.remove(path)
            } catch {
                // A failed delete is safe to retry, including after a lost response.
            }
        }
        return getPendingImageCleanupCount() === 0
    })()

    try {
        return await cleanupInFlight
    } finally {
        cleanupInFlight = null
    }
}

export async function uploadImage(file: File, folder: ImageFolder): Promise<UploadedImage> {
    if (!supabase) throw new Error('사이트 연결 설정 확인 요망')
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
        throw new Error(`이미지 “${file.name}” 업로드 실패. 연결 및 권한 확인 후 재시도 요망.`, { cause: error })
    }

    const entry = { path, reusable: true }
    const fileUploads = uploadedFiles.get(file) ?? {}
    fileUploads[folder] = entry
    uploadedFiles.set(file, fileUploads)
    uploadsByPath.set(path, entry)
    return { path, newlyUploaded: true }
}
