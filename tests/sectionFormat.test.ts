import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSectionContent } from '../src/utils/sectionFormat.ts'
import type { InlineNode, SectionBlock } from '../src/utils/sectionFormat.ts'

const text = (value: string): InlineNode => ({ type: 'text', text: value })
const styled = (type: 'bold' | 'underline' | 'italic' | 'strike', value: string): InlineNode => ({ type, children: [text(value)] })
const paragraph = (children: InlineNode[]): SectionBlock => ({ type: 'text', children })

test('renders the four agreed inline delimiters', () => {
    assert.deepEqual(parseSectionContent('*굵게* _밑줄_ /기울임/ -취소선-'), [paragraph([
        styled('bold', '굵게'), text(' '), styled('underline', '밑줄'), text(' '), styled('italic', '기울임'), text(' '), styled('strike', '취소선'),
    ])])
})

test('preserves text, indentation, blank lines and trailing newline', () => {
    assert.deepEqual(parseSectionContent('  첫 줄\n\n둘째 줄\n'), [paragraph([text('  첫 줄\n\n둘째 줄\n')])])
})

test('normalizes platform line endings for display', () => {
    assert.deepEqual(parseSectionContent('A\r\nB\rC'), [paragraph([text('A\nB\nC')])])
})

test('empty content produces no blocks', () => {
    assert.deepEqual(parseSectionContent(''), [])
})

test('supports nested different styles', () => {
    assert.deepEqual(parseSectionContent('*굵게 _밑줄 /기울임 -취소선-/ 끝_*'), [paragraph([{
        type: 'bold', children: [text('굵게 '), { type: 'underline', children: [text('밑줄 '), {
            type: 'italic', children: [text('기울임 '), styled('strike', '취소선')],
        }, text(' 끝')] }],
    }])])
})

test('preserves unmatched opening and closing markers', () => {
    const source = '*미완성 _ / -\n끝* 밑줄_ 기울임/ 취소선-'
    assert.deepEqual(parseSectionContent(source), [paragraph([text(source)])])
})

test('inline markers never pair across a newline', () => {
    assert.deepEqual(parseSectionContent('*첫 줄\n둘째 줄*'), [paragraph([text('*첫 줄\n둘째 줄*')])])
})

test('escaped syntax and backslash display literally', () => {
    assert.deepEqual(parseSectionContent(String.raw`\*굵게\* \_밑줄\_ \/기울임\/ \-취소선\- \| \\`), [paragraph([text('*굵게* _밑줄_ /기울임/ -취소선- | \\')])])
})

test('unknown escapes keep their backslash', () => {
    assert.deepEqual(parseSectionContent(String.raw`C:\temp\q`), [paragraph([text(String.raw`C:\temp\q`)])])
})

test('ordinary underscores, hyphens and URLs remain text', () => {
    const source = 'first_name_last 2026-11-14 well-known-word https://example.com/a/b/ www.example.com/path/to'
    assert.deepEqual(parseSectionContent(source), [paragraph([text(source)])])
})

test('formatting around a literal URL can still close normally', () => {
    assert.deepEqual(parseSectionContent('*https://example.com/a/b*.'), [paragraph([styled('bold', 'https://example.com/a/b'), text('.')])])
    assert.deepEqual(parseSectionContent('/https://example.com/a/b/'), [paragraph([styled('italic', 'https://example.com/a/b')])])
    assert.deepEqual(parseSectionContent('*_https://example.com/a_b_*'), [paragraph([{
        type: 'bold', children: [styled('underline', 'https://example.com/a_b')],
    }])])
})

test('URL formatting closers respect odd and even literal backslash runs', () => {
    for (const count of [1, 2, 3, 4]) {
        const url = `https://example.com/a${'\\'.repeat(count)}`
        const source = `*${url}*`
        const expected = count % 2 === 1 ? text(source) : styled('bold', url)
        assert.deepEqual(parseSectionContent(source), [paragraph([expected])])
    }
    const nested = String.raw`*_https://example.com/a\_*`
    assert.deepEqual(parseSectionContent(nested), [paragraph([text(nested)])])
})

