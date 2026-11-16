import SiteLink from './SiteLink'

interface SiteHeaderProps {
    isAdmin: boolean
    showEditor: boolean
    busy: boolean
    signingOut: boolean
    navigate: (path: string) => void
    onLogin: () => void
    onLogout: () => void
}

export default function SiteHeader({ isAdmin, showEditor, busy, signingOut, navigate, onLogin, onLogout }: SiteHeaderProps) {
    return (
        <header className="siteHeader widthFull">
            <nav className="headerContent flex alignCenter justifyBetween" aria-label="주 메뉴">
                <SiteLink className="homeButton flex alignCenter justifyCenter" href="/" navigate={navigate} aria-label="메인 페이지">☗</SiteLink>
                <div className="flex alignCenter gapSm">
                    {isAdmin && showEditor && (
                        <SiteLink className="btn border borderRad headerAction headerEditLink flex alignCenter justifyCenter" href="/characters/1/edit" navigate={navigate}>수정</SiteLink>
                    )}
                    {isAdmin ? (
                        <button className="btn border borderRad headerAction headerLogoutButton flex alignCenter justifyCenter" type="button" disabled={busy || signingOut} onClick={onLogout}>
                            {signingOut ? '로그아웃 중…' : '로그아웃'}
                        </button>
                    ) : (
                        <button className="btn border borderRad headerAction headerLoginButton flex alignCenter justifyCenter" type="button" disabled={busy} onClick={onLogin}>로그인</button>
                    )}
                </div>
            </nav>
        </header>
    )
}
