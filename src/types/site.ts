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
}

export interface SectionDraft {
  id: string
  title: string
  content: string
}

export interface FeedDraft {
  id: string
  name: string
  file?: File
}
