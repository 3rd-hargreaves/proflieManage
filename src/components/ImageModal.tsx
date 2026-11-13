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
      <SiteImage className="imgModal" src={image.src} alt={image.alt} />
    </Modal>
  )
}
