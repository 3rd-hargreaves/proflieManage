import type { MainData, SiteData, SiteTheme } from '../types/site'
import { isHexColor } from './validation'

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isCharacterId(value: unknown): value is number {
    // JSON bigint values outside this range have already lost precision in JavaScript.
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function isImagePath(value: unknown, folder: 'profile' | 'feed'): value is string {
    return typeof value === 'string' && value.startsWith(`${folder}/`) && value.length > folder.length + 1
}

function isProfile(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && isCharacterId(value.id) && isText(value.name) && isText(value.status_message)
        && (value.profile_image_path === null || isImagePath(value.profile_image_path, 'profile'))
}

export function isSiteTheme(value: unknown): value is SiteTheme {
    return isRecord(value) && isCharacterId(value.id)
        && ['main_color', 'background_color', 'card_background_color', 'typo_color'].every(key =>
            typeof value[key] === 'string' && isHexColor(value[key]))
}

function isOrderedList(value: unknown, validFields: (row: Record<string, unknown>) => boolean): boolean {
    if (!Array.isArray(value)) return false
    const ids = new Set<number>()
    let previousOrder = 0
    return value.every(row => {
        if (!isRecord(row) || !isCharacterId(row.id) || !isCharacterId(row.sort_order)
            || ids.has(row.id) || row.sort_order <= previousOrder || !validFields(row)) return false
        ids.add(row.id)
        previousOrder = row.sort_order
        return true
    })
}

export function isSiteData(value: unknown): value is SiteData {
    if (!isRecord(value) || !isProfile(value.profile) || !isSiteTheme(value.theme)) return false
    return value.theme.id === value.profile.id
        && isOrderedList(value.sections, row => isText(row.title) && isText(row.content))
        && isOrderedList(value.keywords, row => isText(row.content))
        && isOrderedList(value.feed, row => isImagePath(row.image_path, 'feed'))
}

export function isMainData(value: unknown): value is MainData {
    return isRecord(value) && isSiteTheme(value.theme) && value.theme.id === 1
        && isOrderedList(value.characters, row => isProfile(row))
}
