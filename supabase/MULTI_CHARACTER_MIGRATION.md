# 다중 캐릭터 DB 이전·복원 실행 안내

이 문서는 2단계 준비물이다. **운영 DB에는 아직 적용하지 않는다.** 새 RPC·권한·Storage 정책을 준비하는 3단계와 새 React 저장 기능을 마친 뒤, 검증 환경 리허설을 거쳐 8단계에서 운영 전환한다. `supabase db push`로 이 파일들을 자동 적용하지 않는다.

## 준비 파일

3단계 RPC·RLS·Storage 및 쓰기 재개/차단 절차는 [캐릭터 API 안내](CHARACTER_API.md)에 정리했다. 3단계 migration을 적용해도 쓰기 게이트와 Storage 점검 정책은 닫힌 상태로 유지된다. 운영 전환에서 별도 소유자용 `multi-character-enable-writes.sql`을 실행하기 전까지 열지 않는다.

| 파일 | 역할 |
|---|---|
| `multi-character-preflight.sql` | 읽기 전용 스키마·권한·제약·행 수·시퀀스·이미지 메타데이터 점검 |
| `migrations/*_multi_character_structure.sql` | 기존 프로필을 첫 캐릭터로 이전하고 새 구조 구성 |
| `rollback/multi_character_structure.sql` | 이전 직후 상태가 그대로일 때만 기존 구조·권한 복원 |
| `../tests/multiCharacterMigration.test.mjs` | 로컬 PostgreSQL 호환 환경에서 실행하는 이전·복원 회귀 검사 |

`schema.sql`, `read.sql`, `save.sql`은 기존 단일 프로필의 bootstrap 자료로 유지한다. 다중 캐릭터 구조에 다시 실행하면 구 함수·정책·권한이 복원될 수 있으므로 실행하지 않는다. 특히 기존 `save_site`는 전역 행 삭제를 수행하므로 새 구조와 함께 열어두면 안 된다.

## 실행 환경과 백업

- `postgres` 프로젝트 소유자 권한으로 실행한다. 앱의 publishable key나 서비스 키로 SQL을 실행하는 절차가 아니다.
- 별도 PostgreSQL/Supabase 검증 환경에 현재 DB 백업을 복원해 먼저 연습한다. 운영 프로젝트를 검증 환경으로 사용하지 않는다.
- 접속은 `PGSERVICE`와 개인 `pg_service.conf` 또는 보호된 환경변수를 사용한다. 비밀번호·접속 문자열을 명령 인자, SQL, 로그, Git에 넣지 않는다. 비밀번호 파일은 `PGPASSFILE`로 지정하고 접근 권한을 제한한다.
- 예제는 저장소 루트에서 `psql`을 실행하는 기준이다. `-X`로 개인 시작 설정을 제외하고 `ON_ERROR_STOP=1`로 첫 실패에서 중단한다.
- DB의 스키마·데이터·함수·정책·ACL·시퀀스를 복원 가능한 형태로 백업한다. 플랫폼 자동 백업만 믿지 말고 실제 복원을 확인한다.
- `site-images`의 **파일 원본과 경로 목록은 별도로 백업**한다. DB 백업과 `storage.objects` 메타데이터는 이미지 원본을 포함하지 않는다. 각 파일을 실제로 내려받아 복원할 수 있어야 한다.
- 초기 리허설용 백업 외에, 최종 운영 전환에서는 서버 측 쓰기·정리를 중지하고 진행 중 요청이 끝난 뒤 같은 시점의 DB·파일 백업과 기준값을 다시 확보한다.

보고서·실데이터 덤프·이미지 백업은 Git 바깥의 비공개 장소에 보관한다. 실행 예제의 출력 경로는 실제 비공개 백업 경로로 바꾼다.

```powershell
$env:PGSERVICE = 'profile-migration-rehearsal'
psql -X -v ON_ERROR_STOP=1 -f supabase/multi-character-preflight.sql
```

이 보고서는 이름·상태 메시지·본문을 출력하지 않지만 이미지 경로와 권한 정보를 포함한다. 콘솔 출력을 공개하지 않는다. 실제 함수·ACL·정책을 점검하고 기존 5개 테이블·단일 프로필/테마의 존재, 순서 제약, 고아 경로 여부를 확인한다. 기존 상태가 예상과 다르면 마이그레이션을 수정·검증한 뒤 진행한다.

## 이전 SQL의 동작과 중단 조건

