import { useCallback, useEffect, useRef, useState } from 'react'
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
}

export default function EditPage({ onLogout, signingOut, logoutError }: EditPageProps) {
  const form = useRef<HTMLFormElement>(null)
  const savingRef = useRef(false)
  const sortingRef = useRef(false)
  const mounted = useRef(true)
  const [baseline, setBaseline] = useState<SiteData | null>(null)
  const [draft, setDraft] = useState<SiteEditDraft | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [focusedSection, setFocusedSection] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [sorting, setSorting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [cleanupWarning, setCleanupWarning] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [editorVersion, setEditorVersion] = useState(0)
  const editingDisabled = saving || signingOut || cleaning
  const onSortingChange = useCallback((active: boolean) => {
    sortingRef.current = active
    setSorting(active)
  }, [])

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
        setBaseline(site)
        setDraft(toDraft(site))
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
    setDraft(next)
    setSaved(false)
  }

  function reload() {
    if (savingRef.current || sortingRef.current || cleaning) return
    setLoading(true)
    setLoadError(null)
    setSaveError(null)
    setSaved(false)
    setDraft(null)
    setBaseline(null)
    setFocusedSection(null)
    setLoadAttempt(attempt => attempt + 1)
  }

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.current || !draft || !baseline || savingRef.current || sortingRef.current || signingOut || cleaning) return

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
      setBaseline(result.site)
      setDraft(toDraft(result.site))
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
    if (cleaning || savingRef.current) return
    setCleaning(true)
    try {
      const complete = await retryImageCleanup()
      if (mounted.current) setCleanupWarning(complete ? null : '일부 이전 이미지 정리가 남아 있습니다. 다시 시도해 주세요.')
    } catch {
      if (mounted.current) setCleanupWarning('이미지 정리를 완료하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      if (mounted.current) setCleaning(false)
    }
  }

  return (
    <main className="flexColumn gapLg" aria-busy={loading || saving}>
      <button className="btn h30 border borderRad" type="button" disabled={editingDisabled || sorting} onClick={onLogout}>
        {signingOut ? '로그아웃 중…' : '로그아웃'}
      </button>
      {logoutError && <p role="alert">{logoutError}</p>}
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
                onSortingChange={onSortingChange}
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
            <FeedEditor value={draft.feed} onChange={feed => change({ ...draft, feed })} disabled={editingDisabled} sorting={sorting} onSortingChange={onSortingChange} />
            <button className="btn h30 border borderRad widthFull" type="submit" disabled={sorting}>{saving ? '저장 중…' : '저장'}</button>
          </fieldset>
          {saved && <p role="status">저장했습니다.</p>}
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
    </main>
  )
}
