import type { GalleryImage } from './FeedGallery'
import Modal from './Modal'
import SiteImage from './SiteImage'

interface ImageModalProps {
    image: GalleryImage
    onClose: () => void
}

export default function ImageModal({ image, onClose }: ImageModalProps) {
    return (
        <Modal id="imgModal" label="이미지 확대" onClose={onClose}>
            <div className="modal flexColumn alignCenter gapSm">
                <SiteImage className="imgModal" src={image.src} alt={image.alt} />
                <button type="button" className="btn h30 border borderRad pdSide" onClick={onClose} aria-label="이미지 확대 창 닫기">
                    닫기
                </button>
            </div>
        </Modal>
    )
}