1. 명시적 점검 세션 설정 `app.multi_character_maintenance=on`을 요구한다. 이것은 운영 중지를 확인하는 실행자용 안전장치이며, 설정 자체가 다른 앱 세션의 요청을 차단하지는 않는다.
2. 사전 보고서로 실제 소유자·컬럼·제약·정책·권한을 확인한다. 이전 SQL은 원본 테이블·구 함수·단일 프로필·기존 순서 제약 등의 핵심 전제와 지원하는 ACL 형태를 검사하며, 이미 적용됐거나 전제가 맞지 않으면 중단한다. 반복 실행으로 콘텐츠를 초기값으로 덮어쓰지 않는다.
3. 소유자 전용 `private.multi_character_migration_backup`에 이전 전 데이터 기준과 복원용 메타데이터를 보관한다. 앱 역할이 읽거나 변경할 수 없도록 한다. 이것은 외부 DB·파일 백업을 대체하지 않는다.
4. `characters(id=1, sort_order=1)`과 해당 캐릭터 테마를 생성하고 기존 테마를 메인 테마 초기값으로 복사한다. 자식 행은 재생성하지 않고 `character_id=1`로 연결한다. ID·본문 원문·표시 순서·이미지 경로를 보존한다.
5. 자식 FK·NOT NULL·`ON DELETE CASCADE`, 캐릭터별 `(character_id, sort_order)` 지연 고유 제약을 적용한다. 기존 전역 순서 고유 제약을 교체한다. 캐릭터 ID 시퀀스를 기존 데이터보다 앞으로 맞추며 이미 발급한 값보다 되감지 않는다.
6. 새 테이블은 RLS를 켜고 앱 권한을 열지 않는다. 기존 테이블의 앱 쓰기와 구 조회/저장 RPC·보조 함수 실행 권한을 차단한다. Storage에는 점검용 restrictive 쓰기 차단 정책을 둔다. 3단계 새 API·정책 준비 전까지 기존 앱의 조회·저장은 정상 운영 상태가 아니다.
7. 트랜잭션 안에서 이전 결과를 검증하고 실패하면 DB 변경을 롤백한다. Storage 파일 이동·삭제는 수행하지 않는다.

별도 컬럼 권한(`pg_attribute.attacl`)이나 소유자가 아닌 grantor의 권한 위임 체인이 있으면 지원 범위를 벗어나므로 이전을 거부한다. 이를 무조건 지우지 말고 실제 권한의 목적과 복원 방법을 검토한다. Storage 점검 정책은 `anon`·`authenticated`에 적용되며, RLS를 우회하는 서비스 키·소유자·서버 작업은 별도로 중지해야 한다.

원본 이미지 경로가 `profile/파일명`, `feed/파일명`이어도 그대로 유지한다. 캐릭터별 새 파일 경로와 실제 저장 RPC는 후속 단계의 일이다.

## 검증 환경에서 실행

CLI가 생성한 실제 migration 파일명을 확인해 사용한다. 아래 PowerShell은 해당 이름의 파일이 정확히 하나일 때만 실행한다.

```powershell
$migrationFiles = @(Get-ChildItem -LiteralPath supabase/migrations -Filter '*_multi_character_structure.sql')
if ($migrationFiles.Count -ne 1) { throw '이전 SQL 파일을 하나로 특정해야 합니다.' }
psql -X -v ON_ERROR_STOP=1 -c "SET app.multi_character_maintenance = 'on'" -f $migrationFiles[0].FullName -c "RESET app.multi_character_maintenance"
if ($LASTEXITCODE -ne 0) { throw '이전이 실패했습니다. 오류와 실제 DB 상태를 확인하세요.' }
```

`-c`와 `-f`는 같은 `psql` 세션에서 순서대로 실행한다. 오류로 뒤의 `RESET`까지 실행되지 않아도 프로세스 종료로 해당 세션 설정은 사라진다. 재사용하는 SQL Editor 세션이라면 실패 트랜잭션에 `ROLLBACK`을 실행하고 `RESET app.multi_character_maintenance`를 직접 실행한다. 이를 이유로 이미 실패한 이전 SQL을 무작정 반복 실행하지 않는다.

확인할 결과:

- 첫 캐릭터와 두 테마의 값이 원본과 같다.
- 섹션·키워드·피드의 ID·순서·원문·경로·행 수가 같다.
- 두 캐릭터에 같은 `sort_order=1` 자식을 넣을 수 있고 한 캐릭터 안의 중복 순서는 거부된다.
- 자식의 잘못된 캐릭터 ID와 NULL은 거부되고 캐릭터 삭제 시 해당 자식만 cascade된다. 이 검사는 검증용 트랜잭션에서 실행 후 롤백한다.
- 앱 역할의 구 RPC 실행·테이블 쓰기·Storage 쓰기가 차단된다. 소유자 전용 백업은 앱에서 읽을 수 없다.
- 실제 이미지 파일을 그대로 열 수 있다. DB FK cascade가 Storage 파일을 삭제하지 않았는지도 확인한다.
- 데이터가 그대로인 상태의 복원과 재이전, 새 데이터 변경 후 복원 거부를 모두 확인한다.

로컬 자동 검사는 다음과 같이 실행한다.

```powershell
npm run test:migration
```

검사는 PGlite의 PostgreSQL WASM 엔진을 사용한다. SQL 이전·제약·권한·실패 복구를 검사하지만 **실제 Supabase의 전체 확장·Auth·Storage API, 호스팅 권한, 파일 원본 복원까지 검증하는 것은 아니다.** 실제 백업 복원본의 Supabase 환경에서 같은 절차와 Storage API 검증을 운영 전 별도로 마쳐야 한다.

