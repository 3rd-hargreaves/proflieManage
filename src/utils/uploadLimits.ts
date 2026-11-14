export const MAX_IMAGE_SIZE_MB = 10
export const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024
export const MAX_FEED_IMAGES = 50
export const imageUploadHint = `JPG, JPEG, PNG · 파일당 최대 ${MAX_IMAGE_SIZE_MB}MB`

type ImageFileInfo = Pick<File, 'name' | 'type' | 'size'>

export function validateImageUpload(file: ImageFileInfo): void {
    if (!/\.(?:jpe?g|png)$/i.test(file.name) || (file.type && !/^image\/(?:jpeg|png)$/i.test(file.type))) {
        throw new Error(`지원하지 않는 형식(${file.name})`)
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
        throw new Error(`비어 있는 파일(${file.name}). 다른 파일 선택 요망.`)
    }
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(`용량 제한 초과(${file.name}). ${MAX_IMAGE_SIZE_MB}MB 이하로 압축 후 재시도 요망.`)
    }
}

export function feedImageLimit(savedCount = 0): number {
    return Number.isSafeInteger(savedCount) && savedCount > MAX_FEED_IMAGES ? savedCount : MAX_FEED_IMAGES
}

export function validateFeedImageCount(count: number, maxCount = MAX_FEED_IMAGES): void {
    const limit = feedImageLimit(maxCount)
    if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
        throw new Error(`피드 이미지 수량 제한(${limit}) 초과`)
    }
}
