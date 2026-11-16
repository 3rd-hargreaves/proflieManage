import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
    adminId, applyApi, applyStructure, authenticatedSql, blankData, createCharacter,
    createDatabase, dropDatabase, dumpDatabase, fullDatabase, legacyDatabase,
    literal, managedArchive, migrationFiles, readSql, restoreDatabase, rollbackStructure, rpc,
    rpcSql, saveData, session, sql, startSql, value, waitForAdvisoryWait,
} from './helpers/rehearsalDatabase.mjs'

function sameData(actual, expected, message) {
    const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
    const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
    assert.equal(fingerprint(actual), fingerprint(expected), message)
}

async function withDatabase(create, action) {
    const database = await create()
    try { return await action(database) } finally { await dropDatabase(database) }
}

const legacySnapshot = database => value(database, 'select private.site_snapshot()')
const storageSnapshot = database => value(database, `select coalesce(jsonb_agg(to_jsonb(o) order by name),'[]') from storage.objects o`)
const sequences = database => value(database, `select jsonb_build_object(
    'sections',(select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.sections_id_seq),
    'keywords',(select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.keywords_id_seq),
    'feed_images',(select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.feed_images_id_seq))`)
const catalog = database => value(database, `select jsonb_build_object(
    'relations',(select jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,'acl',c.relacl::text,'rls',c.relrowsecurity) order by n.nspname,c.relname)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where (n.nspname='public' and c.relname in ('profile','theme','sections','keywords','feed_images','sections_id_seq','keywords_id_seq','feed_images_id_seq'))
            or (n.nspname='storage' and c.relname='objects')),
    'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','storage')),
    'routines',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
            and p.proname in ('load_site','save_site','site_snapshot','site_content','is_site_admin')))`)

async function hold(database, lockSql) {
    const marker = `LOCKED_${crypto.randomUUID().replaceAll('-', '')}`
    const connection = session(database, `begin; ${lockSql};\n\\echo ${marker}\n`)
    let closed = false
    await connection.waitFor(marker)
    return {
        async finish(query = '') {
            closed = true
            return connection.finish(`${query ? `${query};` : ''} commit;\n`)
        },
        async cleanup() {
            if (!closed) { closed = true; await connection.finish('rollback;\n').catch(() => {}) }
        },
    }
}

const appName = suffix => `profile_rehearsal_${suffix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`

test('real Supabase Auth/Storage catalog archive restores and migrates without replacing managed schemas', async () => {
    const dump = await readFile(managedArchive.dumpPath)
    const expected = JSON.parse(await readFile(managedArchive.snapshotPath, 'utf8'))
    await withDatabase(createDatabase, async database => {
        await restoreDatabase(database, dump)
        const before = await legacySnapshot(database), identity = await sequences(database), metadata = await storageSnapshot(database)
        sameData(before, expected.site ?? expected, 'The real managed archive matches its external legacy snapshot')
        assert.equal(await value(database, `select to_regclass('auth.users') is not null and to_regclass('storage.migrations') is not null`), true)
        await applyStructure(database)
        await applyApi(database, { activated: false })
        sameData(await rpc(database, 'load_character', [1]), before)
        sameData(await sequences(database), identity)
        sameData(await storageSnapshot(database), metadata)
        assert.equal(await value(database, `select not writes_enabled from private.character_api_control where id=1`), true)
        await assert.rejects(() => rpc(database, 'reserve_character_id', [crypto.randomUUID()]), /writes_disabled/)
        const migratedDump = await dumpDatabase(database)
        await withDatabase(createDatabase, async restored => {
            await restoreDatabase(restored, migratedDump)
            sameData(await rpc(restored, 'load_character', [1]), before)
            sameData(await sequences(restored), identity)
            sameData(await storageSnapshot(restored), metadata)
        })
    })
})

