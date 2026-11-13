import type { ThemeColors } from '../types/site'
import { isHexColor } from '../utils/validation'

interface ThemeEditorProps {
  value: ThemeColors
  onChange: (key: keyof ThemeColors, value: string) => void
}

const colorFields = [
  { key: 'mainColor', variable: '--main-color', label: '메인' },
  { key: 'backgroundColor', variable: '--sub-color', label: '배경' },
  { key: 'cardBackgroundColor', variable: '--background-color', label: '카드 배경' },
  { key: 'typoColor', variable: '--typo-color', label: '글자' },
] as const

export default function ThemeEditor({ value, onChange }: ThemeEditorProps) {
  return (
    <div className="card pdLg flexColumn alignCenter gapMd">
      <p className="widthFull text2 mainColorText bold">테마</p>
      {colorFields.map(({ key, variable, label }) => (
        <div className="widthFull flex gapSm" key={key}>
          <p className="text3 widthFull colorClass line">{label}</p>
          <div
            className="color h30"
            style={{ backgroundColor: isHexColor(value[key]) ? value[key].trim() : undefined }}
            aria-hidden="true"
          />
          <input
            className="widthFull h30 pdSide border"
            type="text"
            placeholder="헥스코드"
            aria-label={`${label} 헥스코드`}
            data-theme={variable}
            value={value[key]}
            onChange={(event) => {
              event.currentTarget.setCustomValidity(
                isHexColor(event.currentTarget.value) ? '' : '올바른 색상코드를 입력해 주세요.',
              )
              onChange(key, event.currentTarget.value)
            }}
          />
        </div>
      ))}
    </div>
  )
}
