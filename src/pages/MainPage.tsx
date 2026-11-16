import { useCallback, useEffect, useState } from 'react'
import SiteImage from '../components/SiteImage'
import SiteLink from '../components/SiteLink'
import ThemeEditor from '../components/ThemeEditor'
import { useMainQuery } from '../hooks/useSiteQuery'
import { getImageUrl } from '../services/storage'
import { applyTheme, toThemeColors, toThemeData } from '../utils/theme'
import type { MainData, ThemeColors } from '../types/site'
import { characterPath } from '../utils/routes'
import { isHexColor } from '../utils/validation'

interface MainPageProps {
    isAdmin: boolean
    navigate: (path: string) => void
}

export default function MainPage({ isAdmin, navigate }: MainPageProps) {
    const [theme, setTheme] = useState<ThemeColors | null>(null)
    const showMain = useCallback((data: MainData) => setTheme(toThemeColors(data.theme)), [])
    const { state, reload } = useMainQuery({ onLoad: showMain })
    const savedTheme = state.status === 'ready' ? state.data.theme : null

    useEffect(() => {
        const previous = document.title
        document.title = '캐릭터 모음'
        return () => { document.title = previous }
    }, [])
    useEffect(() => {
        if (!savedTheme) return
        return applyTheme(isAdmin && theme && Object.values(theme).every(isHexColor)
            ? { id: 1, ...toThemeData(theme) } : savedTheme)
    }, [savedTheme, isAdmin, theme])

    const characters = state.status === 'ready' ? state.data.characters : []

    return (
        <main className="flexColumn gapLg" aria-busy={state.status === 'loading'}>
            {state.status === 'loading' && <p className="card pdLg text3" role="status">불러오는 중…</p>}
            {state.status === 'error' && (
                <div className="card pdLg flexColumn gapMd">
                    <p className="text3" role="alert">{state.message}</p>
                    <button className="btn h30 border borderRad" type="button" onClick={reload}>다시 시도</button>
                </div>
            )}
            {characters.map(character => (
                <SiteLink key={character.id} className="character card flex pdLg gapMd" href={characterPath(character.id)} navigate={navigate}>
                    <SiteImage className="profileImg" src={getImageUrl(character.profile_image_path)} alt={`${character.name} 프로필 이미지`} fallbackText={character.profile_image_path ? undefined : '이미지 없음'} />
                    <div className="flexColumn gapSm">
                        <p className="text1 bold">{character.name}</p>
                        <p className="text3">{character.status_message}</p>
                    </div>
                </SiteLink>
            ))}
            {state.status === 'ready' && characters.length === 0 && <p className="card pdLg text3">등록된 캐릭터가 없습니다.</p>}
            {isAdmin && (
                <>
                    <p className="text3">드래그 앤 드롭으로 순서 변경</p>
                    <button className="btn h30 border borderRad widthFull" type="button" disabled>순서 저장</button>
                    <SiteLink className="btn h30 border borderRad widthFull flex alignCenter justifyCenter" href="/characters/new" navigate={navigate}>캐릭터 추가</SiteLink>
                    {state.status === 'ready' && theme && <ThemeEditor title="메인 테마" value={theme} onChange={(key, value) => setTheme(previous => previous && ({ ...previous, [key]: value }))}>
                        <button className="btn h30 border borderRad widthFull" type="button" disabled>테마 저장</button>
                    </ThemeEditor>}
                    <p className="text3">순서 변경과 메인 테마 저장은 준비 중입니다. 테마 색상은 미리 볼 수 있습니다.</p>
                </>
            )}
        </main>
    )
}
