export type CharacterId = number

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

export interface Draft {
    profile: ProfileDraft
    theme: ThemeColors
    sections: SectionDraft[]
    keywords: string
    feed: FeedDraft[]
}

export interface Profile {
    id: CharacterId
    name: string
    status_message: string
    profile_image_path: string | null
}

export interface Theme {
    id: number
    main_color: string
    background_color: string
    card_background_color: string
    typo_color: string
}

export interface Section {
    id: number
    sort_order: number
    title: string
    content: string
}

export interface Keyword {
    id: number
    sort_order: number
    content: string
}

export interface FeedImage {
    id: number
    image_path: string
    sort_order: number
}

export interface Character {
    profile: Profile
    theme: Theme
    sections: Section[]
    keywords: Keyword[]
    feed: FeedImage[]
}

export interface CharacterSummary extends Profile {
    sort_order: number
}

export interface MainData {
    characters: CharacterSummary[]
    theme: Theme
}
