export interface AuthInfo {
    message: string
    checking: boolean
    requiresLogin: boolean
}

export default function AuthNotice({ notice, disabled, onRetry, onLogin, onExit }: {
    notice: AuthInfo | null
    disabled: boolean
    onRetry: () => void
    onLogin: () => void
    onExit?: () => void
}) {
    if (!notice) return null
    return (
        <div className="card pdLg flexColumn gapSm">
            <p role={notice.checking ? 'status' : 'alert'}>{notice.message}</p>
            <button className="btn h30 border borderRad" type="button" disabled={disabled || notice.checking}
                onClick={notice.requiresLogin ? onLogin : onRetry}>
                {notice.checking ? '로그인 확인 중…' : notice.requiresLogin ? '다시 로그인' : '다시 확인'}
            </button>
            {onExit && <button className="btn h30 border borderRad" type="button" disabled={disabled} onClick={onExit}>메인으로</button>}
        </div>
    )
}
