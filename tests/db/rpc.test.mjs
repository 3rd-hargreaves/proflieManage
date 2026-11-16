import assert from 'node:assert/strict'
import test from 'node:test'
import {
    adminId, otherUserId, asRole, applySql, blankData, createCharacter, rpc,
    saveData, sqlFile, uploadMetadata, value, withDatabase,
} from '../helpers/db.mjs'

const publicVisitor = { role: 'anon', userId: null }
const otherUser = { role: 'authenticated', userId: otherUserId }
const imagePath = (folder, id) => `${folder}/${id}/${crypto.randomUUID()}--테스트 이미지.png`
const load = (db, id, options) => rpc(db, 'load_character', [id], options)
const main = (db, options) => rpc(db, 'load_main', [], options)
const denied = error => error.code === '42501'

async function noRowsOrDenied(action) {
    try { assert.equal((await action()).rows.length, 0) } catch (error) {
        if (!denied(error)) throw error
    }
}

test('fresh schema starts empty and refuses destructive reinitialization', async () => {
    await withDatabase({ seed: false }, async db => {
        const initial = await main(db, publicVisitor)
        assert.deepEqual(initial.characters, [])
        assert.equal(initial.theme.main_color, '#E45C9A')
        const created = await createCharacter(db)
        const before = await main(db, publicVisitor)
        assert.equal(before.characters[0].id, created.id)
        const schema = await sqlFile('schema.sql')
        await assert.rejects(() => applySql(db, schema), /application_schema_already_exists/)
        assert.deepEqual(await main(db, publicVisitor), before)
    })
})

test('owner can pause and resume writes while public reads stay available', async () => {
    await withDatabase({ activated: false }, async db => {
        assert.equal((await main(db, publicVisitor)).characters[0].id, 1)
        assert.equal((await load(db, 1, publicVisitor)).profile.name, '첫 캐릭터')
        await assert.rejects(() => rpc(db, 'reserve_character_id', [crypto.randomUUID()]), /writes_disabled/)
        await assert.rejects(() => uploadMetadata(db, imagePath('profile', 1)), denied)
        await noRowsOrDenied(() => asRole(db, 'authenticated', adminId,
            () => db.query(`update private.character_api_control set writes_enabled=true where id=1 returning id`)))
        assert.equal(await value(db, `select writes_enabled from private.character_api_control where id=1`), false)
        await db.exec('begin; select pg_advisory_xact_lock(70431862911507); update private.character_api_control set writes_enabled=true where id=1; commit;')
        assert.ok(await rpc(db, 'reserve_character_id', [crypto.randomUUID()]))
    })
})

test('visitors and other authenticated accounts can read only public character data', async () => {
    await withDatabase({}, async db => {
        for (const options of [publicVisitor, otherUser]) {
            assert.equal((await load(db, 1, options)).profile.id, 1)
            assert.equal(await load(db, 9999, options), null)
            await assert.rejects(() => rpc(db, 'reserve_character_id', [crypto.randomUUID()], options), denied)
            await assert.rejects(() => rpc(db, 'save_character', [1, awaitableSentinel, {}], options), denied)
        }
        const before = await load(db, 1)
        await noRowsOrDenied(() => asRole(db, 'authenticated', otherUserId,
            () => db.query(`update public.characters set name='금지' where id=1 returning id`)))
        assert.deepEqual(await load(db, 1), before)
        await assert.rejects(() => asRole(db, 'anon', null, () => db.query(`update public.characters set name='금지' where id=1`)), denied)
        await noRowsOrDenied(() => asRole(db, 'anon', null, () => db.query('select name from storage.objects')))
        await noRowsOrDenied(() => asRole(db, 'authenticated', otherUserId,
            () => db.query(`select * from private.character_creation_requests`)))
        assert.equal(await value(db, `select to_regprocedure('public.save_site(jsonb,jsonb)') is null`), true)
        assert.equal(await value(db, `select to_regprocedure('public.load_site()') is null`), true)
    })
})
const awaitableSentinel = { profile: { id: 1 }, theme: {}, sections: [], keywords: [], feed: [] }

