import { useRef } from 'react'
import type { ProfileDraft } from '../types/site'

interface ProfileEditorProps {
  value: ProfileDraft
  onChange: (value: ProfileDraft) => void
}

export default function ProfileEditor({ value, onChange }: ProfileEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)

  return (
    <div className="card pdLg flexColumn alignCenter gapMd">
      <p className="widthFull text2 mainColorText bold">정보</p>
      <div className="picUploader gapSm widthFull">
        <div className="picTitle h30 pdSide border borderRad line" title={value.file?.name}>{value.file?.name ?? '파일 제목'}</div>
        <button className="btn h30 border borderRad" type="button" onClick={() => fileInput.current?.click()}>
          이미지 업로드
        </button>
        <input
          ref={fileInput}
          id="profileFile"
          style={{ display: 'none' }}
          type="file"
          accept=".jpg, .jpeg, .png"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) onChange({ ...value, file })
          }}
        />
      </div>
      <input
        id="profileName"
        className="widthFull h30 pdSide border"
        type="text"
        placeholder="이름"
        aria-label="이름"
        value={value.name}
        onChange={(event) => {
          event.currentTarget.setCustomValidity('')
          onChange({ ...value, name: event.currentTarget.value })
        }}
      />
      <input
        id="profileMessage"
        className="widthFull h30 pdSide border"
        type="text"
        placeholder="상태 메시지"
        aria-label="상태 메시지"
        value={value.statusMessage}
        onChange={(event) => {
          event.currentTarget.setCustomValidity('')
          onChange({ ...value, statusMessage: event.currentTarget.value })
        }}
      />
    </div>
  )
}
