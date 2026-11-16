import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const adminId = 'f711da08-9c0b-42ee-a20c-a4f83ad46473'
export const readSql = name => readFile(path.join(root, 'supabase', name), 'utf8')
export const literal = value => `'${String(value).replaceAll("'", "''")}'`
const stackId = process.env.REHEARSAL_STACK_ID || 'profile-stage7-stack'
const container = process.env.REHEARSAL_PG_CONTAINER || `supabase_db_${stackId}`
if (!/^profile-stage7-[a-z0-9-]+$/.test(stackId) || container !== `supabase_db_${stackId}`) {
    throw new Error('Set REHEARSAL_PG_CONTAINER to the isolated local PostgreSQL 17 Docker container. Hosted database URLs are not accepted.')
}
const inspection = await promisify(execFile)('docker', ['inspect', '--format', '{{json .Config.Labels}}', container], { windowsHide: true })
const labels = JSON.parse(inspection.stdout)
assert.equal(labels['com.supabase.cli.project'], stackId, 'The container must belong to the disposable Supabase rehearsal stack')
assert.equal(labels['com.docker.compose.project'], stackId)
export const managedArchive = {
    dumpPath: process.env.REHEARSAL_MANAGED_DUMP_PATH || path.join(root, 'supabase/.temp', stackId, 'legacy-postgres.dump'),
    snapshotPath: process.env.REHEARSAL_MANAGED_SNAPSHOT_PATH || path.join(root, 'supabase/.temp', stackId, 'legacy-snapshot.json'),
}

function processInContainer(command, args, { input, appName = 'profile_rehearsal', timeout = 90000, interactive = false } = {}) {
    const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${appName}`, container, command, ...args], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = [], errors = []
    let output = '', failure = null
    child.stdin.on('error', error => { failure ??= error })
    const markers = new Set()
    child.stdout.on('data', chunk => {
        chunks.push(chunk)
        if (command !== 'pg_dump') {
            output += chunk.toString('utf8')
            for (const marker of markers) if (output.includes(marker.text)) { markers.delete(marker); marker.resolve() }
        }
    })
    child.stderr.on('data', chunk => errors.push(chunk))
    const timer = setTimeout(() => { failure = new Error('Isolated PostgreSQL process timed out'); child.kill() }, timeout)
    const completion = new Promise((resolve, reject) => {
        child.once('error', error => { failure = error })
        child.once('close', code => {
            clearTimeout(timer)
            const error = failure ?? (code === 0 ? null : new Error(Buffer.concat(errors).toString('utf8').trim() || `Local PostgreSQL process exited ${code}`))
            for (const marker of markers) marker.reject(error ?? new Error('Session ended before its marker'))
            markers.clear()
            if (error) reject(error)
            else resolve(Buffer.concat(chunks))
        })
    })
    // Attach immediately so a session error before a wait/finish call is observed.
    completion.catch(() => {})
    if (!interactive) child.stdin.end(input)
    return {
        completion,
        write(text) { child.stdin.write(text) },
        finish(text = '') { child.stdin.end(text); return completion },
        waitFor(text) {
            if (output.includes(text)) return Promise.resolve()
            return new Promise((resolve, reject) => { markers.add({ text, resolve, reject }) })
        },
        kill() { child.kill() },
    }
}

function assertDatabase(name) {
    assert.match(name, /^profile_rehearsal_[a-z0-9_]+$/, 'Only disposable rehearsal databases may be modified')
}

const psqlArgs = database => ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database]
export function startSql(database, sql, options) {
    assertDatabase(database)
    return processInContainer('psql', psqlArgs(database), { ...options, input: sql })
}
export async function sql(database, text, options) {
    return (await startSql(database, text, options).completion).toString('utf8').trim()
}
export function session(database, initialSql = '') {
    assertDatabase(database)
    const result = processInContainer('psql', psqlArgs(database), { interactive: true })
    result.write(initialSql)
    return result
}
export async function value(database, query, options) {
    const output = await sql(database, `select coalesce(to_jsonb(rehearsal_value),'null'::jsonb) from (${query.replace(/;\s*$/, '')}) as rehearsal_result(rehearsal_value);`, options)
    return JSON.parse(output.split(/\r?\n/).at(-1))
}

export async function createDatabase() {
    const name = `profile_rehearsal_${crypto.randomUUID().replaceAll('-', '')}`
    await processInContainer('createdb', ['-U', 'postgres', '-T', 'template0', name]).completion
    try {
        const version = await value(name, `select current_setting('server_version_num')::int`)
        assert.equal(Math.floor(version / 10000), 17, 'Rehearsal requires native PostgreSQL 17, not PGlite or another major version')
        assert.equal(await value(name, `select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')`), 3, 'Reuse the existing local Supabase roles; do not modify cluster roles')
        return name
    } catch (error) { await dropDatabase(name); throw error }
}
export async function dropDatabase(name) {
    assertDatabase(name)
    await processInContainer('dropdb', ['-U', 'postgres', '--if-exists', '--force', name]).completion
}
export async function dumpDatabase(name) {
    assertDatabase(name)
    return processInContainer('pg_dump', ['-U', 'postgres', '-d', name, '-Fc']).completion
}
export async function restoreDatabase(name, dump) {
    assertDatabase(name)
    // Managed Auth/Storage objects retain their original owners. Use the local
    // stack's existing superuser rather than changing any cluster role grants.
    await processInContainer('pg_restore', ['-U', 'supabase_admin', '-d', name, '--exit-on-error'], { input: dump }).completion
}

