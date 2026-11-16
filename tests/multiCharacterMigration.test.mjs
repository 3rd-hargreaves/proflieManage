import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Every database is an isolated in-memory PostgreSQL instance. No production
// credentials or network connections are used here. Default fixtures are synthetic;
// an optional private export can be loaded in memory without logging its contents.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqlFile = name => readFile(path.join(root, 'supabase', name), 'utf8')
const adminId = 'f711da08-9c0b-42ee-a20c-a4f83ad46473'

async function migrationSql() {
    const names = (await readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('_multi_character_structure.sql'))
    assert.equal(names.length, 1, 'Exactly one stage 2 structure migration must exist')
    return sqlFile(`migrations/${names[0]}`)
}

const bootstrap = `
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets (
        id text primary key, name text not null, public boolean default false,
        file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text references storage.buckets(id), name text not null, metadata jsonb default '{}',
        unique (bucket_id, name)
    );
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
        select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
    $$;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on storage.objects to authenticated, service_role;
`;

async function fixture({ empty = false } = {}) {
    const db = new PGlite()
    try {
        await db.exec(bootstrap)
        for (const name of ['schema.sql', 'read.sql', 'save.sql']) await db.exec(await sqlFile(name))
        await db.query(`update public.profile set name=$1, status_message=$2, profile_image_path=$3 where id=1`, [
            '  테스트 캐릭터\t', '\n상태 메시지 _원문_  ', 'profile/original--한글 이미지.png',
        ])
        await db.exec(`update public.theme set main_color='#aBc', background_color='#AbCd', card_background_color='#123456', typo_color='#12345678' where id=1`)
        if (!empty) {
            await db.query(`insert into public.sections(id,sort_order,title,content) overriding system value values(17,2,$1,$2),(49,8,$3,$4)`, [
                '  첫 제목\t', ' 첫 줄\n\n*볼드* _밑줄_ /기울임/ -취소-\n| 표 |\n ', '다음 제목', '원문\\escape\n',
            ])
            await db.exec(`insert into public.keywords(id,sort_order,content) overriding system value values(23,4,'테스트'),(67,9,'#원문');
                insert into public.feed_images(id,sort_order,image_path) overriding system value values(31,3,'feed/original--한글 파일.png'),(89,11,'feed/old-image.jpg');`)
        }
        await db.exec(`select setval('public.sections_id_seq', 120, true);
            select setval('public.keywords_id_seq', 140, true);
            select setval('public.feed_images_id_seq', 160, true);
            insert into storage.objects(bucket_id,name) values('site-images','profile/original--한글 이미지.png'),('site-images','feed/old-image.jpg');`)
        return db
    } catch (error) {
        await db.close()
        throw error
    }
}

async function value(db, sql) {
    const { rows } = await db.query(sql)
    return Object.values(rows[0])[0]
}

const legacySnapshot = db => value(db, 'select private.site_snapshot()')
const activeSnapshot = db => value(db, `select jsonb_build_object(
    'profile',(select (to_jsonb(c)-'sort_order'-'creation_request_id') from public.characters c where id=1),
    'theme',(select jsonb_build_object('id',1)|| (to_jsonb(t)-'character_id') from public.character_themes t where character_id=1),
    'sections',(select coalesce(jsonb_agg(to_jsonb(s)-'character_id' order by sort_order,id),'[]') from public.sections s),
    'keywords',(select coalesce(jsonb_agg(to_jsonb(k)-'character_id' order by sort_order,id),'[]') from public.keywords k),
    'feed',(select coalesce(jsonb_agg(to_jsonb(f)-'character_id' order by sort_order,id),'[]') from public.feed_images f))`)

async function originalMetadata(db) {
    return value(db, `select jsonb_build_object(
        'relations',(select jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,
                'acl',(select jsonb_agg(to_jsonb(a) order by grantee,grantor,privilege_type,is_grantable) from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a),
                'rls',c.relrowsecurity) order by n.nspname,c.relname)
            from pg_class c join pg_namespace n on n.oid=c.relnamespace where
            (n.nspname='public' and c.relname in ('profile','theme','sections','keywords','feed_images','sections_id_seq','keywords_id_seq','feed_images_id_seq'))
            or (n.nspname='storage' and c.relname='objects')),
        'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','storage')),
        'routines',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
                'acl',(select jsonb_agg(to_jsonb(a) order by grantee,grantor,privilege_type,is_grantable) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) order by p.oid::regprocedure::text)
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('load_site','save_site','site_snapshot','site_content','is_site_admin')))`)
}