test('restrictive Storage guards survive additional permissive mutation policies', async () => {
    await withDatabase({}, async db => {
        await db.exec(`create policy test_broad_insert on storage.objects for insert to authenticated with check (true);
            create policy test_broad_update on storage.objects for update to authenticated using (true) with check (true);
            create policy test_broad_delete on storage.objects for delete to authenticated using (true);`)
        await assert.rejects(() => uploadMetadata(db, 'profile/flat-bypass.png'), denied)
        await assert.rejects(() => uploadMetadata(db, imagePath('profile', 1), otherUserId), denied)
        await noRowsOrDenied(() => asRole(db, 'authenticated', adminId,
            () => db.query(`delete from storage.objects where name='profile/legacy.png' returning name`)))
        await noRowsOrDenied(() => asRole(db, 'authenticated', adminId,
            () => db.query(`update storage.objects set name='profile/renamed.png' where name='profile/legacy.png' returning name`)))
        assert.equal(await value(db, `select count(*)::int from storage.objects where name='profile/legacy.png'`), 1)
    })
})

test('reservation creates no public row; first creation and response-loss retries are idempotent', async () => {
    await withDatabase({}, async db => {
        const requestId = crypto.randomUUID()
        const id = await rpc(db, 'reserve_character_id', [requestId])
        assert.equal(await rpc(db, 'reserve_character_id', [requestId]), id)
        assert.equal((await main(db)).characters.length, 1)
        const data = blankData('새 *이름*')
        data.sections = [{ id: null, title: '섹션', content: '  *원문*\n_그대로_  ' }]
        const created = await rpc(db, 'create_character', [id, requestId, data])
        assert.equal(created.character.profile.id, Number(id))
        assert.equal(created.character.sections[0].content, data.sections[0].content)
        assert.deepEqual(created.cleanup_candidates, [])
        assert.deepEqual(await rpc(db, 'create_character', [id, requestId, data]), created)
        assert.equal((await main(db)).characters.length, 2)
        const changed = structuredClone(data)
        changed.profile.name = '응답 유실 뒤 바뀐 초안'
        await assert.rejects(() => rpc(db, 'create_character', [id, requestId, changed]), /creation_request_conflict/)
        assert.equal((await load(db, id)).profile.name, data.profile.name)
        await assert.rejects(() => rpc(db, 'create_character', [9999, requestId, data]))
    })
})

test('public RPC privileges and invoker settings do not expose admin operations to visitors', async () => {
    await withDatabase({}, async db => {
        const routines = (await db.query(`select p.proname, p.oid::regprocedure::text as routine, p.prosecdef, p.proconfig,
            has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
            has_function_privilege('authenticated',p.oid,'EXECUTE') as user_execute
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in ('load_main','load_character','reserve_character_id',
                'create_character','save_character','delete_character','save_character_order','save_main_theme','load_image_references')`)).rows
        assert.equal(routines.length, 9)
        for (const routine of routines) {
            assert.equal(routine.prosecdef, false, routine.routine)
            assert.ok(routine.proconfig.includes('search_path=""'), routine.routine)
            assert.equal(routine.user_execute, true, routine.routine)
            assert.equal(routine.anon_execute, ['load_main','load_character'].includes(routine.proname), routine.routine)
        }
        await assert.rejects(() => rpc(db, 'load_image_references', [], publicVisitor), denied)
        await assert.rejects(() => rpc(db, 'load_image_references', [], otherUser), denied)
        const refs = await rpc(db, 'load_image_references')
        assert.deepEqual(new Set(refs), new Set(['profile/legacy.png','feed/first.png','feed/second.png']))
    })
})

