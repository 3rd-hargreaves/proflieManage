import type { AnchorHTMLAttributes, MouseEvent } from 'react'

interface SiteLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    href: string
    navigate: (path: string) => void
}

export default function SiteLink({ href, navigate, onClick, ...props }: SiteLinkProps) {
    function follow(event: MouseEvent<HTMLAnchorElement>) {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
            || event.currentTarget.target === '_blank' || event.currentTarget.hasAttribute('download')) return
        event.preventDefault()
        navigate(href)
    }
    return <a {...props} href={href} onClick={follow} />
}
