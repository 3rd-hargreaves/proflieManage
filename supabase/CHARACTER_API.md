# 캐릭터 API·권한·Storage 준비

3단계 로컬 준비 결과다. 운영 DB에는 적용하지 않았으며 프런트 서비스 연결은 후속 단계에서 진행한다. 백업 절차는 [이전 안내](MULTI_CHARACTER_MIGRATION.md)를 따른다.

## 적용 순서와 쓰기 차단

2단계 구조 이전 다음에 CLI가 생성한 `multi_character_api_support`, `multi_character_rpc`, `multi_character_permissions` migration을 파일명 순서대로 실행한다. 프로젝트 소유자의 점검 세션(`SET app.multi_character_maintenance = 'on'`)에서 첫 오류에 중단한다. 각 파일은 개별 트랜잭션이다. 자동 운영 적용이나 `db push`를 실행하지 않는다.

새 조회 API는 읽을 수 있지만 `private.character_api_control.writes_enabled`는 기본 `false`이고 2단계 Storage 점검 정책도 남는다. 새 프런트·API·실제 Storage 검증을 마친 운영 전환 시에만 소유자가 별도 파일로 쓰기를 연다.

```powershell
# 보호된 PGSERVICE/PGPASSFILE 환경에서, 저장소 루트 기준
psql -X -v ON_ERROR_STOP=1 -c "SET app.multi_character_maintenance = 'on'" -f supabase/multi-character-enable-writes.sql -c "RESET app.multi_character_maintenance"
```

재차단은 같은 방식으로 `multi-character-disable-writes.sql`을 실행한다. 일반 쓰기는 공통 advisory shared lock을 트랜잭션 종료까지 유지하고, 열기·닫기는 exclusive lock을 사용한다. 닫기 SQL은 이 규칙을 지키는 DB 쓰기가 끝날 때까지 기다린다. 외부 요청 유입 중지, Storage 메타데이터 트랜잭션 전의 업로드, 서비스 키·소유자 작업 중지는 별도로 확인한다. 실패하면 `ROLLBACK` 후 원인을 확인하고 쓰기를 열지 않는다.

3단계가 일부라도 적용되면 2단계 자동 복원 SQL은 스키마 변경을 감지해 거부한다. 부분 실패는 쓰기를 닫은 채 검증된 전진 수정 또는 외부 백업 복원으로 처리한다. 기준 기록 갱신이나 `DROP ... CASCADE`로 우회하지 않는다.

## 공개 RPC 계약

| 함수 | 입력 | 결과 |
|---|---|---|
| `load_main()` | 없음 | `{characters: 카드 배열, theme: 메인 테마 행}` |
| `load_character(p_character_id bigint)` | 대상 ID | 캐릭터 스냅샷 또는 `null` |
| `reserve_character_id(p_request_id uuid)` | 작성 중 고정 UUID | 예약 ID. 공개 캐릭터 행은 생성하지 않음 |
| `create_character(p_character_id bigint, p_request_id uuid, p_data jsonb)` | 예약 ID·UUID·신규 내용 | `{character: 스냅샷, cleanup_candidates: []}` |
| `save_character(p_character_id bigint, p_expected jsonb, p_data jsonb)` | 대상·기준 스냅샷·수정 내용 | `{character: 최신 스냅샷, cleanup_candidates: 경로 배열}` |
| `delete_character(p_character_id bigint, p_expected jsonb)` | 대상·기준 스냅샷 | `{character_id, cleanup_candidates: 경로 배열}` |
| `save_character_order(p_expected jsonb, p_order jsonb)` | 기준 ID 배열·새 ID 배열 | 저장된 ID 배열 |
| `save_main_theme(p_expected jsonb, p_data jsonb)` | 기존 메인 테마 행·새 색상 객체 | 최신 메인 테마 행 |
| `load_image_references()` | 없음 | 모든 현재 캐릭터 프로필·피드 경로 합집합 배열 |

앞의 두 조회만 방문자와 로그인 사용자에게 공개한다. 나머지는 지정 관리자만 사용한다. 모든 함수는 `SECURITY INVOKER`, 빈 `search_path`와 명시적 스키마를 사용한다. 공개 조회는 단일 SQL 문장의 `STABLE` 스냅샷이며 저장용 내부 스냅샷은 `VOLATILE`로 잠금 대기·쓰기 후 새 값을 읽는다.

스냅샷은 기존 `SiteData` 형식이다. `profile`은 `id/name/status_message/profile_image_path`, `theme`은 캐릭터 ID를 담은 `id`와 네 색상, `sections/keywords/feed`는 해당 캐릭터의 ID·순서·본문/경로 배열이다. 메인 카드 순서는 캐릭터 내용 스냅샷에 넣지 않는다.

`p_data`는 `profile`·`theme`의 `id`, 자식의 `sort_order`를 제외하고 같은 필드를 사용한다. 새 자식은 `id: null`, 기존 자식은 기존 ID를 전송한다. 테마 필드는 `main_color/background_color/card_background_color/typo_color`다. 필드 집합·타입·공란·색상을 검사하고 본문의 공백을 서버에서 임의 수정하지 않는다. 외부 캐릭터의 자식이나 없는 ID를 보내면 전체 저장을 거부한다. 순서는 배열 위치로 1부터 저장한다. 신규 피드는 최대 50장, 기존 초과 목록은 현재 수 이하로 유지·감축·교체할 수 있다.

## 저장·재시도·충돌

