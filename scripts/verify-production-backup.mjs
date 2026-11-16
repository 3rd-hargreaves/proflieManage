import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
    applyApi, applyStructure, createDatabase, dropDatabase, literal, value,
} from '../tests/helpers/rehearsalDatabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.resolve(process.argv[2] || path.join(root, 'supabase/backups/production-cutover-20261116'))
const prefix = process.argv[3] || 'pre-freeze'
assert.match(prefix, /^[a-z][a-z0-9-]*$/)
const stack = process.env.REHEARSAL_STACK_ID || 'profile-stage7-stack'
const container = process.env.REHEARSAL_PG_CONTAINER || `supabase_db_${stack}`
const expectedProject = 'nvunhhyxbbjqgzdhodrw'
const reportPath = path.join(directory, `${prefix}-verification.json`)
const errorPath = path.join(directory, `${prefix}-verification-error.log`)
const sha = data => createHash('sha256').update(data).digest('hex')
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const stable = value => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const fingerprint = value => sha(JSON.stringify(stable(value)))
const same = (actual, expected, label) => assert.equal(fingerprint(actual), fingerprint(expected), label)
const sorted = (rows, key) => [...rows].sort((a, b) => String(key(a)).localeCompare(String(key(b)), 'en'))
let database, phase = 'backup input', storage, bucket

async function restore(text, label) {
    assert.match(database, /^profile_rehearsal_[a-z0-9_]+$/)
    return new Promise((resolve, reject) => {
        const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1'], {
            windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
        })
        const errors = []
        child.stderr.on('data', bytes => errors.push(bytes))
        child.stdin.on('error', () => {})
        child.once('error', reject)
        child.once('close', async code => {
            if (code === 0) resolve()
            else {
                await writeFile(errorPath, Buffer.concat(errors)).catch(() => {})
                reject(new Error(`Local ${label} restore failed (${code}); see the ignored verification error log`))
            }
        })
        child.stdin.end(text)
    })
}

async function normalizeAcl(acl) {
    if (acl === null) return null
    return value(database, `select coalesce(jsonb_agg(jsonb_build_object(
        'grantor',pg_get_userbyid(grantor),'grantee',case when grantee=0 then 'PUBLIC' else pg_get_userbyid(grantee) end,
        'privilege',privilege_type,'grantable',is_grantable)
        order by pg_get_userbyid(grantor),grantee,privilege_type,is_grantable),'[]'::jsonb)
        from aclexplode(${literal(acl)}::aclitem[])`)
}

async function normalizedCatalog(catalog) {
    return {
        tables: sorted(await Promise.all(catalog.tables.map(async row => ({ ...row, acl: await normalizeAcl(row.acl) }))), row => row.name),
        policies: sorted(catalog.policies.map(row => ({ ...row, roles: [...row.roles].sort() })), row => `${row.schemaname}.${row.tablename}.${row.policyname}`),
        functions: sorted(await Promise.all(catalog.functions.map(async row => ({ ...row, acl: await normalizeAcl(row.acl) }))), row => row.signature),
    }
}

async function catalog(expected) {
    const names = expected.tables.map(row => row.name)
    for (const name of names) assert.match(name, /^(public|private|storage|auth)\.[a-z_][a-z0-9_]*$/)
    const schemas = [...new Set(expected.policies.map(row => row.schemaname))]
    const functions = expected.functions.map(row => row.signature)
    return value(database, `select jsonb_build_object(
        'tables',(select jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity) order by n.nspname,c.relname)
            from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||'.'||c.relname in (select jsonb_array_elements_text(${literal(JSON.stringify(names))}::jsonb))),
        'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname),'[]') from pg_policies p where schemaname in (select jsonb_array_elements_text(${literal(JSON.stringify(schemas))}::jsonb))),
        'functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definition_md5',md5(pg_get_functiondef(p.oid))) order by p.oid::regprocedure::text)
            from pg_proc p where p.oid in (select to_regprocedure(v) from jsonb_array_elements_text(${literal(JSON.stringify(functions))}::jsonb) a(v))))`)
}

