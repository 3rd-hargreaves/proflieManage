import { describe, expect, it } from 'vitest'
import {
    MAX_FEED_IMAGES, MAX_IMAGE_BYTES, feedLimit, validateFeedCount, validateUpload,
} from '../../../src/utils/images/limits'

const image = (values: Partial<Pick<File, 'name' | 'type' | 'size'>> = {}) => ({ name: 'photo.png', type: 'image/png', size: 100, ...values })

describe('image upload limits', () => {
    it('allows the supported JPEG and PNG formats', () => {
        expect(() => validateUpload(image())).not.toThrow()
        expect(() => validateUpload(image({ name: 'photo.JPG', type: 'image/jpeg' }))).not.toThrow()
        expect(() => validateUpload(image({ name: 'photo.jpeg', type: 'image/jpeg' }))).not.toThrow()
    })

    it('allows an absent browser MIME when the extension is supported', () => {
        expect(() => validateUpload(image({ type: '' }))).not.toThrow()
    })

    it('rejects unsupported extensions and MIME values', () => {
        expect(() => validateUpload(image({ name: 'page.html' }))).toThrow('지원하지 않는 형식')
        expect(() => validateUpload(image({ type: 'text/html' }))).toThrow('지원하지 않는 형식')
        expect(() => validateUpload(image({ name: 'vector.svg', type: 'image/svg+xml' }))).toThrow('지원하지 않는 형식')
    })

    it('rejects empty images before a request can be made', () => {
        expect(() => validateUpload(image({ size: 0 }))).toThrow('비어 있는 파일')
    })

    it('accepts the exact byte limit and rejects the next byte', () => {
        expect(() => validateUpload(image({ size: MAX_IMAGE_BYTES }))).not.toThrow()
        expect(() => validateUpload(image({ size: MAX_IMAGE_BYTES + 1 }))).toThrow('초과')
    })

    it('rejects invalid size metadata', () => {
        for (const size of [-1, NaN, Infinity, 1.5]) {
            expect(() => validateUpload(image({ size }))).toThrow()
        }
    })
})

describe('feed image count limits', () => {
    it('allows an empty feed and the exact maximum', () => {
        expect(() => validateFeedCount(0)).not.toThrow()
        expect(() => validateFeedCount(MAX_FEED_IMAGES)).not.toThrow()
    })

    it('rejects adding beyond the total maximum', () => {
        expect(() => validateFeedCount(MAX_FEED_IMAGES + 1)).toThrow('수량 제한')
    })

    it('grandfathers a larger saved feed without permitting further growth', () => {
        const savedCount = MAX_FEED_IMAGES + 10
        const limit = feedLimit(savedCount)
        expect(limit).toBe(savedCount)
        expect(() => validateFeedCount(savedCount, limit)).not.toThrow()
        expect(() => validateFeedCount(savedCount - 1, limit)).not.toThrow()
        expect(() => validateFeedCount(savedCount + 1, limit)).toThrow('수량 제한')
    })

    it('keeps the normal allowance when the saved count is smaller', () => {
        expect(feedLimit(0)).toBe(MAX_FEED_IMAGES)
        expect(feedLimit(MAX_FEED_IMAGES - 1)).toBe(MAX_FEED_IMAGES)
    })

    it('does not let invalid saved metadata remove the limit', () => {
        for (const value of [-1, NaN, Infinity, 1.5]) {
            expect(feedLimit(value)).toBe(MAX_FEED_IMAGES)
        }
    })

    it('rejects invalid requested counts', () => {
        for (const count of [-1, NaN, Infinity, 1.5]) {
            expect(() => validateFeedCount(count)).toThrow()
        }
    })
})
