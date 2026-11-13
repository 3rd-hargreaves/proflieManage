import { useRef, useState } from 'react'
import type { FeedDraft } from '../types/site'

interface FeedEditorProps {
  value: FeedDraft[]
  onChange: (value: FeedDraft[]) => void
}

export default function FeedEditor({ value, onChange }: FeedEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [selectedNames, setSelectedNames] = useState('파일 제목')

  return (
    <div className="card widthFull pdLg flexColumn gapSm">
      <p className="widthFull text2 mainColorText bold">피드</p>
      <div id="feedItems" className="widthFull flexColumn gapSm">
        {value.map((item) => (
          <div className="picEditItem h30 widthFull pdSide border borderRad line" key={item.id}>
            <span title={item.name}>{item.name}</span>
            <button
              className="btn h30 border borderRad pdSide"
              type="button"
              onClick={() => onChange(value.filter((entry) => entry.id !== item.id))}
            >
              삭제
            </button>
          </div>
        ))}
      </div>
      <div className="picUploader gapSm widthFull">
        <div className="picTitle h30 pdSide border borderRad line" title={selectedNames}>{selectedNames}</div>
        <button className="btn h30 border borderRad" type="button" onClick={() => fileInput.current?.click()}>
          이미지 업로드
        </button>
        <input
          ref={fileInput}
          id="feedFiles"
          style={{ display: 'none' }}
          type="file"
          accept=".jpg, .jpeg, .png"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            if (files.length === 0) return

            onChange([...value, ...files.map((file) => ({ id: crypto.randomUUID(), name: file.name, file }))])
            setSelectedNames(files.map((file) => file.name).join(', '))
            event.currentTarget.value = ''
          }}
        />
      </div>
    </div>
  )
}