test('native PG17 backup restoration preserves legacy data, ACLs, identity state and first-character migration', async () => {
    await withDatabase(legacyDatabase, async source => {
        const before = await legacySnapshot(source)
        const beforeCatalog = await catalog(source)
        const beforeSequences = await sequences(source)
        const files = await storageSnapshot(source)
        const dump = await dumpDatabase(source)
        assert.ok(dump.subarray(0, 5).equals(Buffer.from('PGDMP')), 'Use a real pg_dump custom-format archive')
        await withDatabase(createDatabase, async restored => {
            await restoreDatabase(restored, dump)
            sameData(await legacySnapshot(restored), before)
            sameData(await catalog(restored), beforeCatalog)
            sameData(await sequences(restored), beforeSequences)
            sameData(await storageSnapshot(restored), files)
            assert.match(await sql(restored, await readSql('multi-character-preflight.sql')), /17\./)
            await applyStructure(restored)
            const migrated = await value(restored, `select jsonb_build_object(
                'profile',(select to_jsonb(c)-'sort_order'-'creation_request_id' from public.characters c where id=1),
                'theme',(select jsonb_build_object('id',1)||(to_jsonb(t)-'character_id') from public.character_themes t where character_id=1),
                'sections',(select jsonb_agg(to_jsonb(s)-'character_id' order by sort_order,id) from public.sections s),
                'keywords',(select jsonb_agg(to_jsonb(k)-'character_id' order by sort_order,id) from public.keywords k),
                'feed',(select jsonb_agg(to_jsonb(f)-'character_id' order by sort_order,id) from public.feed_images f))`)
            sameData(migrated, before)
            sameData(await value(restored, 'select to_jsonb(t) from public.main_theme t where id=1'), before.theme)
            sameData(await sequences(restored), beforeSequences)
            sameData(await storageSnapshot(restored), files)
            assert.equal(await value(restored, `select nextval('public.characters_id_seq')`), 2)
            assert.equal(await value(restored, `select nextval('public.sections_id_seq')`), beforeSequences.sections.last_value + (beforeSequences.sections.is_called ? 1 : 0))
        })
        sameData(await legacySnapshot(source), before, 'Rehearsal never migrates its backup source database')
    })
})

test('native structure-only rollback restores ACLs and raw data, and applying the migration twice is rejected', async () => {
    await withDatabase(legacyDatabase, async database => {
        const before = await legacySnapshot(database), metadata = await catalog(database), identity = await sequences(database)
        await applyStructure(database)
        await assert.rejects(() => applyStructure(database), /mc_already_applied/)
        await rollbackStructure(database)
        sameData(await legacySnapshot(database), before)
        sameData(await catalog(database), metadata)
        sameData(await sequences(database), identity)
        assert.equal(await value(database, `select to_regclass('public.characters') is null`), true)
    })
})

test('native partial migration failure rolls back DDL, data and grants instead of leaving a half-migrated database', async () => {
    await withDatabase(legacyDatabase, async database => {
        const before = await legacySnapshot(database), metadata = await catalog(database)
        const file = (await migrationFiles()).find(name => name.endsWith('_multi_character_structure.sql'))
        const original = await readSql(`migrations/${file}`)
        const broken = original.replace('create table public.character_themes (', 'select 1/0;\ncreate table public.character_themes (')
        assert.notEqual(broken, original)
        await assert.rejects(() => applyStructure(database, broken), /division by zero/)
        sameData(await legacySnapshot(database), before)
        sameData(await catalog(database), metadata)
        assert.equal(await value(database, `select to_regclass('public.characters') is null and to_regclass('private.multi_character_migration_backup') is null`), true)
    })
})

test('rollback fails closed after content or API changes, while full pg_dump restores all post-migration data', async () => {
    await withDatabase(legacyDatabase, async database => {
        const original = await legacySnapshot(database)
        await applyStructure(database)
        await sql(database, `update public.characters set name='변경 후 보존' where id=1;`)
        await assert.rejects(() => rollbackStructure(database), /mc_rollback_data_changed/)
        assert.equal(await value(database, `select name from public.characters where id=1`), '변경 후 보존')
        await sql(database, `update public.characters set name=${literal(original.profile.name)} where id=1;`)
        await applyApi(database)
        await assert.rejects(() => rollbackStructure(database), /mc_rollback_schema_changed/)
        const second = await createCharacter(database)
        const first = await rpc(database, 'load_character', [1])
        const changed = saveData(first)
        changed.profile.name = '첫 캐릭터 편집'
        await rpc(database, 'save_character', [1, first, changed])
        await rpc(database, 'save_character_order', [[1, second.id], [second.id, 1]])
        const main = await rpc(database, 'load_main')
        const characters = await Promise.all(main.characters.map(character => rpc(database, 'load_character', [character.id])))
        const identity = await sequences(database)
        const dump = await dumpDatabase(database)
        await withDatabase(createDatabase, async restored => {
            await restoreDatabase(restored, dump)
            sameData(await rpc(restored, 'load_main'), main)
            sameData(await Promise.all(main.characters.map(character => rpc(restored, 'load_character', [character.id]))), characters)
            sameData(await sequences(restored), identity)
        })
    })
})

test('native two-session creation/order locking rejects an obsolete membership without dropping a new character', async () => {
    await withDatabase(fullDatabase, async database => {
        const request = crypto.randomUUID(), data = blankData('동시 생성')
        const id = await rpc(database, 'reserve_character_id', [request])
        const holder = await hold(database, 'select pg_advisory_xact_lock(70431862911504)')
        try {
            const tag = appName('order_waiter')
            const ordering = startSql(database, authenticatedSql(rpcSql('save_character_order', [[1], [1]])), { appName: tag })
            await waitForAdvisoryWait(database, tag)
            await holder.finish(`set local role authenticated; set local "request.jwt.claim.sub"=${literal(adminId)}; ${rpcSql('create_character', [id, request, data])}`)
            await assert.rejects(ordering.completion, /character_order_conflict/)
            sameData((await rpc(database, 'load_main')).characters.map(row => row.id), [1, id])
            assert.equal(await value(database, `select count(*)=count(distinct sort_order) from public.characters`), true)
        } finally { await holder.cleanup() }
    })
})