async function apply(db, sql) {
    try { await db.exec(sql) } catch (error) {
        await db.exec('rollback')
        throw error
    }
}

async function forward(db) {
    await db.exec(`set app.multi_character_maintenance='on'`)
    await apply(db, await migrationSql())
}

const rollback = async db => apply(db, await sqlFile('rollback/multi_character_structure.sql'))

async function inFixture(options, run) {
    const db = await fixture(options)
    try { await run(db) } finally { await db.close() }
}

test('stage 2 preserves legacy raw data, IDs, gaps, paths and independent initial themes', async () => {
    await inFixture({}, async db => {
        const before = await legacySnapshot(db)
        const files = await value(db, `select jsonb_agg(to_jsonb(o) order by name) from storage.objects o`)
        await forward(db)
        assert.deepEqual(await activeSnapshot(db), before)
        assert.deepEqual(await value(db, `select to_jsonb(t) from public.main_theme t where id=1`), before.theme)
        assert.equal(await value(db, 'select count(*)::int from public.characters'), 1)
        assert.equal(await value(db, 'select sort_order from public.characters'), 1)
        assert.equal(await value(db, 'select count(*)::int from private.multi_character_migration_backup'), 1)
        assert.deepEqual(await value(db, `select jsonb_agg(to_jsonb(o) order by name) from storage.objects o`), files)
        for (const name of ['sections','keywords','feed_images']) {
            assert.equal(await value(db, `select count(*)::int from public.${name} where character_id is distinct from 1`), 0)
        }
        assert.equal(await value(db, `select nextval('public.characters_id_seq')::int`), 2)
        assert.equal(await value(db, `select nextval('public.sections_id_seq')::int`), 121)
        assert.equal(await value(db, `select nextval('public.keywords_id_seq')::int`), 141)
        assert.equal(await value(db, `select nextval('public.feed_images_id_seq')::int`), 161)
    })
})

test('stage 2 supports empty child lists and round-trip restores original data and permissions', async () => {
    for (const empty of [false, true]) await inFixture({ empty }, async db => {
        const before = await legacySnapshot(db)
        const metadata = await originalMetadata(db)
        await forward(db)
        await rollback(db)
        assert.deepEqual(await legacySnapshot(db), before)
        assert.deepEqual(await originalMetadata(db), metadata)
        assert.equal(await value(db, `select to_regclass('public.characters') is null`), true)
        assert.equal(await value(db, `select count(*)::int from information_schema.columns where table_schema='public' and column_name='character_id'`), 0)
        assert.equal(await value(db, `select last_value::int from public.sections_id_seq`), 120)
    })
})

test('migration requires an explicit maintenance gate and rolls back partial DDL failures', async () => {
    await inFixture({}, async db => {
        const sql = await migrationSql()
        const before = await legacySnapshot(db)
        const metadata = await originalMetadata(db)
        await assert.rejects(() => apply(db, sql), /maintenance/i)
        assert.equal(await value(db, `select to_regclass('public.characters') is null`), true)
        await db.exec(`set app.multi_character_maintenance='on'`)
        const commits = [...sql.matchAll(/\bcommit\s*;/gi)]
        assert.ok(commits.length, 'The migration must explicitly commit its transaction')
        const commit = commits.at(-1).index
        const broken = `${sql.slice(0, commit)}select 1/0;\n${sql.slice(commit)}`
        await assert.rejects(() => apply(db, broken), /division by zero/i)
        assert.equal(await value(db, `select to_regclass('public.characters') is null`), true)
        assert.deepEqual(await legacySnapshot(db), before)
        assert.deepEqual(await originalMetadata(db), metadata)
    })
})

test('missing singleton source aborts before creating or rewriting content', async () => {
    await inFixture({}, async db => {
        await db.exec('delete from public.profile')
        const metadata = await originalMetadata(db)
        await assert.rejects(() => forward(db), /profile|source|singleton/i)
        assert.equal(await value(db, `select to_regclass('public.characters') is null`), true)
        assert.deepEqual(await originalMetadata(db), metadata)
        assert.equal(await value(db, 'select count(*)::int from public.sections'), 2)
    })
})

test('a repeated migration is rejected without resetting content or reserved sequence numbers', async () => {
    await inFixture({}, async db => {
        await forward(db)
        await db.exec(`update public.characters set name='새 수정' where id=1; select setval('public.characters_id_seq',50,true)`)
        await assert.rejects(() => forward(db), /mc_already_applied/)
        assert.equal(await value(db, 'select name from public.characters where id=1'), '새 수정')
        assert.equal(await value(db, `select nextval('public.characters_id_seq')::int`), 51)
    })
})

