import { describe, expect, it } from 'vitest'
import { characterEditPath, characterPath, isEditorPath, resolveRoute } from '../src/utils/routes'

describe('character routes', () => {
    it('keeps profile and editor targets distinct for every character', () => {
        expect(resolveRoute(characterPath(2))).toEqual({ page: 'character', characterId: 2 })
        expect(resolveRoute(characterEditPath(73))).toEqual({ page: 'edit', characterId: 73 })
        expect(isEditorPath('/characters/73/edit/')).toBe(true)
        expect(isEditorPath('/characters/73')).toBe(false)
    })

    it('resolves new forms before IDs and accepts existing aliases', () => {
        expect(resolveRoute('/')).toEqual({ page: 'main' })
        for (const path of ['/characters/new', '/character/new/']) {
            expect(resolveRoute(path)).toEqual({ page: 'new' })
            expect(isEditorPath(path)).toBe(true)
        }
        for (const path of ['/edit', '/edit/', '/manage.html', '/manage.html/']) {
            expect(resolveRoute(path)).toEqual({ page: 'edit', characterId: 1 })
        }
        expect(resolveRoute('/character/2/')).toEqual({ page: 'character', characterId: 2 })
    })

    it.each(['/characters/0', '/characters/-1', '/characters/01', '/characters/1.5',
        '/characters/9007199254740992', '/characters/nope/edit', '/characters/new/edit',
        '/characters/2/extra', '/unrelated'])('does not substitute character 1 for invalid path %s', path => {
        expect(resolveRoute(path)).toEqual({ page: 'notFound' })
        expect(isEditorPath(path)).toBe(false)
    })
})
