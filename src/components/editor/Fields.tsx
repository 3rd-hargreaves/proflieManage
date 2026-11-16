import FeedEditor from './FeedEditor'
import ProfileEditor from './ProfileEditor'
import SectionEditor from './SectionEditor'
import ThemeEditor from './ThemeEditor'
import SortableList from '../common/SortableList'
import type { Draft } from '../../types/models'
import type { SortLock } from '../../utils/sortLock'

interface FieldsProps {
    draft: Draft
    change: (draft: Draft) => void
    addSection: () => void
    focusId?: string | null
    sorting: boolean
    sortLock: SortLock
    disabled: boolean
    maxFeedCount: number
    saving?: boolean
}

export default function Fields({ draft, change, addSection, focusId, sorting, sortLock, disabled, maxFeedCount, saving = false }: FieldsProps) {
    return (
        <>
            <ThemeEditor value={draft.theme} onChange={(key, value) => change({ ...draft, theme: { ...draft.theme, [key]: value } })} />
            <ProfileEditor value={draft.profile} onChange={profile => change({ ...draft, profile })} />
            <div id="sections" className="widthFull flexColumn gapLg">
                <p className="text3">↕ 순서 이동 버튼을 드래그해 순서 이동</p>
                <SortableList
                    items={draft.sections}
                    label="섹션 순서"
                    className="flexColumn gapLg"
                    getLabel={section => section.title || '제목 없는 섹션'}
                    onChange={sections => change({ ...draft, sections })}
                    listId="sections"
                    sortLock={sortLock}
                    disabled={disabled}
                >
                    {(section, handleProps) => (
                        <SectionEditor
                            value={section}
                            autoFocus={section.id === focusId}
                            dragHandle={<button {...handleProps} className="btn dragHandle h30 widthFull border borderRad pdSide"><span aria-hidden="true">↕</span> 순서 이동</button>}
                            sorting={sorting}
                            onChange={value => change({ ...draft, sections: draft.sections.map(item => item.id === value.id ? value : item) })}
                            onDelete={() => change({ ...draft, sections: draft.sections.filter(item => item.id !== section.id) })}
                        />
                    )}
                </SortableList>
                <button
                    id="addSectionBtn"
                    className="btn h30 border borderRad"
                    type="button"
                    disabled={sorting}
                    onClick={addSection}
                >섹션 추가</button>
            </div>
            <div className="card widthFull pdLg flexColumn gapSm">
                <p className="widthFull text2 mainColorText bold">키워드</p>
                <p className="text3"> ,로 구분 </p>
                <input
                    id="keywords"
                    className="widthFull h30 pdSide border borderRad"
                    type="text"
                    placeholder="키워드"
                    aria-label="키워드"
                    value={draft.keywords}
                    onChange={event => {
                        event.currentTarget.setCustomValidity('')
                        change({ ...draft, keywords: event.currentTarget.value })
                    }}
                />
            </div>
            <FeedEditor value={draft.feed} onChange={feed => change({ ...draft, feed })} disabled={disabled} sorting={sorting} sortLock={sortLock} maxCount={maxFeedCount} />
            <button className="btn h30 border borderRad widthFull" type="submit" disabled={sorting}>{saving ? '저장 중…' : '저장'}</button>
        </>
    )
}