// This native-Postgres suite models the Auth UID and Storage metadata schemas in
// each disposable database. Full Auth/Storage HTTP and binary-file tests run on
// the separate local Supabase stack; no hosted project is connected here.
const bootstrap = `
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean default false,
        file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
        name text not null, metadata jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), unique(bucket_id,name));
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
        select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
    $$;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on storage.objects to authenticated, service_role;
`

export async function legacyDatabase() {
    const name = await createDatabase()
    try {
        await sql(name, bootstrap)
        for (const file of ['schema.sql', 'read.sql', 'save.sql']) await sql(name, await readSql(file))
        await sql(name, `
            update public.profile set name='  이전 캐릭터  ', status_message=E'상태 _원문_\\n  ', profile_image_path='profile/legacy-original.png';
            update public.theme set main_color='#aBc', background_color='#AbCd', card_background_color='#123456', typo_color='#12345678';
            insert into public.sections(id,sort_order,title,content) overriding system value
                values(17,2,'  첫 제목  ',E' 첫 줄\\n\\n*볼드* _밑줄_ /이탤릭/ -줄-\\n| 표 |\\n '),(49,8,'둘째 제목',E'원문\\\\escape\\n');
            insert into public.keywords(id,sort_order,content) overriding system value values(23,4,'테스트'),(67,9,'#원문');
            insert into public.feed_images(id,sort_order,image_path) overriding system value values(31,3,'feed/legacy-original.png'),(89,11,'feed/legacy-second.jpg');
            select setval('public.sections_id_seq',120,true); select setval('public.keywords_id_seq',140,true); select setval('public.feed_images_id_seq',160,true);
            insert into storage.objects(bucket_id,name,metadata) values
                ('site-images','profile/legacy-original.png','{"size":13}'),('site-images','feed/legacy-original.png','{"size":17}'),('site-images','feed/legacy-second.jpg','{"size":19}');
        `)
        if (process.env.REHEARSAL_SNAPSHOT_PATH) {
            const snapshot = JSON.parse(await readFile(process.env.REHEARSAL_SNAPSHOT_PATH, 'utf8'))
            assert.ok(snapshot.site?.profile && snapshot.site?.theme && snapshot.sequences, 'The private snapshot must contain site and sequences')
            await sql(name, 'delete from public.profile; delete from public.theme; delete from public.sections; delete from public.keywords; delete from public.feed_images; delete from storage.objects;')
            for (const table of ['profile', 'theme']) {
                await sql(name, `insert into public.${table} select * from jsonb_populate_record(null::public.${table},${literal(JSON.stringify(snapshot.site[table]))}::jsonb);`)
            }
            for (const [table, property] of [['sections', 'sections'], ['keywords', 'keywords'], ['feed_images', 'feed']]) {
                await sql(name, `insert into public.${table} overriding system value select * from jsonb_populate_recordset(null::public.${table},${literal(JSON.stringify(snapshot.site[property]))}::jsonb);`)
                const sequence = snapshot.sequences[table]
                assert.match(String(sequence.last_value), /^[0-9]+$/)
                assert.equal(typeof sequence.is_called, 'boolean')
                await sql(name, `select setval('public.${table}_id_seq',${literal(sequence.last_value)}::bigint,${sequence.is_called});`)
            }
            const paths = new Set([snapshot.site.profile.profile_image_path, ...snapshot.site.feed.map(image => image.image_path)].filter(Boolean))
            for (const imagePath of paths) await sql(name, `insert into storage.objects(bucket_id,name) values('site-images',${literal(imagePath)});`)
        }
        return name
    } catch (error) { await dropDatabase(name); throw error }
}

