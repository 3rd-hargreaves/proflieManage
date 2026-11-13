-- Supabase SQL Editor에서 프로젝트 소유자 권한으로 실행한다.
-- is_site_admin에는 현재 프로젝트 관리자 Auth 계정의 UUID를 지정했다.
-- 다른 프로젝트에서 실행할 때에는 해당 프로젝트 관리자의 UUID로 변경한다.
-- 동일한 스키마에 재실행해도 기존 콘텐츠를 초기값으로 덮어쓰지 않는다.
-- 참고 문서 https://supabase.com/docs/guides/database/postgres/row-level-security

begin;

-- 테마와 프로필은 id = 1인 행을 사용한다.
create table if not exists public.theme (
    id bigint primary key default 1 check (id = 1),
    main_color text not null default '#E45C9A'
        check (main_color ~ '^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$'),
    background_color text not null default '#FDE8F0'
        check (background_color ~ '^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$'),
    card_background_color text not null default '#FFFFFF'
        check (card_background_color ~ '^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$'),
    typo_color text not null default '#26232A'
        check (typo_color ~ '^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$')
);

create table if not exists public.profile (
    id bigint primary key default 1 check (id = 1),
    name text not null check (name ~ '[^[:space:]]'),
    status_message text not null check (status_message ~ '[^[:space:]]'),
    -- 사진을 등록하기 전에는 null, 등록 후에는 Storage 내부 경로를 저장한다.
    profile_image_path text check (profile_image_path ~ '^profile/.+')
);

-- 표시 순서는 1부터 시작하며, 순서 변경은 같은 DB 트랜잭션 안에서 저장한다.
-- 순서의 중복은 트랜잭션 종료 시 검사하므로 저장 중 순서를 맞바꿀 수 있다.
create table if not exists public.sections (
    id bigint generated always as identity primary key,
    sort_order integer not null check (sort_order >= 1),
    title text not null check (title ~ '[^[:space:]]'),
    content text not null check (content ~ '[^[:space:]]'),
    constraint sections_sort_order_key unique (sort_order) deferrable initially deferred
);

create table if not exists public.keywords (
    id bigint generated always as identity primary key,
    sort_order integer not null check (sort_order >= 1),
    content text not null check (content ~ '[^[:space:]]'),
    constraint keywords_sort_order_key unique (sort_order) deferrable initially deferred
);

create table if not exists public.feed_images (
    id bigint generated always as identity primary key,
    image_path text not null check (image_path ~ '^feed/.+'),
    sort_order integer not null check (sort_order >= 1),
    constraint feed_images_sort_order_key unique (sort_order) deferrable initially deferred
);

-- 현재 퍼블리싱의 초기 색상과 프로필 문구를 사용한다.
-- 프로필 이미지는 업로드 전까지 null로 둔다.
insert into public.theme (id) values (1) on conflict (id) do nothing;
insert into public.profile (id, name, status_message, profile_image_path)
values (1, '이름', '상태 메시지', null)
on conflict (id) do nothing;

-- 관리자 판별 함수는 Data API에 노출하지 않는 스키마에 둔다.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_site_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select coalesce(
        (select auth.uid()) = 'f711da08-9c0b-42ee-a20c-a4f83ad46473'::uuid,
        false
    );
$$;

revoke all on function private.is_site_admin() from public, anon, authenticated;
grant execute on function private.is_site_admin() to authenticated;

-- SQL로 만든 테이블에는 RLS와 API 권한을 명시적으로 적용한다.
alter table public.theme enable row level security;
alter table public.profile enable row level security;
alter table public.sections enable row level security;
alter table public.keywords enable row level security;
alter table public.feed_images enable row level security;

grant usage on schema public to anon, authenticated, service_role;
revoke all on table public.theme, public.profile, public.sections,
    public.keywords, public.feed_images from public, anon, authenticated;
grant select on table public.theme, public.profile, public.sections,
    public.keywords, public.feed_images to anon, authenticated;
grant insert, update on table public.theme, public.profile to authenticated;
grant insert, update, delete on table public.sections, public.keywords,
    public.feed_images to authenticated;
grant all on table public.theme, public.profile, public.sections,
    public.keywords, public.feed_images to service_role;

revoke all on sequence public.sections_id_seq, public.keywords_id_seq,
    public.feed_images_id_seq from public, anon, authenticated;
