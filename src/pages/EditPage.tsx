import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import FeedEditor from '../components/FeedEditor'
import ProfileEditor from '../components/ProfileEditor'
import SectionEditor from '../components/SectionEditor'
import ThemeEditor from '../components/ThemeEditor'
import type { FeedDraft, ProfileDraft, SectionDraft, ThemeColors } from '../types/site'
import { isHexColor, validateRequired } from '../utils/validation'

function initialTheme(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  return {
    mainColor: style.getPropertyValue('--main-color').trim(),
    backgroundColor: style.getPropertyValue('--sub-color').trim(),
    cardBackgroundColor: style.getPropertyValue('--background-color').trim(),
    typoColor: style.getPropertyValue('--typo-color').trim(),
  }
}

interface EditPageProps {
  onLogout: () => Promise<void>
  signingOut: boolean
  logoutError: string | null
}

export default function EditPage({ onLogout, signingOut, logoutError }: EditPageProps) {
  const form = useRef<HTMLFormElement>(null)
  const [theme, setTheme] = useState(initialTheme)
  const [profile, setProfile] = useState<ProfileDraft>({ name: '', statusMessage: '', file: null })
  const [sections, setSections] = useState<SectionDraft[]>([
    { id: 'initial-section-1', title: '', content: '' },
    { id: 'initial-section-2', title: '', content: '' },
  ])
  const [focusedSection, setFocusedSection] = useState<string | null>(null)
  const [keywords, setKeywords] = useState('')
  const [feed, setFeed] = useState<FeedDraft[]>([
    { id: 'initial-feed-1', name: '파일 제목' },
    { id: 'initial-feed-2', name: '파일 제목' },
  ])

  useEffect(() => {
    document.title = '관리자'
  }, [])

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.current) return

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
      keywords.split(',').some((keyword) => keyword.trim()) ? '' : '키워드를 하나 이상 입력해 주세요.',
    )
    if (!keywordField.reportValidity()) return

    alert('저장')
  }

  return (
    <main className="flexColumn gapLg">
      <button className="btn h30 border borderRad" type="button" disabled={signingOut} onClick={onLogout}>
        {signingOut ? '로그아웃 중…' : '로그아웃'}
      </button>
      {logoutError && <p role="alert">{logoutError}</p>}
      <form ref={form} className="flexColumn gapLg" noValidate onSubmit={save}>
        <ThemeEditor value={theme} onChange={(key, value) => setTheme({ ...theme, [key]: value })} />
        <ProfileEditor value={profile} onChange={setProfile} />
        <div id="sections" className="widthFull flexColumn gapLg">
          {sections.map((section) => (
            <SectionEditor
              key={section.id}
              value={section}
              autoFocus={section.id === focusedSection}
              onChange={(value) => setSections(sections.map((item) => item.id === value.id ? value : item))}
              onDelete={() => setSections(sections.filter((item) => item.id !== section.id))}
            />
          ))}
          <button
            id="addSectionBtn"
            className="btn h30 border borderRad"
            type="button"
            onClick={() => {
              const id = crypto.randomUUID()
              setSections([...sections, { id, title: '', content: '' }])
              setFocusedSection(id)
            }}
          >
            섹션 추가
          </button>
        </div>
        <div className="card widthFull pdLg flexColumn gapSm">
          <p className="widthFull text2 mainColorText bold">키워드</p>
          <p className="text3"> ,로 구분 </p>
          <input
            id="keywords"
            className="widthFull h30 pdSide border"
            type="text"
            placeholder="키워드"
            aria-label="키워드"
            value={keywords}
            onChange={(event) => {
              event.currentTarget.setCustomValidity('')
              setKeywords(event.currentTarget.value)
            }}
          />
        </div>
        <FeedEditor value={feed} onChange={setFeed} />
        <button className="btn h30 border borderRad widthFull" type="submit"> 저장 </button>
      </form>
    </main>
  )
}
