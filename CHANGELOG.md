# 변경 이력

## 2.1.0-beta.5 — integration candidate (2026-10-17)

- Integrates Windows-specific beta.2 browser, UIA, screenshot transport, desktop recovery, watchdog, routing and worker improvements with beta.4, without discarding existing host work.
- Integrates latest NAS Coordinator/browser lease, persistence, context recovery, timeouts and cross-host skills changes; includes four current skill/job packs.
- Fixes HTTP session idle test portability for Windows filesystem paths and child-process exit race.
- Defines single source repository, platform-isolated runtimes, independent deployment and shared release gates.
- Candidate until regression suites, host-specific E2E and both live deployments are independently verified.
- README 전체를 beta.5 소스에 맞춰 갱신: 239개 도구 인벤토리, 호스트별 운영 상태, 테스트 증거, Windows/NAS 기능과 릴리스 안전 절차. NAS live 배포는 별도 검증 대상으로 남긴다.


## 2.1.0-beta.4 (2026-10-09)
- Coordinator가 device task 대상 별칭 `windows`를 실제 등록된 `windows-worker`로 정규화한다. 제출 전에 subject-bound 권한 검사를 적용하여 권한 경계는 유지한다.
- 기존 `windows` 대상으로 대기 중인 task는 Coordinator 재시작 시 ID, idempotency key, attempts를 보존한 채 동일 작업을 재배정한다. running/terminal task는 수정하지 않는다.
- 기존 오프라인 장치 대기 기능 및 태스크 중복 방지에 대한 회귀 테스트를 추가했다.
- MCP idle session cleanup (beta.3)과 transport telemetry (beta.2)는 계속 유지된다.

## 2.1.0-beta.3 (2026-10-09)
- MCP Streamable HTTP 세션이 DELETE 없이 사라지는 클라이언트에서도, 마지막 요청이 끝난 후 기본 30분이 지나면 유휴 transport를 정리한다.
- 진행 중인 tool 응답과 열린 SSE GET stream은 유휴 정리에서 제외하고, 정리 시 기존 onclose 리소스 해제 및 transport telemetry 이벤트를 유지한다.
- 만료 세션은 MCP 표준 404(-32001)로 재초기화를 유도하고, 세션 ID가 없는 요청은 기존대로 400으로 거부해 격리를 보존한다.
- 유휴 세션 정리·활성 스트림 보호·정리 실패 후 재시도·만료 후 새 initialize 회귀 테스트를 test:session에 추가했다.
- 참고: 이 패치는 NAS 측 유휴 세션 누적을 방지하며 ChatGPT 외부 네트워크/클라이언트 오류까지 제거한다고 보장하지 않는다.

## 2.1.0-beta.2 (2026-10-06)
- MCP HTTP transport telemetry를 추가해 connection open/close, request start/finish/abort, response early-close, handler error, MCP handle/session lifecycle을 correlation id와 timestamp로 기록한다.
- Telemetry는 prompt/body/header/raw URL/capability token/session id 원문을 기록하지 않고, remote address와 session id는 per-runtime HMAC hash만 남긴다. 로그는 bounded JSONL(+1 backup)로 회전한다.
- `transport_telemetry_status`와 `diagnostics_snapshot.transport`에서 마지막 ingress/MCP request 시각과 최근 transport event를 read-only로 조회할 수 있다.
- 실제 HTTP client abort/EOF-like close, handler failure, normal request, secret/body redaction 회귀 테스트를 추가했다.

