import { useEffect, useRef } from 'react'
import type { SubmitEvent } from 'react'
import CharacterFields from '../components/CharacterFields'
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
    signingOut: boolean
    authNotice: { message: string, checking: boolean, requiresLogin: boolean } | null
    onRetryAuth: () => void
    onReauthenticate: () => void
    onExit: () => void
    onLeaveGuardChange: (guard: LeaveGuard) => void
    canWrite: () => boolean
    onBusyChange?: (busy: boolean) => void
}

export default function EditPage({ signingOut, authNotice, onRetryAuth, onReauthenticate, onExit, onLeaveGuardChange, canWrite, onBusyChange }: EditPageProps) {
    const form = useRef<HTMLFormElement>(null)
    const {
        baseline, draft, loading, loadError, focusedSection, saving, saveError, saved,
        cleanupWarning, cleaning, editorVersion, sorting, sortLock, editingDisabled,
        pendingCleanupCount, change, addSection, reload, canSave, save: saveDraft, retryCleanup, reportError,
    } = useSiteEditor({ signingOut, authBlocked: !!authNotice, canWrite, onLeaveGuardChange })

    useEffect(() => {
        onBusyChange?.(loading || saving || cleaning || sorting)
        return () => onBusyChange?.(false)
    }, [onBusyChange, loading, saving, cleaning, sorting])

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
                        <CharacterFields draft={draft} change={change} addSection={addSection}
                            focusedSection={focusedSection} sorting={sorting} sortLock={sortLock}
                            editingDisabled={editingDisabled} maxFeedCount={feedImageLimit(baseline?.feed.length ?? 0)} saving={saving} />
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
            {draft && !loading && (
                <div className="flexColumn gapSm">
                    <p className="text3" id="characterDeleteNotice">캐릭터 삭제는 준비 중입니다.</p>
                    <button className="btn h30 border borderRad widthFull" type="button" disabled aria-describedby="characterDeleteNotice">캐릭터 삭제</button>
                </div>
            )}
        </main>
    )
}
