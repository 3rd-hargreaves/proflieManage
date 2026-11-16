import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = 'profile-stage7-stack'
const workdir = path.join(root, 'supabase/.temp', project)
const container = `supabase_db_${project}`
const cli = path.join(root, 'node_modules/supabase/dist/supabase.js')
const configPath = path.join(workdir, 'credentials.json')
const statePath = path.join(workdir, 'rehearsal-state.json')
const adminId = 'f711da08-9c0b-42ee-a20c-a4f83ad46473'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')

async function run(command, args, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        const output = [], errors = []
        child.stdout.on('data', chunk => output.push(chunk))
        child.stderr.on('data', chunk => errors.push(chunk))
        child.on('error', reject)
        child.on('close', async code => {
            if (code === 0) resolve(Buffer.concat(output))
            else {
                await writeFile(path.join(workdir, 'last-command-error.log'), Buffer.concat(errors)).catch(() => {})
                reject(new Error(`${path.basename(command)} failed (${code}); details are in the ignored rehearsal directory.`))
            }
        })
        child.stdin.on('error', () => {})
        child.stdin.end(input)
    })
}

const supabaseCli = args => run(process.execPath, [cli, ...args, '--workdir', workdir])
const sql = text => run('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], text)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))

function assertLocal(config) {
    const url = new URL(config.apiUrl)
    assert.equal(config.rehearsal, true, 'Explicit rehearsal marker required')
    assert.equal(url.origin, 'http://127.0.0.1:55431', 'Only this isolated local API is allowed')
    assert.equal(config.adminUserId, adminId)
}

async function assertContainer() {
    const details = JSON.parse((await run('docker', ['inspect', container])).toString())[0]
    assert.equal(details.Name, `/${container}`)
    assert.equal(details.Config.Labels['com.supabase.cli.project'], project)
    assert.equal(path.resolve(details.Config.Labels['com.supabase.cli.workdir']), workdir)
    const version = (await sql('select current_setting(\'server_version_num\');')).toString().trim()
    assert.match(version, /^17\d{4}$/)
}

async function assertReady(config) {
    assertLocal(config)
    const state = await json(statePath)
    assert.equal(state.rehearsal, true)
    assert.equal(state.project, project)
    if (state.schemaHash) assert.equal(state.schemaHash, digest(await readFile(path.join(root, 'supabase/schema.sql'))), 'schema.sql changed; recreate the isolated local database before preparing it again')
    const catalog = JSON.parse((await sql(`select jsonb_build_object(
        'database',current_database(),
        'tables',to_regclass('public.characters') is not null and to_regclass('public.character_themes') is not null and to_regclass('public.main_theme') is not null and to_regclass('private.character_api_control') is not null,
        'read_api',to_regprocedure('public.load_main()') is not null and to_regprocedure('public.load_character(bigint)') is not null,
        'write_api',to_regprocedure('public.create_character(bigint,uuid,jsonb)') is not null and to_regprocedure('public.save_character(bigint,jsonb,jsonb)') is not null and to_regprocedure('public.delete_character(bigint,jsonb)') is not null and to_regprocedure('public.save_character_order(jsonb,jsonb)') is not null and to_regprocedure('public.save_main_theme(jsonb,jsonb)') is not null
    );`)).toString())
    assert.equal(catalog.database, 'postgres')
    assert(catalog.tables && catalog.read_api && catalog.write_api, 'Rehearsal schema is not initialized; refusing to start the frontend')
    assert.equal((await sql('select writes_enabled from private.character_api_control where id=1;')).toString().trim(), 't', 'Rehearsal writes are not enabled')
    const client = createClient(config.apiUrl, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const response = await client.rpc('load_main').abortSignal(AbortSignal.timeout(10000))
    assert(!response.error && Array.isArray(response.data?.characters) && response.data?.theme?.id === 1, 'Rehearsal REST API is not ready')
}

async function start() {
    await mkdir(workdir, { recursive: true })
    const tomlPath = path.join(workdir, 'supabase/config.toml')
    let toml
    try { toml = await readFile(tomlPath, 'utf8') } catch {
        await supabaseCli(['init'])
        toml = await readFile(tomlPath, 'utf8')
        toml = toml.replaceAll('54321', '55431').replaceAll('54322', '55432').replaceAll('54320', '55430')
            .replaceAll('54323', '55433').replaceAll('54324', '55434').replaceAll('54329', '55439')
            .replace('# auto_expose_new_tables = true', 'auto_expose_new_tables = false')
            .replace(/(\[studio\]\s*)enabled = true/, '$1enabled = false')
            .replace(/(\[local_smtp\]\s*)enabled = true/, '$1enabled = false')
        await writeFile(tomlPath, toml)
    }
    assert.match(toml, /^project_id = "profile-stage7-stack"$/m)
    assert.match(toml, /^major_version = 17$/m)
    assert.match(toml, /^port = 55431$/m)
    assert.match(toml, /^port = 55432$/m)
    try { await readFile(path.join(workdir, 'supabase/.temp/project-ref')); throw new Error('Hosted project link is forbidden') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await supabaseCli(['start', '--exclude', 'realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'])
    await assertContainer()
    const status = JSON.parse((await supabaseCli(['status', '-o', 'json'])).toString())
    await writeFile(path.join(workdir, 'status.json'), JSON.stringify(status))
    return status
}

async function prepare() {
    const status = await start()
    let config
    try { config = await json(configPath) } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Invalid rehearsal credentials file; refusing to replace it')
        config = {
            rehearsal: true, apiUrl: status.API_URL, publishableKey: status.PUBLISHABLE_KEY || status.ANON_KEY,
            adminEmail: 'rehearsal-admin@example.test', adminUserId: adminId, adminPassword: randomBytes(24).toString('base64url'),
            otherEmail: 'rehearsal-other@example.test', otherPassword: randomBytes(24).toString('base64url'),
            initialCharacterId: 1, storageBucket: 'site-images',
        }
        await writeFile(configPath, JSON.stringify(config, null, 4))
    }
    assertLocal(config)
    assert.equal(status.API_URL, config.apiUrl)
    const owner = createClient(config.apiUrl, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    let state
    try { state = await json(statePath) } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Invalid rehearsal state file; refusing to restart initialization')
        state = { rehearsal: true, project, completed: [] }
    }
    assert.equal(state.rehearsal, true)
    assert.equal(state.project, project)
    assert(Array.isArray(state.completed), 'Invalid rehearsal setup state')
    const schema = await readFile(path.join(root, 'supabase/schema.sql'), 'utf8')
    if (state.schemaHash) assert.equal(state.schemaHash, digest(schema), 'schema.sql changed; recreate the isolated local database before preparing it again')
    const existing = (await sql("select to_regclass('public.characters') is not null;")).toString().trim() === 't'
    if (existing) {
        assert(state.completed.includes('accounts') && (['current-schema', 'existing-local-fixture'].includes(state.setup) || state.completed.includes('verify-migration')), 'Refusing to adopt an unrecognized existing local application')
        await assertReady(config)
        state.setup ??= 'existing-local-fixture'
    } else {
        assert.equal((await sql("select to_regclass('public.profile') is null and to_regclass('public.theme') is null;")).toString().trim(), 't', 'Refusing to initialize over legacy application data')
        state.setup = 'current-schema'
    }
    async function step(name, action) {
        if (state.completed.includes(name)) return
        await action()
        state.completed.push(name)
        await writeFile(statePath, JSON.stringify(state, null, 4))
        console.log(`Completed: ${name}`)
    }
    await step('accounts', async () => {
        for (const user of [
            { id: adminId, email: config.adminEmail, password: config.adminPassword },
            { email: config.otherEmail, password: config.otherPassword },
        ]) {
            const result = await owner.auth.admin.createUser({ ...user, email_confirm: true })
            if (result.error) throw new Error('Could not create isolated rehearsal accounts', { cause: result.error })
        }
    })
    if (!existing) await step('schema', async () => {
        await sql(schema)
        await sql("notify pgrst, 'reload schema';")
    })
    const admin = createClient(config.apiUrl, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const signed = await admin.auth.signInWithPassword({ email: config.adminEmail, password: config.adminPassword })
    assert(!signed.error && signed.data.user.id === adminId, 'Isolated admin authentication failed')
    async function rpc(name, args = {}) {
        const { data, error } = await admin.rpc(name, args).abortSignal(AbortSignal.timeout(10000))
        if (error) throw new Error('Could not prepare current-schema rehearsal fixtures', { cause: error })
        return data
    }
    try {
        const main = await rpc('load_main')
        if (!main.characters.length) {
            const requestId = randomUUID()
            const characterId = await rpc('reserve_character_id', { p_request_id: requestId })
            const profile = 'profile/' + characterId + '/' + requestId + '--fixture.png'
            const feed = 'feed/' + characterId + '/' + requestId + '--fixture.png'
            for (const name of [profile, feed]) {
                const result = await admin.storage.from(config.storageBucket).upload(name, png, { contentType: 'image/png', upsert: false })
                assert(!result.error, 'Could not upload isolated synthetic fixture')
            }
            await rpc('create_character', { p_character_id: characterId, p_request_id: requestId, p_data: {
                profile: { name: '검증 캐릭터', status_message: '로컬 통합 검사 전용', profile_image_path: profile },
                theme: Object.fromEntries(Object.entries(main.theme).filter(([key]) => key !== 'id')),
                sections: [{ id: null, title: '기본 섹션', content: '검증용 본문' }],
                keywords: [{ id: null, content: '검증' }], feed: [{ id: null, image_path: feed }],
            } })
            config.initialCharacterId = characterId
        } else if (!main.characters.some(character => character.id === config.initialCharacterId)) {
            config.initialCharacterId = main.characters[0].id
        }
    } finally { await admin.auth.signOut({ scope: 'local' }) }
    state.schemaHash = digest(schema)
    await writeFile(statePath, JSON.stringify(state, null, 4))
    await writeFile(configPath, JSON.stringify(config, null, 4))
    await assertReady(config)
    const env = `VITE_SUPABASE_URL=${config.apiUrl}\nVITE_SUPABASE_PUBLISHABLE_KEY=${config.publishableKey}\nVITE_ADMIN_EMAIL=${config.adminEmail}\nVITE_ADMIN_USER_ID=${config.adminUserId}\nVITE_SUPABASE_STORAGE_BUCKET=${config.storageBucket}\n`
    await writeFile(path.join(root, '.env.rehearsal.local'), env)
    console.log(`Rehearsal prepared at ${config.apiUrl}; production configuration was not changed.`)
}

async function dev() {
    const config = await json(configPath)
    assertLocal(config)
    await assertContainer()
    await assertReady(config)
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--mode', 'rehearsal', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
        cwd: root, windowsHide: true, stdio: 'inherit', env: {
            ...process.env, VITE_SUPABASE_URL: config.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
            VITE_ADMIN_EMAIL: config.adminEmail, VITE_ADMIN_USER_ID: config.adminUserId, VITE_SUPABASE_STORAGE_BUCKET: config.storageBucket,
        },
    })
    child.on('error', () => { console.error('Could not start the rehearsal frontend'); process.exitCode = 1 })
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
    child.on('exit', code => { process.exitCode = code ?? 1 })
}

try {
    const command = process.argv[2]
    if (command === 'prepare') { assert(!process.argv[3], 'Current-schema preparation uses synthetic fixtures and accepts no snapshot file'); await prepare() }
    else if (command === 'dev') await dev()
    else if (command === 'check') { await assertContainer(); await assertReady(await json(configPath)); console.log('Local rehearsal database and REST API are ready.') }
    else if (command === 'stop') { await assertContainer(); await supabaseCli(['stop']); console.log('Stopped the isolated rehearsal stack; data volumes retained.') }
    else throw new Error('Usage: local.mjs prepare | check | dev | stop')
} catch (error) {
    console.error(error.message)
    process.exitCode = 1
}
