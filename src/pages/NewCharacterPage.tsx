import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import CharacterFields from '../components/CharacterFields'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useSortLock } from '../hooks/useSortLock'
import type { SiteData, SiteEditDraft } from '../types/site'
import { isEditorDirty } from '../utils/editorDirty'
import { toDraft } from '../utils/siteDraft'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { MAX_FEED_IMAGES } from '../utils/uploadLimits'
import { isHexColor } from '../utils/validation'

interface NewCharacterPageProps {
    onLeaveGuardChange: (guard: LeaveGuard) => void
    authBlocked: boolean
}

function emptyCharacter(): SiteData {
    return {
        profile: { id: 1, name: '', status_message: '', profile_image_path: null },
        theme: { id: 1, main_color: '#E45C9A', background_color: '#FDE8F0', card_background_color: '#FFFFFF', typo_color: '#26232A' },
        sections: [], keywords: [], feed: [],
    }
}

export default function NewCharacterPage({ onLeaveGuardChange, authBlocked }: NewCharacterPageProps) {
    const [baseline] = useState(emptyCharacter)
    const [draft, setDraft] = useState(() => toDraft(baseline))
    const currentDraft = useRef(draft)
    const blocked = useRef(authBlocked)
    useLayoutEffect(() => { blocked.current = authBlocked }, [authBlocked])
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const { lock, activeListId } = useSortLock()
    const sorting = activeListId !== null

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(baseline, currentDraft.current) || lock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [baseline, lock, onLeaveGuardChange])

    useEffect(() => {
        const previousTitle = document.title
        document.title = '캐릭터 추가'
        return () => { document.title = previousTitle }
    }, [])

    useEffect(() => {
        if (!themeFields.every(({ key }) => isHexColor(draft.theme[key]))) return
        return applyTheme({ id: 1, ...toThemeData(draft.theme) })
    }, [draft.theme])

    function change(next: SiteEditDraft) {
        if (blocked.current) return
        currentDraft.current = next
        setDraft(next)
    }

    function addSection() {
        if (blocked.current || lock.getOwner() !== null) return
        const id = crypto.randomUUID()
        change({ ...currentDraft.current, sections: [...currentDraft.current.sections, { id, title: '', content: '' }] })
        setFocusedSection(id)
    }

    return (
        <main className="flexColumn gapLg">
            <h1 className="text2 mainColorText bold">캐릭터 추가</h1>
            <p className="card pdLg text3" id="newCharacterNotice">신규 캐릭터 저장은 준비 중입니다.</p>
            {authBlocked && <p className="card pdLg text3" role="status">로그인 상태를 확인해 주세요. 입력한 내용은 유지됩니다.</p>}
            <form className="flexColumn gapLg" onSubmit={event => event.preventDefault()} aria-describedby="newCharacterNotice">
                <fieldset className="editorFields flexColumn gapLg" disabled={authBlocked}>
                    <CharacterFields draft={draft} change={change} addSection={addSection}
                        focusedSection={focusedSection} sorting={sorting} sortLock={lock}
                        editingDisabled={authBlocked} maxFeedCount={MAX_FEED_IMAGES} saveDisabled />
                </fieldset>
            </form>
        </main>
    )
}
