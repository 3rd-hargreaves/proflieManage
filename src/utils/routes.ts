export type PageRoute =
    | { page: 'main' | 'new' | 'notFound' }
    | { page: 'character' | 'edit', characterId: string }

export function resolveRoute(path: string): PageRoute {
    const normalized = path.replace(/\/$/, '') || '/'
    if (normalized === '/') return { page: 'main' }
    if (normalized === '/characters/new') return { page: 'new' }
    if (['/edit', '/manage.html'].includes(normalized)) return { page: 'edit', characterId: '1' }
    const match = /^\/characters\/([1-9]\d*)(\/edit)?$/.exec(normalized)
    if (match) return { page: match[2] ? 'edit' : 'character', characterId: match[1] }
    return { page: 'notFound' }
}

export function isEditorPath(path: string): boolean {
    const route = resolveRoute(path)
    return route.page === 'new' || route.page === 'edit'
}
