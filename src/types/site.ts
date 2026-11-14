export interface ThemeColors {
    mainColor: string
    backgroundColor: string
    cardBackgroundColor: string
    typoColor: string
}

export interface ProfileDraft {
    name: string
    statusMessage: string
    file: File | null
    imagePath: string | null
}

export interface SectionDraft {
    id: string
    databaseId?: number
    title: string
    content: string
}

export interface FeedDraft {
    id: string
    name: string
    file?: File
    path?: string
    databaseId?: number
}

export interface SiteEditDraft {
    profile: ProfileDraft
    theme: ThemeColors
    sections: SectionDraft[]
    keywords: string
    feed: FeedDraft[]
}

export interface SiteProfile {
    id: number
    name: string
    status_message: string
    profile_image_path: string | null
}

export interface SiteTheme {
    id: number
    main_color: string
    background_color: string
    card_background_color: string
    typo_color: string
}

export interface SiteSection {
    id: number
    sort_order: number
    title: string
    content: string
}

export interface SiteKeyword {
    id: number
    sort_order: number
    content: string
}

export interface SiteFeedImage {
    id: number
    image_path: string
    sort_order: number
}

export interface SiteData {
    profile: SiteProfile
    theme: SiteTheme
    sections: SiteSection[]
    keywords: SiteKeyword[]
    feed: SiteFeedImage[]
}
