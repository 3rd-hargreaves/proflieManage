import type { GalleryImage } from './Gallery'
import Modal from '../common/Modal'
import Image from '../common/Image'

interface ImageModalProps {
    image: GalleryImage
    onClose: () => void
}

export default function ImageModal({ image, onClose }: ImageModalProps) {
    return (
        <Modal id="imgModal" label="이미지 확대" onClose={onClose}>
            <div className="modal flexColumn alignCenter gapSm">
                <Image className="imgModal widthFull" src={image.src} alt={image.alt} />
            </div>
        </Modal>
    )
}