grant usage, select on sequence public.sections_id_seq, public.keywords_id_seq,
    public.feed_images_id_seq to authenticated, service_role;

-- 방문자와 로그인 사용자는 공개 콘텐츠를 조회할 수 있다.
drop policy if exists theme_public_read on public.theme;
create policy theme_public_read on public.theme
    for select to anon, authenticated using (true);
drop policy if exists profile_public_read on public.profile;
create policy profile_public_read on public.profile
    for select to anon, authenticated using (true);
drop policy if exists sections_public_read on public.sections;
create policy sections_public_read on public.sections
    for select to anon, authenticated using (true);
drop policy if exists keywords_public_read on public.keywords;
create policy keywords_public_read on public.keywords
    for select to anon, authenticated using (true);
drop policy if exists feed_images_public_read on public.feed_images;
create policy feed_images_public_read on public.feed_images
    for select to anon, authenticated using (true);

-- 쓰기는 지정한 관리자 UUID에만 허용한다.
-- 테마와 프로필은 등록·수정, 목록 항목은 등록·수정·삭제를 허용한다.
drop policy if exists theme_admin_write on public.theme;
drop policy if exists theme_admin_insert on public.theme;
create policy theme_admin_insert on public.theme
    for insert to authenticated
    with check ((select private.is_site_admin()));
drop policy if exists theme_admin_update on public.theme;
create policy theme_admin_update on public.theme
    for update to authenticated
    using ((select private.is_site_admin()))
    with check ((select private.is_site_admin()));

drop policy if exists profile_admin_write on public.profile;
drop policy if exists profile_admin_insert on public.profile;
create policy profile_admin_insert on public.profile
    for insert to authenticated
    with check ((select private.is_site_admin()));
drop policy if exists profile_admin_update on public.profile;
create policy profile_admin_update on public.profile
    for update to authenticated
    using ((select private.is_site_admin()))
    with check ((select private.is_site_admin()));

drop policy if exists sections_admin_write on public.sections;
drop policy if exists sections_admin_insert on public.sections;
create policy sections_admin_insert on public.sections
    for insert to authenticated
    with check ((select private.is_site_admin()));
drop policy if exists sections_admin_update on public.sections;
create policy sections_admin_update on public.sections
    for update to authenticated
    using ((select private.is_site_admin()))
    with check ((select private.is_site_admin()));
drop policy if exists sections_admin_delete on public.sections;
create policy sections_admin_delete on public.sections
    for delete to authenticated
    using ((select private.is_site_admin()));

drop policy if exists keywords_admin_write on public.keywords;
drop policy if exists keywords_admin_insert on public.keywords;
create policy keywords_admin_insert on public.keywords
    for insert to authenticated
    with check ((select private.is_site_admin()));
drop policy if exists keywords_admin_update on public.keywords;
create policy keywords_admin_update on public.keywords
    for update to authenticated
    using ((select private.is_site_admin()))
    with check ((select private.is_site_admin()));
drop policy if exists keywords_admin_delete on public.keywords;
create policy keywords_admin_delete on public.keywords
    for delete to authenticated
    using ((select private.is_site_admin()));

drop policy if exists feed_images_admin_write on public.feed_images;
drop policy if exists feed_images_admin_insert on public.feed_images;
create policy feed_images_admin_insert on public.feed_images
    for insert to authenticated
    with check ((select private.is_site_admin()));
drop policy if exists feed_images_admin_update on public.feed_images;
create policy feed_images_admin_update on public.feed_images
    for update to authenticated
    using ((select private.is_site_admin()))
    with check ((select private.is_site_admin()));
drop policy if exists feed_images_admin_delete on public.feed_images;
create policy feed_images_admin_delete on public.feed_images
    for delete to authenticated
    using ((select private.is_site_admin()));

-- 프로젝트 생성 시 자동 RLS를 켜면 생성되는 이벤트 트리거 함수의
-- API 직접 실행 권한을 정리한다. 테이블 생성 이벤트에서는 계속 사용한다.
do $$
begin
    if to_regprocedure('public.rls_auto_enable()') is not null then
        revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
    end if;
end;
$$;

-- 공개 화면의 프로필·피드 이미지는 같은 버킷의 경로로 구분한다.
insert into storage.buckets (id, name, public)
values ('site-images', 'site-images', true)
on conflict (id) do nothing;

commit;
