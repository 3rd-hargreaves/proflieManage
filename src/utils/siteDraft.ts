import type { SiteData, SiteEditDraft, ThemeColors } from '../types/site'
import { imageFileName } from './imageFileName'
import { themeFields, toThemeColors, toThemeData } from './theme'
import { feedImageLimit, validateFeedImageCount } from './uploadLimits'
import { hexColorMessage, requiredMessage } from './validation'

export type DraftValidationIssue =
    | { field: 'profile.name' | 'profile.statusMessage' | 'keywords', message: string }
    | { field: 'theme', key: keyof ThemeColors, message: string }
    | { field: 'section', index: number, key: 'title' | 'content', message: string }
    | { field: 'feed', index?: number, message: string }

export interface SavedImagePaths {
    profile: string | null
    feed: readonly string[]
}

export interface SiteSaveData {
    profile: Omit<SiteData['profile'], 'id'>
    theme: Omit<SiteData['theme'], 'id'>
    sections: { id: number | null, title: string, content: string }[]
    keywords: { id: number | null, content: string }[]
    feed: { id: number | null, image_path: string }[]
}

export function parseKeywords(value: string): string[] {
    return value.split(',').map(keyword => keyword.trim()).filter(Boolean)
}

export function validateSiteDraft(draft: SiteEditDraft, savedFeedCount = 0): DraftValidationIssue[] {
    const issues: DraftValidationIssue[] = []
    for (const { key } of themeFields) {
        const message = hexColorMessage(draft.theme[key])
        if (message) issues.push({ field: 'theme', key, message })
    }
    const nameMessage = requiredMessage(draft.profile.name, '이름')
    const statusMessage = requiredMessage(draft.profile.statusMessage, '상태 메시지')
    if (nameMessage) issues.push({ field: 'profile.name', message: nameMessage })
    if (statusMessage) issues.push({ field: 'profile.statusMessage', message: statusMessage })
    draft.sections.forEach((section, index) => {
        const titleMessage = requiredMessage(section.title, '섹션 제목')
        const contentMessage = requiredMessage(section.content, '섹션 내용')
        if (titleMessage) issues.push({ field: 'section', index, key: 'title', message: titleMessage })
        if (contentMessage) issues.push({ field: 'section', index, key: 'content', message: contentMessage })
    })
    if (!parseKeywords(draft.keywords).length) {
        issues.push({ field: 'keywords', message: '키워드 한 개 이상 입력 필수' })
    }
    draft.feed.forEach((image, index) => {
        if (!image.file && !image.path) issues.push({ field: 'feed', index, message: '피드 이미지 선택 필수' })
    })
    try {
        validateFeedImageCount(draft.feed.length, feedImageLimit(savedFeedCount))
    } catch (error) {
        issues.push({ field: 'feed', message: (error as Error).message })
    }
    return issues
}

export function toDraft(site: SiteData): SiteEditDraft {
    return {
        profile: {
            name: site.profile.name,
            statusMessage: site.profile.status_message,
            imagePath: site.profile.profile_image_path,
            file: null,
        },
        theme: toThemeColors(site.theme),
        sections: site.sections.map(section => ({
            id: `section-${section.id}`, databaseId: section.id, title: section.title, content: section.content,
        })),
        keywords: site.keywords.map(keyword => keyword.content).join(', '),
        feed: site.feed.map(image => ({
            id: `feed-${image.id}`, databaseId: image.id, name: imageFileName(image.image_path), path: image.image_path,
        })),
    }
}

export function buildSaveData(draft: SiteEditDraft, expected: SiteData, images: SavedImagePaths): SiteSaveData {
    if (images.feed.length !== draft.feed.length) throw new Error('피드 이미지 경로 확인 요망')
    return {
        profile: {
            name: draft.profile.name.trim(),
            status_message: draft.profile.statusMessage.trim(),
            profile_image_path: images.profile,
        },
        theme: toThemeData(draft.theme),
        sections: draft.sections.map(section => ({
            id: section.databaseId ?? null,
            title: section.title.trim(),
            content: section.content,
        })),
        keywords: parseKeywords(draft.keywords).map((content, index) => ({ id: expected.keywords[index]?.id ?? null, content })),
        feed: draft.feed.map((image, index) => ({ id: image.databaseId ?? null, image_path: images.feed[index] })),
    }
}
