import { useState } from 'react'
import type { ImgHTMLAttributes } from 'react'

interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'onError'> {
    alt: string
    fallbackText?: string
}

export default function Image({
    src,
    alt,
    className,
    fallbackText = '이미지 로드 실패',
    ...imageProps
}: ImageProps) {
    const [failedSource, setFailedSource] = useState<string | null>(null)

    if (!src || failedSource === src) {
        return (
            <span className={`${className || ''} imagePlaceholder flex alignCenter justifyCenter pdSm textCenter`} role="img" aria-label={`${alt}. ${fallbackText}`}>
                {fallbackText}
            </span>
        )
    }

    return <img {...imageProps} className={className} src={src} alt={alt} onError={() => setFailedSource(src)} />
}
