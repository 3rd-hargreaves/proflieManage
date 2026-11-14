import { useEffect, useId, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import type { Announcements, CollisionDetection, DragEndEvent, Modifier } from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const verticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

export type SortHandleProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref: Ref<HTMLButtonElement>
}

interface SortableEntry {
  id: string
}

interface SortableListProps<Item extends SortableEntry> {
  items: Item[]
  label: string
  className?: string
  disabled?: boolean
  getLabel: (item: Item) => string
  onChange: (items: Item[]) => void
  onSortingChange: (sorting: boolean) => void
  children: (item: Item, handleProps: SortHandleProps) => ReactNode
}

function SortableItem({
  id, label, disabled, children,
}: {
  id: string
  label: string
  disabled: boolean
  children: (handleProps: SortHandleProps) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })

  return (
    <div
      ref={setNodeRef}
      className={`sortableItem${isDragging ? ' sortableDragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition: transition ?? 'none' }}
      role="listitem"
    >
      {children({
        ...attributes,
        ...listeners,
        ref: setActivatorNodeRef,
        type: 'button',
        disabled,
        'aria-label': `${label} 순서 이동`,
        'aria-roledescription': '순서 이동',
        title: '드래그해 순서 변경 · 키보드는 Space 또는 Enter, 위아래 방향키, Esc로 취소',
      })}
    </div>
  )
}

export default function SortableList<Item extends SortableEntry>({
  items, label, className = '', disabled = false, getLabel, onChange, onSortingChange, children,
}: SortableListProps<Item>) {
  const contextId = useId()
  const container = useRef<HTMLDivElement>(null)
  const pointerId = useRef<number | null>(null)
  const releasedPointer = useRef<{ x: number, y: number } | null>(null)
  const allowedDrop = useRef(true)
  useEffect(() => {
    // The final move can still be waiting for a render when the pointer is
    // released. Capture the actual release before the sensor ends the drag.
    const recordRelease = (event: PointerEvent) => {
      if (event.pointerId === pointerId.current) {
        releasedPointer.current = { x: event.clientX, y: event.clientY }
      }
    }
    document.addEventListener('pointerup', recordRelease, true)
    return () => document.removeEventListener('pointerup', recordRelease, true)
  }, [])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const itemLabel = (id: string | number) => {
    const item = items.find(entry => entry.id === id)
    return item ? getLabel(item) : label
  }
  const position = (id: string | number) => items.findIndex(item => item.id === id) + 1

  function isInside({ x, y }: { x: number, y: number }): boolean {
    const bounds = container.current?.getBoundingClientRect()
    return !!bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
  }

  const collisionDetection: CollisionDetection = args => {
    if (args.pointerCoordinates && !isInside(args.pointerCoordinates)) return []
    return closestCenter(args)
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `${itemLabel(active.id)} 이동을 시작합니다. 전체 ${items.length}개 중 ${position(active.id)}번째입니다.`,
    onDragOver: ({ active, over }) => over
      ? `${itemLabel(active.id)}을 ${position(over.id)}번째 위치로 이동합니다.`
      : '목록 밖입니다. 놓으면 이동을 취소합니다.',
    onDragEnd: ({ active, over }) => over && allowedDrop.current
      ? `${itemLabel(active.id)}을 ${position(over.id)}번째로 이동했습니다. 저장 버튼을 눌러 반영해 주세요.`
      : '이동을 취소했습니다.',
    onDragCancel: () => '이동을 취소했습니다.',
  }

  function finish({ active, over }: DragEndEvent) {
    const pointerInside = pointerId.current === null
      || (releasedPointer.current !== null && isInside(releasedPointer.current))
    allowedDrop.current = !disabled && !!over && pointerInside
    if (allowedDrop.current && over && active.id !== over.id) {
      const from = items.findIndex(item => item.id === active.id)
      const to = items.findIndex(item => item.id === over.id)
      if (from >= 0 && to >= 0) onChange(arrayMove(items, from, to))
    }
    pointerId.current = null
    onSortingChange(false)
  }

  return (
    <DndContext
      id={contextId}
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={[verticalAxis]}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: 'Space 또는 Enter 키로 이동을 시작하고 위아래 방향키로 순서를 바꿉니다. Space 또는 Enter 키로 놓고 Esc 키로 취소합니다. 바뀐 순서는 저장 버튼을 눌러 반영해 주세요.',
        },
      }}
      onDragStart={({ activatorEvent }) => {
        pointerId.current = activatorEvent instanceof PointerEvent ? activatorEvent.pointerId : null
        releasedPointer.current = null
        allowedDrop.current = true
        onSortingChange(true)
      }}
      onDragEnd={finish}
      onDragCancel={() => {
        pointerId.current = null
        allowedDrop.current = false
        onSortingChange(false)
      }}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy} disabled={disabled}>
        <div ref={container} className={`sortableList ${className}`} role="list" aria-label={label}>
          {items.map(item => (
            <SortableItem key={item.id} id={item.id} label={getLabel(item)} disabled={disabled || items.length < 2}>
              {handleProps => children(item, handleProps)}
            </SortableItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
