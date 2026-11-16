import type { SiteData, SiteEditDraft } from '../types/site'
import { themeFields } from './theme.ts'

export function isEditorDirty(site: SiteData | null, draft: SiteEditDraft | null): boolean {
    if (!site || !draft) return false
    if (draft.profile.file || draft.feed.some(image => image.file)) return true
    if (draft.profile.name !== site.profile.name
        || draft.profile.statusMessage !== site.profile.status_message
        || draft.profile.imagePath !== site.profile.profile_image_path
        || draft.keywords !== site.keywords.map(keyword => keyword.content).join(', ')) return true
    if (themeFields.some(({ key, column }) => draft.theme[key] !== site.theme[column])) return true
    if (draft.sections.length !== site.sections.length || draft.feed.length !== site.feed.length) return true
    return draft.sections.some((section, index) => {
        const saved = site.sections[index]
        return section.databaseId !== saved.id || section.title !== saved.title || section.content !== saved.content
    }) || draft.feed.some((image, index) => {
        const saved = site.feed[index]
        return image.databaseId !== saved.id || image.path !== saved.image_path
    })
}
