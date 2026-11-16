-- Stage 2: structure/data only. DO NOT apply to production before the cutover runbook.
-- Run as database owner after DB/Storage writers stop and final DB/file backups exist.
-- Explicit session gate: SET app.multi_character_maintenance = 'on';
-- No Storage objects/files are moved, rewritten, or deleted here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare v_table text;
begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then
        raise exception 'mc_maintenance_required';
    end if;
    perform pg_advisory_xact_lock(70431862911502);
    if to_regclass('private.multi_character_migration_backup') is not null then
        raise exception 'mc_already_applied';
    end if;
    if to_regclass('public.characters') is not null or to_regclass('public.character_themes') is not null
        or to_regclass('public.main_theme') is not null then
        raise exception 'mc_unexpected_target_schema';
    end if;
    foreach v_table in array array['profile', 'theme', 'sections', 'keywords', 'feed_images'] loop
        if to_regclass('public.' || v_table) is null then
            raise exception 'mc_missing_source_table: %', v_table;
        end if;
        if exists (select 1 from information_schema.columns where table_schema = 'public'
            and table_name = v_table and column_name = 'character_id') then
            raise exception 'mc_unexpected_source_schema: %', v_table;
        end if;
    end loop;
    if exists (select 1 from pg_attribute a
        where a.attrelid in ('public.profile'::regclass, 'public.theme'::regclass,
            'public.sections'::regclass, 'public.keywords'::regclass, 'public.feed_images'::regclass)
            and a.attnum > 0 and not a.attisdropped and a.attacl is not null) then
        raise exception 'mc_unsupported_column_acl';
    end if;
    if to_regprocedure('public.load_site()') is null or to_regprocedure('public.save_site(jsonb,jsonb)') is null
        or to_regprocedure('private.site_snapshot()') is null or to_regprocedure('private.site_content(jsonb)') is null then
        raise exception 'mc_missing_legacy_routine';
    end if;
    if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'mc_maintenance_%') then
        raise exception 'mc_unexpected_storage_policy';
    end if;
end;
$$;
lock table public.profile, public.theme, public.sections, public.keywords, public.feed_images in access exclusive mode;
-- Does not replace stopping in-flight Storage API requests before taking final backups.
lock table storage.objects in share row exclusive mode;

do $$
declare v_table text;
begin
    if (select count(*) from public.profile) <> 1 or not exists (select 1 from public.profile where id = 1)
        or (select count(*) from public.theme) <> 1 or not exists (select 1 from public.theme where id = 1) then
        raise exception 'mc_single_profile_required';
    end if;
    foreach v_table in array array['sections', 'keywords', 'feed_images'] loop
        if not exists (select 1 from pg_constraint c where c.conrelid = ('public.' || v_table)::regclass
            and c.conname = v_table || '_sort_order_key' and c.contype = 'u' and c.condeferrable and c.condeferred
            and pg_get_constraintdef(c.oid) = 'UNIQUE (sort_order) DEFERRABLE INITIALLY DEFERRED') then
            raise exception 'mc_unexpected_order_constraint: %', v_table;
        end if;
    end loop;
end;
$$;

-- Owner-only journal, not a substitute for external DB and binary-file backups.
create table private.multi_character_migration_backup (
    migration_key text primary key check (migration_key = 'multi_character_structure_v1'),
    created_at timestamptz not null default now(),
    original_data jsonb not null,
    original_acl jsonb not null,
    expected_data jsonb not null,
    expected_catalog jsonb
);
alter table private.multi_character_migration_backup enable row level security;
revoke all on private.multi_character_migration_backup from public, anon, authenticated, service_role;

create function private.mc_migration_data()
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
    v_table text;
    v_rows jsonb;
    v_result jsonb := '{}'::jsonb;
begin
    foreach v_table in array array['profile', 'theme', 'sections', 'keywords', 'feed_images',
        'characters', 'character_themes', 'main_theme'] loop
        if to_regclass('public.' || v_table) is not null then
            execute format('select coalesce(jsonb_agg(to_jsonb(t) order by %I), ''[]''::jsonb) from public.%I t',
                case when v_table = 'character_themes' then 'character_id' else 'id' end, v_table) into v_rows;
            v_result := v_result || jsonb_build_object(v_table, v_rows);
        end if;
    end loop;
    return v_result;
end;
$$;
revoke all on function private.mc_migration_data() from public, anon, authenticated, service_role;

