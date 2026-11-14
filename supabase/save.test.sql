-- Run as project owner. All site content changes are rolled back.
-- Identity sequences can advance, leaving normal harmless ID gaps.
-- Never changes storage.objects metadata or file binaries.
begin;
do $$
begin
    if has_function_privilege('anon', 'public.save_site(jsonb,jsonb)', 'execute')
        or not has_function_privilege('authenticated', 'public.save_site(jsonb,jsonb)', 'execute')
    then raise exception 'Incorrect RPC execute grants'; end if;
    if exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname, p.proname) in (
            ('public', 'save_site'), ('private', 'site_snapshot'), ('private', 'site_content')
        ) and (p.prosecdef or not 'search_path=""' = any(p.proconfig))
    ) then raise exception 'Unsafe function security/search_path'; end if;
    if (select count(*) from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname in ('site_images_admin_select', 'site_images_admin_insert',
            'site_images_admin_update', 'site_images_admin_delete')
          and roles = array['authenticated']::name[]) <> 4
    then raise exception 'Missing authenticated Storage policies'; end if;
end;
$$;
set local role anon;
do $$
begin
    begin
        perform public.save_site('{}'::jsonb, '{}'::jsonb);
        raise exception 'Anon executed save_site';
    exception when insufficient_privilege then null;
    end;
end;
$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f711da08-9c0b-42ee-a20c-a4f83ad46473', true);
select set_config('request.jwt.claims', '{"sub":"f711da08-9c0b-42ee-a20c-a4f83ad46473","role":"authenticated"}', true);
do $$
declare
    v_initial jsonb := private.site_snapshot();
    v_seed jsonb := '{
        "profile":{"name":"SQL test","status_message":"Status","profile_image_path":"profile/sql-test.png"},
        "theme":{"main_color":"#123456","background_color":"#abcdef","card_background_color":"#fff","typo_color":"#222"},
        "sections":[{"id":null,"title":"A","content":" *bold* "},{"id":null,"title":"B","content":"Second"}],
        "keywords":[{"id":null,"content":"Alpha"},{"id":null,"content":"Beta"}],
        "feed":[{"id":null,"image_path":"feed/sql-a.png"},{"id":null,"image_path":"feed/sql-b.png"}]
    }'::jsonb;
    v_payload jsonb;
    v_result jsonb;
    v_created jsonb;
    v_swapped jsonb;
    v_replaced jsonb;
    v_empty jsonb;
    v_duplicate_payload jsonb;
    v_duplicates jsonb;
    v_duplicate_swapped jsonb;
    v_bad jsonb;
    v_bad_cases jsonb;
    v_list text;