export async function migrationFiles() {
    return (await readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()
}
export async function applyStructure(name, override) {
    const file = (await migrationFiles()).find(name => name.endsWith('_multi_character_structure.sql'))
    await sql(name, `set app.multi_character_maintenance='on';\n${override ?? await readSql(`migrations/${file}`)}`)
}
export async function applyApi(name, { activated = true } = {}) {
    for (const file of (await migrationFiles()).filter(name => !name.endsWith('_multi_character_structure.sql'))) {
        await sql(name, `set app.multi_character_maintenance='on';\n${await readSql(`migrations/${file}`)}`)
    }
    if (activated) await sql(name, `set app.multi_character_maintenance='on';\n${await readSql('multi-character-enable-writes.sql')}`)
}
export async function rollbackStructure(name) {
    await sql(name, `set app.multi_character_maintenance='on';\n${await readSql('rollback/multi_character_structure.sql')}`)
}
export async function fullDatabase(options) {
    const name = await legacyDatabase()
    try { await applyStructure(name); await applyApi(name, options); return name }
    catch (error) { await dropDatabase(name); throw error }
}

export function rpcSql(name, args = []) {
    assert.match(name, /^[a-z_]+$/)
    const encoded = args.map(value => value === null ? 'null' : typeof value === 'object' ? `${literal(JSON.stringify(value))}::jsonb` : typeof value === 'number' ? String(value) : literal(value))
    return `select coalesce(to_jsonb(public.${name}(${encoded.join(',')})),'null'::jsonb)`
}
export function authenticatedSql(query, userId = adminId) {
    return `begin; set local role authenticated; set local "request.jwt.claim.sub"=${literal(userId)}; ${query}; commit;`
}
export async function rpc(database, name, args = []) {
    const output = await sql(database, authenticatedSql(rpcSql(name, args)))
    return JSON.parse(output.split(/\r?\n/).at(-1))
}
export const blankData = (name = '두 번째 캐릭터') => ({
    profile: { name, status_message: '새 상태', profile_image_path: null },
    theme: { main_color: '#f39', background_color: '#ffe8f0', card_background_color: '#ffffff', typo_color: '#26232a' },
    sections: [], keywords: [{ id: null, content: '새 키워드' }], feed: [],
})
export const saveData = site => ({
    profile: { name: site.profile.name, status_message: site.profile.status_message, profile_image_path: site.profile.profile_image_path },
    theme: Object.fromEntries(Object.entries(site.theme).filter(([key]) => key !== 'id')),
    sections: site.sections.map(({ id, title, content }) => ({ id, title, content })),
    keywords: site.keywords.map(({ id, content }) => ({ id, content })),
    feed: site.feed.map(({ id, image_path }) => ({ id, image_path })),
})
export async function createCharacter(name, data = blankData()) {
    const request = crypto.randomUUID()
    const id = await rpc(name, 'reserve_character_id', [request])
    return { id, request, data, result: await rpc(name, 'create_character', [id, request, data]) }
}

export async function waitForAdvisoryWait(database, applicationName) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
        if (await value(database, `select exists(select from pg_stat_activity where application_name=${literal(applicationName)} and wait_event_type='Lock' and wait_event='advisory')`)) return
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`The independent PostgreSQL session did not reach its advisory lock: ${applicationName}`)
}