-- Detect later RPC/policy/DDL/ACL changes before rollback removes their dependencies.
create function private.mc_migration_catalog()
returns jsonb language sql volatile security invoker set search_path = '' as $$
    select jsonb_build_object(
        'relations', (select coalesce(jsonb_agg(jsonb_build_object('schema', n.nspname,
            'name', c.relname, 'kind', c.relkind, 'owner', c.relowner, 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
            'acl', c.relacl::text) order by n.nspname, c.relname), '[]'::jsonb)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'private') and c.relkind in ('r', 'S', 'v', 'm')),
        'columns', (select coalesce(jsonb_agg(to_jsonb(a) order by a.table_schema, a.table_name, a.ordinal_position), '[]'::jsonb)
            from information_schema.columns a where a.table_schema in ('public', 'private')),
        'column_acl', (select coalesce(jsonb_agg(jsonb_build_object('table', a.attrelid::regclass::text,
            'column', a.attname, 'acl', a.attacl::text) order by a.attrelid, a.attnum), '[]'::jsonb)
            from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'private') and a.attnum > 0 and not a.attisdropped and a.attacl is not null),
        'indexes', (select coalesce(jsonb_agg(to_jsonb(i) order by schemaname, tablename, indexname), '[]'::jsonb)
            from pg_indexes i where i.schemaname in ('public', 'private')),
        'triggers', (select coalesce(jsonb_agg(jsonb_build_object('table', t.tgrelid::regclass::text,
            'name', t.tgname, 'enabled', t.tgenabled, 'definition', pg_get_triggerdef(t.oid)) order by t.tgrelid, t.tgname), '[]'::jsonb)
            from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'private') and not t.tgisinternal),
        'constraints', (select coalesce(jsonb_agg(jsonb_build_object('table', c.conrelid::regclass::text,
            'name', c.conname, 'definition', pg_get_constraintdef(c.oid)) order by c.conrelid, c.conname), '[]'::jsonb)
            from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public', 'private')),
        'routines', (select coalesce(jsonb_agg(jsonb_build_object('definition', pg_get_functiondef(p.oid),
            'acl', p.proacl::text) order by n.nspname, p.oid::regprocedure::text), '[]'::jsonb)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')),
        'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by schemaname, tablename, policyname), '[]'::jsonb)
            from pg_policies p where p.schemaname in ('public', 'private') or (p.schemaname = 'storage' and p.tablename = 'objects'))
    );
$$;
revoke all on function private.mc_migration_catalog() from public, anon, authenticated, service_role;

do $$
declare
    v_data jsonb := private.mc_migration_data();
    v_acl jsonb;
    v_expected jsonb;
    v_table text;
    v_request uuid := gen_random_uuid();
begin
    select coalesce(jsonb_agg(to_jsonb(a) order by kind, object_name, grantee, privilege_type), '[]'::jsonb) into v_acl from (
        select case when c.relkind = 'S' then 'sequence' else 'table' end as kind,
            format('%I.%I', n.nspname, c.relname) as object_name,
            case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
            x.privilege_type, x.is_grantable, x.grantor = c.relowner as owner_granted, x.grantee = c.relowner as is_owner
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
            cross join lateral aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) x
        where n.nspname = 'public' and c.relname in ('profile', 'theme', 'sections', 'keywords', 'feed_images',
            'sections_id_seq', 'keywords_id_seq', 'feed_images_id_seq')
        union all
        select 'function', format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
            case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,
            x.privilege_type, x.is_grantable, x.grantor = p.proowner, x.grantee = p.proowner
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
        where p.oid in ('public.load_site()'::regprocedure, 'public.save_site(jsonb,jsonb)'::regprocedure,
            'private.site_snapshot()'::regprocedure, 'private.site_content(jsonb)'::regprocedure)
    ) a;
    if exists (select 1 from jsonb_array_elements(v_acl) a where not (a->>'owner_granted')::boolean) then
        raise exception 'mc_unsupported_acl_grant_chain';
    end if;
    v_expected := v_data || jsonb_build_object(
        'characters', jsonb_build_array((v_data->'profile'->0) || jsonb_build_object('sort_order', 1, 'creation_request_id', v_request)),
        'character_themes', jsonb_build_array(((v_data->'theme'->0) - 'id') || jsonb_build_object('character_id', 1)),
        'main_theme', v_data->'theme');
    foreach v_table in array array['sections', 'keywords', 'feed_images'] loop
        v_expected := jsonb_set(v_expected, array[v_table],
            (select coalesce(jsonb_agg(value || '{"character_id":1}'::jsonb order by ord), '[]'::jsonb)
                from jsonb_array_elements(v_data->v_table) with ordinality a(value, ord)));
    end loop;
    insert into private.multi_character_migration_backup(migration_key, original_data, original_acl, expected_data)
        values ('multi_character_structure_v1', v_data, v_acl, v_expected);
