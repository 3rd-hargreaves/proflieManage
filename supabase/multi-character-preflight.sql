-- 프로젝트 소유자가 실행하는 읽기 전용 사전 점검이다.
-- 이름·상태 메시지·본문 원문은 출력하지 않는다. 결과에도 경로·권한 정보가
-- 포함되므로 백업과 함께 비공개 보관하고 Git에 커밋하지 않는다.
-- 이 보고서는 쓰기/정리 중지 후 다시 실행해 최종 백업 기준과 대조한다.

begin read only;

select current_database() as database_name, current_user as execution_role,
    current_setting('server_version') as postgres_version,
    current_setting('transaction_read_only') as read_only;

-- 기존 5개 테이블과 새 구조의 존재 여부. 이미 새 구조가 있으면 재적용하지 않는다.
select name, to_regclass(name) is not null as relation_exists
from unnest(array[
    'public.profile', 'public.theme', 'public.sections', 'public.keywords', 'public.feed_images',
    'public.characters', 'public.character_themes', 'public.main_theme',
    'private.multi_character_migration_backup'
]) as objects(name);

select c.relname as table_name, pg_get_userbyid(c.relowner) as owner,
    c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced, c.relacl
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (
    'profile', 'theme', 'sections', 'keywords', 'feed_images',
    'characters', 'character_themes', 'main_theme'
)
order by c.relname;

select table_name, ordinal_position, column_name, data_type, is_nullable,
    column_default, is_identity, identity_generation
from information_schema.columns
where table_schema = 'public' and table_name in (
    'profile', 'theme', 'sections', 'keywords', 'feed_images'
)
order by table_name, ordinal_position;

select c.relname as table_name, con.conname, con.contype,
    con.condeferrable, con.condeferred, con.convalidated,
    pg_get_constraintdef(con.oid, true) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (
    'profile', 'theme', 'sections', 'keywords', 'feed_images'
)
order by c.relname, con.conname;

select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in (
    'profile', 'theme', 'sections', 'keywords', 'feed_images'
)
order by tablename, indexname;

select n.nspname as schema_name, p.proname,
    pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_userbyid(p.proowner) as owner, p.provolatile,
    p.prosecdef as security_definer, p.proconfig, p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in ('load_site', 'save_site'))
    or (n.nspname = 'private' and p.proname in ('site_snapshot', 'site_content', 'is_site_admin'))
order by n.nspname, p.proname;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename in (
    'profile', 'theme', 'sections', 'keywords', 'feed_images'
)) or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;

select table_schema, table_name, grantee, privilege_type, is_grantable
from information_schema.table_privileges
where table_schema = 'public' and table_name in (
    'profile', 'theme', 'sections', 'keywords', 'feed_images'
)
order by table_name, grantee, privilege_type;

-- Explicit column grants survive table-level REVOKE; stage 2 refuses them for review.
select a.attrelid::regclass as table_name, a.attname as column_name, a.attacl as column_acl
from pg_attribute a
where a.attrelid in ('public.profile'::regclass, 'public.theme'::regclass,
    'public.sections'::regclass, 'public.keywords'::regclass, 'public.feed_images'::regclass)
    and a.attnum > 0 and not a.attisdropped and a.attacl is not null
order by a.attrelid, a.attnum;

-- 실제 identity 시퀀스를 조회한다. 번호를 발급하거나 시퀀스를 되감지 않는다.
select tables.table_name,
    pg_get_serial_sequence('public.' || tables.table_name, 'id') as identity_sequence,
    s.sequenceowner, s.start_value, s.min_value, s.max_value, s.increment_by,
    s.cycle, s.cache_size, s.last_value
from unnest(array['sections', 'keywords', 'feed_images']) as tables(table_name)
left join pg_sequences s on format('%I.%I', s.schemaname, s.sequencename)
    = pg_get_serial_sequence('public.' || tables.table_name, 'id')
order by tables.table_name;

select 'profile' as table_name, count(*) as row_count, min(id) as min_id, max(id) as max_id from public.profile
union all select 'theme', count(*), min(id), max(id) from public.theme
union all select 'sections', count(*), min(id), max(id) from public.sections
union all select 'keywords', count(*), min(id), max(id) from public.keywords
union all select 'feed_images', count(*), min(id), max(id) from public.feed_images;

select
    (select count(*) = 1 and count(*) filter (where id = 1) = 1 from public.profile) as single_profile_ready,
    (select count(*) = 1 and count(*) filter (where id = 1) = 1 from public.theme) as single_theme_ready,
    (select count(*) from public.profile where name !~ '[^[:space:]]' or status_message !~ '[^[:space:]]') as blank_profile_count,
    (select count(*) from public.sections where title !~ '[^[:space:]]' or content !~ '[^[:space:]]') as blank_section_count,
    (select count(*) from public.keywords where content !~ '[^[:space:]]') as blank_keyword_count,
    (select count(*) from public.profile where profile_image_path is not null and profile_image_path !~ '^profile/.+') as invalid_profile_path_count,
    (select count(*) from public.feed_images where image_path !~ '^feed/.+') as invalid_feed_path_count;

select 'sections' as table_name, min(sort_order) as first_order, max(sort_order) as last_order,
    count(*) - count(distinct sort_order) as duplicate_order_count,
    count(*) filter (where sort_order < 1) as invalid_order_count
from public.sections
union all select 'keywords', min(sort_order), max(sort_order), count(*) - count(distinct sort_order), count(*) filter (where sort_order < 1) from public.keywords
union all select 'feed_images', min(sort_order), max(sort_order), count(*) - count(distinct sort_order), count(*) filter (where sort_order < 1) from public.feed_images;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'site-images';

-- 참조는 있지만 Storage 메타데이터가 없는 경로만 보고한다. 원본 파일 검증은 별도로 한다.
with referenced as (
    select profile_image_path as path from public.profile where profile_image_path is not null
    union
    select image_path from public.feed_images
)
select r.path as missing_storage_metadata_path
from referenced r
where not exists (
    select 1 from storage.objects o where o.bucket_id = 'site-images' and o.name = r.path
)
order by r.path;

select count(*) as storage_metadata_count,
    coalesce(sum(case when (metadata ->> 'size') ~ '^[0-9]+$'
        then (metadata ->> 'size')::numeric else 0 end), 0) as reported_total_bytes
from storage.objects where bucket_id = 'site-images';

commit;
