import type { SectionDraft } from '../types/site'

interface SectionEditorProps {
  value: SectionDraft
  autoFocus?: boolean
  onChange: (value: SectionDraft) => void
  onDelete: () => void
}

export default function SectionEditor({ value, autoFocus = false, onChange, onDelete }: SectionEditorProps) {
  return (
    <div className="card widthFull pdLg flexColumn gapSm" data-section="">
      <input
        className="widthFull h30 pdSide border"
        type="text"
        placeholder="섹션 제목"
        aria-label="섹션 제목"
        value={value.title}
        autoFocus={autoFocus}
        onChange={(event) => {
          event.currentTarget.setCustomValidity('')
          onChange({ ...value, title: event.currentTarget.value })
        }}
      />
      <p className="text3">*볼드체* _밑줄_ /이탤릭체/ -가로줄- | 표 | </p>
      <textarea
        className="pdSm border"
        placeholder="섹션 내용"
        aria-label="섹션 내용"
        value={value.content}
        onChange={(event) => {
          event.currentTarget.setCustomValidity('')
          onChange({ ...value, content: event.currentTarget.value })
        }}
      />
      <button className="btn h30 border borderRad" type="button" onClick={onDelete}>섹션 삭제</button>
    </div>
  )
}
