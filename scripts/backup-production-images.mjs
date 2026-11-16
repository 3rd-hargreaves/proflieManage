import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backupRoot = path.join(root, 'supabase/backups')
const project = 'nvunhhyxbbjqgzdhodrw'
const origin = `https://${project}.supabase.co`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const withinBackup = value => {
    const target = path.resolve(value)
    assert(target.startsWith(backupRoot + path.sep), 'Backup paths must stay inside the ignored backup directory')
    return target
}

try {
    assert(process.argv[2] && process.argv[3], 'Usage: backup-production-images.mjs <snapshot.json> <new-backup-directory>')
    const snapshot = JSON.parse(await readFile(withinBackup(process.argv[2]), 'utf8'))
    assert.equal(snapshot.project_id, project)
    const destination = withinBackup(process.argv[3])
    await mkdir(destination, { recursive: false })
    const files = []
    const names = new Set()
    for (const object of snapshot.storage) {
        assert.equal(object.bucket_id, 'site-images')
        assert(typeof object.name === 'string' && /^(profile|feed)\/.+/.test(object.name) && !object.name.split('/').some(part => part === '..' || part === '.'))
        assert(!names.has(object.name), 'Duplicate Storage key')
        names.add(object.name)
        const url = new URL(`/storage/v1/object/public/site-images/${object.name.split('/').map(encodeURIComponent).join('/')}`, origin)
        assert.equal(url.origin, origin)
        const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60000) })
        assert.equal(response.status, 200, 'An original Storage object could not be downloaded')
        const bytes = Buffer.from(await response.arrayBuffer())
        assert(bytes.length > 0)
        if (object.metadata?.size !== undefined) assert.equal(bytes.length, Number(object.metadata.size), 'Storage metadata size must match original bytes')
        const file = `${hash(object.name)}.bin`
        await writeFile(path.join(destination, file), bytes, { flag: 'wx' })
        files.push({ path: object.name, file, size: bytes.length, sha256: hash(bytes), contentType: response.headers.get('content-type') })
    }
    for (const reference of [snapshot.site.profile.profile_image_path, ...snapshot.site.feed.map(image => image.image_path)].filter(Boolean)) {
        assert(names.has(reference), 'A referenced image is missing from the complete Storage backup')
    }
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ project_id: project, captured_at: new Date().toISOString(), files }, null, 4), { flag: 'wx' })
    console.log(JSON.stringify({ originalFiles: files.length, originalBytes: files.reduce((sum, file) => sum + file.size, 0), sha256Recorded: true }))
} catch (error) {
    console.error(error.message)
    process.exitCode = 1
}