test('new tables fail closed and the old global APIs, table writes and Storage writes are frozen', async () => {
    await inFixture({}, async db => {
        await forward(db)
        for (const role of ['anon','authenticated']) {
            for (const table of ['characters','character_themes','main_theme']) {
                assert.equal(await value(db, `select has_table_privilege('${role}','public.${table}','SELECT')`), false)
                assert.equal(await value(db, `select relrowsecurity from pg_class where oid='public.${table}'::regclass`), true)
            }
            assert.equal(await value(db, `select has_function_privilege('${role}','public.load_site()','EXECUTE')`), false)
            assert.equal(await value(db, `select has_function_privilege('${role}','public.save_site(jsonb,jsonb)','EXECUTE')`), false)
            for (const table of ['profile','theme','sections','keywords','feed_images']) {
                assert.equal(await value(db, `select has_table_privilege('${role}','public.${table}','INSERT,UPDATE,DELETE')`), false)
            }
        }
        await assert.rejects(() => apply(db, `begin; set local role authenticated;
            select set_config('request.jwt.claim.sub','${adminId}',true);
            insert into storage.objects(bucket_id,name) values('site-images','feed/new.png'); commit;`), /row-level security/i)
        await apply(db, `begin; set local role authenticated;
            select set_config('request.jwt.claim.sub','${adminId}',true);
            update storage.objects set name='feed/replaced.png' where bucket_id='site-images';
            delete from storage.objects where bucket_id='site-images'; commit;`)
        assert.equal(await value(db, `select count(*)::int from storage.objects where bucket_id='site-images'`), 2)
        assert.equal(await value(db, `select count(*)::int from storage.objects where name='feed/replaced.png'`), 0)
    })
})

test('character scoped ordering is deferred, permits equal order across characters, and cascades only the target', async () => {
    await inFixture({}, async db => {
        await forward(db)
        await db.exec(`begin;
            insert into public.characters(id,sort_order,name,status_message,creation_request_id)
                values(2,2,'두 번째','다른 상태',gen_random_uuid());
            insert into public.character_themes select 2,main_color,background_color,card_background_color,typo_color from public.main_theme;
            insert into public.sections(character_id,sort_order,title,content) values(2,2,'다른 제목','다른 본문');
            insert into public.keywords(character_id,sort_order,content) values(2,4,'다른 키워드');
            insert into public.feed_images(character_id,sort_order,image_path) values(2,3,'feed/2/new.png');
            update public.sections set sort_order=case id when 17 then 8 when 49 then 2 else sort_order end where character_id=1;
            update public.characters set sort_order=case id when 1 then 2 when 2 then 1 end;
            set constraints all immediate;`)
        assert.deepEqual((await db.query('select id::int from public.sections where character_id=1 order by sort_order')).rows.map(row => row.id), [49,17])
        await db.exec('delete from public.characters where id=2')
        for (const table of ['character_themes','sections','keywords','feed_images']) {
            assert.equal(await value(db, `select count(*)::int from public.${table} where character_id=2`), 0)
        }
        assert.equal(await value(db, 'select count(*)::int from public.sections where character_id=1'), 2)
        await db.exec('rollback')
        await assert.rejects(() => apply(db, `begin; insert into public.sections(character_id,sort_order,title,content) values(999,1,'제목','내용'); commit;`), /foreign key/i)
        await assert.rejects(() => apply(db, `begin; insert into public.sections(character_id,sort_order,title,content) values(1,2,'중복','내용'); commit;`), /unique constraint/i)
        await assert.rejects(() => apply(db, `begin; insert into public.sections(sort_order,title,content) values(1,'누락','내용'); commit;`), /null value/i)
        await rollback(db)
    })
})

test('rollback refuses changed character, theme, child, membership and preserved legacy data', async () => {
    const mutations = [
        `update public.characters set name='다른 이름' where id=1`,
        `update public.character_themes set main_color='#000' where character_id=1`,
        `update public.main_theme set main_color='#000' where id=1`,
        `update public.sections set content='변경 본문' where id=17`,
        `delete from public.keywords where id=23`,
        `insert into public.characters(id,sort_order,name,status_message,creation_request_id) values(2,2,'추가','상태',gen_random_uuid())`,
        `update public.profile set name='보존 테이블 변경' where id=1`,
    ]
    for (const mutation of mutations) await inFixture({}, async db => {
        await forward(db)
        await db.exec(mutation)
        await assert.rejects(() => rollback(db), /mc_rollback_data_changed/)
        assert.equal(await value(db, `select to_regclass('public.characters') is not null`), true)
        assert.equal(await value(db, `select has_function_privilege('authenticated','public.save_site(jsonb,jsonb)','EXECUTE')`), false)
    })
})

