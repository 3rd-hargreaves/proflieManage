export const MAX_IMAGE_SIZE_MB = 10
export const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024
export const MAX_FEED_IMAGES = 50
export const imageUploadHint = `JPG, JPEG, PNG · 파일당 최대 ${MAX_IMAGE_SIZE_MB}MB`

type ImageFileInfo = Pick<File, 'name' | 'type' | 'size'>

export function validateImageUpload(file: ImageFileInfo): void {
    if (!/\.(?:jpe?g|png)$/i.test(file.name) || (file.type && !/^image\/(?:jpeg|png)$/i.test(file.type))) {
        throw new Error(`이미지 “${file.name}”는 지원하지 않는 형식입니다. JPG, JPEG, PNG 파일을 선택해 주세요.`)
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
        throw new Error(`이미지 “${file.name}”가 비어 있습니다. 다른 파일을 선택해 주세요.`)
    }
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(`이미지 “${file.name}”의 크기가 ${MAX_IMAGE_SIZE_MB}MB를 초과했습니다. 파일 크기를 줄여 다시 선택해 주세요.`)
    }
}

export function feedImageLimit(savedCount = 0): number {
    return Number.isSafeInteger(savedCount) && savedCount > MAX_FEED_IMAGES ? savedCount : MAX_FEED_IMAGES
}

export function validateFeedImageCount(count: number, maxCount = MAX_FEED_IMAGES): void {
    const limit = feedImageLimit(maxCount)
    if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
        throw new Error(`피드는 최대 ${limit}장까지 등록할 수 있습니다. 기존 사진을 삭제한 뒤 추가해 주세요.`)
    }
}