end;
$$;

-- Freeze all captured non-owner privileges; retain only existing legacy table reads.
do $$
declare
    v_acl jsonb := (select original_acl from private.multi_character_migration_backup);
    v_entry record;
begin
    for v_entry in select distinct a->>'kind' as kind, a->>'object_name' as object_name,
        a->>'grantee' as grantee from jsonb_array_elements(v_acl) a where not (a->>'is_owner')::boolean loop
        execute format('revoke all on %s %s from %s', v_entry.kind, v_entry.object_name,
            case when v_entry.grantee = 'PUBLIC' then 'PUBLIC' else quote_ident(v_entry.grantee) end);
    end loop;
    for v_entry in select a from jsonb_array_elements(v_acl) a where a->>'kind' = 'table'
        and a->>'privilege_type' = 'SELECT' and not (a->>'is_owner')::boolean loop
        execute format('grant select on table %s to %s%s', v_entry.a->>'object_name',
            case when v_entry.a->>'grantee' = 'PUBLIC' then 'PUBLIC' else quote_ident(v_entry.a->>'grantee') end,
            case when (v_entry.a->>'is_grantable')::boolean then ' with grant option' else '' end);
    end loop;
end;
$$;

create table public.characters (
    id bigint generated by default as identity primary key check (id >= 1),
    sort_order integer not null check (sort_order >= 1),
    name text not null check (name ~ '[^[:space:]]'),
    status_message text not null check (status_message ~ '[^[:space:]]'),
    profile_image_path text check (profile_image_path ~ '^profile/.+'),
    creation_request_id uuid not null unique,
    constraint characters_sort_order_key unique (sort_order) deferrable initially deferred
);
create table public.character_themes (like public.theme including defaults including constraints);
alter table public.character_themes drop constraint theme_id_check;
alter table public.character_themes rename column id to character_id;
alter table public.character_themes alter column character_id drop default;
alter table public.character_themes add primary key (character_id),
    add constraint character_themes_character_id_fkey foreign key (character_id) references public.characters(id) on delete cascade;
create table public.main_theme (like public.theme including defaults including constraints);
alter table public.main_theme add primary key (id);

insert into public.characters(id, sort_order, name, status_message, profile_image_path, creation_request_id)
select p.id, 1, p.name, p.status_message, p.profile_image_path,
    (b.expected_data->'characters'->0->>'creation_request_id')::uuid
from public.profile p cross join private.multi_character_migration_backup b;
insert into public.character_themes select * from public.theme;
insert into public.main_theme select * from public.theme;

do $$
declare
    v_table text;
    v_last bigint;
begin
    foreach v_table in array array['sections', 'keywords', 'feed_images'] loop
        execute format('alter table public.%I add column character_id bigint', v_table);
        execute format('update public.%I set character_id = 1', v_table);
        execute format('alter table public.%I alter column character_id set not null', v_table);
        execute format('alter table public.%I drop constraint %I, add constraint %I foreign key (character_id) references public.characters(id) on delete cascade, add constraint %I unique (character_id, sort_order) deferrable initially deferred',
            v_table, v_table || '_sort_order_key', v_table || '_character_id_fkey', v_table || '_character_sort_order_key');
    end loop;
    select last_value into v_last from public.characters_id_seq;
    perform setval('public.characters_id_seq', greatest(v_last, (select max(id) from public.characters)), true);
end;
$$;

alter table public.characters enable row level security;
alter table public.character_themes enable row level security;
alter table public.main_theme enable row level security;
revoke all on public.characters, public.character_themes, public.main_theme from public, anon, authenticated, service_role;
revoke all on sequence public.characters_id_seq from public, anon, authenticated, service_role;
-- Stage 3 supplies scoped RPCs and RLS before writes reopen. Do not re-run legacy SQL.
create policy mc_maintenance_insert on storage.objects as restrictive for insert to anon, authenticated
    with check (bucket_id <> 'site-images');
create policy mc_maintenance_update on storage.objects as restrictive for update to anon, authenticated
    using (bucket_id <> 'site-images') with check (bucket_id <> 'site-images');
create policy mc_maintenance_delete on storage.objects as restrictive for delete to anon, authenticated
    using (bucket_id <> 'site-images');

do $$
begin
    if private.mc_migration_data() is distinct from (select expected_data from private.multi_character_migration_backup) then
        raise exception 'mc_migration_data_mismatch';
    end if;
    update private.multi_character_migration_backup set expected_catalog = private.mc_migration_catalog();
end;
$$;
commit;