test('character writes preserve IDs, isolate other characters and return updated atomic snapshots', async () => {
    await withDatabase({}, async db => {
        const second = await createCharacter(db)
        const first = await load(db, 1)
        const data = saveData(first)
        data.profile.name = '수정한 첫 캐릭터'
        data.sections.reverse()
        data.sections[0].content = '  새 *원문*\n\n끝  '
        data.keywords.push({ id: null, content: '추가 키워드' })
        data.feed.reverse()
        const saved = await rpc(db, 'save_character', [1, first, data])
        assert.equal(saved.character.profile.name, data.profile.name)
        assert.deepEqual(saved.character.sections.map(row => row.id), [11, 10])
        assert.deepEqual(saved.character.feed.map(row => row.id), [21, 20])
        assert.equal(saved.character.sections[0].content, data.sections[0].content)
        assert.equal(saved.character.keywords.length, 2)
        assert.deepEqual(await load(db, second.id), second.character)
        assert.deepEqual(await load(db, 1), saved.character)
        assert.deepEqual((await rpc(db, 'save_character', [1, first, data])).character, saved.character)
    })
})

test('stale edits conflict, foreign or missing child IDs cannot move rows or partially save', async () => {
    await withDatabase({}, async db => {
        const secondData = blankData()
        secondData.sections = [{ id: null, title: '다른 캐릭터 섹션', content: '다른 본문' }]
        const second = await createCharacter(db, secondData)
        const first = await load(db, 1)
        const good = saveData(first)
        good.profile.name = '먼저 저장'
        const current = (await rpc(db, 'save_character', [1, first, good])).character
        const stale = saveData(first)
        stale.profile.name = '늦게 저장'
        await assert.rejects(() => rpc(db, 'save_character', [1, first, stale]), /character_conflict/)
        for (const id of [second.character.sections[0].id, 999999]) {
            const invalid = saveData(current)
            invalid.profile.name = '부분 저장되면 안 됨'
            invalid.sections[0].id = id
            await assert.rejects(() => rpc(db, 'save_character', [1, current, invalid]))
            assert.deepEqual(await load(db, 1), current)
            assert.deepEqual(await load(db, second.id), second.character)
        }
        await assert.rejects(() => rpc(db, 'save_character', [second.id, current, saveData(current)]))
    })
})

test('card ordering, character content and main theme use independent conflict baselines', async () => {
    await withDatabase({}, async db => {
        const first = await load(db, 1)
        const before = await main(db)
        const second = await createCharacter(db)
        await assert.rejects(() => rpc(db, 'save_character_order', [[1], [1]]))
        assert.deepEqual(await rpc(db, 'save_character_order', [[1, second.id], [second.id, 1]]), [second.id, 1])
        assert.deepEqual(await rpc(db, 'save_character_order', [[1, second.id], [second.id, 1]]), [second.id, 1])
        const nextTheme = { ...blankData().theme, main_color: '#123' }
        const newTheme = await rpc(db, 'save_main_theme', [before.theme, nextTheme])
        assert.equal(newTheme.main_color, '#123')
        assert.deepEqual(await rpc(db, 'save_main_theme', [before.theme, nextTheme]), newTheme)
        await assert.rejects(() => rpc(db, 'save_main_theme', [before.theme, { ...nextTheme, main_color: '#456' }]))
        const data = saveData(first)
        data.profile.status_message = '정렬과 테마 변경 뒤에도 저장 가능'
        await rpc(db, 'save_character', [1, first, data])
        assert.deepEqual((await main(db)).characters.map(row => row.id), [second.id, 1])
        assert.equal((await main(db)).theme.main_color, '#123')
        for (const invalid of [[1, 1], [second.id], [1, second.id, 9999], [String(second.id), 1], [0, 1]]) {
            await assert.rejects(() => rpc(db, 'save_character_order', [[second.id, 1], invalid]))
            assert.deepEqual((await main(db)).characters.map(row => row.id), [second.id, 1])
        }
    })
})

