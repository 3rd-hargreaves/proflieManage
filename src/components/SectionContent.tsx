import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { parseSectionContent } from '../utils/sectionFormat'
import type { InlineNode } from '../utils/sectionFormat'

const inlineElements = { bold: 'strong', underline: 'u', italic: 'em', strike: 'del' } as const

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.text
    const Element = inlineElements[node.type]
    return <Element key={index}>{renderInline(node.children)}</Element>
  })
}

interface SectionContentProps {
  content: string
  label: string
}

export default function SectionContent({ content, label }: SectionContentProps) {
  const blocks = useMemo(() => parseSectionContent(content), [content])

  return (
    <div className="widthFull text3 sectionContent">
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          return <div key={index} className="sectionProse">{renderInline(block.children)}</div>
        }
        const [header, ...body] = block.rows
        const rows = block.hasHeader ? body : block.rows
        return (
          <div key={index} className="sectionTableWrap border borderRad" role="region" tabIndex={0} aria-label={`${label} 표 영역`}>
            <table className="sectionTable" aria-label={`${label} 표`}>
              {block.hasHeader && (
                <thead><tr>{header.map((cell, column) => <th key={column} scope="col">{renderInline(cell)}</th>)}</tr></thead>
              )}
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{renderInline(cell)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
