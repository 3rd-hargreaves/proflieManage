-- Run read.sql after schema.sql and save.sql, then run this file as project owner.
-- Every test transaction is rolled back; no site content is committed.
-- Identity sequences can advance, leaving normal harmless ID gaps.
-- Never changes storage.objects metadata or file binaries.

-- Public reads must also work in an explicitly read-only transaction.
begin read only;

do $$
declare
    v_function record;
begin
    select p.*, l.lanname into strict v_function
    from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'public.load_site()'::regprocedure;
    if v_function.lanname <> 'sql'
        or v_function.provolatile <> 's'
        or v_function.prosecdef
        or v_function.pronargs <> 0
        or v_function.prorettype <> 'jsonb'::regtype
        or not coalesce('search_path=""' = any(v_function.proconfig), false)
    then raise exception 'Unsafe load_site language/volatility/security/signature/search_path'; end if;
    if not has_function_privilege('anon', 'public.load_site()', 'execute')
        or not has_function_privilege('authenticated', 'public.load_site()', 'execute')
        or exists (
            select 1
            from aclexplode(coalesce(v_function.proacl, acldefault('f', v_function.proowner))) a
            where a.privilege_type = 'EXECUTE'
                and a.grantee not in (
                    v_function.proowner,
                    'anon'::regrole::oid,
                    'authenticated'::regrole::oid
                )
        )
    then raise exception 'Incorrect load_site execute grants'; end if;
    if (select count(*) from pg_class c
        where c.oid in ('public.profile'::regclass, 'public.theme'::regclass,
            'public.sections'::regclass, 'public.keywords'::regclass, 'public.feed_images'::regclass)
            and c.relrowsecurity) <> 5
    then raise exception 'Public content tables must retain RLS'; end if;
end;
$$;

set local role anon;
do $$
declare
    v_site jsonb := public.load_site();
begin
    if current_setting('transaction_read_only') <> 'on'
        or jsonb_typeof(v_site) is distinct from 'object'
        or not v_site ?& array['profile', 'theme', 'sections', 'keywords', 'feed']
        or v_site - array['profile', 'theme', 'sections', 'keywords', 'feed'] <> '{}'::jsonb
        or jsonb_typeof(v_site -> 'sections') is distinct from 'array'
        or jsonb_typeof(v_site -> 'keywords') is distinct from 'array'
        or jsonb_typeof(v_site -> 'feed') is distinct from 'array'
    then raise exception 'Anon load_site failed in a read-only transaction'; end if;
end;
$$;
reset role;

set local role authenticated;
do $$
declare
    v_site jsonb;
begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
    if private.is_site_admin() then raise exception 'Read test user is an admin'; end if;
    v_site := public.load_site();
    if current_setting('transaction_read_only') <> 'on'
        or jsonb_typeof(v_site) is distinct from 'object'
        or not v_site ?& array['profile', 'theme', 'sections', 'keywords', 'feed']
    then raise exception 'Nonadmin load_site failed in a read-only transaction'; end if;
end;
$$;
reset role;
rollback;

begin;

-- Keep other writers outside the seeded test, including direct table writes.
lock table public.profile, public.theme, public.sections, public.keywords,
    public.feed_images in share row exclusive mode;

delete from public.sections;
delete from public.keywords;
delete from public.feed_images;
update public.profile set name = 'Read SQL test', status_message = 'Public status',
    profile_image_path = 'profile/read-test.png' where id = 1;
update public.theme set main_color = '#123456', background_color = '#abcdef',
    card_background_color = '#ffffff', typo_color = '#222222' where id = 1;

-- Insert in the opposite order to display order so IDs alone cannot order lists.
insert into public.sections (sort_order, title, content) values
    (20, 'Later section', 'Second content'),
    (10, 'First section', E'  *bold* _underline_ /italic/\r\n| table |  ');
insert into public.keywords (sort_order, content) values
    (20, 'Later keyword'), (10, 'First keyword');
insert into public.feed_images (sort_order, image_path) values
    (20, 'feed/later-read-test.png'), (10, 'feed/first-read-test.png');
set constraints all immediate;

do $$
declare
    v_site jsonb := public.load_site();
    v_list text;
