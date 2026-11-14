export function imageFileName(path: string): string {
    const name = path.split('/').at(-1) || path
    const encoded = name.match(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}--(.*)$/i)?.[1]
    try {
        return decodeURIComponent(encoded === undefined ? name : encoded.replace(/_([\da-f]{2})/gi, '%$1'))
    } catch {
        return encoded ?? name
    }
}
