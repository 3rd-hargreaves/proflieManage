import { useCallback, useEffect, useState } from 'react'
import sampleImage from '../assets/img.jpg'
import FeedGallery from '../components/FeedGallery'
import type { GalleryImage } from '../components/FeedGallery'
import ImageModal from '../components/ImageModal'
import LoginModal from '../components/LoginModal'

const images: GalleryImage[] = Array.from({ length: 9 }, (_, index) => ({
  id: String(index + 1),
  src: index === 0 ? sampleImage : undefined,
  alt: '',
}))

interface MainPageProps {
  isAdmin: boolean
  onOpenEditor: () => void
  onLoginSuccess: () => Promise<void>
}

export default function MainPage({ isAdmin, onOpenEditor, onLoginSuccess }: MainPageProps) {
  const [modal, setModal] = useState<'login' | GalleryImage | null>(null)
  const closeModal = useCallback(() => setModal(null), [])

  useEffect(() => {
    document.title = '이름'
  }, [])

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
      <main className="flexColumn gapLg">
        <div className="flexColumn alignCenter gapMd">
          <img className="profileImg" alt="" />
          <p className="widthFull text1 mainColorText bold textCenter">이름</p>
          <p className="widthFull text3 textCenter">“<span>상태 메시지</span>”</p>
        </div>
        <div className="widthFull flexColumn gapLg">
          {[1, 2].map(id => (
            <div key={id} className="card widthFull pdLg flexColumn gapSm">
              <p className="widthFull text2 mainColorText bold">섹션 제목</p>
              <p className="widthFull text3">서술</p>
            </div>
          ))}
        </div>
        <div className="card widthFull pdLg flexColumn gapSm">
          <p className="widthFull text2 mainColorText bold">키워드</p>
          <div className="widthFull flex gapSm">
            {[1, 2, 3].map(id => (
              <div key={id} className="keyword h30 text3 mainColorText borderRad line">#키워드</div>
            ))}
          </div>
        </div>
        <FeedGallery images={images} onOpenImage={setModal} />
      </main>
      <LoginModal isOpen={modal === 'login'} onClose={closeModal} onLoginSuccess={onLoginSuccess} />
      {modal && modal !== 'login' && <ImageModal image={modal} onClose={closeModal} />}
    </>
  )
}