begin
    if v_site is distinct from private.site_snapshot()
    then raise exception 'load_site differs from the existing save snapshot'; end if;
    if v_site #>> '{profile,name}' is distinct from 'Read SQL test'
        or v_site #>> '{profile,status_message}' is distinct from 'Public status'
        or v_site #>> '{profile,profile_image_path}' is distinct from 'profile/read-test.png'
        or v_site #>> '{theme,main_color}' is distinct from '#123456'
        or v_site #>> '{theme,background_color}' is distinct from '#abcdef'
        or v_site #>> '{theme,card_background_color}' is distinct from '#ffffff'
        or v_site #>> '{theme,typo_color}' is distinct from '#222222'
        or v_site #>> '{sections,0,title}' is distinct from 'First section'
        or v_site #>> '{sections,0,content}' is distinct from E'  *bold* _underline_ /italic/\r\n| table |  '
        or v_site #>> '{keywords,0,content}' is distinct from 'First keyword'
        or v_site #>> '{feed,0,image_path}' is distinct from 'feed/first-read-test.png'
    then raise exception 'Public reads changed stored content or display order'; end if;
    foreach v_list in array array['sections', 'keywords', 'feed'] loop
        if jsonb_array_length(v_site -> v_list) is distinct from 2
            or v_site #>> array[v_list, '0', 'sort_order'] is distinct from '10'
            or v_site #>> array[v_list, '1', 'sort_order'] is distinct from '20'
        then raise exception 'Incorrect ordered list: %', v_list; end if;
    end loop;
    if v_site #> '{sections,0,id}' is distinct from (select to_jsonb(id) from public.sections where sort_order = 10)
        or v_site #> '{sections,1,id}' is distinct from (select to_jsonb(id) from public.sections where sort_order = 20)
        or v_site #> '{keywords,0,id}' is distinct from (select to_jsonb(id) from public.keywords where sort_order = 10)
        or v_site #> '{keywords,1,id}' is distinct from (select to_jsonb(id) from public.keywords where sort_order = 20)
        or v_site #> '{feed,0,id}' is distinct from (select to_jsonb(id) from public.feed_images where sort_order = 10)
        or v_site #> '{feed,1,id}' is distinct from (select to_jsonb(id) from public.feed_images where sort_order = 20)
    then raise exception 'Public reads changed row IDs'; end if;
    perform set_config('read_test.expected', v_site::text, true);
end;
$$;

set local role anon;
do $$
begin
    if public.load_site() is distinct from current_setting('read_test.expected')::jsonb
    then raise exception 'Anon cannot read the full public snapshot'; end if;
end;
$$;
reset role;

set local role authenticated;
do $$
begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
    if private.is_site_admin() then raise exception 'Read test user is an admin'; end if;
    if public.load_site() is distinct from current_setting('read_test.expected')::jsonb
    then raise exception 'Nonadmin cannot read the full public snapshot'; end if;
end;
$$;
reset role;

delete from public.sections;
delete from public.keywords;
delete from public.feed_images;

set local role anon;
do $$
declare
    v_site jsonb := public.load_site();
begin
    if v_site -> 'sections' is distinct from '[]'::jsonb
        or v_site -> 'keywords' is distinct from '[]'::jsonb
        or v_site -> 'feed' is distinct from '[]'::jsonb
        or v_site #>> '{profile,name}' is distinct from 'Read SQL test'
    then raise exception 'Empty lists must return arrays and retain singleton content'; end if;
end;
$$;
reset role;

-- A scalar JSON RPC must aggregate every row, beyond the usual 1,000-row API page.
insert into public.sections (sort_order, title, content)
select position, 'Read section ' || position, 'Raw content ' || position
from generate_series(1, 1005) as entries(position)
order by position desc;
set constraints all immediate;

do $$
begin
    if public.load_site() is distinct from private.site_snapshot()
    then raise exception 'Large public snapshot differs from the save snapshot'; end if;
end;
$$;

set local role anon;
do $$
declare
    v_site jsonb := public.load_site();
begin
    if jsonb_array_length(v_site -> 'sections') is distinct from 1005
        or v_site #>> '{sections,0,title}' is distinct from 'Read section 1'
        or v_site #>> '{sections,1004,title}' is distinct from 'Read section 1005'
        or exists (
            select 1
            from jsonb_array_elements(v_site -> 'sections') with ordinality as entries(value, position)
            left join public.sections s on s.sort_order = position
            where s.id is null
                or value -> 'id' is distinct from to_jsonb(s.id)
                or (value ->> 'sort_order')::integer is distinct from position
                or value ->> 'title' is distinct from ('Read section ' || position)
                or value ->> 'content' is distinct from ('Raw content ' || position)
        )
    then raise exception 'Large public snapshot lost, reordered, or changed section rows'; end if;
    if v_site -> 'keywords' is distinct from '[]'::jsonb
        or v_site -> 'feed' is distinct from '[]'::jsonb
    then raise exception 'Large section reads changed empty sibling lists'; end if;
end;
$$;
reset role;

select 'PASS: load_site metadata/grants/RLS, anon/nonadmin/read-only, snapshot equality, ordered IDs/raw content, empty lists, all 1005 sections' as sql_check;
rollback;
