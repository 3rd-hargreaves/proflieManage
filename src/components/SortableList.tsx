import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import {
    closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import type { CollisionDetection, DragEndEvent, Modifier } from '@dnd-kit/core'
import {
    arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { createSortLock } from '../utils/sortLock'
import type { SortLock } from '../utils/sortLock'

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
    listId?: string
    sortLock?: SortLock
    getLabel: (item: Item) => string
    onChange: (items: Item[]) => void
    onSortingChange?: (sorting: boolean) => void
    children: (item: Item, handleProps: SortHandleProps) => ReactNode
}

function SortableItem({
    id, label, disabled, onActivate, children,
}: {
    id: string
    label: string
    disabled: boolean
    onActivate: (event: PointerEvent | KeyboardEvent) => boolean
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
                onPointerDown: event => {
                    if (!event.isPrimary || event.button !== 0 || event.defaultPrevented) return
                    if (!onActivate(event.nativeEvent)) {
                        event.preventDefault()
                        event.stopPropagation()
                        return
                    }
                    listeners?.onPointerDown?.(event)
                },
                onKeyDown: event => {
                    if (!['Space', 'Enter'].includes(event.code) || event.defaultPrevented || event.target !== event.currentTarget) return
                    if (!onActivate(event.nativeEvent)) {
                        event.preventDefault()
                        event.stopPropagation()
                        return
                    }
                    listeners?.onKeyDown?.(event)
                },
                ref: setActivatorNodeRef,
                type: 'button',
                disabled,
                'aria-label': `${label} 순서 이동`,
                'aria-roledescription': '순서 이동',
                title: '드래그해 순서 변경',
            })}
        </div>
    )
}

export default function SortableList<Item extends SortableEntry>({
    items, label, className = '', disabled = false, listId: suppliedListId, sortLock, getLabel, onChange, onSortingChange, children,
}: SortableListProps<Item>) {
    const contextId = useId()
    const listId = suppliedListId ?? contextId
    const [localLock] = useState(createSortLock)
    const lock = sortLock ?? localLock
    const owner = useSyncExternalStore(lock.subscribe, lock.getOwner, lock.getOwner)
    const blockedByOtherList = owner !== null && owner !== listId
    const phase = useRef<'pending' | 'active' | null>(null)
    const notifySorting = useRef(onSortingChange)
    useEffect(() => { notifySorting.current = onSortingChange }, [onSortingChange])
    const container = useRef<HTMLDivElement>(null)
    const pointerId = useRef<number | null>(null)
    const releasedPointer = useRef<{ x: number, y: number } | null>(null)
    const allowedDrop = useRef(true)
    const release = useCallback(() => {
        phase.current = null
        pointerId.current = null
        if (lock.end(listId)) notifySorting.current?.(false)
    }, [lock, listId])
    const cancel = useCallback(() => {
        if (phase.current !== null && lock.getOwner() === listId) {
            // dnd-kit's sensors expose Escape cancellation, but no imperative
            // cancel API. Only the code is needed by the sensors; leaving key
            // blank avoids also triggering the modal's Escape-close handler.
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', cancelable: true }))
        }
        allowedDrop.current = false
        release()
    }, [lock, listId, release])
    useEffect(() => () => cancel(), [cancel])
    useEffect(() => { if (disabled) cancel() }, [disabled, cancel])

    function acquire(event: PointerEvent | KeyboardEvent): boolean {
        if (disabled || items.length < 2) return false
        if (phase.current !== null) return lock.getOwner() === listId
        if (!lock.tryStart(listId)) return false
        phase.current = 'pending'
        pointerId.current = event instanceof PointerEvent ? event.pointerId : null
        releasedPointer.current = null
        notifySorting.current?.(true)
        return true
    }
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


    function isInside({ x, y }: { x: number, y: number }): boolean {
        const bounds = container.current?.getBoundingClientRect()
        return !!bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
    }

    const collisionDetection: CollisionDetection = args => {
        if (args.pointerCoordinates && !isInside(args.pointerCoordinates)) return []
        return closestCenter(args)
    }

    function finish({ active, over }: DragEndEvent) {
        const pointerInside = pointerId.current === null
            || (releasedPointer.current !== null && isInside(releasedPointer.current))
        allowedDrop.current = phase.current === 'active' && lock.getOwner() === listId && !disabled && !!over && pointerInside
        if (allowedDrop.current && over && active.id !== over.id) {
            const from = items.findIndex(item => item.id === active.id)
            const to = items.findIndex(item => item.id === over.id)
            if (from >= 0 && to >= 0) onChange(arrayMove(items, from, to))
        }
        release()
    }

    return (
        <DndContext
            id={contextId}
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={[verticalAxis]}
            accessibility={{
                announcements: { onDragStart: () => undefined, onDragMove: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined },
                screenReaderInstructions: {
                    draggable: 'Space 또는 Enter 키로 이동을 시작하고 위아래 방향키로 순서를 바꿉니다. Space 또는 Enter 키로 놓고 Esc 키로 취소합니다. 바뀐 순서는 저장 버튼을 눌러 반영해 주세요.',
                },
            }}
            onDragStart={({ activatorEvent }) => {
                if (lock.getOwner() !== listId || phase.current !== 'pending') return
                phase.current = 'active'
                pointerId.current = activatorEvent instanceof PointerEvent ? activatorEvent.pointerId : null
                releasedPointer.current = null
                allowedDrop.current = true
            }}
            onDragAbort={release}
            onDragEnd={finish}
            onDragCancel={() => {
                allowedDrop.current = false
                release()
            }}
        >
            <SortableContext items={items} strategy={verticalListSortingStrategy} disabled={disabled || blockedByOtherList}>
                <div ref={container} className={`sortableList ${className}`} role="list" aria-label={label}>
                    {items.map(item => (
                        <SortableItem key={item.id} id={item.id} label={getLabel(item)} disabled={disabled || blockedByOtherList || items.length < 2} onActivate={acquire}>
                            {handleProps => children(item, handleProps)}
                        </SortableItem>
                    ))}
                </div>
            </SortableContext>
        </DndContext>
    )
}
