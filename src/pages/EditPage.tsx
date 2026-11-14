import { useEffect, useRef } from 'react'
import type { SubmitEvent } from 'react'
import FeedEditor from '../components/FeedEditor'
import ProfileEditor from '../components/ProfileEditor'
import SectionEditor from '../components/SectionEditor'
import ThemeEditor from '../components/ThemeEditor'
import SortableList from '../components/SortableList'
import { applyTheme, themeFields, toThemeData } from '../utils/theme'
import { isHexColor } from '../utils/validation'
import { validateSiteDraft } from '../utils/siteDraft'
import type { DraftValidationIssue } from '../utils/siteDraft'
import { feedImageLimit } from '../utils/uploadLimits'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useSiteEditor } from '../hooks/useSiteEditor'

function validationField(form: HTMLFormElement, issue: DraftValidationIssue): HTMLInputElement | HTMLTextAreaElement | null {
    switch (issue.field) {
        case 'profile.name': return form.querySelector('#profileName')
        case 'profile.statusMessage': return form.querySelector('#profileMessage')
        case 'keywords': return form.querySelector('#keywords')
        case 'theme': {
            const variable = themeFields.find(field => field.key === issue.key)?.variable
            return variable ? form.querySelector(`[data-theme="${variable}"]`) : null
        }
        case 'section':
            return form.querySelectorAll('[data-section]')[issue.index]?.querySelector(issue.key === 'title' ? 'input' : 'textarea') ?? null
        case 'feed': return null
    }
}

interface EditPageProps {
    onLogout: () => Promise<void>
    signingOut: boolean
    logoutError: string | null
    authNotice: { message: string, checking: boolean, requiresLogin: boolean } | null
    onRetryAuth: () => void
    onReauthenticate: () => void
    onExit: () => void
    onLeaveGuardChange: (guard: LeaveGuard) => void
    canWrite: () => boolean
}

export default function EditPage({ onLogout, signingOut, logoutError, authNotice, onRetryAuth, onReauthenticate, onExit, onLeaveGuardChange, canWrite }: EditPageProps) {
    const form = useRef<HTMLFormElement>(null)
    const {
        baseline, draft, loading, loadError, focusedSection, saving, saveError, saved,
        cleanupWarning, cleaning, editorVersion, sorting, sortLock, editingDisabled,
        pendingCleanupCount, change, addSection, reload, canSave, save: saveDraft, retryCleanup, reportError,
    } = useSiteEditor({ signingOut, authBlocked: !!authNotice, canWrite, onLeaveGuardChange })

    useEffect(() => {
        const previousTitle = document.title
        document.title = '관리자'
        return () => { document.title = previousTitle }
    }, [])

    const theme = draft?.theme
    useEffect(() => {
        if (!theme || !themeFields.every(({ key }) => isHexColor(theme[key]))) return
        return applyTheme({ id: 1, ...toThemeData(theme) })
    }, [theme])

    async function save(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!form.current || !draft || !baseline || !canSave()) return

        const fields = form.current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="file"]), textarea')
        for (const field of fields) field.setCustomValidity('')
        const issues = validateSiteDraft(draft, baseline.feed.length)
        for (const issue of issues) validationField(form.current, issue)?.setCustomValidity(issue.message)
        if (issues.length) {
            const field = validationField(form.current, issues[0])
            if (field) field.reportValidity()
            else reportError(issues[0].message)
            return
        }
        await saveDraft()
    }

    return (
        <main className="flexColumn gapLg" aria-busy={loading || saving}>
            {authNotice && (
                <div className="card pdLg flexColumn gapSm">
                    <p role={authNotice.checking ? 'status' : 'alert'}>{authNotice.message}</p>
                    <button className="btn h30 border borderRad" type="button"
                        disabled={authNotice.checking || saving || cleaning || sorting || signingOut}
                        onClick={authNotice.requiresLogin ? onReauthenticate : onRetryAuth}>
                        {authNotice.checking ? '로그인 확인 중…' : authNotice.requiresLogin ? '다시 로그인' : '다시 확인'}
                    </button>
                    <button className="btn h30 border borderRad" type="button" disabled={saving || cleaning || sorting || signingOut} onClick={onExit}>메인으로</button>
                </div>
            )}
            {loading && <p className="card pdLg text3" role="status">수정할 정보를 불러오는 중…</p>}
            {loadError && (
                <div className="card pdLg flexColumn gapMd">
                    <p role="alert">{loadError}</p>
                    <button className="btn h30 border borderRad" type="button" onClick={reload}>다시 시도</button>
                </div>
            )}
            {draft && !loading && (
                <form ref={form} className="flexColumn gapLg" noValidate onSubmit={save}>
                    <fieldset className="editorFields flexColumn gapLg" disabled={editingDisabled} key={editorVersion}>
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
                                disabled={editingDisabled}
                            >
                                {(section, handleProps) => (
                                    <SectionEditor
                                        value={section}
                                        autoFocus={section.id === focusedSection}
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
                        <FeedEditor value={draft.feed} onChange={feed => change({ ...draft, feed })} disabled={editingDisabled} sorting={sorting} sortLock={sortLock} maxCount={feedImageLimit(baseline?.feed.length ?? 0)} />
                        <button className="btn h30 border borderRad widthFull" type="submit" disabled={sorting}>{saving ? '저장 중…' : '저장'}</button>
                    </fieldset>
                    {saved && <p role="status">저장 성공</p>}
                    {saveError && (
                        <div className="card pdLg flexColumn gapSm">
                            <p role="alert">{saveError}</p>
                            <button className="btn border borderRad pdSm" type="button" disabled={editingDisabled || sorting} onClick={reload}>
                                편집 내용을 버리고 DB에서 다시 불러오기
                            </button>
                        </div>
                    )}
                    {cleanupWarning && (
                        <div className="card pdLg flexColumn gapSm">
                            <p role="status">{cleanupWarning}</p>
                            {pendingCleanupCount > 0 && (
                                <button className="btn h30 border borderRad" type="button" disabled={editingDisabled || sorting} onClick={retryCleanup}>
                                    {cleaning ? '이미지 정리 중…' : '이미지 정리 다시 시도'}
                                </button>
                            )}
                        </div>
                    )}
                </form>
            )}
            <button className="btn h30 border borderRad" type="button" disabled={editingDisabled || sorting} onClick={onLogout}>
                {signingOut ? '로그아웃 중…' : '로그아웃'}
            </button>
            {logoutError && <p role="alert">{logoutError}</p>}
        </main>
    )
}
