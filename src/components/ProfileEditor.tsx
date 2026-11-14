import { useEffect, useRef, useState } from 'react'
import type { ProfileDraft } from '../types/site'
import { imageFileName } from '../services/save'
import { getImageUrl } from '../services/storage'
import SiteImage from './SiteImage'

interface ProfileEditorProps {
  value: ProfileDraft
  onChange: (value: ProfileDraft) => void
}

export default function ProfileEditor({ value, onChange }: ProfileEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<{ file: File, url: string } | null>(null)
  const fileName = value.file?.name ?? (value.imagePath ? imageFileName(value.imagePath) : '파일 제목')

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview.url) }
  }, [preview])

  return (
    <div className="card pdLg flexColumn alignCenter gapMd">
      <p className="widthFull text2 mainColorText bold">정보</p>
      <SiteImage
        className="profileImg"
        src={value.file ? (preview?.file === value.file ? preview.url : undefined) : getImageUrl(value.imagePath)}
        alt="프로필 이미지 미리보기"
        fallbackText={value.file || value.imagePath ? undefined : '이미지 없음'}
      />
      <div className="picUploader gapSm widthFull">
        <div className="picTitle h30 pdSide border borderRad line" title={fileName}>{fileName}</div>
        <button className="btn h30 border borderRad" type="button" onClick={() => fileInput.current?.click()}>
          이미지 업로드
        </button>
        <input className="borderRad"
          ref={fileInput}
          id="profileFile"
          style={{ display: 'none' }}
          type="file"
          accept=".jpg, .jpeg, .png"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) {
              setPreview({ file, url: URL.createObjectURL(file) })
              onChange({ ...value, file })
            }
            event.currentTarget.value = ''
          }}
        />
      </div>
      <input
        id="profileName"
        className="widthFull h30 pdSide border borderRad"
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
        className="widthFull h30 pdSide border borderRad"
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
