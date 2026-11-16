-- Stage 3 RPCs. Apply locally after API support and before the permissions migration.
-- All writes are administrator-only, maintenance-gated, and scoped to one character.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then
        raise exception 'mc_maintenance_required';
    end if;
    perform pg_advisory_xact_lock(70431862911502);
    if not exists (select 1 from private.character_api_control where id = 1 and not writes_enabled) then
        raise exception 'mc_writes_must_be_disabled';
    end if;
end; $$;

create function public.load_main()
returns jsonb language sql stable security invoker set search_path = '' as $$
    select jsonb_build_object(
        'characters', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'sort_order', c.sort_order, 'name', c.name,
            'status_message', c.status_message, 'profile_image_path', c.profile_image_path) order by c.sort_order, c.id), '[]'::jsonb)
            from public.characters c),
        'theme', (select to_jsonb(t) from public.main_theme t where t.id = 1)
    );
$$;
revoke all on function public.load_main() from public, anon, authenticated, service_role;

create function public.load_character(p_character_id bigint)
returns jsonb language sql stable security invoker set search_path = '' as $$

    select case when c.id is null then null else jsonb_build_object(
        'profile', jsonb_build_object('id', c.id, 'name', c.name, 'status_message', c.status_message, 'profile_image_path', c.profile_image_path),
        'theme', (select jsonb_build_object('id', t.character_id, 'main_color', t.main_color, 'background_color', t.background_color,
            'card_background_color', t.card_background_color, 'typo_color', t.typo_color) from public.character_themes t where t.character_id = c.id),
        'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'sort_order', s.sort_order, 'title', s.title, 'content', s.content)
            order by s.sort_order, s.id), '[]'::jsonb) from public.sections s where s.character_id = c.id),
        'keywords', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'sort_order', k.sort_order, 'content', k.content)
            order by k.sort_order, k.id), '[]'::jsonb) from public.keywords k where k.character_id = c.id),
        'feed', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'sort_order', f.sort_order, 'image_path', f.image_path)
            order by f.sort_order, f.id), '[]'::jsonb) from public.feed_images f where f.character_id = c.id)
    ) end from (select p_character_id as requested_id) requested
    left join public.characters c on c.id = requested.requested_id;
$$;
revoke all on function public.load_character(bigint) from public, anon, authenticated, service_role;

-- VOLATILE gives write RPCs a fresh snapshot after waiting for locks and after their own writes.
create function private.character_snapshot(p_character_id bigint)
returns jsonb language sql volatile security invoker set search_path = '' as $$

    select case when c.id is null then null else jsonb_build_object(
        'profile', jsonb_build_object('id', c.id, 'name', c.name, 'status_message', c.status_message, 'profile_image_path', c.profile_image_path),
        'theme', (select jsonb_build_object('id', t.character_id, 'main_color', t.main_color, 'background_color', t.background_color,
            'card_background_color', t.card_background_color, 'typo_color', t.typo_color) from public.character_themes t where t.character_id = c.id),
        'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'sort_order', s.sort_order, 'title', s.title, 'content', s.content)
            order by s.sort_order, s.id), '[]'::jsonb) from public.sections s where s.character_id = c.id),
        'keywords', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'sort_order', k.sort_order, 'content', k.content)
            order by k.sort_order, k.id), '[]'::jsonb) from public.keywords k where k.character_id = c.id),
        'feed', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'sort_order', f.sort_order, 'image_path', f.image_path)
            order by f.sort_order, f.id), '[]'::jsonb) from public.feed_images f where f.character_id = c.id)
    ) end from (select p_character_id as requested_id) requested
    left join public.characters c on c.id = requested.requested_id;
$$;
revoke all on function private.character_snapshot(bigint) from public, anon, authenticated, service_role;

