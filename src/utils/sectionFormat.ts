export type InlineNode =
    | { type: 'text'; text: string }
    | { type: 'bold' | 'underline' | 'italic' | 'strike'; children: InlineNode[] }

export type SectionBlock =
    | { type: 'text'; children: InlineNode[] }
    | { type: 'table'; rows: InlineNode[][][]; hasHeader: boolean }

type Marker = '*' | '_' | '/' | '-'
type Style = Exclude<InlineNode['type'], 'text'>

const styles: Record<Marker, Style> = { '*': 'bold', _: 'underline', '/': 'italic', '-': 'strike' }
const escapedCharacters = new Set(['*', '_', '/', '-', '|', '\\'])
const trailingUrlPunctuation = new Set(['.', ',', '!', '?', ';', ':', ')', ']'])
const asciiWord = /[a-z0-9_]/i
const whitespace = /\s/

function appendText(nodes: InlineNode[], text: string): void {
    if (!text) return
    const previous = nodes.at(-1)
    if (previous?.type === 'text') previous.text += text
    else nodes.push({ type: 'text', text })
}

/** Parse one line. Each marker can be open once, so nesting is bounded by four. */
function parseInline(line: string): InlineNode[] {
    const root: InlineNode[] = []
    const frames: { marker: Marker; children: InlineNode[] }[] = []
    const nodes = () => frames.at(-1)?.children ?? root
    // URL tokens are literal; scheme and path slashes are not italic markers.
    const urls = new Map<number, string>()
    for (const match of line.matchAll(/(?:https?:\/\/|www\.)[^\s]+/gi)) {
        // An underscore may be the surrounding underline marker, not a URL prefix.
        if (match.index > 0 && /[a-z0-9]/i.test(line[match.index - 1])) continue
        urls.set(match.index, match[0])
    }

    for (let index = 0; index < line.length;) {
        const url = urls.get(index)
        if (url) {
            let literalLength = url.length
            if (frames.length) {
                let candidateEnd = url.length
                while (candidateEnd > 0 && trailingUrlPunctuation.has(url[candidateEnd - 1])) candidateEnd--
                const candidate = url.slice(0, candidateEnd)
                for (let count = frames.length; count > 0; count--) {
                    const closing = frames.slice(-count).reverse().map(frame => frame.marker).join('')
                    if (candidate.endsWith(closing) && !isEscaped(candidate, candidate.length - closing.length)) {
                        literalLength = candidate.length - closing.length
                        break
                    }
                }
            }
            appendText(nodes(), url.slice(0, literalLength))
            index += literalLength
            continue
        }
        const character = line[index]
        if (character === '\\' && escapedCharacters.has(line[index + 1])) {
            appendText(nodes(), line[index + 1])
            index += 2
            continue
        }
        if (!Object.hasOwn(styles, character)) {
            appendText(nodes(), character)
            index++
            continue
        }

        const marker = character as Marker
        let end = index + 1
        while (line[end] === marker) end++
        // Only the agreed single-character delimiters are supported.
        if (end - index > 1) {
            appendText(nodes(), line.slice(index, end))
            index = end
            continue
        }
        const previous = line[index - 1]
        const next = line[index + 1]
        const current = frames.at(-1)
        const canClose = previous !== undefined && !whitespace.test(previous)
            && (marker === '*' || next === undefined || !asciiWord.test(next))
        if (current?.marker === marker && current.children.length > 0 && canClose) {
            frames.pop()
            nodes().push({ type: styles[marker], children: current.children })
        } else {
            const canOpen = next !== undefined && !whitespace.test(next)
                && (marker === '*' || previous === undefined || !asciiWord.test(previous))
            if (canOpen && !frames.some(frame => frame.marker === marker)) {
                frames.push({ marker, children: [] })
            } else appendText(nodes(), marker)
        }
        index++
    }

    // Unclosed delimiters remain visible. No source text becomes HTML.
    while (frames.length) {
        const frame = frames.pop()!
        appendText(nodes(), frame.marker)
        for (const child of frame.children) {
            if (child.type === 'text') appendText(nodes(), child.text)
            else nodes().push(child)
        }
    }
    return root
}

function isEscaped(text: string, index: number): boolean {
    let slashes = 0
    while (index > 0 && text[--index] === '\\') slashes++
    return slashes % 2 === 1
}

function tableCells(line: string): string[] | null {
    const trimmed = line.trim()
    if (trimmed.length < 2 || trimmed[0] !== '|' || trimmed.at(-1) !== '|'
        || isEscaped(trimmed, trimmed.length - 1)) return null
    const cells: string[] = []
    let start = 1
    for (let index = 1; index < trimmed.length; index++) {
        if (trimmed[index] === '|' && !isEscaped(trimmed, index)) {
            cells.push(trimmed.slice(start, index).trim())
            start = index + 1
        }
    }
    return cells
}

/** Parse display grammar without changing the original editor/DB string. */
export function parseSectionContent(text: string): SectionBlock[] {
    if (!text) return []
    const lines = text.split(/\r\n|\n|\r/)
    const blocks: SectionBlock[] = []
    let pending: string[] = []
    const flushText = () => {
        if (!pending.length) return
        const children: InlineNode[] = []
        pending.forEach((line, index) => {
            if (index > 0) appendText(children, '\n')
            for (const child of parseInline(line)) {
                if (child.type === 'text') appendText(children, child.text)
                else children.push(child)
            }
        })
        blocks.push({ type: 'text', children })
        pending = []
    }

    for (let index = 0; index < lines.length;) {
        const firstRow = tableCells(lines[index])
        if (!firstRow) {
            pending.push(lines[index++])
            continue
        }
        flushText()
        const rawRows = [firstRow]
        index++
        while (index < lines.length) {
            const row = tableCells(lines[index])
            if (!row) break
            rawRows.push(row)
            index++
        }
        const separator = rawRows[1]
        const hasHeader = !!separator && separator.length === firstRow.length
            && separator.every(cell => /^:?-{3,}:?$/.test(cell))
        if (hasHeader) rawRows.splice(1, 1)
        // Keep natural row widths rather than multiplying a wide row across every
        // short row. HTML tables can display rows with differing cell counts.
        const rows = rawRows.map(row => row.map(parseInline))
        blocks.push({ type: 'table', rows, hasHeader })
    }
    flushText()
    return blocks
}
