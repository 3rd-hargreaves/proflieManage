import { supabase } from '../lib/supabase'
import type { Character, Draft } from '../types/models'
import { toSaveData, validateDraft } from '../utils/character/draft'
import type { SaveData } from '../utils/character/draft'
import { isCharacterId, isCharacter } from '../utils/character/guards'
import { isImagePath } from '../utils/images/cleanup'
import { cleanupMessage, queueCleanup, retryCleanup, uploadImage, validateImage } from './storage'
import { allowWrite, ensureWrite, writeError } from './write'
import type { WriteGuard } from './write'

export { cleanupCount } from './storage'
export interface SaveResult { site: Character, cleanupWarning: string | null }
type CreateState =
    | { phase: 'idle' }
    | { phase: 'reserved', characterId: number }
    | { phase: 'prepared' | 'uncertain', characterId: number, payload: SaveData, uploadPaths: string[], submittedDraft: Draft }
    | { phase: 'confirmed', site: Character, savedDraft: Draft }

export interface CreateContext {
    requestId: string
    state: CreateState
}
export function createContext(): CreateContext {
    return { requestId: crypto.randomUUID(), state: { phase: 'idle' } }
}
function isDefiniteRejection(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error
        && ['22023', '23514', '23503', '23505', '42501', 'PGRST202'].includes(String(error.code))
}
function isSaveRolledBack(error: unknown): boolean {
    return isDefiniteRejection(error) || (record(error) && error.code === 'P0001'
        && ['character_conflict', 'character_not_found'].includes(String(error.message)))
}
function imagePaths(site: Character): Set<string> {
    const paths = new Set(site.feed.map(image => image.image_path))
    if (site.profile.profile_image_path) paths.add(site.profile.profile_image_path)
    return paths
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function cleanupPaths(value: unknown, candidates: Set<string>): value is string[] {
    return Array.isArray(value) && value.every(path => typeof path === 'string' && isImagePath(path) && candidates.has(path))
}
function savedEnvelope(value: unknown, characterId: number, candidates: Set<string>): { character: Character, cleanup_candidates: string[] } {
    if (!record(value) || !isCharacter(value.character) || value.character.profile.id !== characterId
        || !cleanupPaths(value.cleanup_candidates, candidates)) throw new Error('invalid_save_response')
    return { character: value.character, cleanup_candidates: value.cleanup_candidates }
}
function validate(draft: Draft, savedFeedCount = 0, characterId?: number) {
    const issues = validateDraft(draft, savedFeedCount)
    if (issues.length) throw new Error(issues[0].message)
    if (draft.profile.file) validateImage(draft.profile.file, 'profile', characterId)
    for (const image of draft.feed) if (image.file) validateImage(image.file, 'feed', characterId)
}
async function cleanedResult(site: Character, paths: Iterable<string>, characterId: number, canWrite: WriteGuard): Promise<SaveResult> {
    queueCleanup(paths, characterId)
    const cleaned = canWrite() && await retryCleanup(canWrite)
    return { site, cleanupWarning: cleaned ? null : cleanupMessage('내용은 저장됐지만 이전 이미지 정리가 완료되지 않았습니다. 이미지 정리를 다시 시도해 주세요.') }
}
async function uploadData(draft: Draft, expected: Character, characterId: number, canWrite: WriteGuard): Promise<{ payload: SaveData, newPaths: string[] }> {
    const newPaths: string[] = []
    let profile = draft.profile.imagePath
    const feed: string[] = []
    try {
        if (draft.profile.file) {
            ensureWrite(canWrite)
            const uploaded = await uploadImage(draft.profile.file, 'profile', characterId)
            profile = uploaded.path
            if (uploaded.newlyUploaded) newPaths.push(uploaded.path)
        }
        for (const image of draft.feed) {
            let path = image.path!
            if (image.file) {
                ensureWrite(canWrite)
                const uploaded = await uploadImage(image.file, 'feed', characterId)
                path = uploaded.path
                if (uploaded.newlyUploaded) newPaths.push(path)
            }
            feed.push(path)
        }
        ensureWrite(canWrite)
    } catch (error) {
        // Cached paths may belong to an earlier ambiguous save. Only this
        // attempt's never-submitted uploads are classified as unused here.
        queueCleanup(newPaths, characterId)
        if (canWrite()) await retryCleanup(canWrite)
        throw error
    }
    return { payload: toSaveData(draft, expected, { profile, feed }), newPaths }
}
export async function saveCharacter(characterId: number, draft: Draft, expected: Character, canWrite: WriteGuard = allowWrite): Promise<SaveResult> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    if (!isCharacterId(characterId) || !isCharacter(expected) || expected.profile.id !== characterId) throw new Error('수정할 캐릭터를 확인해 주세요.')
    validate(draft, expected.feed.length, characterId)
    const { payload, newPaths } = await uploadData(draft, expected, characterId, canWrite)
    let envelope
    try {
        ensureWrite(canWrite)
        const { data, error } = await supabase.rpc('save_character', { p_character_id: characterId, p_expected: expected, p_data: payload })
        if (error) throw error
        envelope = savedEnvelope(data, characterId, imagePaths(expected))
    } catch (error) {
        if (isSaveRolledBack(error)) {
            queueCleanup(newPaths, characterId)
            if (canWrite()) await retryCleanup(canWrite)
        }
        throw writeError(error)
    }
    const retained = imagePaths(envelope.character)
    const candidates = new Set([...envelope.cleanup_candidates, ...Array.from(imagePaths(expected)).filter(path => !retained.has(path))])
    return cleanedResult(envelope.character, candidates, characterId, canWrite)
}
function snapshotDraft(draft: Draft): Draft {
    return { ...draft, profile: { ...draft.profile }, theme: { ...draft.theme }, sections: draft.sections.map(row => ({ ...row })), feed: draft.feed.map(row => ({ ...row })) }
}
function sameDraft(first: Draft, current: Draft): boolean {
    return JSON.stringify(first) === JSON.stringify(current) && first.profile.file === current.profile.file
        && first.feed.every((row, index) => row.file === current.feed[index]?.file)
}
function adoptCreatedIds(draft: Draft, submitted: Draft, site: Character): Draft {
    return {
        ...draft,
        sections: draft.sections.map(row => {
            const index = submitted.sections.findIndex(item => item.id === row.id)
            return { ...row, databaseId: index < 0 ? undefined : site.sections[index]?.id }
        }),
        feed: draft.feed.map(row => {
            const index = submitted.feed.findIndex(item => item.id === row.id)
            return { ...row, databaseId: index < 0 ? undefined : site.feed[index]?.id }
        }),
    }
}
export async function createCharacter(draft: Draft, context: CreateContext, canWrite: WriteGuard = allowWrite): Promise<SaveResult> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    let state = context.state
    if (state.phase === 'idle' || state.phase === 'reserved') {
        validate(draft)
        if (state.phase === 'idle') {
            try {
                ensureWrite(canWrite)
                const { data, error } = await supabase.rpc('reserve_character_id', { p_request_id: context.requestId })
                if (error) throw error
                if (!isCharacterId(data)) throw new Error('invalid_reservation_response')
                state = context.state = { phase: 'reserved', characterId: data }
            } catch (error) { throw writeError(error) }
        }
        const characterId = state.characterId
        const emptyBaseline: Character = {
            profile: { id: characterId, name: '', status_message: '', profile_image_path: null },
            theme: { id: characterId, main_color: '', background_color: '', card_background_color: '', typo_color: '' },
            sections: [], keywords: [], feed: [],
        }
        const uploaded = await uploadData(draft, emptyBaseline, characterId, canWrite)
        state = context.state = {
            phase: 'prepared', characterId, uploadPaths: uploaded.newPaths, submittedDraft: snapshotDraft(draft),
            payload: { ...uploaded.payload,
                sections: uploaded.payload.sections.map(row => ({ ...row, id: null })),
                keywords: uploaded.payload.keywords.map(row => ({ ...row, id: null })),
                feed: uploaded.payload.feed.map(row => ({ ...row, id: null })),
            },
        }
    }
    if (state.phase !== 'confirmed') {
        const pending = state
        const characterId = pending.characterId
        if (!isCharacterId(characterId)) throw new Error('새 캐릭터 예약 정보를 확인해 주세요.')
        let attempted = false
        let site: Character
        try {
            ensureWrite(canWrite)
            attempted = true
            const { data, error } = await supabase.rpc('create_character', { p_character_id: characterId, p_request_id: context.requestId, p_data: pending.payload })
            if (error) throw error
            site = savedEnvelope(data, characterId, new Set()).character
        } catch (error) {
            // Validation precedes receipt lookup in the RPC. Even a later
            // validation rejection cannot disprove an earlier unknown commit.
            if (attempted && !isDefiniteRejection(error)) context.state = { ...pending, phase: 'uncertain' }
            if (pending.phase !== 'uncertain' && isDefiniteRejection(error) && record(error) && !['42501', 'PGRST202'].includes(String(error.code))) {
                queueCleanup(pending.uploadPaths, characterId)
                context.state = { phase: 'reserved', characterId }
                if (canWrite()) await retryCleanup(canWrite)
            }
            throw writeError(error)
        }
        state = context.state = { phase: 'confirmed', site, savedDraft: pending.submittedDraft }
    }
    const { site, savedDraft } = state
    const characterId = site.profile.id
    if (!sameDraft(savedDraft, draft)) {
        const result = await saveCharacter(characterId, adoptCreatedIds(draft, savedDraft, site), site, canWrite)
        context.state = { phase: 'confirmed', site: result.site, savedDraft: snapshotDraft(draft) }
        return result
    }
    return cleanedResult(site, [], characterId, canWrite)
}
export async function deleteCharacter(characterId: number, expected: Character, canWrite: WriteGuard = allowWrite): Promise<{ cleanupWarning: string | null }> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    if (!isCharacterId(characterId) || !isCharacter(expected) || expected.profile.id !== characterId) throw new Error('삭제할 캐릭터를 확인해 주세요.')
    let candidates: string[]
    try {
        ensureWrite(canWrite)
        const { data, error } = await supabase.rpc('delete_character', { p_character_id: characterId, p_expected: expected })
        if (error) throw error
        if (!record(data) || data.character_id !== characterId || !cleanupPaths(data.cleanup_candidates, imagePaths(expected))) throw new Error('invalid_delete_response')
        candidates = data.cleanup_candidates
    } catch (error) { throw writeError(error) }
    queueCleanup(candidates, characterId)
    const cleaned = canWrite() && await retryCleanup(canWrite)
    return { cleanupWarning: cleaned ? null : cleanupMessage('캐릭터는 삭제됐지만 이미지 정리가 남아 있습니다. 다시 시도해 주세요.') }
}
