-- Stage 3 support; prepare locally, after stage 2. Writes stay closed until cutover.
begin;
set local lock_timeout = '5s';
do $$
begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then
        raise exception 'mc_maintenance_required';
    end if;
    if to_regclass('private.multi_character_migration_backup') is null then
        raise exception 'mc_structure_required';
    end if;
end;
$$;

create table private.character_api_control (
    id integer primary key check (id = 1),
    writes_enabled boolean not null default false
);
insert into private.character_api_control(id) values (1);
create table private.character_creation_requests (
    request_id uuid primary key,
    character_id bigint not null unique check (character_id > 0),
    payload jsonb,
    result jsonb,
    check ((payload is null) = (result is null))
);
-- No FK: reservations precede characters; receipts survive deletion, preventing resurrection.
create table private.character_deletion_receipts (
    character_id bigint primary key,
    expected jsonb not null,
    result jsonb not null
);
alter table private.character_api_control enable row level security;
alter table private.character_creation_requests enable row level security;
alter table private.character_deletion_receipts enable row level security;
revoke all on private.character_api_control, private.character_creation_requests,
    private.character_deletion_receipts from public, anon, authenticated, service_role;

create function private.character_writes_enabled()
returns boolean language plpgsql volatile security invoker set search_path = '' as $$
declare v_enabled boolean;
begin
    -- Hold the shared write gate until transaction end; owner pause waits exclusively.
    perform pg_advisory_xact_lock_shared(70431862911507);
    select writes_enabled into v_enabled from private.character_api_control where id = 1;
    return coalesce(v_enabled, false);
end;
$$;
create function private.require_character_admin(p_write boolean default true)
returns void language plpgsql security invoker set search_path = '' as $$
begin
    if not private.is_site_admin() then
        raise exception using errcode = '42501', message = 'character_admin_required';
    end if;
    if p_write and not private.character_writes_enabled() then
        raise exception using errcode = '42501', message = 'character_writes_disabled';
    end if;
end;
$$;

create function private.validate_character_image(p_path text, p_character_id bigint, p_folder text, p_legacy_path text default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
    perform private.require_character_admin();
    if p_character_id is null or p_character_id < 1 or p_folder is null or p_folder not in ('profile', 'feed') then
        raise exception using errcode = '22023', message = 'invalid_character_image';
    end if;
    if p_path is null and p_folder = 'profile' then return; end if;
    if p_path is null or p_path !~ ('^' || p_folder || '/.+') then
        raise exception using errcode = '22023', message = 'invalid_character_image';
    end if;
    -- Preserve unchanged legacy references byte for byte, including flat paths.
    if p_path = p_legacy_path then return; end if;
    if p_path !~ ('^' || p_folder || '/' || p_character_id::text || '/[^/]+$')
        or split_part(p_path, '/', 3) in ('.', '..') then
        raise exception using errcode = '22023', message = 'character_image_scope_mismatch';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'site-images' and name = p_path) then
        raise exception using errcode = '22023', message = 'character_image_missing';
    end if;
end;
$$;

create function private.can_upload_character_image(p_path text)
returns boolean language sql stable security invoker set search_path = '' as $$
    select private.is_site_admin() and private.character_writes_enabled()
        and p_path ~ '^(profile|feed)/[1-9][0-9]*/[^/]+$'
        and split_part(p_path, '/', 3) not in ('.', '..')
        and (exists (select 1 from public.characters c where c.id::text = split_part(p_path, '/', 2))
            or exists (select 1 from private.character_creation_requests r
                where r.character_id::text = split_part(p_path, '/', 2) and r.result is null));
$$;

create function private.can_delete_character_image(p_path text)
returns boolean language plpgsql volatile security invoker set search_path = '' as $$
begin
    if not private.is_site_admin() or not private.character_writes_enabled() then return false; end if;
    if p_path is null or p_path !~ '^(profile|feed)/.+' then return false; end if;
    -- RPC writes acquire this lock in shared mode before validating new references.
    -- Fresh VOLATILE queries run after waiting, so committed references are visible.
    perform pg_advisory_xact_lock(70431862911503);
    return not exists (select 1 from public.characters where profile_image_path = p_path)
        and not exists (select 1 from public.feed_images where image_path = p_path);
end;
$$;

create function public.load_image_references()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_paths jsonb;
begin
    perform private.require_character_admin(false);
    select coalesce(jsonb_agg(path order by path), '[]'::jsonb) into v_paths from (
        select profile_image_path as path from public.characters where profile_image_path is not null
        union select image_path from public.feed_images
    ) paths;
    return v_paths;
end;
$$;
revoke all on function private.character_writes_enabled(), private.require_character_admin(boolean),
    private.validate_character_image(text,bigint,text,text), private.can_upload_character_image(text),
    private.can_delete_character_image(text), public.load_image_references()
    from public, anon, authenticated, service_role;
commit;
