import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import CharacterFields from '../components/CharacterFields'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useMainQuery } from '../hooks/useSiteQuery'
import { useSortLock } from '../hooks/useSortLock'
import type { MainData, SiteData, SiteEditDraft, SiteTheme } from '../types/site'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { MAX_FEED_IMAGES } from '../utils/uploadLimits'
import { isHexColor } from '../utils/validation'

interface NewCharacterPageProps {
    onLeaveGuardChange: (guard: LeaveGuard) => void
    authBlocked: boolean
}

interface NewEditor {
    baseline: SiteData
    draft: SiteEditDraft
}

function emptyCharacter(theme: SiteTheme): SiteData {
    return {
        profile: { id: 1, name: '', status_message: '', profile_image_path: null },
        theme,
        sections: [], keywords: [], feed: [],
    }
}

export default function NewCharacterPage({ onLeaveGuardChange, authBlocked }: NewCharacterPageProps) {
    const [editor, setEditor] = useState<NewEditor | null>(null)
    const currentEditor = useRef<NewEditor | null>(null)
    const blocked = useRef(authBlocked)
    useLayoutEffect(() => { blocked.current = authBlocked }, [authBlocked])
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const { lock, activeListId } = useSortLock()
    const sorting = activeListId !== null

    const initialize = useCallback((main: MainData) => {
        const baseline = emptyCharacter(main.theme)
        const next = { baseline, draft: toDraft(baseline) }
        currentEditor.current = next
        setEditor(next)
    }, [])
    const { state: query, reload } = useMainQuery({ onLoad: initialize })

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(currentEditor.current?.baseline ?? null, currentEditor.current?.draft ?? null)
            || lock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [lock, onLeaveGuardChange])

    useEffect(() => {
        const previousTitle = document.title
        document.title = '캐릭터 추가'
        return () => { document.title = previousTitle }
    }, [])

    const draft = query.status === 'ready' ? editor?.draft : null
    const theme = draft?.theme
    useEffect(() => {
        if (!theme || !themeFields.every(({ key }) => isHexColor(theme[key]))) return
        return applyTheme({ id: 1, ...toThemeData(theme) })
    }, [theme])

    function change(next: SiteEditDraft) {
        if (blocked.current || !currentEditor.current) return
        const value = { ...currentEditor.current, draft: next }
        currentEditor.current = value
        setEditor(value)
    }

    function addSection() {
        if (blocked.current || lock.getOwner() !== null || !currentEditor.current) return
        const id = crypto.randomUUID()
        const draft = currentEditor.current.draft
        change({ ...draft, sections: [...draft.sections, { id, title: '', content: '' }] })
        setFocusedSection(id)
    }

    return (
        <main className="flexColumn gapLg" aria-busy={query.status === 'loading'}>
            <h1 className="text2 mainColorText bold">캐릭터 추가</h1>
            <p className="card pdLg text3" id="newCharacterNotice">신규 캐릭터 저장은 준비 중입니다.</p>
            {query.status === 'loading' && <p className="card pdLg text3" role="status">기본 테마를 불러오는 중…</p>}
            {query.status === 'error' && (
                <div className="card pdLg flexColumn gapSm">
                    <p role="alert">{query.message}</p>
                    <button className="btn h30 border borderRad" type="button" onClick={reload}>다시 시도</button>
                </div>
            )}
            {authBlocked && <p className="card pdLg text3" role="status">로그인 상태를 확인해 주세요. 입력한 내용은 유지됩니다.</p>}
            {draft && (
                <form className="flexColumn gapLg" onSubmit={event => event.preventDefault()} aria-describedby="newCharacterNotice">
                    <fieldset className="editorFields flexColumn gapLg" disabled={authBlocked}>
                        <CharacterFields draft={draft} change={change} addSection={addSection}
                            focusedSection={focusedSection} sorting={sorting} sortLock={lock}
                            editingDisabled={authBlocked} maxFeedCount={MAX_FEED_IMAGES} saveDisabled />
                    </fieldset>
                </form>
            )}
        </main>
    )
}
