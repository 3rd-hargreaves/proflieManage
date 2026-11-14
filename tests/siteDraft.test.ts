import { describe, expect, it } from 'vitest'
import type { SiteData, SiteEditDraft } from '../src/types/site'
import { buildSaveData, parseKeywords, toDraft, validateSiteDraft } from '../src/utils/siteDraft'
import { themeFields, toThemeColors, toThemeData } from '../src/utils/theme'
import { imageFileName } from '../src/utils/imageFileName'

function fixture(): SiteData {
    return {
        profile: { id: 1, name: '이름', status_message: '상태 메시지', profile_image_path: 'profile/existing.png' },
        theme: { id: 1, main_color: '#123', background_color: '#abcd', card_background_color: '#aabbcc', typo_color: '#aabbccdd' },
        sections: [
            { id: 10, sort_order: 1, title: '첫 제목', content: '첫 *원문*' },
            { id: 11, sort_order: 2, title: '둘째 제목', content: '둘째 _원문_' },
        ],
        keywords: [{ id: 30, sort_order: 1, content: '첫째' }, { id: 31, sort_order: 2, content: '둘째' }],
        feed: [
            { id: 20, sort_order: 1, image_path: 'feed/first.png' },
            { id: 21, sort_order: 2, image_path: 'feed/second.png' },
        ],
    }
}

function imagePaths(draft: SiteEditDraft) {
    return { profile: draft.profile.imagePath, feed: draft.feed.map(image => image.path!) }
}

describe('shared draft validation', () => {
    it('parses keywords without empty entries while retaining their order and duplicates', () => {
        expect(parseKeywords('  둘째, , 첫째 , 둘째,\n셋째 ,')).toEqual(['둘째', '첫째', '둘째', '셋째'])
        expect(parseKeywords(' , \t,\r\n')).toEqual([])
    })

    it('accepts a loaded draft without changing source whitespace or markup', () => {
        const site = fixture()
        site.profile.name = ' 이름 '
        site.sections[0].content = '\r\n  *원문*\n| 가 | 나 |\r\n'
        const draft = toDraft(site)
        const original = structuredClone(draft)

        expect(validateSiteDraft(draft, site.feed.length)).toEqual([])
        expect(draft).toEqual(original)
    })

    it('identifies each invalid field, including the section position, for the form and service', () => {
        const draft = toDraft(fixture())
        draft.theme.mainColor = 'red'
        draft.theme.backgroundColor = '  '
        draft.profile.name = '\t'
        draft.profile.statusMessage = ' '
        draft.sections[1].title = '\r\n'
        draft.sections[1].content = '\t '
        draft.keywords = ', ,'

        expect(validateSiteDraft(draft)).toEqual([
            { field: 'theme', key: 'mainColor', message: '색상코드 형식 불일치' },
            { field: 'theme', key: 'backgroundColor', message: '헥스코드 항목 입력 바람' },
            { field: 'profile.name', message: '이름 항목 입력 바람' },
            { field: 'profile.statusMessage', message: '상태 메시지 항목 입력 바람' },
            { field: 'section', index: 1, key: 'title', message: '섹션 제목 항목 입력 바람' },
            { field: 'section', index: 1, key: 'content', message: '섹션 내용 항목 입력 바람' },
            { field: 'keywords', message: '키워드 한 개 이상 입력 필수' },
        ])
    })

    it.each(['#abc', '#ABCD', ' #aAbBcC ', '#11223344'])('accepts the supported CSS hex format %s', color => {
        const draft = toDraft(fixture())
        draft.theme.mainColor = color
        expect(validateSiteDraft(draft)).toEqual([])
    })

    it('requires a stored path or a selected File for each feed entry', () => {
        const draft = toDraft(fixture())
        draft.feed[1].path = undefined
        expect(validateSiteDraft(draft)).toContainEqual({ field: 'feed', index: 1, message: '피드 이미지 선택 필수' })

        draft.feed[1].file = new File(['image'], 'new.png', { type: 'image/png' })
        expect(validateSiteDraft(draft)).toEqual([])
    })

    it('shares the 50-image limit and preserves the saved over-limit allowance', () => {
        const draft = toDraft(fixture())
        draft.feed = Array.from({ length: 50 }, (_, index) => ({ id: `feed-${index}`, name: 'existing.png', path: `feed/${index}.png` }))
        expect(validateSiteDraft(draft, 2)).toEqual([])

        draft.feed.push({ id: '51', name: 'existing.png', path: 'feed/51.png' })
        expect(validateSiteDraft(draft, 2)).toContainEqual(expect.objectContaining({ field: 'feed', message: expect.stringContaining('피드 이미지 수량 제한(50)') }))
        expect(validateSiteDraft(draft, 51)).toEqual([])

        draft.feed.push({ id: '52', name: 'existing.png', path: 'feed/52.png' })
        expect(validateSiteDraft(draft, 51)).toContainEqual(expect.objectContaining({ field: 'feed', message: expect.stringContaining('피드 이미지 수량 제한(51)') }))
    })
})

