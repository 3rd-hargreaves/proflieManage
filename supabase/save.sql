-- schema.sql 실행 후 프로젝트 소유자 권한으로 실행한다.
-- 기존 콘텐츠를 보존하며, 이 파일의 함수·정책만 다시 만들 수 있다.
-- Storage 파일은 SDK로 업로드/삭제한다. 이 SQL은 파일 자체를 삭제하지 않는다.
-- 참고 https://supabase.com/docs/guides/storage/security/access-control

begin;

-- VOLATILE이어야 같은 트랜잭션의 수정 결과도 마지막 스냅샷에 반영된다.
create or replace function private.site_snapshot()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'profile', (
            select jsonb_build_object(
                'id', p.id, 'name', p.name,
                'status_message', p.status_message,
                'profile_image_path', p.profile_image_path
            ) from public.profile p where p.id = 1
        ),
        'theme', (
            select jsonb_build_object(
                'id', t.id, 'main_color', t.main_color,
                'background_color', t.background_color,
                'card_background_color', t.card_background_color,
                'typo_color', t.typo_color
            ) from public.theme t where t.id = 1
        ),
        'sections', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', s.id, 'sort_order', s.sort_order,
                'title', s.title, 'content', s.content
            ) order by s.sort_order, s.id), '[]'::jsonb)
            from public.sections s
        ),
        'keywords', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', k.id, 'sort_order', k.sort_order, 'content', k.content
            ) order by k.sort_order, k.id), '[]'::jsonb)
            from public.keywords k
        ),
        'feed', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', f.id, 'image_path', f.image_path, 'sort_order', f.sort_order
            ) order by f.sort_order, f.id), '[]'::jsonb)
            from public.feed_images f
        )
    );
$$;

-- 응답 유실 후 재시도에는 ID 발급 없이 현재 성공 결과를 돌려준다.
-- ID와 sort_order만 제외하며, 배열 순서·문자열·이미지 경로는 그대로 비교한다.
create or replace function private.site_content(p_site jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'profile', (p_site -> 'profile') - 'id',
        'theme', (p_site -> 'theme') - 'id',
        'sections', (
            select coalesce(jsonb_agg(value - 'id' - 'sort_order' order by position), '[]'::jsonb)
            from jsonb_array_elements(p_site -> 'sections') with ordinality as e(value, position)
        ),
        'keywords', (
            select coalesce(jsonb_agg(value - 'id' - 'sort_order' order by position), '[]'::jsonb)
            from jsonb_array_elements(p_site -> 'keywords') with ordinality as e(value, position)
        ),
        'feed', (
            select coalesce(jsonb_agg(value - 'id' - 'sort_order' order by position), '[]'::jsonb)
            from jsonb_array_elements(p_site -> 'feed') with ordinality as e(value, position)
        )
    );
$$;

