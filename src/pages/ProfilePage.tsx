import { useCallback, useEffect, useState } from 'react'
import Gallery from '../components/profile/Gallery'
import type { GalleryImage } from '../components/profile/Gallery'
import ImageModal from '../components/profile/ImageModal'
import Image from '../components/common/Image'
import SectionContent from '../components/profile/SectionContent'
import { getImageUrl } from '../services/storage'
import type { Character } from '../types/models'
import { applyTheme } from '../utils/theme'
import { useCharacterQuery } from '../hooks/common/useQuery'

interface ProfilePageProps {
    characterId: number
    onLoaded: (id: number | null) => void
}

export default function ProfilePage({ characterId, onLoaded }: ProfilePageProps) {
    const [modal, setModal] = useState<GalleryImage | null>(null)
    const closeModal = useCallback(() => setModal(null), [])

    useEffect(() => {
        const previousTitle = document.title
        document.title = '프로필'
        return () => { document.title = previousTitle }
    }, [])

    const showSite = useCallback((site: Character | null) => {
        if (!site) return
        const restoreTheme = applyTheme(site.theme)
        document.title = site.profile.name
        return restoreTheme
    }, [])
    const { state: siteState, reload } = useCharacterQuery(characterId, { onLoad: showSite })

    const site = siteState.status === 'ready' ? siteState.data : null
    useEffect(() => {
        onLoaded(site?.profile.id ?? null)
        return () => onLoaded(null)
    }, [site, onLoaded])
    const images: GalleryImage[] = site ? site.feed.map((image, index) => ({
        id: String(image.id),
        src: getImageUrl(image.image_path),
        alt: `피드 이미지 ${index + 1}`,
    })) : []

    return (
        <>
            <main className="flexColumn gapLg" aria-busy={siteState.status === 'loading'}>
                {siteState.status === 'loading' && <p className="card pdLg text3" role="status">불러오는 중…</p>}
                {siteState.status === 'ready' && !site && <p className="card pdLg text3" role="status">캐릭터를 찾을 수 없습니다.</p>}
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
                            <Image
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

                        <Gallery images={images} onOpenImage={setModal} />
                    </>
                )}
            </main>

            {modal && <ImageModal image={modal} onClose={closeModal} />}
        </>
    )
}
