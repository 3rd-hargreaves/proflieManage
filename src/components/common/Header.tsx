import Link from './Link'

interface HeaderProps {
    isAdmin: boolean
    editHref?: string
    busy: boolean
    signingOut: boolean
    navigate: (path: string) => void
    onLogin: () => void
    onLogout: () => void
}

export default function Header({ isAdmin, editHref, busy, signingOut, navigate, onLogin, onLogout }: HeaderProps) {
    return (
        <header className="siteHeader widthFull">
            <nav className="headerContent flex alignCenter justifyBetween" aria-label="주 메뉴">
                <Link className="homeButton h30 mainColorText flex alignCenter justifyCenter" href="/" navigate={navigate} aria-label="메인 페이지">☗</Link>
                <div className="flex alignCenter gapSm">
                    {isAdmin && editHref && (
                        <Link className="btn h30 border borderRad headerAction headerEditLink flex alignCenter justifyCenter" href={editHref} navigate={navigate}>수정</Link>
                    )}
                    {isAdmin ? (
                        <button className="btn h30 border borderRad headerAction headerLogoutButton flex alignCenter justifyCenter" type="button" disabled={busy || signingOut} onClick={onLogout}>
                            {signingOut ? '로그아웃 중…' : '로그아웃'}
                        </button>
                    ) : (
                        <button className="btn h30 border borderRad headerAction headerLoginButton flex alignCenter justifyCenter" type="button" disabled={busy} onClick={onLogin}>로그인</button>
                    )}
                </div>
            </nav>
        </header>
    )
}
