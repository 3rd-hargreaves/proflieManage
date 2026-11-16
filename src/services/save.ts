import { supabase } from '../lib/supabase'
import type { SiteData, SiteEditDraft } from '../types/site'
import { buildSaveData, validateSiteDraft } from '../utils/siteDraft'
import type { SiteSaveData } from '../utils/siteDraft'
import { isCharacterId, isSiteData } from '../utils/siteData'
import { isCleanupPath } from '../utils/cleanupJournal'
import { imageCleanupWarning, queueImageCleanup, retryImageCleanup, uploadImage, validateImageFile } from './storage'
import { allowWrite, ensureWrite, writeError } from './write'
import type { WriteGuard } from './write'

export { getPendingImageCleanupCount } from './storage'
export interface SaveResult { site: SiteData, cleanupWarning: string | null }
type CreationState =
    | { phase: 'idle' }
    | { phase: 'reserved', characterId: number }
    | { phase: 'prepared' | 'uncertain', characterId: number, payload: SiteSaveData, uploadPaths: string[], submittedDraft: SiteEditDraft }
    | { phase: 'confirmed', site: SiteData, savedDraft: SiteEditDraft }

export interface CreationContext {
    requestId: string
    state: CreationState
}
export function createCharacterContext(): CreationContext {
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
function imagePaths(site: SiteData): Set<string> {
    const paths = new Set(site.feed.map(image => image.image_path))
    if (site.profile.profile_image_path) paths.add(site.profile.profile_image_path)
    return paths
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function cleanupPaths(value: unknown, candidates: Set<string>): value is string[] {
    return Array.isArray(value) && value.every(path => typeof path === 'string' && isCleanupPath(path) && candidates.has(path))
}
function savedEnvelope(value: unknown, characterId: number, candidates: Set<string>): { character: SiteData, cleanup_candidates: string[] } {
    if (!record(value) || !isSiteData(value.character) || value.character.profile.id !== characterId
        || !cleanupPaths(value.cleanup_candidates, candidates)) throw new Error('invalid_save_response')
    return { character: value.character, cleanup_candidates: value.cleanup_candidates }
}
function validate(draft: SiteEditDraft, savedFeedCount = 0, characterId?: number) {
    const issues = validateSiteDraft(draft, savedFeedCount)
    if (issues.length) throw new Error(issues[0].message)
    if (draft.profile.file) validateImageFile(draft.profile.file, 'profile', characterId)
    for (const image of draft.feed) if (image.file) validateImageFile(image.file, 'feed', characterId)
}
async function cleanedResult(site: SiteData, paths: Iterable<string>, characterId: number, canWrite: WriteGuard): Promise<SaveResult> {
    queueImageCleanup(paths, characterId)
    const cleaned = canWrite() && await retryImageCleanup(canWrite)
    return { site, cleanupWarning: cleaned ? null : imageCleanupWarning('내용은 저장됐지만 이전 이미지 정리가 완료되지 않았습니다. 이미지 정리를 다시 시도해 주세요.') }
}
async function uploadData(draft: SiteEditDraft, expected: SiteData, characterId: number, canWrite: WriteGuard): Promise<{ payload: SiteSaveData, newPaths: string[] }> {
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
        queueImageCleanup(newPaths, characterId)
        if (canWrite()) await retryImageCleanup(canWrite)
        throw error
    }
    return { payload: buildSaveData(draft, expected, { profile, feed }), newPaths }
}
export async function saveCharacter(characterId: number, draft: SiteEditDraft, expected: SiteData, canWrite: WriteGuard = allowWrite): Promise<SaveResult> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    if (!isCharacterId(characterId) || !isSiteData(expected) || expected.profile.id !== characterId) throw new Error('수정할 캐릭터를 확인해 주세요.')
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
            queueImageCleanup(newPaths, characterId)
            if (canWrite()) await retryImageCleanup(canWrite)
        }
        throw writeError(error)
    }
    const retained = imagePaths(envelope.character)
    const candidates = new Set([...envelope.cleanup_candidates, ...Array.from(imagePaths(expected)).filter(path => !retained.has(path))])
    return cleanedResult(envelope.character, candidates, characterId, canWrite)
}
function snapshotDraft(draft: SiteEditDraft): SiteEditDraft {
    return { ...draft, profile: { ...draft.profile }, theme: { ...draft.theme }, sections: draft.sections.map(row => ({ ...row })), feed: draft.feed.map(row => ({ ...row })) }
}
function sameDraft(first: SiteEditDraft, current: SiteEditDraft): boolean {
    return JSON.stringify(first) === JSON.stringify(current) && first.profile.file === current.profile.file
        && first.feed.every((row, index) => row.file === current.feed[index]?.file)
}
function adoptCreatedIds(draft: SiteEditDraft, submitted: SiteEditDraft, site: SiteData): SiteEditDraft {
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
export async function createCharacter(draft: SiteEditDraft, context: CreationContext, canWrite: WriteGuard = allowWrite): Promise<SaveResult> {
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
        const emptyBaseline: SiteData = {
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
        let site: SiteData
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
                queueImageCleanup(pending.uploadPaths, characterId)
                context.state = { phase: 'reserved', characterId }
                if (canWrite()) await retryImageCleanup(canWrite)
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
export async function deleteCharacter(characterId: number, expected: SiteData, canWrite: WriteGuard = allowWrite): Promise<{ cleanupWarning: string | null }> {
    if (!supabase) throw new Error('사이트 연결 설정을 확인해 주세요.')
    ensureWrite(canWrite)
    if (!isCharacterId(characterId) || !isSiteData(expected) || expected.profile.id !== characterId) throw new Error('삭제할 캐릭터를 확인해 주세요.')
    let candidates: string[]
    try {
        ensureWrite(canWrite)
        const { data, error } = await supabase.rpc('delete_character', { p_character_id: characterId, p_expected: expected })
        if (error) throw error
        if (!record(data) || data.character_id !== characterId || !cleanupPaths(data.cleanup_candidates, imagePaths(expected))) throw new Error('invalid_delete_response')
        candidates = data.cleanup_candidates
    } catch (error) { throw writeError(error) }
    queueImageCleanup(candidates, characterId)
    const cleaned = canWrite() && await retryImageCleanup(canWrite)
    return { cleanupWarning: cleaned ? null : imageCleanupWarning('캐릭터는 삭제됐지만 이미지 정리가 남아 있습니다. 다시 시도해 주세요.') }
}