- 캐릭터 내용 CAS는 메인 순서·메인 테마와 독립적이다. 내용은 대상별 잠금, 추가·삭제·순서 변경은 공통 목록 잠금, 메인 테마는 별도 잠금을 사용한다. 자식 조회·수정·삭제는 대상 `character_id`로 한정한다.
- 순서는 숫자 ID 배열이다. 중복·잘못된 ID·멤버 누락을 거부하고, 다른 창에서 추가·삭제된 캐릭터를 오래된 배열로 덮어쓰지 않는다. 동일 결과 재전송은 성공한다.
- 예약은 작성 UUID에 고정된다. 업로드 후 캐릭터·테마·자식·마지막 순서·생성 결과 기록을 함께 커밋한다. 같은 UUID·본문 재시도는 같은 결과를 반환하고 다른 본문은 `creation_request_conflict`로 거부한다. 생성 결과를 받은 뒤 새로 조회해 최신 기준으로 편집한다. 삭제된 캐릭터를 과거 생성 요청으로 되살리지 않는다.
- 같은 내용의 저장 재시도는 자식 ID를 재발급하지 않는다. 응답 유실 시 기준 스냅샷의 경로에서 현재 전역 참조를 빼 정리 후보를 다시 얻는다. 삭제는 별도 결과 기록으로 재시도 시 후보를 보존한다.
- SQLSTATE `42501`은 관리자 권한·쓰기 차단, `22023`은 잘못된 입력이다. `character_conflict`, `character_order_conflict`, `main_theme_conflict`, `creation_request_conflict`에서는 초안·File을 보존하고 새 기준값을 확인한다. 없는 캐릭터는 `character_not_found`이며 수정 요청을 자동 생성으로 바꾸지 않는다.

내부 `character_creation_requests`·`character_deletion_receipts`는 공개 콘텐츠가 아닌 재시도 기록이다. 관리자 RLS와 최소 권한으로 보호하며 클라이언트에서 초기화하거나 운영 전환 직후 삭제하지 않는다. `character_api_control` 변경 권한은 앱에 주지 않는다.

## 권한 경계

여섯 공개 테이블의 RLS가 공개 조회와 지정 관리자 쓰기를 구분한다. 구 `load_site`·`save_site`와 보조 함수는 계속 폐쇄하고, 보존한 `profile`·`theme`은 소유자 전용 기록으로 둔다. 조회·쓰기 정책을 분리해 동일 SELECT 정책을 중복 생성하지 않는다.

Invoker RPC 실행에 필요한 테이블 DML·시퀀스 권한은 `authenticated`에 있으나 RLS가 지정 관리자와 쓰기 게이트를 검사한다. 다른 로그인 계정은 공개 데이터만 읽는다. 관리자 자신의 직접 Data API/SQL DML은 RPC의 CAS·이미지 잠금·입력 검사를 우회할 수 있으므로 **앱의 모든 쓰기는 RPC로 연결한다.** 직접 관리 작업은 요청 중지·점검 절차에서 수행한다. 앱에 서비스 키나 DB 소유자 자격 정보를 넣지 않는다.

## 이미지 정책과 정리

- 새 업로드는 `profile/{character_id}/{파일명}`, `feed/{character_id}/{파일명}`만 허용한다. 현재 캐릭터 또는 아직 생성되지 않은 유효 예약 ID를 사용한다. 클라이언트는 매번 고유 파일명을 만든다.
- 기존 평면 경로는 유지하고 새 평면 업로드를 막는다. 새 이미지 연결은 해당 캐릭터 namespace와 Storage 메타데이터 존재를 확인한다. 같은 캐릭터의 기존 경로는 그대로 보존할 수 있다.
- 기존 경로 덮어쓰기·이름 변경·upsert는 금지한다. 새 파일 업로드 → DB 저장 → 미사용 옛 파일 정리 순서다. 파일당 10MiB·JPEG/PNG 버킷 설정과 원본 유지 방침을 유지한다.
- `authenticated`용 restrictive INSERT/DELETE/UPDATE 정책으로 다른 permissive 정책의 OR가 경로 제한·참조 보호·덮어쓰기 금지를 풀지 못하게 한다. 익명 쓰기 정책은 제공하지 않는다. 서비스 키·소유자는 RLS 우회 권한이 있으므로 앱에 사용하지 않는다.
- 삭제 전 **모든 현재 캐릭터**의 프로필·피드 참조를 검사한다. 보존용 `profile`은 현재 참조가 아니다. DB 참조 변경 RPC는 이미지 shared lock, Storage 삭제는 같은 exclusive lock을 사용한다. 삭제가 먼저 끝났다면 새 참조 저장의 파일 존재 검사가 실패한다.
- `cleanup_candidates`는 삭제 완료가 아닌 후보다. 클라이언트는 전역 참조 재확인·Storage API 삭제·실패 기록을 별도 처리한다. 불명확한 저장 결과의 업로드는 삭제하지 않는다. 기존 정리 기록도 전역 참조로 재검증한다.
- `storage-audit.sql`은 전체 캐릭터 기준의 읽기 전용 후보 보고서다. 진행 중 업로드·불명확한 요청 여부를 확인하고 Storage API로만 실제 파일을 삭제한다. SQL로 `storage.objects`를 삭제하는 운영 절차는 만들지 않는다.

## 로컬 검증과 남은 리허설

```powershell
npm run test:rpc
npm run test:migration
```

PGlite는 PostgreSQL 18.6 단일 메모리 연결로 함수·트랜잭션·SQL 권한/RLS를 실행한다. 운영 PostgreSQL 17.11의 다중 세션에서 목록 생성/정렬, 이미지 참조 저장/삭제, 쓰기 게이트 대기를 별도 검증한다. 실제 Auth 토큰·Storage HTTP API·바이너리 크기/MIME 검사·업로드 복원은 호스팅 리허설 범위다. 이번 단계는 운영 접속이나 적용 없이 로컬 검증만 수행한다.