describe('database and draft conversion', () => {
    it('loads raw section source, stable database IDs and decoded display names without selected Files', () => {
        const site = fixture()
        const source = '  *원문*\r\n_밑줄_ /기울임/\n| 가 | 나 |\r\n'
        site.sections[0].content = source
        site.feed[0].image_path = 'feed/00000000-0000-4000-8000-000000000001--my_20file_5F.png'

        const draft = toDraft(site)

        expect(draft.profile).toEqual({ name: '이름', statusMessage: '상태 메시지', imagePath: 'profile/existing.png', file: null })
        expect(draft.sections[0]).toEqual({ id: 'section-10', databaseId: 10, title: '첫 제목', content: source })
        expect(draft.feed[0]).toEqual({ id: 'feed-20', databaseId: 20, name: 'my file_.png', path: site.feed[0].image_path })
        expect(draft.feed[0].file).toBeUndefined()
        expect(draft.keywords).toBe('첫째, 둘째')
        expect(draft.sections[0]).not.toBe(site.sections[0])
    })

    it('round-trips loaded content, row IDs and image paths into the save payload', () => {
        const site = fixture()
        const draft = toDraft(site)
        const original = structuredClone(site)

        const data = buildSaveData(draft, site, imagePaths(draft))

        expect(data.profile).toEqual({ name: site.profile.name, status_message: site.profile.status_message, profile_image_path: site.profile.profile_image_path })
        expect(data.theme).toEqual({ main_color: '#123', background_color: '#abcd', card_background_color: '#aabbcc', typo_color: '#aabbccdd' })
        expect(data.sections).toEqual(site.sections.map(({ id, title, content }) => ({ id, title, content })))
        expect(data.keywords).toEqual(site.keywords.map(({ id, content }) => ({ id, content })))
        expect(data.feed).toEqual(site.feed.map(({ id, image_path }) => ({ id, image_path })))
        expect(site).toEqual(original)
    })

    it('trims names, messages, titles, keywords and colors while preserving section source exactly', () => {
        const site = fixture()
        const draft = toDraft(site)
        const source = '\r\n  *원문* _밑줄_ /기울임/\n| 가 | 나 |\r\n'
        draft.profile.name = '  새 이름\t'
        draft.profile.statusMessage = '\n 새 상태  '
        draft.theme.mainColor = ' #AABBCC '
        draft.sections[0].title = '  새 제목\r\n'
        draft.sections[0].content = source
        draft.keywords = '  첫째 , , 둘째  '

        const data = buildSaveData(draft, site, imagePaths(draft))

        expect(data.profile).toMatchObject({ name: '새 이름', status_message: '새 상태' })
        expect(data.theme.main_color).toBe('#AABBCC')
        expect(data.sections[0]).toEqual({ id: 10, title: '새 제목', content: source })
        expect(data.keywords).toEqual([{ id: 30, content: '첫째' }, { id: 31, content: '둘째' }])
        expect(draft.sections[0].content).toBe(source)
        expect(draft.profile.name).toBe('  새 이름\t')
    })

    it('keeps reordered section/feed IDs and uses null IDs for newly added rows', () => {
        const site = fixture()
        const draft = toDraft(site)
        draft.sections.reverse()
        draft.sections.unshift({ id: 'local-new-section', title: '새 제목', content: '새 내용' })
        draft.feed.reverse()
        draft.feed.unshift({ id: 'local-new-feed', name: 'new.png', file: new File(['image'], 'new.png', { type: 'image/png' }) })

        const data = buildSaveData(draft, site, { profile: draft.profile.imagePath, feed: ['feed/uploaded.png', 'feed/second.png', 'feed/first.png'] })

        expect(data.sections.map(row => row.id)).toEqual([null, 11, 10])
        expect(data.feed).toEqual([
            { id: null, image_path: 'feed/uploaded.png' },
            { id: 21, image_path: 'feed/second.png' },
            { id: 20, image_path: 'feed/first.png' },
        ])
    })

    it('retains keyword order and the existing positional keyword ID rule', () => {
        const site = fixture()
        const draft = toDraft(site)
        draft.keywords = ' 둘째, 첫째, 새 키워드, 둘째 '

        expect(buildSaveData(draft, site, imagePaths(draft)).keywords).toEqual([
            { id: 30, content: '둘째' }, { id: 31, content: '첫째' },
            { id: null, content: '새 키워드' }, { id: null, content: '둘째' },
        ])
    })

    it('uses uploaded paths without replacing or modifying selected File objects', () => {
        const site = fixture()
        const draft = toDraft(site)
        const profileFile = new File(['profile'], 'profile.png', { type: 'image/png' })
        const feedFile = new File(['feed'], 'feed.png', { type: 'image/png' })
        draft.profile.file = profileFile
        draft.feed[0].file = feedFile

        const data = buildSaveData(draft, site, { profile: 'profile/new.png', feed: ['feed/new.png', 'feed/second.png'] })

        expect(data.profile.profile_image_path).toBe('profile/new.png')
        expect(data.feed[0]).toEqual({ id: 20, image_path: 'feed/new.png' })
        expect(draft.profile.file).toBe(profileFile)
        expect(draft.feed[0].file).toBe(feedFile)
        expect(draft.profile.imagePath).toBe('profile/existing.png')
        expect(draft.feed[0].path).toBe('feed/first.png')
    })

    it('rejects a missing resolved image path rather than creating a partial payload', () => {
        const site = fixture()
        const draft = toDraft(site)
        expect(() => buildSaveData(draft, site, { profile: null, feed: ['feed/first.png'] })).toThrow('피드 이미지 경로')
    })

    it('continues decoding legacy and reversible storage filenames', () => {
        expect(imageFileName('feed/legacy%20photo.png')).toBe('legacy photo.png')
        expect(imageFileName('feed/00000000-0000-4000-8000-000000000001--_ED_95_9C_EA_B8_80.png')).toBe('한글.png')
        expect(imageFileName('feed/legacy%invalid.png')).toBe('legacy%invalid.png')
    })
})

describe('shared theme field mapping', () => {
    it('defines editor keys, DB columns, CSS variables and labels once with the current mapping', () => {
        expect(themeFields).toEqual([
            { key: 'mainColor', column: 'main_color', variable: '--main-color', label: '메인' },
            { key: 'backgroundColor', column: 'background_color', variable: '--sub-color', label: '배경' },
            { key: 'cardBackgroundColor', column: 'card_background_color', variable: '--background-color', label: '카드 배경' },
            { key: 'typoColor', column: 'typo_color', variable: '--typo-color', label: '글자' },
        ])
        const site = fixture()
        expect(toThemeColors(site.theme)).toEqual({ mainColor: '#123', backgroundColor: '#abcd', cardBackgroundColor: '#aabbcc', typoColor: '#aabbccdd' })
        expect(toThemeData(toThemeColors(site.theme))).toEqual({ main_color: '#123', background_color: '#abcd', card_background_color: '#aabbcc', typo_color: '#aabbccdd' })
    })
})