create function private.character_content(p_character jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
    select jsonb_build_object(
        'profile', (p_character->'profile') - 'id',
        'theme', (p_character->'theme') - 'id',
        'sections', (select coalesce(jsonb_agg(value - 'id' - 'sort_order' order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_character->'sections') with ordinality a(value, ord)),
        'keywords', (select coalesce(jsonb_agg(value - 'id' - 'sort_order' order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_character->'keywords') with ordinality a(value, ord)),
        'feed', (select coalesce(jsonb_agg(value - 'id' - 'sort_order' order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_character->'feed') with ordinality a(value, ord))
    );
$$;
revoke all on function private.character_content(jsonb) from public, anon, authenticated, service_role;

create function private.validate_character_theme(p_theme jsonb)
returns void language plpgsql immutable security invoker set search_path = '' as $$
declare v_keys text[] := array['main_color', 'background_color', 'card_background_color', 'typo_color'];
begin
    if jsonb_typeof(p_theme) is distinct from 'object' or not p_theme ?& v_keys or p_theme - v_keys <> '{}'::jsonb then
        raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Invalid theme shape.';
    end if;
    if exists (select 1 from unnest(v_keys) k where jsonb_typeof(p_theme->k) is distinct from 'string'
        or (p_theme->>k) !~ '^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$') then
        raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Invalid theme colour.';
    end if;
end;
$$;
revoke all on function private.validate_character_theme(jsonb) from public, anon, authenticated, service_role;

create function private.validate_character_data(p_data jsonb)
returns void language plpgsql immutable security invoker set search_path = '' as $$
declare
    v_list text;
    v_item jsonb;
    v_keys text[];
begin
    v_keys := array['profile', 'theme', 'sections', 'keywords', 'feed'];
    if jsonb_typeof(p_data) is distinct from 'object' or not p_data ?& v_keys or p_data - v_keys <> '{}'::jsonb
        or jsonb_typeof(p_data->'profile') is distinct from 'object'
        or jsonb_typeof(p_data->'sections') is distinct from 'array'
        or jsonb_typeof(p_data->'keywords') is distinct from 'array'
        or jsonb_typeof(p_data->'feed') is distinct from 'array' then
        raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Invalid character shape.';
    end if;
    v_keys := array['name', 'status_message', 'profile_image_path'];
    if not (p_data->'profile') ?& v_keys or (p_data->'profile') - v_keys <> '{}'::jsonb
        or jsonb_typeof(p_data#>'{profile,name}') is distinct from 'string'
        or jsonb_typeof(p_data#>'{profile,status_message}') is distinct from 'string'
        or jsonb_typeof(p_data#>'{profile,profile_image_path}') not in ('string', 'null')
        or (p_data#>>'{profile,name}') !~ '[^[:space:]]'
        or (p_data#>>'{profile,status_message}') !~ '[^[:space:]]' then
        raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Invalid profile fields.';
    end if;
    perform private.validate_character_theme(p_data->'theme');
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_keys := case v_list when 'sections' then array['id', 'title', 'content']
            when 'keywords' then array['id', 'content'] else array['id', 'image_path'] end;
        for v_item in select value from jsonb_array_elements(p_data->v_list) loop
            if jsonb_typeof(v_item) is distinct from 'object' or not v_item ?& v_keys or v_item - v_keys <> '{}'::jsonb then
                raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Invalid ' || v_list || ' shape.';
            end if;
            if jsonb_typeof(v_item->'id') not in ('number', 'null') then
                raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'IDs must be positive bigint numbers or null.';
            end if;
            if v_item->'id' <> 'null'::jsonb then
                if (v_item->>'id') !~ '^[1-9][0-9]*$' or (v_item->>'id')::numeric > 9223372036854775807 then
                    raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'ID outside positive bigint range.';
                end if;
            end if;
            if exists (select 1 from unnest(v_keys) k where k <> 'id'
                and (jsonb_typeof(v_item->k) is distinct from 'string' or (v_item->>k) !~ '[^[:space:]]')) then
                raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Invalid ' || v_list || ' text.';
            end if;
        end loop;
        if exists (select 1 from jsonb_array_elements(p_data->v_list) a where a->>'id' is not null
            group by (a->>'id')::bigint having count(*) > 1) then
            raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Duplicate child IDs.';
        end if;
    end loop;
end;
$$;
revoke all on function private.validate_character_data(jsonb) from public, anon, authenticated, service_role;

create function private.validate_character_order(p_order jsonb)
returns void language plpgsql immutable security invoker set search_path = '' as $$
declare v_id jsonb;
begin
    if jsonb_typeof(p_order) is distinct from 'array' then
        raise exception using errcode = '22023', message = 'invalid_character_order';
    end if;
    for v_id in select value from jsonb_array_elements(p_order) loop
        if jsonb_typeof(v_id) is distinct from 'number' then
            raise exception using errcode = '22023', message = 'invalid_character_order';
        end if;
        if v_id::text !~ '^[1-9][0-9]*$' or v_id::text::numeric > 9223372036854775807 then
            raise exception using errcode = '22023', message = 'invalid_character_order';
        end if;
    end loop;
    if exists (select 1 from jsonb_array_elements(p_order) a group by a having count(*) > 1) then
        raise exception using errcode = '22023', message = 'invalid_character_order';
    end if;
end;
$$;
revoke all on function private.validate_character_order(jsonb) from public, anon, authenticated, service_role;

-- Called only after validation/target locks. Every UPDATE and DELETE includes character_id.
create function private.write_character_data(p_character_id bigint, p_data jsonb)
returns void language plpgsql volatile security invoker set search_path = '' as $$
declare
    v_item jsonb;
    v_position integer;
begin
    perform private.require_character_admin();
    update public.characters set name = p_data#>>'{profile,name}', status_message = p_data#>>'{profile,status_message}',
        profile_image_path = p_data#>>'{profile,profile_image_path}' where id = p_character_id;
    if not found then raise exception 'character_not_found'; end if;
    insert into public.character_themes(character_id, main_color, background_color, card_background_color, typo_color)
        values (p_character_id, p_data#>>'{theme,main_color}', p_data#>>'{theme,background_color}',
            p_data#>>'{theme,card_background_color}', p_data#>>'{theme,typo_color}')
        on conflict (character_id) do update set main_color = excluded.main_color, background_color = excluded.background_color,
            card_background_color = excluded.card_background_color, typo_color = excluded.typo_color;
    set constraints public.sections_character_sort_order_key, public.keywords_character_sort_order_key,
        public.feed_images_character_sort_order_key deferred;
    delete from public.sections s where s.character_id = p_character_id and not exists
        (select 1 from jsonb_array_elements(p_data->'sections') a where (a->>'id')::bigint = s.id);
    for v_item, v_position in select value, ord::integer from jsonb_array_elements(p_data->'sections') with ordinality a(value, ord) loop
        if v_item->>'id' is null then
            insert into public.sections(character_id, sort_order, title, content)
                values (p_character_id, v_position, v_item->>'title', v_item->>'content');
        else
            update public.sections set sort_order = v_position, title = v_item->>'title', content = v_item->>'content'
                where character_id = p_character_id and id = (v_item->>'id')::bigint;
        end if;
    end loop;
    delete from public.keywords k where k.character_id = p_character_id and not exists
        (select 1 from jsonb_array_elements(p_data->'keywords') a where (a->>'id')::bigint = k.id);
    for v_item, v_position in select value, ord::integer from jsonb_array_elements(p_data->'keywords') with ordinality a(value, ord) loop
        if v_item->>'id' is null then
            insert into public.keywords(character_id, sort_order, content) values (p_character_id, v_position, v_item->>'content');
        else
            update public.keywords set sort_order = v_position, content = v_item->>'content'
                where character_id = p_character_id and id = (v_item->>'id')::bigint;
        end if;
    end loop;
    delete from public.feed_images f where f.character_id = p_character_id and not exists
        (select 1 from jsonb_array_elements(p_data->'feed') a where (a->>'id')::bigint = f.id);
    for v_item, v_position in select value, ord::integer from jsonb_array_elements(p_data->'feed') with ordinality a(value, ord) loop
        if v_item->>'id' is null then
            insert into public.feed_images(character_id, sort_order, image_path) values (p_character_id, v_position, v_item->>'image_path');
        else
            update public.feed_images set sort_order = v_position, image_path = v_item->>'image_path'
                where character_id = p_character_id and id = (v_item->>'id')::bigint;
        end if;
    end loop;
end;
$$;
revoke all on function private.write_character_data(bigint,jsonb) from public, anon, authenticated, service_role;

create function public.reserve_character_id(p_request_id uuid)
returns bigint language plpgsql volatile security invoker set search_path = '' as $$
declare v_id bigint;
begin
    perform private.require_character_admin();
    if p_request_id is null then raise exception using errcode = '22023', message = 'invalid_creation_request'; end if;
    insert into private.character_creation_requests(request_id, character_id)
        values (p_request_id, nextval('public.characters_id_seq'))
        on conflict (request_id) do update set request_id = excluded.request_id
        returning character_id into v_id;
    return v_id;
end;
$$;
revoke all on function public.reserve_character_id(uuid) from public, anon, authenticated, service_role;

create function public.create_character(p_character_id bigint, p_request_id uuid, p_data jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
    v_request private.character_creation_requests%rowtype;
    v_order integer;
    v_result jsonb;
    v_item jsonb;
begin
    perform private.require_character_admin();
    perform private.validate_character_data(p_data);
    if p_character_id is null or p_character_id < 1 or p_request_id is null then
        raise exception using errcode = '22023', message = 'invalid_creation_request';
    end if;
    perform pg_advisory_xact_lock(70431862911504);
    perform pg_advisory_xact_lock(hashtextextended('character:' || p_character_id::text, 0));
    select * into v_request from private.character_creation_requests where request_id = p_request_id for update;
    if not found or v_request.character_id <> p_character_id then
        raise exception using errcode = '22023', message = 'invalid_creation_request';
    end if;
    if v_request.result is not null then
        if v_request.payload is distinct from p_data then raise exception 'creation_request_conflict'; end if;
        if not exists (select 1 from public.characters where id = p_character_id) then raise exception 'character_not_found'; end if;
        return v_request.result;
    end if;
    if exists (select 1 from public.characters where id = p_character_id or creation_request_id = p_request_id)
        or exists (select 1 from private.character_deletion_receipts where character_id = p_character_id) then
        raise exception 'creation_request_conflict';
    end if;
    if exists (select 1 from unnest(array['sections', 'keywords', 'feed']) lists(name)
        cross join lateral jsonb_array_elements(p_data->lists.name) a where a->>'id' is not null) then
        raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'New children require null IDs.';
    end if;
    if jsonb_array_length(p_data->'feed') > 50 then
        raise exception using errcode = '22023', message = 'character_feed_limit_exceeded';
    end if;
    perform pg_advisory_xact_lock_shared(70431862911503);
    perform private.validate_character_image(p_data#>>'{profile,profile_image_path}', p_character_id, 'profile', null);
    for v_item in select value from jsonb_array_elements(p_data->'feed') loop
        perform private.validate_character_image(v_item->>'image_path', p_character_id, 'feed', null);
    end loop;
    select coalesce(max(sort_order), 0) + 1 into v_order from public.characters;
    insert into public.characters(id, sort_order, name, status_message, profile_image_path, creation_request_id)
        values (p_character_id, v_order, p_data#>>'{profile,name}', p_data#>>'{profile,status_message}',
            p_data#>>'{profile,profile_image_path}', p_request_id);
    perform private.write_character_data(p_character_id, p_data);
    v_result := jsonb_build_object('character', private.character_snapshot(p_character_id), 'cleanup_candidates', '[]'::jsonb);
    update private.character_creation_requests set payload = p_data, result = v_result where request_id = p_request_id;
    return v_result;
end;
$$;
revoke all on function public.create_character(bigint,uuid,jsonb) from public, anon, authenticated, service_role;

create function public.save_character(p_character_id bigint, p_expected jsonb, p_data jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
    v_current jsonb;
    v_same boolean;
    v_item jsonb;
    v_legacy text;
    v_old_paths jsonb;
    v_cleanup jsonb;
begin
    perform private.require_character_admin();
    perform private.validate_character_data(p_data);
    if p_character_id is null or p_character_id < 1 or jsonb_typeof(p_expected) is distinct from 'object'
        or not p_expected ?& array['profile', 'theme', 'sections', 'keywords', 'feed']
        or jsonb_typeof(p_expected#>'{profile,id}') is distinct from 'number'
        or p_expected#>'{profile,id}' is distinct from to_jsonb(p_character_id) then
        raise exception using errcode = '22023', message = 'invalid_expected_character';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('character:' || p_character_id::text, 0));
    perform pg_advisory_xact_lock_shared(70431862911503);
    v_current := private.character_snapshot(p_character_id);
    if v_current is null then raise exception 'character_not_found'; end if;
    if exists (select 1 from jsonb_array_elements(p_data->'sections') a where a->>'id' is not null and not exists
        (select 1 from public.sections s where s.character_id = p_character_id and s.id = (a->>'id')::bigint))
        or exists (select 1 from jsonb_array_elements(p_data->'keywords') a where a->>'id' is not null and not exists
        (select 1 from public.keywords k where k.character_id = p_character_id and k.id = (a->>'id')::bigint))
        or exists (select 1 from jsonb_array_elements(p_data->'feed') a where a->>'id' is not null and not exists
        (select 1 from public.feed_images f where f.character_id = p_character_id and f.id = (a->>'id')::bigint)) then
        raise exception using errcode = '22023', message = 'invalid_character_data', detail = 'Unknown or foreign child ID.';
    end if;
    if jsonb_array_length(p_data->'feed') > greatest(50, jsonb_array_length(v_current->'feed')) then
        raise exception using errcode = '22023', message = 'character_feed_limit_exceeded';
    end if;
    v_same := private.character_content(v_current) = private.character_content(p_data)
        and not exists (select 1 from unnest(array['sections', 'keywords', 'feed']) lists(name)
            cross join lateral jsonb_array_elements(p_data->lists.name) with ordinality items(value, position)
            where (items.value->>'id' is null and v_current = p_expected)
                or (items.value->>'id' is not null and items.value->'id' is distinct from
                    v_current->lists.name->((items.position - 1)::integer)->'id'));
    if v_current is distinct from p_expected and not v_same then raise exception 'character_conflict'; end if;
    if v_same then
        -- A lost response must not lose the original request's cleanup candidates.
        -- Reconstruct them from its baseline and re-check every current character reference.
        select coalesce(jsonb_agg(path order by path), '[]'::jsonb) into v_cleanup from (
            select p_expected#>>'{profile,profile_image_path}' as path
                where jsonb_typeof(p_expected#>'{profile,profile_image_path}') = 'string'
            union
            select a->>'image_path' from jsonb_array_elements(
                case when jsonb_typeof(p_expected->'feed') = 'array' then p_expected->'feed' else '[]'::jsonb end) a
                where jsonb_typeof(a->'image_path') = 'string'
        ) old_paths where path ~ '^(profile|feed)/.+'
            and not exists (select 1 from public.characters where profile_image_path = path)
            and not exists (select 1 from public.feed_images where image_path = path);
        return jsonb_build_object('character', v_current, 'cleanup_candidates', v_cleanup);
    end if;
    perform private.validate_character_image(p_data#>>'{profile,profile_image_path}', p_character_id, 'profile',
        v_current#>>'{profile,profile_image_path}');
    for v_item in select value from jsonb_array_elements(p_data->'feed') loop
        select image_path into v_legacy from public.feed_images where character_id = p_character_id and id = (v_item->>'id')::bigint;
        perform private.validate_character_image(v_item->>'image_path', p_character_id, 'feed', v_legacy);
    end loop;
    select coalesce(jsonb_agg(path), '[]'::jsonb) into v_old_paths from (
        select v_current#>>'{profile,profile_image_path}' as path
        union select a->>'image_path' from jsonb_array_elements(v_current->'feed') a
    ) paths where path is not null;
    perform private.write_character_data(p_character_id, p_data);
    select coalesce(jsonb_agg(path order by path), '[]'::jsonb) into v_cleanup from (
        select value #>> '{}' as path from jsonb_array_elements(v_old_paths)
        except
        select profile_image_path from public.characters where profile_image_path is not null
        except
        select image_path from public.feed_images
    ) unreferenced;
    return jsonb_build_object('character', private.character_snapshot(p_character_id), 'cleanup_candidates', v_cleanup);
end;
$$;
revoke all on function public.save_character(bigint,jsonb,jsonb) from public, anon, authenticated, service_role;

create function public.delete_character(p_character_id bigint, p_expected jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
    v_current jsonb;
    v_receipt private.character_deletion_receipts%rowtype;
    v_paths jsonb;
    v_result jsonb;
begin
    perform private.require_character_admin();
    if p_character_id is null or p_character_id < 1 or jsonb_typeof(p_expected) is distinct from 'object'
        or not p_expected ?& array['profile', 'theme', 'sections', 'keywords', 'feed']
        or jsonb_typeof(p_expected#>'{profile,id}') is distinct from 'number'
        or p_expected#>'{profile,id}' is distinct from to_jsonb(p_character_id) then
        raise exception using errcode = '22023', message = 'invalid_expected_character';
    end if;
    perform pg_advisory_xact_lock(70431862911504);
    perform pg_advisory_xact_lock(hashtextextended('character:' || p_character_id::text, 0));
    perform pg_advisory_xact_lock_shared(70431862911503);
    select * into v_receipt from private.character_deletion_receipts where character_id = p_character_id;
    if found then
        if v_receipt.expected is distinct from p_expected then raise exception 'character_conflict'; end if;
        return v_receipt.result;
    end if;
    v_current := private.character_snapshot(p_character_id);
    if v_current is null then raise exception 'character_not_found'; end if;
    if v_current is distinct from p_expected then raise exception 'character_conflict'; end if;
    select coalesce(jsonb_agg(path order by path), '[]'::jsonb) into v_paths from (
        select v_current#>>'{profile,profile_image_path}' as path
        union select a->>'image_path' from jsonb_array_elements(v_current->'feed') a
    ) paths where path is not null;
    delete from public.characters where id = p_character_id;
    select coalesce(jsonb_agg(path order by path), '[]'::jsonb) into v_paths from (
        select value #>> '{}' as path from jsonb_array_elements(v_paths)
        except select profile_image_path from public.characters where profile_image_path is not null
        except select image_path from public.feed_images
    ) unreferenced;
    v_result := jsonb_build_object('character_id', p_character_id, 'cleanup_candidates', v_paths);
    insert into private.character_deletion_receipts(character_id, expected, result) values (p_character_id, p_expected, v_result);
    return v_result;
end;
$$;
revoke all on function public.delete_character(bigint,jsonb) from public, anon, authenticated, service_role;

create function public.save_character_order(p_expected jsonb, p_order jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare v_current jsonb; v_id jsonb; v_position integer;
begin
    perform private.require_character_admin();
    perform private.validate_character_order(p_expected);
    perform private.validate_character_order(p_order);
    perform pg_advisory_xact_lock(70431862911504);
    select coalesce(jsonb_agg(id order by sort_order, id), '[]'::jsonb) into v_current from public.characters;
    if exists (select value from jsonb_array_elements(v_current) except select value from jsonb_array_elements(p_order))
        or exists (select value from jsonb_array_elements(p_order) except select value from jsonb_array_elements(v_current)) then
        raise exception 'character_order_conflict';
    end if;
    if v_current = p_order then return v_current; end if;
    if v_current is distinct from p_expected then raise exception 'character_order_conflict'; end if;
    set constraints public.characters_sort_order_key deferred;
    for v_id, v_position in select value, ord::integer from jsonb_array_elements(p_order) with ordinality a(value, ord) loop
        update public.characters set sort_order = v_position where id = v_id::text::bigint;
    end loop;
    return p_order;
end;
$$;
revoke all on function public.save_character_order(jsonb,jsonb) from public, anon, authenticated, service_role;

create function public.save_main_theme(p_expected jsonb, p_data jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare v_current jsonb;
begin
    perform private.require_character_admin();
    perform private.validate_character_theme(p_data);
    if jsonb_typeof(p_expected) is distinct from 'object' or p_expected->'id' is distinct from '1'::jsonb then
        raise exception using errcode = '22023', message = 'invalid_expected_theme';
    end if;
    perform private.validate_character_theme(p_expected - 'id');
    perform pg_advisory_xact_lock(70431862911506);
    select to_jsonb(t) into v_current from public.main_theme t where id = 1;
    if v_current is null then raise exception 'main_theme_not_found'; end if;
    if v_current - 'id' = p_data then return v_current; end if;
    if v_current is distinct from p_expected then raise exception 'main_theme_conflict'; end if;
    update public.main_theme set main_color = p_data->>'main_color', background_color = p_data->>'background_color',
        card_background_color = p_data->>'card_background_color', typo_color = p_data->>'typo_color' where id = 1;
    select to_jsonb(t) into v_current from public.main_theme t where id = 1;
    return v_current;
end;
$$;
revoke all on function public.save_main_theme(jsonb,jsonb) from public, anon, authenticated, service_role;
commit;
