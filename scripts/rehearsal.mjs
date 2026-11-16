import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
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
    for (const name of (await readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql'))) {
        assert.equal(state.migrationHashes?.[name], digest(await readFile(path.join(root, 'supabase/migrations', name))), 'Rehearsal migrations changed; rerun their rehearsal before using this database')
    }
    const catalog = JSON.parse((await sql(`select jsonb_build_object(
        'database',current_database(),
        'tables',to_regclass('public.characters') is not null and to_regclass('public.character_themes') is not null and to_regclass('public.main_theme') is not null and to_regclass('private.character_api_control') is not null,
        'read_api',to_regprocedure('public.load_main()') is not null and to_regprocedure('public.load_character(bigint)') is not null,
        'write_api',to_regprocedure('public.create_character(bigint,uuid,jsonb)') is not null and to_regprocedure('public.save_character(bigint,jsonb,jsonb)') is not null and to_regprocedure('public.delete_character(bigint,jsonb)') is not null and to_regprocedure('public.save_character_order(jsonb,jsonb)') is not null and to_regprocedure('public.save_main_theme(jsonb,jsonb)') is not null
    );`)).toString())
    assert.equal(catalog.database, 'postgres')
    assert(catalog.tables && catalog.read_api && catalog.write_api, 'Rehearsal database is not migrated; refusing to start the frontend')
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

async function prepare(snapshotPath) {
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
    await step('legacy-schema', async () => {
        const present = (await sql("select to_regclass('public.profile') is not null or to_regclass('public.characters') is not null;")).toString().trim()
        assert.equal(present, 'f', 'Refusing to seed a database with pre-existing application data')
        for (const name of ['schema.sql', 'read.sql', 'save.sql']) await sql(await readFile(path.join(root, 'supabase', name), 'utf8'))
    })
    await step('offline-data', async () => {
        assert(snapshotPath, 'Pass a private offline snapshot file to prepare the rehearsal')
        const snapshot = await json(path.resolve(snapshotPath))
        assert(snapshot.site?.profile && snapshot.site?.theme && snapshot.sequences)
        let text = 'begin; delete from public.sections; delete from public.keywords; delete from public.feed_images; delete from public.profile; delete from public.theme;'
        for (const table of ['profile', 'theme']) text += `insert into public.${table} select * from jsonb_populate_record(null::public.${table},${literal(snapshot.site[table])});`
        for (const [table, key] of [['sections', 'sections'], ['keywords', 'keywords'], ['feed_images', 'feed']]) {
            text += `insert into public.${table} overriding system value select * from jsonb_populate_recordset(null::public.${table},${literal(snapshot.site[key])});`
            const sequence = snapshot.sequences[table]
            assert.match(String(sequence.last_value), /^\d+$/)
            assert.equal(typeof sequence.is_called, 'boolean')
            text += `select setval('public.${table}_id_seq',${sequence.last_value},${sequence.is_called});`
        }
        await sql(text + 'commit;')
    })
    await step('binary-fixtures', async () => {
        const snapshot = JSON.parse((await sql('select public.load_site();')).toString())
        const paths = new Set([snapshot.profile.profile_image_path, ...snapshot.feed.map(row => row.image_path)].filter(Boolean))
        const manifest = []
        for (const name of paths) {
            assert.match(name, /^(profile|feed)\/[^\r\n]+$/)
            const uploaded = await owner.storage.from(config.storageBucket).upload(name, png, { contentType: 'image/png', upsert: false })
            if (uploaded.error) {
                const downloaded = await owner.storage.from(config.storageBucket).download(name)
                assert(!downloaded.error && digest(Buffer.from(await downloaded.data.arrayBuffer())) === digest(png), 'Existing rehearsal image differs')
            }
            manifest.push({ path: name, sha256: digest(png), contentType: 'image/png', bytes: png.toString('base64') })
        }
        // Paths are from the offline export; bytes are explicitly synthetic fixtures.
        await writeFile(path.join(workdir, 'binary-fixtures.json'), JSON.stringify({ synthetic: true, files: manifest }, null, 4))
    })
    await step('legacy-backup', async () => {
        const backup = await run('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '-Fc'])
        await writeFile(path.join(workdir, 'legacy-postgres.dump'), backup)
        await writeFile(path.join(workdir, 'legacy-snapshot.json'), await sql('select public.load_site();'))
    })
    const migrations = (await readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()
    state.migrationHashes ??= {}
    for (const name of migrations) {
        const content = await readFile(path.join(root, 'supabase/migrations', name), 'utf8')
        if (state.completed.includes(name)) assert.equal(state.migrationHashes[name], digest(content), 'Applied rehearsal migration differs from the working tree')
        await step(name, async () => {
            await sql(`set app.multi_character_maintenance='on';\n${content}`)
            state.migrationHashes[name] = digest(content)
        })
    }
    await step('verify-migration', async () => {
        const before = await json(path.join(workdir, 'legacy-snapshot.json'))
        const after = JSON.parse((await sql('select public.load_character(1);')).toString())
        assert.equal(digest(JSON.stringify(after)), digest(JSON.stringify(before)), 'Migration must preserve the complete offline character')
        await sql(`set app.multi_character_maintenance='on';\n${await readFile(path.join(root, 'supabase/multi-character-enable-writes.sql'), 'utf8')}`)
        await sql("notify pgrst, 'reload schema';")
    })
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
    if (command === 'prepare') await prepare(process.argv[3])
    else if (command === 'dev') await dev()
    else if (command === 'check') { await assertContainer(); await assertReady(await json(configPath)); console.log('Local rehearsal database and REST API are ready.') }
    else if (command === 'stop') { await assertContainer(); await supabaseCli(['stop']); console.log('Stopped the isolated rehearsal stack; data volumes retained.') }
    else throw new Error('Usage: rehearsal.mjs prepare <private-offline-snapshot.json> | check | dev | stop')
} catch (error) {
    console.error(error.message)
    process.exitCode = 1
}
