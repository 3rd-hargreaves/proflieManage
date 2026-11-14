import type { ThemeColors } from '../types/site'
import { themeFields } from '../utils/theme'
import { hexColorMessage, isHexColor } from '../utils/validation'

interface ThemeEditorProps {
    value: ThemeColors
    onChange: (key: keyof ThemeColors, value: string) => void
}

export default function ThemeEditor({ value, onChange }: ThemeEditorProps) {
    return (
        <div className="card pdLg flexColumn alignCenter gapMd">
            <p className="widthFull text2 mainColorText bold">테마</p>
            {themeFields.map(({ key, variable, label }) => (
                <div className="widthFull flex gapSm" key={key}>
                    <p className="text3 widthFull colorClass line">{label}</p>
                    <div
                        className="color h30"
                        style={{ backgroundColor: isHexColor(value[key]) ? value[key].trim() : undefined }}
                        aria-hidden="true"
                    />
                    <input
                        className="widthFull h30 pdSide border borderRad"
                        type="text"
                        placeholder="헥스코드"
                        aria-label={`${label} 헥스코드`}
                        data-theme={variable}
                        value={value[key]}
                        onChange={(event) => {
                            event.currentTarget.setCustomValidity(hexColorMessage(event.currentTarget.value))
                            onChange(key, event.currentTarget.value)
                        }}
                    />
                </div>
            ))}
        </div>
    )
}