test('delete snapshots and replay receipts preserve cleanup paths and never recreate deleted characters', async () => {
    await withDatabase({}, async db => {
        const first = await load(db, 1)
        const second = await createCharacter(db)
        const result = await rpc(db, 'delete_character', [1, first])
        assert.equal(result.character_id, 1)
        assert.deepEqual(new Set(result.cleanup_candidates), new Set(['profile/legacy.png', 'feed/first.png', 'feed/second.png']))
        assert.equal(await load(db, 1), null)
        assert.deepEqual(await load(db, second.id), second.character)
        assert.deepEqual(await rpc(db, 'delete_character', [1, first]), result)
        await assert.rejects(() => rpc(db, 'delete_character', [1, { ...first, profile: { ...first.profile, name: '다른 기준값' } }]))
        await rpc(db, 'delete_character', [second.id, second.character])
        assert.deepEqual((await main(db)).characters, [])
        await assert.rejects(() => rpc(db, 'create_character', [second.id, second.requestId, second.data]))
        const third = await createCharacter(db, blankData('빈 목록 이후'))
        assert.equal((await main(db)).characters[0].sort_order, 1)
        assert.equal((await main(db)).characters[0].id, third.id)
    })
})

test('Storage permits immutable files in reserved character namespaces and rejects flat or foreign uploads', async () => {
    await withDatabase({}, async db => {
        const requestId = crypto.randomUUID()
        const reserved = await rpc(db, 'reserve_character_id', [requestId])
        const profile = imagePath('profile', reserved)
        await uploadMetadata(db, profile)
        assert.equal(await load(db, reserved), null)
        await assert.rejects(() => uploadMetadata(db, 'profile/old-flat.png'), denied)
        await assert.rejects(() => uploadMetadata(db, imagePath('feed', 999999)), denied)
        await assert.rejects(() => uploadMetadata(db, imagePath('profile', reserved), otherUserId), denied)
        await assert.rejects(() => uploadMetadata(db, `feed/${reserved}/../escape.png`), denied)
        await noRowsOrDenied(() => asRole(db, 'authenticated', adminId,
            () => db.query(`update storage.objects set metadata='{"size":999}' where name=$1 returning id`, [profile])))
        const data = blankData()
        data.profile.profile_image_path = profile
        const created = await rpc(db, 'create_character', [reserved, requestId, data])
        assert.equal(created.character.profile.profile_image_path, profile)
        const bucket = (await db.query(`select file_size_limit,allowed_mime_types from storage.buckets where id='site-images'`)).rows[0]
        assert.equal(Number(bucket.file_size_limit), 10 * 1024 * 1024)
        assert.deepEqual(bucket.allowed_mime_types, ['image/jpeg', 'image/png'])
    })
})

test('global Storage reference protection covers every character and releases only unreferenced legacy files', async () => {
    await withDatabase({}, async db => {
        const first = await load(db, 1)
        const second = await createCharacter(db)
        const file = imagePath('feed', second.id)
        await uploadMetadata(db, file)
        const secondData = saveData(second.character)
        secondData.feed = [{ id: null, image_path: file }]
        const savedSecond = (await rpc(db, 'save_character', [second.id, second.character, secondData])).character
        assert.deepEqual(new Set(await rpc(db, 'load_image_references')),
            new Set(['profile/legacy.png','feed/first.png','feed/second.png',file]))
        for (const name of ['profile/legacy.png', 'feed/first.png', file]) {
            const deleted = await asRole(db, 'authenticated', adminId,
                () => db.query(`delete from storage.objects where name=$1 returning name`, [name]))
            assert.equal(deleted.rows.length, 0)
        }
        const firstData = saveData(first)
        firstData.feed = firstData.feed.filter(row => row.image_path !== 'feed/first.png')
        const savedFirst = await rpc(db, 'save_character', [1, first, firstData])
        assert.ok(savedFirst.cleanup_candidates.includes('feed/first.png'))
        const replay = await rpc(db, 'save_character', [1, first, firstData])
        assert.deepEqual(replay, savedFirst, 'A lost save response must retain its cleanup candidates on retry')
        const cleanup = await asRole(db, 'authenticated', adminId,
            () => db.query(`delete from storage.objects where name='feed/first.png' returning name`))
        assert.equal(cleanup.rows.length, 1)
        assert.deepEqual(await load(db, second.id), savedSecond)
    })
})

