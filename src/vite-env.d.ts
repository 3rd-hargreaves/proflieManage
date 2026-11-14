interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string
    readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
    readonly VITE_ADMIN_EMAIL?: string
    readonly VITE_ADMIN_USER_ID?: string
    readonly VITE_SUPABASE_STORAGE_BUCKET?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
