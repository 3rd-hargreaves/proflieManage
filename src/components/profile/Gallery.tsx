import { useState } from 'react'
import Image from '../common/Image'

export interface GalleryImage {
    id: string
    src?: string
    alt: string
}

interface GalleryProps {
    images: GalleryImage[]
    onOpenImage: (image: GalleryImage) => void
}

export default function Gallery({ images, onOpenImage }: GalleryProps) {
    const [isOpen, setIsOpen] = useState(false)

    return (
        <div className="widthFull flexColumn gapSm">
            <button
                id="feedOpenBtn"
                type="button"
                className="btn h30 border borderRad widthFull"
                style={{ display: isOpen ? 'none' : 'block' }}
                onClick={() => setIsOpen(true)}
            >피드 보기</button>
            <div className="picList gapSm" style={{ display: isOpen ? 'grid' : 'none' }}>
                {images.map(image => (
                    <Image
                        key={image.id}
                        className="pic widthFull"
                        src={image.src}
                        alt={image.alt}
                        loading="lazy"
                        decoding="async"
                        role="button"
                        aria-label={`${image.alt} 확대`}
                        tabIndex={isOpen ? 0 : -1}
                        onClick={() => onOpenImage(image)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                onOpenImage(image)
                            }
                        }}
                    />
                ))}
                {images.length === 0 && <p className="card pdLg text3 feedEmpty">등록된 이미지가 없습니다.</p>}
            </div>
            <button
                id="feedBtn"
                type="button"
                className="btn h30 border borderRad widthFull"
                style={{ display: isOpen ? 'block' : 'none' }}
                onClick={() => setIsOpen(false)}
            >피드 닫기</button>
        </div>
    )
}
