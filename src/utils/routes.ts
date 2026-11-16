export type PageRoute =
    | { page: 'main' | 'new' | 'notFound' }
    | { page: 'character' | 'edit', characterId: number }

export function resolveRoute(path: string): PageRoute {
    const normalized = path.replace(/\/$/, '') || '/'
    if (normalized === '/') return { page: 'main' }
    if (['/characters/new', '/character/new'].includes(normalized)) return { page: 'new' }
    if (['/edit', '/manage.html'].includes(normalized)) return { page: 'edit', characterId: 1 }
    const match = /^\/characters?\/([1-9]\d*)(\/edit)?$/.exec(normalized)
    if (match && Number.isSafeInteger(Number(match[1]))) {
        return { page: match[2] ? 'edit' : 'character', characterId: Number(match[1]) }
    }
    return { page: 'notFound' }
}

export const characterPath = (id: number) => `/characters/${id}`
export const characterEditPath = (id: number) => `${characterPath(id)}/edit`

export function isEditorPath(path: string): boolean {
    const route = resolveRoute(path)
    return route.page === 'new' || route.page === 'edit'
}
