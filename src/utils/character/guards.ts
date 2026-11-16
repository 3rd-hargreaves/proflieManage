import type { MainData, Character, Theme } from '../../types/models'
import { isHexColor } from '../validation'
import { themeFields } from '../theme'

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

export function isTheme(value: unknown): value is Theme {
    return isRecord(value) && isCharacterId(value.id)
        && themeFields.every(({ column }) => typeof value[column] === 'string' && isHexColor(value[column]))
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

export function isCharacter(value: unknown): value is Character {
    if (!isRecord(value) || !isProfile(value.profile) || !isTheme(value.theme)) return false
    return value.theme.id === value.profile.id
        && isOrderedList(value.sections, row => isText(row.title) && isText(row.content))
        && isOrderedList(value.keywords, row => isText(row.content))
        && isOrderedList(value.feed, row => isImagePath(row.image_path, 'feed'))
}

export function isMainData(value: unknown): value is MainData {
    return isRecord(value) && isTheme(value.theme) && value.theme.id === 1
        && isOrderedList(value.characters, row => isProfile(row))
}