## 2.1.0-beta.1 (2026-10-05)
- `diagnostics_snapshot`으로 Connector/coordinator/git/runtime/task/worker 진단을 병렬 집계해 여러 MCP 왕복을 한 번으로 축소.
- `coordinator_submit`에 최대 15초 bounded wait를 추가하고 빠른 device 작업은 기본 6초 동안 terminal 결과를 기다려 submit→status 왕복을 줄임. idempotency key 기반 lost-ACK 복구를 유지.
- 독립 health-monitor가 `chatgpt-connector`의 Created/Exited/Dead 상태를 다음 monitor tick에서 즉시 start하고, running 상태의 연속 health 실패는 기존 threshold/cooldown 후 restart하도록 강화.
- 신규 performance/recovery regression으로 bounded wait, lost-ACK, 즉시 stopped-container recovery, diagnostics aggregation을 검증.
- UI watchdog은 정확히 연결된 Retry를 composer 초안과 독립적으로 InvokePattern으로 한 번 실행하고, continuation text 주입 단계에서만 빈 composer를 요구하도록 분리해 `Message delivery timed out` 자동 복구를 강화.
- ChatGPT renderer/UIA 객체가 poll 도중 stale해지는 경우 fresh UI snapshot으로 한 번만 재평가하고, persistent episode latch로 Retry/Send 중복 dispatch를 계속 차단.
- UI watchdog `run`에 process-level named mutex를 추가하고 PID 파일은 소유 프로세스만 제거하도록 해 launcher 재시작 뒤 고아/중복 watchdog이 남는 문제를 방지.
- UI watchdog Scheduled Task를 `wscript` wrapper 대신 hidden `powershell.exe` 직접 실행으로 전환하고, 로그/observation 기록 오류를 best-effort 처리해 진단 파일 잠금이 watchdog process를 종료시키지 않도록 강화.
- UI watchdog이 foreground ChatGPT 데스크톱 앱뿐 아니라 제목에 `ChatGPT`가 명확히 포함된 foreground Edge/Chrome 계열 창에서도 `Connection interrupted. Waiting for the complete answer`와 기존 delivery timeout recovery surface를 안전하게 처리하도록 확장.
- 동일 제목의 duplicate persistent goal만 남은 경우 `goal`/`work_resume`이 완료 step 수, 생성시각 순으로 진행 중 goal을 자동 선택해 interruption 이후 resume이 `multiple active goals`에서 막히지 않도록 보강.
- `runAt` device task가 due 전에는 숨겨지고, due 후 online device에 전달되며, offline device는 `waiting_for_device`에서 재접속 후 poll/claim으로 자동 이어지는 회귀 테스트를 추가.
- Windows beta 환경에서 `sites-test`의 임시 HTTP child가 운영 `WEBJJONKU_RUNTIME_PROFILE=windows`를 상속해 test port 대신 8748을 사용하던 격리 문제를 수정.
- Persistent Goal을 ChatGPT 예약 실행으로 이어갈 때 one-shot 결과 보고로 chain이 끊기지 않도록 recurring continuation을 유지하고, 모든 done criteria가 검증된 뒤에만 예약을 종료하는 운영 규칙을 명시.

## 2.0.1 (2026-10-05)
- Windows recovery E2E probe를 ephemeral retention으로 분류하고 legacy probe 누적을 정리해 coordinator state가 무한히 커지는 문제를 방지.
- terminal task/idempotency 메타데이터 pruning을 보강하고 durable keyed task는 보존하도록 retention 정책을 명시.
- production runtime 환경변수가 smoke/session regression 자식 프로세스에 누출되지 않도록 테스트 격리를 강화하고 HTTP session startup을 고부하 NAS에서도 안정적으로 검증.

## 2.0.0 (2026-09-25)
- MCP 도구 217개로 확장: local DOM browser, Windows UIA/computer use, Work facade, Task/Project/Artifact, cloud browser, schedule/webhook, Office live editing 등.
- 일반 Chat과 Work에서 동일한 ChatGPT Connector MCP를 사용할 수 있는 최종 연결 검증.
- Playwright local browser E2E(open/type/click/read) 검증.
- 보안 self-review 19/19, smoke 40/40, state concurrency, Work approval policy, scheduler resilience 통과.
- Windows용 `start-chatgpt-connector.ps1` 및 자동 시작 작업 스케줄러 설치 도우미 추가.
- Tailscale Funnel 기반 재부팅 복구 절차 문서화.

## 1.0.1 (2026-09-02)
- **fix(Windows)**: 지속 터미널 세션을 cmd 호스팅으로 변경 — powershell.exe는 stdin이
  파이프면 EOF까지 실행을 미루는 특성이 있어 세션 생성이 타임아웃되던 문제 해결.
  (원샷 exec_command는 기존대로 PowerShell 기본)
- **fix**: 세션 센티널을 별도 줄로 전송 — cmd의 `%errorlevel%` 조기 확장 버그 회피, 종료코드 정확화
- **fix**: codex 실행을 stdin 프롬프트 방식("-")으로 변경 — 따옴표/개행/공백 이스케이프 문제 원천 차단,
  Windows codex.cmd 셔틀 대응(셸 한 줄 문자열 구성)
- **fix**: DEP0190 경고 제거 — shell:true + args 배열 조합 제거(docker/wsl은 직접 spawn)
- exec_command 기본 타임아웃 60초 → 55초 (MCP 클라이언트 60초 제한과 레이스 방지)

## 1.0.0 (2026-09-02)
- 최초 릴리스: 55개 도구 (파일/실행/DB 7종/로그/goal/effort/세션/워커/codex 브리지/데스크톱/SSH/샌드박스/하네스)