create or replace function public.save_site(p_expected jsonb, p_data jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_current jsonb;
    v_same_content boolean;
    v_list text;
    v_keys text[];
    v_item jsonb;
    v_order integer;
begin
    if not private.is_site_admin() then
        raise exception using errcode = '42501', message = 'site_admin_required';
    end if;

    if jsonb_typeof(p_data) is distinct from 'object'
        or not p_data ?& array['profile', 'theme', 'sections', 'keywords', 'feed']
        or p_data - array['profile', 'theme', 'sections', 'keywords', 'feed'] <> '{}'::jsonb
        or jsonb_typeof(p_data -> 'profile') is distinct from 'object'
        or jsonb_typeof(p_data -> 'theme') is distinct from 'object'
        or jsonb_typeof(p_data -> 'sections') is distinct from 'array'
        or jsonb_typeof(p_data -> 'keywords') is distinct from 'array'
        or jsonb_typeof(p_data -> 'feed') is distinct from 'array'
    then
        raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Invalid site shape.';
    end if;

    if jsonb_typeof(p_expected) is distinct from 'object'
        or not p_expected ?& array['profile', 'theme', 'sections', 'keywords', 'feed']
        or jsonb_typeof(p_expected -> 'profile') is distinct from 'object'
        or jsonb_typeof(p_expected -> 'theme') is distinct from 'object'
        or jsonb_typeof(p_expected -> 'sections') is distinct from 'array'
        or jsonb_typeof(p_expected -> 'keywords') is distinct from 'array'
        or jsonb_typeof(p_expected -> 'feed') is distinct from 'array'
    then
        raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Invalid expected snapshot.';
    end if;

    v_keys := array['name', 'status_message', 'profile_image_path'];
    if not (p_data -> 'profile') ?& v_keys
        or (p_data -> 'profile') - v_keys <> '{}'::jsonb
        or jsonb_typeof(p_data #> '{profile,name}') is distinct from 'string'
        or jsonb_typeof(p_data #> '{profile,status_message}') is distinct from 'string'
        or jsonb_typeof(p_data #> '{profile,profile_image_path}') not in ('string', 'null')
    then
        raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Invalid profile fields.';
    end if;

    v_keys := array['main_color', 'background_color', 'card_background_color', 'typo_color'];
    if not (p_data -> 'theme') ?& v_keys
        or (p_data -> 'theme') - v_keys <> '{}'::jsonb
        or exists (
            select 1 from unnest(v_keys) as e(key)
            where jsonb_typeof(p_data -> 'theme' -> key) is distinct from 'string'
        )
    then
        raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Invalid theme fields.';
    end if;

    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        v_keys := case v_list
            when 'sections' then array['id', 'title', 'content']
            when 'keywords' then array['id', 'content']
            else array['id', 'image_path']
        end;

        for v_item in select value from jsonb_array_elements(p_data -> v_list) loop
            if jsonb_typeof(v_item) is distinct from 'object'
                or not v_item ?& v_keys
                or v_item - v_keys <> '{}'::jsonb
            then
                raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Invalid ' || v_list || ' item shape.';
            end if;

            if jsonb_typeof(v_item -> 'id') not in ('number', 'null') then
                raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'IDs must be positive integers or null.';
            end if;
            if v_item -> 'id' <> 'null'::jsonb then
                if (v_item ->> 'id') !~ '^[1-9][0-9]*$' then
                    raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'IDs must be positive integers or null.';
                end if;
                if (v_item ->> 'id')::numeric > 9223372036854775807 then
                    raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'ID is outside the bigint range.';
                end if;
            end if;

            if exists (
                select 1 from unnest(v_keys) as e(key)
                where key <> 'id' and jsonb_typeof(v_item -> key) is distinct from 'string'
            ) then
                raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Invalid ' || v_list || ' text fields.';
            end if;
        end loop;

        if exists (
            select 1 from jsonb_array_elements(p_data -> v_list) as e(value)
            where value ->> 'id' is not null
            group by (value ->> 'id')::bigint having count(*) > 1
        ) then
            raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Duplicate ' || v_list || ' IDs.';
        end if;
    end loop;

    -- RPC 외의 일반 테이블 쓰기도 잠금과 충돌하여 비교와 저장 사이에 끼어들지 않는다.
    lock table public.profile, public.theme, public.sections, public.keywords,
        public.feed_images in share row exclusive mode;

    v_current := private.site_snapshot();
    -- 같은 내용의 기존 행도 ID 순서가 바뀌면 실제로 저장해야 한다.
    -- null ID는 기대 스냅샷이 달라진 응답 유실 재시도에서만 발급된 ID와 일치할 수 있다.
    -- 최신 스냅샷에서 요청한 null ID는 같은 내용이라도 새 행으로 저장한다.
    v_same_content := private.site_content(v_current) = private.site_content(p_data)
        and not exists (
            select 1
            from unnest(array['sections', 'keywords', 'feed']) as lists(name)
            cross join lateral jsonb_array_elements(p_data -> lists.name)
                with ordinality as items(value, position)
            where (items.value ->> 'id' is null and v_current = p_expected)
                or (items.value ->> 'id' is not null
                    and items.value -> 'id' is distinct from
                        v_current -> lists.name -> ((items.position - 1)::integer) -> 'id')
        );
    if v_current is distinct from p_expected and not v_same_content then
        raise exception using errcode = 'P0001', message = 'site_conflict';
    end if;

    if exists (
        select 1 from jsonb_array_elements(p_data -> 'sections') as e(value)
        where value ->> 'id' is not null and not exists (
            select 1 from public.sections s where s.id = (value ->> 'id')::bigint
        )
    ) or exists (
        select 1 from jsonb_array_elements(p_data -> 'keywords') as e(value)
        where value ->> 'id' is not null and not exists (
            select 1 from public.keywords k where k.id = (value ->> 'id')::bigint
        )
    ) or exists (
        select 1 from jsonb_array_elements(p_data -> 'feed') as e(value)
        where value ->> 'id' is not null and not exists (
            select 1 from public.feed_images f where f.id = (value ->> 'id')::bigint
        )
    ) then
        raise exception using errcode = '22023', message = 'invalid_site_data', detail = 'Unknown item ID.';
    end if;

    if v_same_content then
        return v_current;
    end if;

    set constraints public.sections_sort_order_key, public.keywords_sort_order_key,
        public.feed_images_sort_order_key deferred;

    insert into public.profile (id, name, status_message, profile_image_path)
    values (1, p_data #>> '{profile,name}', p_data #>> '{profile,status_message}',
        p_data #>> '{profile,profile_image_path}')
    on conflict (id) do update set
        name = excluded.name, status_message = excluded.status_message,
        profile_image_path = excluded.profile_image_path;

    insert into public.theme (id, main_color, background_color, card_background_color, typo_color)
    values (1, p_data #>> '{theme,main_color}', p_data #>> '{theme,background_color}',
        p_data #>> '{theme,card_background_color}', p_data #>> '{theme,typo_color}')
    on conflict (id) do update set
        main_color = excluded.main_color, background_color = excluded.background_color,
        card_background_color = excluded.card_background_color, typo_color = excluded.typo_color;

    delete from public.sections s where not exists (
        select 1 from jsonb_array_elements(p_data -> 'sections') as e(value)
        where (value ->> 'id')::bigint = s.id
    );
    for v_item, v_order in
        select value, position::integer
        from jsonb_array_elements(p_data -> 'sections') with ordinality as e(value, position)
    loop
        if v_item ->> 'id' is null then
            insert into public.sections (sort_order, title, content)
            values (v_order, v_item ->> 'title', v_item ->> 'content');
        else
            update public.sections set sort_order = v_order,
                title = v_item ->> 'title', content = v_item ->> 'content'
            where id = (v_item ->> 'id')::bigint;
        end if;
    end loop;

    delete from public.keywords k where not exists (
        select 1 from jsonb_array_elements(p_data -> 'keywords') as e(value)
        where (value ->> 'id')::bigint = k.id
    );
    for v_item, v_order in
        select value, position::integer
        from jsonb_array_elements(p_data -> 'keywords') with ordinality as e(value, position)
    loop
        if v_item ->> 'id' is null then
            insert into public.keywords (sort_order, content)
            values (v_order, v_item ->> 'content');
        else
            update public.keywords set sort_order = v_order, content = v_item ->> 'content'
            where id = (v_item ->> 'id')::bigint;
        end if;
    end loop;

    delete from public.feed_images f where not exists (
        select 1 from jsonb_array_elements(p_data -> 'feed') as e(value)
        where (value ->> 'id')::bigint = f.id
    );
    for v_item, v_order in
        select value, position::integer
        from jsonb_array_elements(p_data -> 'feed') with ordinality as e(value, position)
    loop
        if v_item ->> 'id' is null then
            insert into public.feed_images (image_path, sort_order)
            values (v_item ->> 'image_path', v_order);
        else
            update public.feed_images set image_path = v_item ->> 'image_path', sort_order = v_order
            where id = (v_item ->> 'id')::bigint;
        end if;
    end loop;

    return private.site_snapshot();
end;
$$;

revoke all on function private.site_snapshot(), private.site_content(jsonb),
    public.save_site(jsonb, jsonb) from public, anon, authenticated;
grant execute on function private.site_snapshot(), private.site_content(jsonb),
    public.save_site(jsonb, jsonb) to authenticated;

-- 공개 버킷의 이미지 URL은 방문자도 열 수 있다. 목록 조회와 쓰기는 관리자만 허용한다.
drop policy if exists site_images_admin_select on storage.objects;
create policy site_images_admin_select on storage.objects
    for select to authenticated
    using (
        bucket_id = 'site-images'
        and (storage.foldername(name))[1] in ('profile', 'feed')
        and (select private.is_site_admin())
    );

drop policy if exists site_images_admin_insert on storage.objects;
create policy site_images_admin_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'site-images'
        and (storage.foldername(name))[1] in ('profile', 'feed')
        and (select private.is_site_admin())
    );

drop policy if exists site_images_admin_update on storage.objects;
create policy site_images_admin_update on storage.objects
    for update to authenticated
    using (
        bucket_id = 'site-images'
        and (storage.foldername(name))[1] in ('profile', 'feed')
        and (select private.is_site_admin())
    )
    with check (
        bucket_id = 'site-images'
        and (storage.foldername(name))[1] in ('profile', 'feed')
        and (select private.is_site_admin())
    );

drop policy if exists site_images_admin_delete on storage.objects;
create policy site_images_admin_delete on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'site-images'
        and (storage.foldername(name))[1] in ('profile', 'feed')
        and (select private.is_site_admin())
    );

commit;