test('native two-session CAS permits one same-baseline character save and preserves the other character', async () => {
    await withDatabase(fullDatabase, async database => {
        const second = await createCharacter(database)
        const beforeSecond = await rpc(database, 'load_character', [second.id])
        const first = await rpc(database, 'load_character', [1])
        const a = saveData(first), b = saveData(first)
        a.profile.name = '저장 A'; b.profile.name = '저장 B'
        const holder = await hold(database, `select pg_advisory_xact_lock(hashtextextended('character:1',0))`)
        try {
            const tagA = appName('save_a'), tagB = appName('save_b')
            const savingA = startSql(database, authenticatedSql(rpcSql('save_character', [1, first, a])), { appName: tagA })
            const savingB = startSql(database, authenticatedSql(rpcSql('save_character', [1, first, b])), { appName: tagB })
            await Promise.all([waitForAdvisoryWait(database, tagA), waitForAdvisoryWait(database, tagB)])
            await holder.finish()
            const results = await Promise.allSettled([savingA.completion, savingB.completion])
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
            assert.match(results.find(result => result.status === 'rejected').reason.message, /character_conflict/)
            assert.ok(['저장 A', '저장 B'].includes((await rpc(database, 'load_character', [1])).profile.name))
            sameData(await rpc(database, 'load_character', [second.id]), beforeSecond)
        } finally { await holder.cleanup() }
    })
})

test('native two-session delete/order locking never recreates or reorders a deleted member', async () => {
    await withDatabase(fullDatabase, async database => {
        const second = await createCharacter(database)
        const holder = await hold(database, 'select pg_advisory_xact_lock(70431862911504)')
        try {
            const tag = appName('delete_order')
            const ordering = startSql(database, authenticatedSql(rpcSql('save_character_order', [[1, second.id], [second.id, 1]])), { appName: tag })
            await waitForAdvisoryWait(database, tag)
            await holder.finish(`set local role authenticated; set local "request.jwt.claim.sub"=${literal(adminId)}; ${rpcSql('delete_character', [second.id, second.result.character])}`)
            await assert.rejects(ordering.completion, /character_order_conflict/)
            assert.equal(await rpc(database, 'load_character', [second.id]), null)
            sameData((await rpc(database, 'load_main')).characters.map(row => row.id), [1])
        } finally { await holder.cleanup() }
    })
})

test('native Storage cleanup wins a race safely: a later image claim rejects the removed object atomically', async () => {
    await withDatabase(fullDatabase, async database => {
        const path = 'profile/1/race-claim.png'
        await sql(database, `insert into storage.objects(bucket_id,name) values('site-images',${literal(path)});`)
        const before = await rpc(database, 'load_character', [1]), data = saveData(before)
        data.profile.profile_image_path = path
        const holder = await hold(database, 'select pg_advisory_xact_lock(70431862911503)')
        try {
            const tag = appName('image_claim')
            const claiming = startSql(database, authenticatedSql(rpcSql('save_character', [1, before, data])), { appName: tag })
            await waitForAdvisoryWait(database, tag)
            await holder.finish(`set local role authenticated; set local "request.jwt.claim.sub"=${literal(adminId)}; delete from storage.objects where name=${literal(path)}`)
            await assert.rejects(claiming.completion, /character_image_missing/)
            sameData(await rpc(database, 'load_character', [1]), before)
            assert.equal(await value(database, `select exists(select from storage.objects where name=${literal(path)})`), false)
        } finally { await holder.cleanup() }
    })
})

test('native image claim wins a race safely: waiting Storage RLS rechecks the committed reference before deletion', async () => {
    await withDatabase(fullDatabase, async database => {
        const path = 'profile/1/race-retained.png'
        await sql(database, `insert into storage.objects(bucket_id,name) values('site-images',${literal(path)});`)
        const before = await rpc(database, 'load_character', [1]), data = saveData(before)
        data.profile.profile_image_path = path
        const holder = await hold(database, `set local role authenticated; set local "request.jwt.claim.sub"=${literal(adminId)}; ${rpcSql('save_character', [1, before, data])}`)
        try {
            const tag = appName('cleanup_waiter')
            const deleting = startSql(database, authenticatedSql(`delete from storage.objects where name=${literal(path)} returning name`), { appName: tag })
            await waitForAdvisoryWait(database, tag)
            await holder.finish()
            assert.equal((await deleting.completion).toString('utf8').trim(), '')
            assert.equal((await rpc(database, 'load_character', [1])).profile.profile_image_path, path)
            assert.equal(await value(database, `select exists(select from storage.objects where name=${literal(path)})`), true)
        } finally { await holder.cleanup() }
    })
})