test('long URL punctuation runs are processed in linear time', () => {
    const url = `https://example.com/${'.'.repeat(100_000)}x`
    const started = performance.now()
    assert.deepEqual(parseSectionContent(`*${url}*`), [paragraph([styled('bold', url)])])
    assert.ok(performance.now() - started < 2000, 'URL suffix parsing exceeded the linear-time regression budget')
})

test('can format Korean text without surrounding spaces', () => {
    assert.deepEqual(parseSectionContent('이름은_밑줄_입니다'), [paragraph([text('이름은'), styled('underline', '밑줄'), text('입니다')])])
})

test('supports hyphens inside a strike span', () => {
    assert.deepEqual(parseSectionContent('-strike-this-text-'), [paragraph([styled('strike', 'strike-this-text')])])
})

test('unsupported repeated delimiters remain literal', () => {
    assert.deepEqual(parseSectionContent('**굵게** __밑줄__ //기울임// --취소선--'), [paragraph([text('**굵게** __밑줄__ //기울임// --취소선--')])])
})

test('does not consume whitespace-only delimiters', () => {
    assert.deepEqual(parseSectionContent('* * _ _ / / - -'), [paragraph([text('* * _ _ / / - -')])])
})

test('raw HTML remains text rather than an HTML AST node', () => {
    const source = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    assert.deepEqual(parseSectionContent(source), [paragraph([text(source)])])
})

test('a single pipe row is a one-cell table', () => {
    assert.deepEqual(parseSectionContent('| 표 |'), [{ type: 'table', rows: [[[text('표')]]], hasHeader: false }])
})

test('consecutive pipe rows become one table with inline formatting', () => {
    assert.deepEqual(parseSectionContent('| *이름* | _설명_ |\n| 가 | /나/ |'), [{
        type: 'table', rows: [[[styled('bold', '이름')], [styled('underline', '설명')]], [[text('가')], [styled('italic', '나')]]], hasHeader: false,
    }])
})

test('optional separator creates a header and is not rendered', () => {
    assert.deepEqual(parseSectionContent('| 이름 | 설명 |\n| --- | :---: |\n| 가 | 나 |'), [{
        type: 'table', rows: [[[text('이름')], [text('설명')]], [[text('가')], [text('나')]]], hasHeader: true,
    }])
})

test('ordinary second row is never silently consumed', () => {
    assert.deepEqual(parseSectionContent('| 제목 |\n| -취소선- |'), [{
        type: 'table', rows: [[[text('제목')]], [[styled('strike', '취소선')]]], hasHeader: false,
    }])
})

test('empty and short table cells retain their natural cell counts', () => {
    assert.deepEqual(parseSectionContent('| 가 || 다 |\n||'), [{
        type: 'table', rows: [[[text('가')], [], [text('다')]], [[]]], hasHeader: false,
    }])
})

test('escaped pipes stay inside the cell and escaped markers stay literal', () => {
    assert.deepEqual(parseSectionContent(String.raw`| 가\|나 | \*문자\* |`), [{
        type: 'table', rows: [[[text('가|나')], [text('*문자*')]]], hasHeader: false,
    }])
})

test('escaped opening or ending pipes do not form a table', () => {
    assert.deepEqual(parseSectionContent(String.raw`\| 가 |`), [paragraph([text('| 가 |')])])
    assert.deepEqual(parseSectionContent(String.raw`| 가 \|`), [paragraph([text('| 가 |')])])
})

test('blank lines separate tables and surrounding text is retained', () => {
    assert.deepEqual(parseSectionContent('앞\n\n| 표1 |\n\n| 표2 |\n뒤'), [
        paragraph([text('앞\n')]), { type: 'table', rows: [[[text('표1')]]], hasHeader: false },
        paragraph([]), { type: 'table', rows: [[[text('표2')]]], hasHeader: false }, paragraph([text('뒤')]),
    ])
})

test('source is unchanged when parsing formatted table content', () => {
    const source = '  *굵게*\r\n| _밑줄_ | 가\\|나 |\r\n'
    const original = source
    parseSectionContent(source)
    assert.equal(source, original)
})

test('large unmatched or repeated marker inputs do not recurse or hang', () => {
    const source = '*'.repeat(100_000)
    assert.deepEqual(parseSectionContent(source), [paragraph([text(source)])])
    assert.doesNotThrow(() => parseSectionContent('*_/-'.repeat(25_000)))
})