begin
    v_created := public.save_site(v_initial, v_seed);
    if v_created #>> '{profile,name}' <> 'SQL test'
        or v_created #>> '{theme,main_color}' <> '#123456'
        or v_created #>> '{sections,0,content}' <> ' *bold* '
    then raise exception 'Snapshot must include new writes and raw content'; end if;
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        if jsonb_array_length(v_created -> v_list) <> 2
            or v_created #>> array[v_list, '0', 'sort_order'] <> '1'
            or v_created #>> array[v_list, '1', 'sort_order'] <> '2'
        then raise exception 'Create/order failed: %', v_list; end if;
    end loop;
    if public.save_site(v_initial, v_seed) is distinct from v_created
    then raise exception 'Lost response replay allocated different IDs'; end if;
    set constraints all immediate;
    set constraints all deferred;

    v_payload := v_seed;
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_payload := jsonb_set(v_payload, array[v_list], jsonb_build_array(
            (v_created -> v_list -> 1) - 'sort_order', (v_created -> v_list -> 0) - 'sort_order'
        ));
    end loop;
    v_payload := jsonb_set(v_payload, '{sections,0,title}', '"B edited"'::jsonb);
    v_swapped := public.save_site(v_created, v_payload);
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        if v_swapped #> array[v_list, '0', 'id'] is distinct from v_created #> array[v_list, '1', 'id']
            or v_swapped #> array[v_list, '1', 'id'] is distinct from v_created #> array[v_list, '0', 'id']
        then raise exception 'ID preserving swap failed: %', v_list; end if;
    end loop;
    if v_swapped #>> '{sections,0,title}' <> 'B edited'
    then raise exception 'Row edit failed'; end if;
    set constraints all immediate;
    set constraints all deferred;

    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_payload := jsonb_set(v_payload, array[v_list], jsonb_build_array(
            (v_swapped -> v_list -> 0) - 'sort_order', v_seed -> v_list -> 0
        ));
    end loop;
    v_payload := jsonb_set(v_payload, '{sections,1,title}', '"New section"'::jsonb);
    v_payload := jsonb_set(v_payload, '{keywords,1,content}', '"New keyword"'::jsonb);
    v_payload := jsonb_set(v_payload, '{feed,1,image_path}', '"feed/sql-new.png"'::jsonb);
    v_replaced := public.save_site(v_swapped, v_payload);
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        if jsonb_array_length(v_replaced -> v_list) <> 2
            or v_replaced #> array[v_list, '0', 'id'] is distinct from v_swapped #> array[v_list, '0', 'id']
            or v_replaced #> array[v_list, '1', 'id'] = v_swapped #> array[v_list, '1', 'id']
        then raise exception 'Keep/delete/insert failed: %', v_list; end if;
    end loop;
    if public.save_site(v_swapped, v_payload) is distinct from v_replaced
    then raise exception 'Successful deletion and new-null-ID replay failed'; end if;
    set constraints all immediate;
    set constraints all deferred;

    v_bad := jsonb_set(v_payload, '{sections,1,id}', v_swapped #> '{sections,1,id}');
    v_bad := jsonb_set(v_bad, '{profile,name}', '"stale change"'::jsonb);
    begin
        perform public.save_site(v_swapped, v_bad);
        raise exception 'Stale request accepted';
    exception when raise_exception then
        if sqlerrm <> 'site_conflict' then raise; end if;
    end;
    if private.site_snapshot() is distinct from v_replaced
    then raise exception 'Conflict changed data'; end if;
    -- Semantically identical content must not bypass malformed/unknown ID checks.
    v_bad_cases := jsonb_build_array(
        jsonb_set(v_payload, '{sections,1,id}', v_payload #> '{sections,0,id}'),
        jsonb_set(v_payload, '{sections,0,id}', '9223372036854775807'::jsonb),
        jsonb_set(v_payload, '{sections,0,id}', '"1"'::jsonb),
        jsonb_set(v_payload, '{sections,0,id}', '1.5'::jsonb),
        jsonb_set(v_payload, '{sections,0,id}', '-1'::jsonb),
        jsonb_set(v_payload, '{sections,0,id}', '9223372036854775808'::jsonb),
        jsonb_set(v_payload, '{sections,0}', (v_payload #> '{sections,0}') - 'id'),
        jsonb_set(v_payload, '{keywords,0,content}', 'false'::jsonb),
        jsonb_set(v_payload, '{profile,profile_image_path}', '42'::jsonb),
        v_payload - 'feed', v_payload || '{"extra":true}'::jsonb,
        jsonb_set(v_payload, '{theme}', 'null'::jsonb)
    );
    for v_bad in select value from jsonb_array_elements(v_bad_cases) loop
        begin
            perform public.save_site(v_replaced, v_bad);
            raise exception 'Malformed request accepted';
        exception when invalid_parameter_value then
            if sqlerrm <> 'invalid_site_data' then raise; end if;
        end;
    end loop;
    if private.site_snapshot() is distinct from v_replaced
    then raise exception 'Malformed request changed data'; end if;

    -- A late feed CHECK violation must roll back earlier profile/list updates.
    v_bad_cases := jsonb_build_array(
        jsonb_set(v_payload, '{profile,name}', '"  "'::jsonb),
        jsonb_set(v_payload, '{profile,status_message}', '""'::jsonb),
        jsonb_set(v_payload, '{profile,profile_image_path}', '"feed/wrong.png"'::jsonb),
        jsonb_set(v_payload, '{theme,main_color}', '"invalid"'::jsonb),
        jsonb_set(jsonb_set(v_payload, '{profile,name}', '"must roll back"'::jsonb),
            '{feed,1,image_path}', '"profile/wrong.png"'::jsonb)
    );
    for v_bad in select value from jsonb_array_elements(v_bad_cases) loop
        begin
            perform public.save_site(v_replaced, v_bad);
            raise exception 'Invalid constraint accepted';
        exception when check_violation then null;
        end;
        if private.site_snapshot() is distinct from v_replaced
        then raise exception 'Failed save did not roll back atomically'; end if;
    end loop;

    v_payload := jsonb_set(v_payload, '{profile,profile_image_path}', 'null'::jsonb);
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_payload := jsonb_set(v_payload, array[v_list], '[]'::jsonb);
    end loop;
    v_empty := public.save_site(v_replaced, v_payload);
    if v_empty -> 'sections' <> '[]'::jsonb or v_empty -> 'keywords' <> '[]'::jsonb
        or v_empty -> 'feed' <> '[]'::jsonb or v_empty #> '{profile,profile_image_path}' <> 'null'::jsonb
        or public.save_site(v_replaced, v_payload) is distinct from v_empty
    then raise exception 'Empty lists/image removal/replay failed'; end if;
    set constraints all immediate;

    -- Identical text or image paths still represent distinct existing rows.
    -- Reordering their IDs must update sort_order instead of becoming a no-op.
    v_duplicate_payload := v_seed;
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_duplicate_payload := jsonb_set(v_duplicate_payload, array[v_list],
            jsonb_build_array(v_seed -> v_list -> 0, v_seed -> v_list -> 0));
    end loop;
    v_duplicates := public.save_site(v_empty, v_duplicate_payload);
    if public.save_site(v_empty, v_duplicate_payload) is distinct from v_duplicates
    then raise exception 'Identical new-null-ID rows replay failed'; end if;
    set constraints all immediate;

    v_bad := v_duplicate_payload;
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_bad := jsonb_set(v_bad, array[v_list], jsonb_build_array(
            (v_duplicates -> v_list -> 0) - 'sort_order',
            (v_duplicates -> v_list -> 1) - 'sort_order'
        ));
        v_duplicate_payload := jsonb_set(v_duplicate_payload, array[v_list], jsonb_build_array(
            (v_duplicates -> v_list -> 1) - 'sort_order',
            (v_duplicates -> v_list -> 0) - 'sort_order'
        ));
    end loop;
    v_duplicate_swapped := public.save_site(v_duplicates, v_duplicate_payload);
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        if v_duplicate_swapped #> array[v_list, '0', 'id'] is distinct from v_duplicates #> array[v_list, '1', 'id']
            or v_duplicate_swapped #> array[v_list, '1', 'id'] is distinct from v_duplicates #> array[v_list, '0', 'id']
            or v_duplicate_swapped #>> array[v_list, '0', 'sort_order'] <> '1'
            or v_duplicate_swapped #>> array[v_list, '1', 'sort_order'] <> '2'
        then raise exception 'Identical-content ID swap failed: %', v_list; end if;
    end loop;
    if public.save_site(v_duplicates, v_duplicate_payload) is distinct from v_duplicate_swapped
    then raise exception 'Identical-content swapped request replay failed'; end if;
    begin
        perform public.save_site(v_duplicates, v_bad);
        raise exception 'Stale identical-content ID order accepted';
    exception when raise_exception then
        if sqlerrm <> 'site_conflict' then raise; end if;
    end;
    if private.site_snapshot() is distinct from v_duplicate_swapped
    then raise exception 'Stale identical-content order changed data'; end if;
    set constraints all immediate;

    -- A fresh delete-and-add of identical content must allocate a new ID.
    -- Replaying its lost response must then reuse that newly allocated ID.
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_duplicate_payload := jsonb_set(v_duplicate_payload,
            array[v_list, '0', 'id'], 'null'::jsonb);
    end loop;
    v_result := public.save_site(v_duplicate_swapped, v_duplicate_payload);
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        if v_result #> array[v_list, '0', 'id'] = v_duplicate_swapped #> array[v_list, '0', 'id']
            or v_result #> array[v_list, '1', 'id'] is distinct from v_duplicate_swapped #> array[v_list, '1', 'id']
        then raise exception 'Fresh identical-content null-ID replacement failed: %', v_list; end if;
    end loop;
    if public.save_site(v_duplicate_swapped, v_duplicate_payload) is distinct from v_result
    then raise exception 'Identical-content replacement request replay failed'; end if;
    set constraints all immediate;

    v_result := public.save_site(v_result, v_payload);
    if v_result is distinct from v_empty
    then raise exception 'Identical-content test did not restore empty snapshot'; end if;
    set constraints all immediate;

    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
    if private.is_site_admin() then raise exception 'Nonadmin recognized as admin'; end if;
    begin
        perform public.save_site(v_empty, v_payload);
        raise exception 'Nonadmin save accepted';
    exception when insufficient_privilege then
        if sqlerrm <> 'site_admin_required' then raise; end if;
    end;
    update public.profile set name = 'nonadmin edit' where id = 1;
    if found then raise exception 'Nonadmin direct update accepted'; end if;
    begin
        insert into public.sections(sort_order, title, content) values (1, 'denied', 'denied');
        raise exception 'Nonadmin direct insert accepted';
    exception when insufficient_privilege then null;
    end;
    if private.site_snapshot() is distinct from v_empty
    then raise exception 'Unauthorized operations changed data'; end if;
end;
$$;
reset role;
select 'PASS: admin save, IDs, reorder/new/delete, identical-content ID reorder, replay, stale conflict, malformed/no-op, atomic rollback, empty lists, anon/nonadmin denied, Storage policies' as sql_check;
rollback;
