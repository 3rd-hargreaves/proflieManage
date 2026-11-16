import { useState } from 'react'
import { getPendingImageCleanupCount, imageCleanupWarning, retryImageCleanup } from '../services/storage'
import { createSortLock } from '../utils/sortLock'
import type { SortLock } from '../utils/sortLock'
import { useEditorWork } from '../hooks/useEditorWork'

export default function ImageCleanupNotice({ message, workLock, sortLock: suppliedSortLock, canWrite, blocked, onCleared }: {
    message?: string | null
    workLock: SortLock
    sortLock?: SortLock
    canWrite: () => boolean
    blocked: boolean
    onCleared?: () => void
}) {
    const [localLock] = useState(createSortLock)
    const sortLock = suppliedSortLock ?? localLock
    const [retryMessage, setRetryMessage] = useState<string | null>(null)
    const work = useEditorWork({ workLock, sortLock, canWrite, blocked })
    const pending = getPendingImageCleanupCount()
    const notice = retryMessage || message || imageCleanupWarning()
    if (!pending && !notice && !work.error) return null

    async function retry() {
        await work.run('cleaning', async guard => {
            const complete = await retryImageCleanup(guard)
            if (!work.isMounted()) return
            setRetryMessage(complete ? null : imageCleanupWarning('이미지 정리를 완료하지 못했습니다. 다시 시도해 주세요.'))
            if (complete) onCleared?.()
        })
    }

    return (
        <div className="card pdLg flexColumn gapSm">
            <p role="status">{notice || '이미지 정리 상태를 확인해 주세요.'}</p>
            {work.error && <p role="alert">{work.error}</p>}
            <button className="btn h30 border borderRad" type="button" disabled={blocked || work.busy || sortLock.getOwner() !== null} onClick={() => void retry()}>
                {work.action === 'cleaning' ? '이미지 정리 중…' : '이미지 정리 다시 시도'}
            </button>
        </div>
    )
}
