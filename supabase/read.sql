-- schema.sql 실행 후 프로젝트 소유자 권한으로 실행한다.
-- 다섯 테이블을 하나의 SQL 문장으로 읽어 같은 시점의 공개 콘텐츠를 반환한다.
-- SECURITY INVOKER이므로 기존 테이블 SELECT 권한과 RLS를 그대로 따른다.
-- 저장 직후의 새 스냅샷이 필요한 private.site_snapshot()은 VOLATILE로 유지한다.
-- 참고 https://www.postgresql.org/docs/current/xfunc-volatility.html

begin;

create or replace function public.load_site()
returns jsonb
language sql
stable
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

revoke all on function public.load_site() from public, anon, authenticated, service_role;
grant execute on function public.load_site() to anon, authenticated;

commit;