async function verifyBinaries(snapshot) {
    phase = 'binary backup verification'
    const binaryDirectory = await realpath(path.join(directory, `${prefix}-binary`))
    const manifest = await readJson(path.join(binaryDirectory, 'manifest.json'))
    assert.equal(manifest.project_id, expectedProject)
    assert(Array.isArray(manifest.files))
    const original = snapshot.storage.filter(row => row.bucket_id === 'site-images')
    same([...manifest.files.map(row => row.path)].sort(), [...original.map(row => row.name)].sort(), 'Every original Storage object must have one binary backup')
    assert.equal(new Set(manifest.files.map(row => row.path)).size, manifest.files.length)
    const bytesByPath = new Map()
    let total = 0
    for (const file of manifest.files) {
        assert.equal(path.basename(file.file), file.file)
        assert.match(file.sha256, /^[a-f0-9]{64}$/)
        const target = await realpath(path.join(binaryDirectory, file.file))
        assert(target.startsWith(binaryDirectory + path.sep), 'Backup bytes must stay inside the manifest directory')
        const bytes = await readFile(target)
        assert.equal(bytes.length, file.size, 'Original image size')
        assert.equal(sha(bytes), file.sha256, 'Original image SHA256')
        const metadata = original.find(row => row.name === file.path)?.metadata
        if (metadata?.size !== undefined) assert.equal(Number(metadata.size), bytes.length, 'Storage metadata size must match bytes')
        bytesByPath.set(file.path, bytes)
        total += bytes.length
    }
    phase = 'local binary restoration'
    const status = await readJson(path.join(root, 'supabase/.temp', stack, 'status.json'))
    assert.equal(status.API_URL, 'http://127.0.0.1:55431', 'Only the isolated local Storage API is allowed')
    assert(typeof status.SERVICE_ROLE_KEY === 'string' && status.SERVICE_ROLE_KEY)
    storage = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).storage
    bucket = `profile-production-backup-${randomUUID()}`
    const created = await storage.createBucket(bucket, { public: true })
    assert.equal(created.error, null, 'Create an independent local restoration bucket')
    for (const file of manifest.files) {
        const uploaded = await storage.from(bucket).upload(file.path, bytesByPath.get(file.path), { contentType: file.contentType || 'application/octet-stream', upsert: false })
        assert.equal(uploaded.error, null, 'Restore original bytes to the separate local bucket')
        const downloaded = await storage.from(bucket).download(file.path)
        assert.equal(downloaded.error, null, 'Read the restored original image')
        assert.equal(sha(Buffer.from(await downloaded.data.arrayBuffer())), file.sha256, 'Restored binary SHA256')
        const url = storage.from(bucket).getPublicUrl(file.path).data.publicUrl
        assert.equal(new URL(url).origin, status.API_URL)
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) })
        assert.equal(response.status, 200, 'Restored original image has a working public URL')
        assert.equal(sha(Buffer.from(await response.arrayBuffer())), file.sha256, 'Restored public image SHA256')
    }
    return { files: manifest.files.length, bytes: total, restoredAndHashVerified: true }
}

try {
    const snapshot = await readJson(path.join(directory, `${prefix}-snapshot.json`))
    assert.equal(snapshot.project_id, expectedProject)
    assert.match(snapshot.database_version, /^17\./)
    const schema = await readFile(path.join(directory, `${prefix}-schema.sql`))
    const data = await readFile(path.join(directory, `${prefix}-data.sql`))
    // Global role definitions are deliberately never executed on the local cluster.
    assert(!/^\s*\\(?:connect|c\s)/m.test(schema.toString()) && !/^\s*\\(?:connect|c\s)/m.test(data.toString()))
    database = await createDatabase()
    phase = 'native schema restoration'
    await restore(schema, 'schema')
    phase = 'native COPY data restoration'
    await restore(data, 'data')
    phase = 'legacy data and catalog comparison'
    same(await value(database, 'select public.load_site()'), snapshot.site, 'All original application rows, IDs, order, raw text, colors and paths')
    const identity = await value(database, `select jsonb_build_object(
        'sections',(select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.sections_id_seq),
        'keywords',(select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.keywords_id_seq),
        'feed_images',(select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.feed_images_id_seq))`)
    same(identity, snapshot.sequences, 'Original sequence state')
    const beforeStorage = await value(database, `select coalesce(jsonb_agg(to_jsonb(o) order by bucket_id,name),'[]') from storage.objects o`)
    same(sorted(beforeStorage, row => `${row.bucket_id}/${row.name}`), sorted(snapshot.storage, row => `${row.bucket_id}/${row.name}`), 'Original Storage object metadata')
    same(await value(database, `select coalesce(jsonb_agg(to_jsonb(b) order by id),'[]') from storage.buckets b`), sorted(snapshot.buckets, row => row.id), 'Original bucket metadata')
    same(await normalizedCatalog(await catalog(snapshot.catalog)), await normalizedCatalog(snapshot.catalog), 'Original owners, ACLs, RLS, policies and function definitions')
    phase = 'full production-copy migration'
    await applyStructure(database)
    await applyApi(database, { activated: false })
    same(await value(database, 'select public.load_character(1)'), snapshot.site, 'Four migrations preserve the original character exactly')
    same(await value(database, `select coalesce(jsonb_agg(to_jsonb(o) order by bucket_id,name),'[]') from storage.objects o`), beforeStorage, 'Migration preserves original Storage metadata')
    assert.equal(await value(database, 'select writes_enabled from private.character_api_control where id=1'), false, 'New writes remain closed until cutover verification')
    const binaries = await verifyBinaries(snapshot)
    const report = {
        project_id: expectedProject, verified_at: new Date().toISOString(), target: 'isolated-local-postgresql-17',
        sourcePrefix: prefix, schemaSha256: sha(schema), dataSha256: sha(data),
        legacyRowsCatalogSequencesVerified: true, originalOwnerAclVerified: true, allFourMigrationsVerified: true,
        authStorageSchemasRestored: true, globalRolesModified: false, binaries,
    }
    await writeFile(reportPath, JSON.stringify(report, null, 4))
    console.log(JSON.stringify(report, null, 2))
} catch (error) {
    console.error(`Production backup verification failed during ${phase}: ${error.message}`)
    process.exitCode = 1
} finally {
    if (storage && bucket) {
        try {
            assert.match(bucket, /^profile-production-backup-[a-f0-9-]+$/)
            const emptied = await storage.emptyBucket(bucket)
            assert.equal(emptied.error, null, 'Cleanup local restoration bucket')
            const deleted = await storage.deleteBucket(bucket)
            assert.equal(deleted.error, null, 'Remove the independent local bucket')
        } catch { console.error('Local restoration bucket cleanup failed'); process.exitCode = 1 }
    }
    if (database) await dropDatabase(database)
}
