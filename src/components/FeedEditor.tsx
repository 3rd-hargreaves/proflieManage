import { useRef, useState } from 'react'
import type { FeedDraft } from '../types/site'
import SortableList from './SortableList'

interface FeedEditorProps {
  value: FeedDraft[]
  onChange: (value: FeedDraft[]) => void
  disabled: boolean
  sorting: boolean
  onSortingChange: (sorting: boolean) => void
}

export default function FeedEditor({ value, onChange, disabled, sorting, onSortingChange }: FeedEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [selectedNames, setSelectedNames] = useState('파일 제목')

  return (
    <div className="card widthFull pdLg flexColumn gapSm">
      <p className="widthFull text2 mainColorText bold">피드</p>
      <p className="text3">파일 제목 행을 드래그해 순서를 바꾸고 저장해 주세요.</p>
      <div id="feedItems" className="widthFull flexColumn gapSm">
        <SortableList
          items={value}
          label="피드 순서"
          className="flexColumn gapSm"
          getLabel={item => item.name}
          onChange={onChange}
          onSortingChange={onSortingChange}
          disabled={disabled}
        >
          {(item, handleProps) => (
            <div className="picEditItem h30 widthFull pdSide border borderRad line">
              <button {...handleProps} className="dragHandle feedDragHandle">
                <span aria-hidden="true">↕</span>
                <span className="dragLabel" title={item.name}>{item.name}</span>
              </button>
              <button
                className="btn h30 border borderRad pdSide"
                type="button"
                disabled={sorting}
                onClick={() => onChange(value.filter((entry) => entry.id !== item.id))}
              >
                삭제
              </button>
            </div>
          )}
        </SortableList>
      </div>
      <div className="picUploader gapSm widthFull">
        <div className="picTitle h30 pdSide border borderRad line" title={selectedNames}>{selectedNames}</div>
        <button className="btn h30 border borderRad" type="button" disabled={sorting} onClick={() => fileInput.current?.click()}>
          이미지 업로드
        </button>
        <input className="borderRad"
          ref={fileInput}
          id="feedFiles"
          style={{ display: 'none' }}
          type="file"
          disabled={sorting}
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
