import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const adminId = 'f711da08-9c0b-42ee-a20c-a4f83ad46473'
export const otherUserId = '11111111-1111-4111-8111-111111111111'
export const sqlFile = name => readFile(path.join(projectRoot, 'supabase', name), 'utf8')

// Only in-memory PostgreSQL and synthetic data are used. This is not a mock of SQL:
// real functions, grants and RLS execute; hosted Auth/Storage/file behavior does not.
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
        bucket_id text references storage.buckets(id), name text not null,
        metadata jsonb default '{}', created_at timestamptz default now(),
        updated_at timestamptz default now(), unique(bucket_id,name)
    );
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
        select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
    $$;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on storage.objects to authenticated, service_role;
`;

export async function value(db, sql, parameters = []) {
    const result = await db.query(sql, parameters)
    return Object.values(result.rows[0])[0]
}

export async function applySql(db, sql) {
    try { return await db.exec(sql) } catch (error) {
        await db.exec('rollback')
        throw error
    }
}

export async function asRole(db, role, userId, action) {
    if (!['anon', 'authenticated', 'service_role'].includes(role)) throw new Error('Unexpected test role')
    await db.exec('begin')
    try {
        await db.exec(`set local role ${role}`)
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId || ''])
        const result = await action()
        await db.exec('commit')
        return result
    } catch (error) {
        await db.exec('rollback')
        throw error
    }
}

export async function rpc(db, name, args = [], { role = 'authenticated', userId = adminId } = {}) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected RPC name')
    const parameters = args.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value)
    return asRole(db, role, userId, () => value(db,
        `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')})`, parameters))
}

export async function createCharacterDatabase({ activated = true, empty = false } = {}) {
    const db = new PGlite()
    try {
        await db.exec(bootstrap)
        for (const name of ['schema.sql', 'read.sql', 'save.sql']) await db.exec(await sqlFile(name))
        await db.exec(`update public.profile set name='첫 캐릭터', status_message='기존 상태', profile_image_path='profile/legacy.png';
            update public.theme set main_color='#7841ab';
            insert into storage.objects(bucket_id,name) values
                ('site-images','profile/legacy.png'),('site-images','feed/first.png'),('site-images','feed/second.png');`)
        if (!empty) await db.exec(`
            insert into public.sections(id,sort_order,title,content) overriding system value
                values(10,1,'첫 제목','  원문\n*볼드* _밑줄_\n  '),(11,2,'둘째 제목','둘째 내용');
            insert into public.keywords(id,sort_order,content) overriding system value values(30,1,'첫 키워드');
            insert into public.feed_images(id,sort_order,image_path) overriding system value
                values(20,1,'feed/first.png'),(21,2,'feed/second.png');
            select setval('public.sections_id_seq',100,true);
            select setval('public.keywords_id_seq',100,true);
            select setval('public.feed_images_id_seq',100,true);
        `)
        await db.exec(`set app.multi_character_maintenance='on'`)
        const names = (await readdir(path.join(projectRoot, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()
        for (const name of names) await applySql(db, await sqlFile(`migrations/${name}`))
        if (activated) await applySql(db, await sqlFile('multi-character-enable-writes.sql'))
        return db
    } catch (error) {
        await db.close()
        throw error
    }
}

export async function withDatabase(options, action) {
    const db = await createCharacterDatabase(options)
    try { return await action(db) } finally { await db.close() }
}

export const theme = { main_color: '#f39', background_color: '#ffe8f0', card_background_color: '#ffffff', typo_color: '#26232a' }
export const blankData = (name = '새 캐릭터') => ({
    profile: { name, status_message: '새 상태', profile_image_path: null },
    theme: { ...theme }, sections: [], keywords: [{ id: null, content: '새 키워드' }], feed: [],
})

export function saveData(snapshot) {
    return {
        profile: {
            name: snapshot.profile.name,
            status_message: snapshot.profile.status_message,
            profile_image_path: snapshot.profile.profile_image_path,
        },
        theme: Object.fromEntries(Object.keys(theme).map(key => [key, snapshot.theme[key]])),
        sections: snapshot.sections.map(({ id, title, content }) => ({ id, title, content })),
        keywords: snapshot.keywords.map(({ id, content }) => ({ id, content })),
        feed: snapshot.feed.map(({ id, image_path }) => ({ id, image_path })),
    }
}

export async function createCharacter(db, data = blankData(), requestId = crypto.randomUUID()) {
    const id = await rpc(db, 'reserve_character_id', [requestId])
    const result = await rpc(db, 'create_character', [id, requestId, data])
    return { id: Number(id), requestId, data, result, character: result.character }
}

export async function uploadMetadata(db, name, userId = adminId) {
    return asRole(db, 'authenticated', userId, () => db.query(
        `insert into storage.objects(bucket_id,name,metadata) values('site-images',$1,'{"mimetype":"image/png","size":42}') returning name`, [name]))
}
