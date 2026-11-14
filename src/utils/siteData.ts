import type { SiteData } from '../types/site'

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isSiteData(value: unknown): value is SiteData {
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
