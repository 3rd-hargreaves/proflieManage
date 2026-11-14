import type { SiteData, SiteEditDraft } from '../types/site'

export function isEditorDirty(site: SiteData | null, draft: SiteEditDraft | null): boolean {
    if (!site || !draft) return false
    if (draft.profile.file || draft.feed.some(image => image.file)) return true
    if (draft.profile.name !== site.profile.name
        || draft.profile.statusMessage !== site.profile.status_message
        || draft.profile.imagePath !== site.profile.profile_image_path
        || draft.keywords !== site.keywords.map(keyword => keyword.content).join(', ')) return true
    if (draft.theme.mainColor !== site.theme.main_color
        || draft.theme.backgroundColor !== site.theme.background_color
        || draft.theme.cardBackgroundColor !== site.theme.card_background_color
        || draft.theme.typoColor !== site.theme.typo_color) return true
    if (draft.sections.length !== site.sections.length || draft.feed.length !== site.feed.length) return true
    return draft.sections.some((section, index) => {
        const saved = site.sections[index]
        return section.databaseId !== saved.id || section.title !== saved.title || section.content !== saved.content
    }) || draft.feed.some((image, index) => {
        const saved = site.feed[index]
        return image.databaseId !== saved.id || image.path !== saved.image_path
    })
}