test('read-only preflight executes without changing data, metadata or sequence state', async () => {
    await inFixture({}, async db => {
        const before = await legacySnapshot(db)
        const metadata = await originalMetadata(db)
        const results = await db.exec(await sqlFile('multi-character-preflight.sql'))
        assert.ok(results.some(result => result.rows?.some(row => row.read_only === 'on')))
        assert.deepEqual(await legacySnapshot(db), before)
        assert.deepEqual(await originalMetadata(db), metadata)
        assert.equal(await value(db, `select last_value::int from public.sections_id_seq`), 120)
    })
})

test('forward refuses source column grants instead of silently dropping their privileges', async () => {
    await inFixture({}, async db => {
        await db.exec('grant select(name) on public.profile to anon')
        await assert.rejects(() => forward(db), /mc_unsupported_column_acl/)
        assert.equal(await value(db, `select to_regclass('public.characters') is null`), true)
        assert.equal(await value(db, `select attacl is not null from pg_attribute where attrelid='public.profile'::regclass and attname='name'`), true)
    })
})

test('rollback refuses later grants, policies, indexes, triggers and RPC definitions', async () => {
    const mutations = [
        { sql: 'grant select on public.characters to anon' },
        { sql: 'grant select(name) on public.characters to anon' },
        { sql: 'create policy stage3_read on public.characters for select to anon using (true)' },
        { sql: 'create index stage3_name_idx on public.characters(name)' },
        { sql: 'alter table public.characters force row level security' },
        { sql: `create function public.stage3_probe() returns bigint language sql stable as $$select count(*) from public.characters$$` },
        {
            setup: `create function private.test_trigger() returns trigger language plpgsql as $$begin return new; end;$$`,
            sql: 'create trigger stage3_trigger before update on public.characters for each row execute function private.test_trigger()',
        },
    ]
    for (const mutation of mutations) await inFixture({}, async db => {
        if (mutation.setup) await db.exec(mutation.setup)
        await forward(db)
        await db.exec(mutation.sql)
        await assert.rejects(() => rollback(db), /mc_rollback_schema_changed/)
        assert.equal(await value(db, `select to_regclass('public.characters') is not null`), true)
    })
})

test('optional private snapshot clone round-trips actual IDs, raw contents, paths and sequences', {
    skip: !process.env.MIGRATION_SNAPSHOT_PATH,
}, async () => {
    const snapshot = JSON.parse(await readFile(process.env.MIGRATION_SNAPSHOT_PATH, 'utf8'))
    assert.ok(snapshot.site?.profile && snapshot.site?.theme && snapshot.sequences)
    await inFixture({ empty: true }, async db => {
        await db.exec(`delete from public.sections; delete from public.keywords; delete from public.feed_images;
            delete from public.profile; delete from public.theme;`)
        for (const table of ['profile','theme']) {
            await db.query(`insert into public.${table} select * from jsonb_populate_record(null::public.${table}, $1::jsonb)`, [JSON.stringify(snapshot.site[table])])
        }
        for (const [table, property] of [['sections','sections'],['keywords','keywords'],['feed_images','feed']]) {
            await db.query(`insert into public.${table} overriding system value select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`, [JSON.stringify(snapshot.site[property])])
            const sequence = snapshot.sequences[table]
            assert.ok(sequence && typeof sequence.is_called === 'boolean')
            await db.query('select setval($1::regclass,$2::bigint,$3::boolean)', [`public.${table}_id_seq`, String(sequence.last_value), sequence.is_called])
        }
        const before = await legacySnapshot(db)
        const metadata = await originalMetadata(db)
        assert.deepEqual(before, snapshot.site)
        await forward(db)
        assert.deepEqual(await activeSnapshot(db), before)
        await rollback(db)
        assert.deepEqual(await legacySnapshot(db), before)
        assert.deepEqual(await originalMetadata(db), metadata)
        for (const table of ['sections','keywords','feed_images']) {
            const actual = (await db.query(`select last_value::text, is_called from public.${table}_id_seq`)).rows[0]
            assert.equal(actual.last_value, String(snapshot.sequences[table].last_value))
            assert.equal(actual.is_called, snapshot.sequences[table].is_called)
        }
    })
})
