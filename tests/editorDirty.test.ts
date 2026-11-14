import assert from 'node:assert/strict'
import test from 'node:test'
import { isEditorDirty } from '../src/utils/editorDirty.ts'
import type { SiteData, SiteEditDraft } from '../src/types/site.ts'

function fixture(): { site: SiteData, draft: SiteEditDraft } {
    return {
        site: {
            profile: { id: 1, name: '이름', status_message: '상태', profile_image_path: 'profile/old.png' },
            theme: { id: 1, main_color: '#123', background_color: '#fff', card_background_color: '#fff', typo_color: '#222' },
            sections: [{ id: 1, sort_order: 1, title: 'A', content: '*원문*' }, { id: 2, sort_order: 2, title: 'B', content: '내용' }],
            keywords: [{ id: 1, sort_order: 1, content: '키워드' }],
            feed: [{ id: 1, sort_order: 1, image_path: 'feed/a.png' }, { id: 2, sort_order: 2, image_path: 'feed/b.png' }],
        },
        draft: {
            profile: { name: '이름', statusMessage: '상태', imagePath: 'profile/old.png', file: null },
            theme: { mainColor: '#123', backgroundColor: '#fff', cardBackgroundColor: '#fff', typoColor: '#222' },
            sections: [{ id: 'one', databaseId: 1, title: 'A', content: '*원문*' }, { id: 'two', databaseId: 2, title: 'B', content: '내용' }],
            keywords: '키워드',
            feed: [{ id: 'one', databaseId: 1, path: 'feed/a.png', name: 'a.png' }, { id: 'two', databaseId: 2, path: 'feed/b.png', name: 'b.png' }],
        },
    }
}

test('loading and a freshly loaded draft do not block leaving', () => {
    const { site, draft } = fixture()
    assert.equal(isEditorDirty(null, null), false)
    assert.equal(isEditorDirty(site, null), false)
    assert.equal(isEditorDirty(site, draft), false)
})
test('text edits become clean again when reverted', () => {
    const { site, draft } = fixture()
    draft.profile.name = '수정'
    assert.equal(isEditorDirty(site, draft), true)
    draft.profile.name = site.profile.name
    assert.equal(isEditorDirty(site, draft), false)
    draft.sections[0].content += '\n'
    assert.equal(isEditorDirty(site, draft), true)
})
test('theme and keyword changes count as unsaved edits', () => {
    const { site, draft } = fixture()
    draft.theme.mainColor = '#456'
    assert.equal(isEditorDirty(site, draft), true)
    draft.theme.mainColor = site.theme.main_color
    draft.keywords += ', 새 키워드'
    assert.equal(isEditorDirty(site, draft), true)
})
test('section reorder, removal and new row identity are detected', () => {
    const { site, draft } = fixture()
    draft.sections.reverse()
    assert.equal(isEditorDirty(site, draft), true)
    draft.sections.reverse()
    draft.sections[0].databaseId = undefined
    assert.equal(isEditorDirty(site, draft), true)
    draft.sections.pop()
    assert.equal(isEditorDirty(site, draft), true)
})
test('feed order and path changes are detected without comparing display names', () => {
    const { site, draft } = fixture()
    draft.feed[0].name = '표시 이름'
    assert.equal(isEditorDirty(site, draft), false)
    draft.feed.reverse()
    assert.equal(isEditorDirty(site, draft), true)
    draft.feed.reverse()
    draft.feed[0].path = 'feed/new.png'
    assert.equal(isEditorDirty(site, draft), true)
})
test('selected profile and feed Files stay dirty even when filenames match', () => {
    const { site, draft } = fixture()
    draft.profile.file = new File(['x'], 'old.png', { type: 'image/png' })
    assert.equal(isEditorDirty(site, draft), true)
    draft.profile.file = null
    draft.feed[0].file = new File(['x'], 'a.png', { type: 'image/png' })
    assert.equal(isEditorDirty(site, draft), true)
})
