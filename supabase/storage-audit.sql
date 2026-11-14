-- 프로젝트 소유자 권한으로 실행하는 읽기 전용 후보 보고서다.
-- 24시간 이상 미참조 상태일 가능성이 있는 객체를 검토 대상으로 표시할 뿐이다.
-- 파일의 미참조 시작 시각은 없으므로 생성/수정 후 24시간을 유예 기준으로 사용한다.
-- 진행 중이거나 응답이 불명확한 저장 요청이 없는지 별도로 확인해야 한다.
-- storage.objects를 SQL로 삭제하지 않는다. 확정한 파일 삭제는 Storage API로 한다.
with referenced as (
    select profile_image_path as path from public.profile where profile_image_path is not null
    union
    select image_path from public.feed_images
)
select o.name, o.created_at, o.updated_at, o.metadata ->> 'size' as size_bytes
from storage.objects o
where o.bucket_id = 'site-images'
    and split_part(o.name, '/', 1) in ('profile', 'feed')
    and greatest(o.created_at, o.updated_at) < now() - interval '24 hours'
    and not exists (select 1 from referenced r where r.path = o.name)
order by o.created_at, o.name;
