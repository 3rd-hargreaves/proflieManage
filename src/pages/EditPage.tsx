import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import FeedEditor from '../components/FeedEditor'
import ProfileEditor from '../components/ProfileEditor'
import SectionEditor from '../components/SectionEditor'
import ThemeEditor from '../components/ThemeEditor'
import SortableList from '../components/SortableList'
import { loadSite } from '../services/site'
import { getPendingImageCleanupCount, imageFileName, retryImageCleanup, saveSite } from '../services/save'
import type { SiteData, SiteEditDraft } from '../types/site'
import { applyTheme } from '../utils/theme'
import { isHexColor, validateRequired } from '../utils/validation'
import { isEditorDirty } from '../utils/editorDirty'
import type { LeaveGuard } from '../hooks/useGuardedNavigation'
import { useSortLock } from '../hooks/useSortLock'

function toDraft(site: SiteData): SiteEditDraft {
    return {
        profile: {
            name: site.profile.name,
            statusMessage: site.profile.status_message,
            imagePath: site.profile.profile_image_path,
            file: null,
        },
        theme: {
            mainColor: site.theme.main_color,
            backgroundColor: site.theme.background_color,
            cardBackgroundColor: site.theme.card_background_color,
            typoColor: site.theme.typo_color,
        },
        sections: site.sections.map(section => ({
            id: `section-${section.id}`, databaseId: section.id, title: section.title, content: section.content,
        })),
        keywords: site.keywords.map(keyword => keyword.content).join(', '),
        feed: site.feed.map(image => ({
            id: `feed-${image.id}`, databaseId: image.id, name: imageFileName(image.image_path), path: image.image_path,
        })),
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
    const savingRef = useRef(false)
    const { lock: sortLock, activeListId } = useSortLock()
    const sorting = activeListId !== null
    const mounted = useRef(true)
    const cleaningRef = useRef(false)
    const leaveState = useRef<{ baseline: SiteData | null, draft: SiteEditDraft | null }>({ baseline: null, draft: null })
    const [baseline, setBaseline] = useState<SiteData | null>(null)
    const [draft, setDraft] = useState<SiteEditDraft | null>(null)
    const [loadAttempt, setLoadAttempt] = useState(0)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [focusedSection, setFocusedSection] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    const [cleanupWarning, setCleanupWarning] = useState<string | null>(null)
    const [cleaning, setCleaning] = useState(false)
    const [editorVersion, setEditorVersion] = useState(0)
    const editingDisabled = saving || signingOut || cleaning || !!authNotice

    useEffect(() => {
        onLeaveGuardChange(() => isEditorDirty(leaveState.current.baseline, leaveState.current.draft)
            || savingRef.current || cleaningRef.current || sortLock.getOwner() !== null)
        return () => onLeaveGuardChange(null)
    }, [onLeaveGuardChange, sortLock])

    useEffect(() => {
        mounted.current = true
        const previousTitle = document.title
        document.title = '관리자'
        return () => {
            mounted.current = false
            document.title = previousTitle
        }
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const site = await loadSite(controller.signal)
                if (controller.signal.aborted) return
                const nextDraft = toDraft(site)
                leaveState.current = { baseline: site, draft: nextDraft }
                setBaseline(site)
                setDraft(nextDraft)
                setEditorVersion(version => version + 1)
                setLoading(false)
            } catch (error) {
                if (controller.signal.aborted) return
                controller.abort()
                setLoadError(error instanceof Error ? error.message : '수정할 정보를 불러오지 못했습니다.')
                setLoading(false)
            }
        }
        void load()
        return () => controller.abort()
    }, [loadAttempt])

    const theme = draft?.theme
    useEffect(() => {
        if (!theme || !Object.values(theme).every(isHexColor)) return
        return applyTheme({
            id: 1,
            main_color: theme.mainColor,
            background_color: theme.backgroundColor,
            card_background_color: theme.cardBackgroundColor,
            typo_color: theme.typoColor,
        })
    }, [theme])

    function change(next: SiteEditDraft) {
        leaveState.current.draft = next
        setDraft(next)
        setSaved(false)
    }

    function reload() {
        if (savingRef.current || sortLock.getOwner() !== null || cleaning || authNotice || !canWrite()) return
        setLoading(true)
        setLoadError(null)
        setSaveError(null)
        setSaved(false)
        setDraft(null)
        setBaseline(null)
        leaveState.current = { baseline: null, draft: null }
        setFocusedSection(null)
        setLoadAttempt(attempt => attempt + 1)
    }

    async function save(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!form.current || !draft || !baseline || savingRef.current || sortLock.getOwner() !== null || signingOut || cleaning || authNotice || !canWrite()) return

        const themeFields = form.current.querySelectorAll<HTMLInputElement>('[data-theme]')
        for (const field of themeFields) {
            if (!validateRequired(field)) return
        }
        for (const field of themeFields) {
            field.setCustomValidity(isHexColor(field.value) ? '' : '올바른 색상코드를 입력해 주세요.')
            if (!field.reportValidity()) return
        }
        const requiredFields = form.current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            '#profileName, #profileMessage, [data-section] input, [data-section] textarea, #keywords',
        )
        for (const field of requiredFields) {
            if (!validateRequired(field)) return
        }
        const keywordField = form.current.querySelector<HTMLInputElement>('#keywords')!
        keywordField.setCustomValidity(
            draft.keywords.split(',').some(keyword => keyword.trim()) ? '' : '키워드를 하나 이상 입력해 주세요.',
        )
        if (!keywordField.reportValidity()) return

        savingRef.current = true
        setSaving(true)
        setSaveError(null)
        setSaved(false)
        try {
            const result = await saveSite(draft, baseline)
            if (!mounted.current) return
            const nextDraft = toDraft(result.site)
            leaveState.current = { baseline: result.site, draft: nextDraft }
            setBaseline(result.site)
            setDraft(nextDraft)
            setFocusedSection(null)
            setEditorVersion(version => version + 1)
            setCleanupWarning(result.cleanupWarning)
            setSaved(true)
        } catch (error) {
            if (mounted.current) {
                setSaveError(error instanceof Error ? error.message : '저장하지 못했습니다. 다시 시도해 주세요.')
                if (getPendingImageCleanupCount() > 0) {
                    setCleanupWarning('미저장 이미지 정리가 남아 있습니다. 다시 시도해 주세요.')
                }
            }
        } finally {
            savingRef.current = false
            if (mounted.current) setSaving(false)
        }
    }

    async function retryCleanup() {
        if (cleaningRef.current || savingRef.current || sortLock.getOwner() !== null || authNotice || !canWrite()) return
        cleaningRef.current = true
        setCleaning(true)
        try {
            const complete = await retryImageCleanup()
            if (mounted.current) setCleanupWarning(complete ? null : '일부 이전 이미지 정리가 남아 있습니다. 다시 시도해 주세요.')
        } catch {
            if (mounted.current) setCleanupWarning('이미지 정리를 완료하지 못했습니다. 다시 시도해 주세요.')
        } finally {
            cleaningRef.current = false
            if (mounted.current) setCleaning(false)
        }
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
                                onClick={() => {
                                    const id = crypto.randomUUID()
                                    change({ ...draft, sections: [...draft.sections, { id, title: '', content: '' }] })
                                    setFocusedSection(id)
                                }}
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
                        <FeedEditor value={draft.feed} onChange={feed => change({ ...draft, feed })} disabled={editingDisabled} sorting={sorting} sortLock={sortLock} />
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
                            {getPendingImageCleanupCount() > 0 && (
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
