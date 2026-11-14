import { useCallback, useEffect, useState } from 'react'
import FeedGallery from '../components/FeedGallery'
import type { GalleryImage } from '../components/FeedGallery'
import ImageModal from '../components/ImageModal'
import LoginModal from '../components/LoginModal'
import SiteImage from '../components/SiteImage'
import SectionContent from '../components/SectionContent'
import { getImageUrl } from '../services/storage'
import type { SiteData } from '../types/site'
import { applyTheme } from '../utils/theme'
import { useSiteQuery } from '../hooks/useSiteQuery'

interface MainPageProps {
    isAdmin: boolean
    onOpenEditor: () => void
    onLoginSuccess: () => Promise<void>
}

export default function MainPage({ isAdmin, onOpenEditor, onLoginSuccess }: MainPageProps) {
    const [modal, setModal] = useState<'login' | GalleryImage | null>(null)
    const closeModal = useCallback(() => setModal(null), [])

    useEffect(() => {
        const previousTitle = document.title
        document.title = '프로필'
        return () => { document.title = previousTitle }
    }, [])

    const showSite = useCallback((site: SiteData) => {
        const restoreTheme = applyTheme(site.theme)
        document.title = site.profile.name
        return restoreTheme
    }, [])
    const { state: siteState, reload } = useSiteQuery({ onLoad: showSite })

    const site = siteState.status === 'ready' ? siteState.data : null
    const images: GalleryImage[] = site ? site.feed.map((image, index) => ({
        id: String(image.id),
        src: getImageUrl(image.image_path),
        alt: `피드 이미지 ${index + 1}`,
    })) : []

    return (
        <>
            <button
                type="button"
                className="btn border borderRad edit"
                aria-label={isAdmin ? '수정 화면 열기' : '관리자 로그인 열기'}
                onClick={() => {
                    if (isAdmin) onOpenEditor()
                    else setModal('login')
                }}
            >✎</button>

            <main className="flexColumn gapLg" aria-busy={siteState.status === 'loading'}>
                {siteState.status === 'loading' && <p className="card pdLg text3" role="status">불러오는 중…</p>}
                {siteState.status === 'error' && (
                    <div className="card pdLg flexColumn gapMd">
                        <p className="text3" role="alert">{siteState.message}</p>
                        <button
                            type="button"
                            className="btn h30 border borderRad"
                            onClick={() => {
                                document.title = '프로필'
                                reload()
                            }}
                        >다시 시도</button>
                    </div>
                )}

                {site && (
                    <>
                        <div className="flexColumn alignCenter gapMd">
                            <SiteImage
                                className="profileImg"
                                src={getImageUrl(site.profile.profile_image_path)}
                                alt={`${site.profile.name} 프로필 이미지`}
                                fallbackText={site.profile.profile_image_path ? undefined : '이미지 없음'}
                            />
                            <p className="widthFull text1 mainColorText bold textCenter profileName">{site.profile.name}</p>
                            <p className="widthFull text3 textCenter profileMessage">“<span>{site.profile.status_message}</span>”</p>
                        </div>

                        <div className="widthFull flexColumn gapLg">
                            {site.sections.map(section => (
                                <div key={section.id} className="card widthFull pdLg flexColumn gapSm">
                                    <p className="widthFull text2 mainColorText bold sectionText">{section.title}</p>
                                    <SectionContent content={section.content} label={section.title} />
                                </div>
                            ))}
                            {site.sections.length === 0 && <p className="card pdLg text3">등록된 섹션이 없습니다.</p>}
                        </div>

                        <div className="card widthFull pdLg flexColumn gapSm">
                            <p className="widthFull text2 mainColorText bold">키워드</p>
                            <div className="widthFull flex gapSm keywordList">
                                {site.keywords.map(keyword => (
                                    <div key={keyword.id} className="keyword text3 mainColorText borderRad line">
                                        {keyword.content.startsWith('#') ? keyword.content : `#${keyword.content}`}
                                    </div>
                                ))}
                                {site.keywords.length === 0 && <p className="text3">등록된 키워드가 없습니다.</p>}
                            </div>
                        </div>

                        <FeedGallery images={images} onOpenImage={setModal} />
                    </>
                )}
            </main>

            <LoginModal isOpen={modal === 'login'} onClose={closeModal} onLoginSuccess={onLoginSuccess} />
            {modal && modal !== 'login' && <ImageModal image={modal} onClose={closeModal} />}
        </>
    )
}
