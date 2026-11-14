import { describe, expect, it } from 'vitest'
import {
    MAX_FEED_IMAGES, MAX_IMAGE_BYTES, feedImageLimit, validateFeedImageCount, validateImageUpload,
} from '../src/utils/uploadLimits'

const image = (values: Partial<Pick<File, 'name' | 'type' | 'size'>> = {}) => ({ name: 'photo.png', type: 'image/png', size: 100, ...values })

describe('image upload limits', () => {
    it('allows the supported JPEG and PNG formats', () => {
        expect(() => validateImageUpload(image())).not.toThrow()
        expect(() => validateImageUpload(image({ name: 'photo.JPG', type: 'image/jpeg' }))).not.toThrow()
        expect(() => validateImageUpload(image({ name: 'photo.jpeg', type: 'image/jpeg' }))).not.toThrow()
    })

    it('allows an absent browser MIME when the extension is supported', () => {
        expect(() => validateImageUpload(image({ type: '' }))).not.toThrow()
    })

    it('rejects unsupported extensions and MIME values', () => {
        expect(() => validateImageUpload(image({ name: 'page.html' }))).toThrow('지원하지 않는 형식')
        expect(() => validateImageUpload(image({ type: 'text/html' }))).toThrow('지원하지 않는 형식')
        expect(() => validateImageUpload(image({ name: 'vector.svg', type: 'image/svg+xml' }))).toThrow('지원하지 않는 형식')
    })

    it('rejects empty images before a request can be made', () => {
        expect(() => validateImageUpload(image({ size: 0 }))).toThrow('비어 있는 파일')
    })

    it('accepts the exact byte limit and rejects the next byte', () => {
        expect(() => validateImageUpload(image({ size: MAX_IMAGE_BYTES }))).not.toThrow()
        expect(() => validateImageUpload(image({ size: MAX_IMAGE_BYTES + 1 }))).toThrow('초과')
    })

    it('rejects invalid size metadata', () => {
        for (const size of [-1, NaN, Infinity, 1.5]) {
            expect(() => validateImageUpload(image({ size }))).toThrow()
        }
    })
})

describe('feed image count limits', () => {
    it('allows an empty feed and the exact maximum', () => {
        expect(() => validateFeedImageCount(0)).not.toThrow()
        expect(() => validateFeedImageCount(MAX_FEED_IMAGES)).not.toThrow()
    })

    it('rejects adding beyond the total maximum', () => {
        expect(() => validateFeedImageCount(MAX_FEED_IMAGES + 1)).toThrow('수량 제한')
    })

    it('grandfathers a larger saved feed without permitting further growth', () => {
        const savedCount = MAX_FEED_IMAGES + 10
        const limit = feedImageLimit(savedCount)
        expect(limit).toBe(savedCount)
        expect(() => validateFeedImageCount(savedCount, limit)).not.toThrow()
        expect(() => validateFeedImageCount(savedCount - 1, limit)).not.toThrow()
        expect(() => validateFeedImageCount(savedCount + 1, limit)).toThrow('수량 제한')
    })

    it('keeps the normal allowance when the saved count is smaller', () => {
        expect(feedImageLimit(0)).toBe(MAX_FEED_IMAGES)
        expect(feedImageLimit(MAX_FEED_IMAGES - 1)).toBe(MAX_FEED_IMAGES)
    })

    it('does not let invalid saved metadata remove the limit', () => {
        for (const value of [-1, NaN, Infinity, 1.5]) {
            expect(feedImageLimit(value)).toBe(MAX_FEED_IMAGES)
        }
    })

    it('rejects invalid requested counts', () => {
        for (const count of [-1, NaN, Infinity, 1.5]) {
            expect(() => validateFeedImageCount(count)).toThrow()
        }
    })
})