test('new image claims require own namespace and an existing file; legacy references can remain unchanged', async () => {
    await withDatabase({}, async db => {
        const first = await load(db, 1)
        const second = await createCharacter(db)
        const foreign = imagePath('profile', second.id)
        await uploadMetadata(db, foreign)
        for (const path of [foreign, imagePath('profile', 1), 'profile/some-other-legacy.png']) {
            const data = saveData(first)
            data.profile.profile_image_path = path
            await assert.rejects(() => rpc(db, 'save_character', [1, first, data]))
            assert.deepEqual(await load(db, 1), first)
        }
        assert.deepEqual((await rpc(db, 'save_character', [1, first, saveData(first)])).character, first)
    })
})

test('invalid payloads and excessive new feeds fail atomically while grandfathered feed lists remain editable', async () => {
    await withDatabase({}, async db => {
        const first = await load(db, 1)
        const cases = [
            data => { data.profile.name = '  \t' },
            data => { data.profile.status_message = '' },
            data => { data.theme.main_color = 'red' },
            data => { data.profile.extra = 'unexpected' },
            data => { data.sections[0].title = '' },
            data => { data.sections[0].content = ' \n ' },
            data => { data.sections.push({ ...data.sections[0] }) },
            data => { data.keywords = [{ id: null, content: ' \t' }] },
            data => { data.feed = Array.from({ length: 51 }, () => ({ id: null, image_path: imagePath('feed', 1) })) },
        ]
        for (const change of cases) {
            const data = saveData(first)
            change(data)
            await assert.rejects(() => rpc(db, 'save_character', [1, first, data]))
            assert.deepEqual(await load(db, 1), first)
        }
        await db.exec(`insert into public.feed_images(character_id,sort_order,image_path)
            select 1,n,'feed/grandfathered-'||n||'.png' from generate_series(3,51) n;
            insert into storage.objects(bucket_id,name)
            select 'site-images','feed/grandfathered-'||n||'.png' from generate_series(3,51) n;`)
        const grandfathered = await load(db, 1)
        const data = saveData(grandfathered)
        data.profile.name = '기존 51장 유지'
        const saved = await rpc(db, 'save_character', [1, grandfathered, data])
        assert.equal(saved.character.feed.length, 51)
        data.feed.pop()
        const reduced = await rpc(db, 'save_character', [1, saved.character, data])
        assert.equal(reduced.character.feed.length, 50)
    })
})

test('disabling writes blocks RPC and Storage again without disabling public reads', async () => {
    await withDatabase({}, async db => {
        await db.exec('begin; select pg_advisory_xact_lock(70431862911507); update private.character_api_control set writes_enabled=false where id=1; commit;')
        const first = await load(db, 1, publicVisitor)
        await assert.rejects(() => rpc(db, 'save_character', [1, first, saveData(first)]), /writes_disabled/)
        await assert.rejects(() => rpc(db, 'reserve_character_id', [crypto.randomUUID()]), /writes_disabled/)
        await assert.rejects(() => uploadMetadata(db, imagePath('profile', 1)), denied)
        const deleted = await asRole(db, 'authenticated', adminId,
            () => db.query(`delete from storage.objects where name='feed/second.png' returning name`))
        assert.equal(deleted.rows.length, 0)
        assert.equal((await main(db, publicVisitor)).characters.length, 1)
    })
})