현재 고정한 PGlite `0.5.16`은 PostgreSQL `18.6` 엔진이고, 확인한 운영 DB는 `17.11`이다. 이번 SQL은 17에서 지원하는 문법을 사용하지만 운영 전 PostgreSQL 17/Supabase 복원본에서 재검증한다. 로컬 단일 연결 검사로 실제 동시 세션의 잠금·요청 경합을 검증했다고 간주하지 않는다.

별도로 내보낸 공개 데이터 스냅샷을 로컬에만 복원하는 선택 검사는 다음과 같다. 파일 형식은 `site`(기존 `load_site` 형식)와 `sequences`(목록별 `last_value`·`is_called`)이며, 파일 내용은 저장소에 넣지 않는다.

```powershell
$env:MIGRATION_SNAPSHOT_PATH = '비공개 백업 경로의 snapshot.json'
try { npm run test:migration } finally { Remove-Item Env:MIGRATION_SNAPSHOT_PATH }
```

## 복원 SQL

단순 복원은 새 구조의 DB 데이터가 이전 직후 기준값과 정확히 같고 아직 후속 스키마 변경이 없는 경우에만 허용한다. 캐릭터가 하나라는 이유로 실행해서는 안 된다. 첫 캐릭터 수정·삭제, 자식 변경, 메인 테마 변경, 추가 캐릭터 생성이 있으면 중단해야 한다.

```powershell
psql -X -v ON_ERROR_STOP=1 -c "SET app.multi_character_maintenance = 'on'" -f supabase/rollback/multi_character_structure.sql -c "RESET app.multi_character_maintenance"
if ($LASTEXITCODE -ne 0) { throw '자동 복원이 거부되거나 실패했습니다. 강제 삭제하지 말고 확인하세요.' }
```

쓰기·업로드·정리를 중지하고 진행 중 요청이 끝난 상태에서만 실행한다. 복원은 기존 데이터와 운영 메타데이터를 확인하고 새 FK·컬럼·테이블을 제거한 뒤 원래 제약·ACL·정책으로 되돌린다. 이후 기존 프런트를 복원하고 조회·저장·파일 접근을 검증한다. 후속 단계가 추가한 함수·정책 등이 있다면 이 복원 SQL을 그대로 사용하지 않는다.

복원이 거부되면 `DROP ... CASCADE`, 테이블 비우기, 기준값 갱신으로 우회하지 않는다. 신규 데이터를 포함한 DB·파일 백업을 추가 확보하고 전진 수정 또는 모든 캐릭터를 보존하는 명시적 역이전을 준비한다. 백업 시점 복원은 그 이후 변경분을 보존·재반영할 계획을 세운 뒤 수행한다.

## 운영 전환 순서

1. 3단계 이후 SQL·새 프런트·PR·백업 복원 리허설을 모두 준비한다.
2. 서버 쓰기·정리를 중지하고 진행 중 저장·업로드 요청을 확인한다. 최종 DB·파일 백업과 기준값을 확보한다.
3. 이전 SQL과 준비된 후속 API·정책을 적용한다. 구 RPC는 다시 열지 않는다.
4. 요청된 PR 병합으로 새 프런트를 배포하고 메인·첫 캐릭터·로그인·편집·이미지 조회를 검증한다.
5. 새 쓰기를 통제하에 열고 생성·수정·삭제·순서·테마·정리 재시도를 검증한 뒤 운영을 재개한다. 점검용 restrictive Storage 정책 해제는 검증된 새 정책으로 보호된 상태에서 수행한다.
6. 안정화 전에는 구 테이블·함수·이미지·백업을 정리하지 않는다. 구 편집 탭은 새로고침하도록 안내한다.

참고: [Supabase 백업](https://supabase.com/docs/guides/platform/backups), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control), [PostgreSQL 제약](https://www.postgresql.org/docs/current/ddl-constraints.html).

## 2단계 검증 기록

2026-11-16 기준 운영 스키마·제약·권한·행 수를 읽기 전용으로 확인했다. 명시적 컬럼 ACL은 없고, 프로필·피드 참조 중 Storage 메타데이터가 없는 경로는 없었다. 실제 공개 데이터 사본(섹션 5개·키워드 9개·피드 13개)을 Git 바깥에 내보내 로컬 메모리 DB에만 복원했으며 이전·복원 후 원문·ID·순서·경로·시퀀스가 일치했다. 해당 선택 검사를 포함해 SQL 검사 12개, 기존 단위/서비스 129개와 빌드·린트를 통과했다. 운영 DB·Storage에는 변경을 적용하지 않았으며 파일 원본·호스팅 환경 복원은 이후 리허설 범위다. 이 행 수는 점검 당시 기록이므로 실제 운영 전환 시 다시 확보한다.
