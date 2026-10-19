# Consumer Event Bridge — NAS ↔ 일반 ChatGPT

`@webjjonku/consumer-event-bridge`는 NAS 이벤트를 **공식 MCP Apps UI의 `ui/message`** 흐름으로 전달하기 위한 독립 실험 모듈이다. 기본 동작은 **추론 API가 없는 영속 큐/감시기/서버**이며, ChatGPT 계정의 모델은 오직 **일반 ChatGPT에서 열린 위젯이** 후속 메시지를 요청할 때만 사용될 수 있다.

> **이벤트를 받는 앱 UI가 ChatGPT 내부에 열려 있고 사용자가 Start를 누른 상태여야 한다.** ChatGPT 브라우저/앱이 완전히 닫히면 자동으로 새 일반 GPT-6 턴을 만드는 기능이 아니다. 기존 개발 기록에는 열린 위젯에서 NAS 이벤트 2건과 일반 ChatGPT 응답 2건을 관측했다는 보고가 있다. 이번 소스 배포에서는 이 실제 호스트 동작을 반복 검증하지 않았다. 자동 응답 완료 영수증은 제공하지 않으며, 닫힌 창의 자동 기상도 지원하지 않는다.

## 구조와 안전한 결과 확정

1. NAS 실행기(`watch-research.mjs` 또는 `cli.mjs publish`)가 **민감정보 없는 이벤트 ID와 제한된 참조만** 디스크에 기록한다.
2. 사용자가 일반 ChatGPT에서 앱 위젯의 Start를 클릭한다. 열린 세션에서만 최대 15분/6건, 이벤트 ID/참조만 ChatGPT에 전달한다.
3. 이벤트는 별도의 디스크 `claims/` 파일을 통해 **처음 한 번만 claim** 된다. 호스트 접수 상태는 `deliveries/`에 남지만 **AI 응답·실제 결과 저장을 의미하지 않는다.** 서버가 재시작되거나 ack가 불확실해도 자동 재전송하지 않는다.
4. 일반 ChatGPT가 실제로 NAS Connector를 호출해 검증된 결과를 영속 저장했다면, **신뢰할 수 있는 NAS 로컬 실행기**가 증빙 JSON을 만들어 `cli.mjs complete` 명령을 실행한다. 이 명령은 **공개 MCP 도구에는 등록하지 않았다.**
5. `completions/`에 증빙 해시가 남으면 완료. 과학적 결과 `UNPROVEN`을 임의로 변경하지 않는다.

허용 이벤트: `nas.harmless.probe` (`probe`), `research.review.ready` (20자리 소문자 16진수 `jobId`), `research.progress.ready` (`run-<양의 정수>`). **임의 프롬프트와 셸 명령을 받는 이벤트 타입은 없다.**

## 빠른 로컬 검증 (Node 22+)

```bash
# 커넥터 저장소 루트에서
node --test apps/consumer-event-bridge/test/*.test.mjs
export CONSUMER_EVENT_DATA="$PWD/.webjjonku/consumer-bridge-state"
node apps/consumer-event-bridge/src/cli.mjs publish nas.harmless.probe probe
node apps/consumer-event-bridge/src/cli.mjs status
CONSUMER_EVENT_PORT=18797 node apps/consumer-event-bridge/src/server.mjs
```

`/healthz` 및 `/mcp`를 우선 검증한 뒤, 공식 ChatGPT 플러그인에 **올바른 NAS MCP HTTPS 엔드포인트를 연결해야** 앱 UI가 나타난다. 기존 `Webjjonku Web SDK Probe`는 18795 포트의 검증된 v2 서비스를 가리키므로, 새 브리지를 검증하기 전에 운영 플러그인을 몰래 전환하지 않는다.

## NAS 독립 Docker 배포 (선택)

```bash
export EVENT_STATE_DIR=/your/private/nas/path/consumer-event-state
export RESEARCH_ROOT=/your/private/nas/path/badminton_validation
# state 폴더는 컨테이너 uid 1000 소유, mode 0700 으로 직접 준비
# 기본 시험 포트는 18797; 기존 v2 프로브(18795)와 격리
docker compose -f deploy/consumer-event-bridge/compose.yml up -d --build consumer-event-bridge
# 연구 큐 감시기는 원하는 경우 별도 활성화
docker compose -f deploy/consumer-event-bridge/compose.yml --profile research up -d consumer-research-watcher
```

Compose 환경에서는 NAS host-local 127.0.0.1 포트만 사용한다. 외부 ChatGPT에서 접근시키려면 별도로 인증·네트워크 접근 범위를 검토한 프록시가 필요하며, 기존 Tailscale Funnel 443/8443 라우팅을 덮어쓰지 않는다. 서버의 MCP 세션 호출은 **자체 인증을 대신하지 않으므로**, 공개 엔드포인트에서는 harmless probe만 사용하거나 신뢰할 수 있는 접근 제어를 먼저 구성해야 한다. 연구 원문, 인증 정보 또는 명령 본문은 이 경로로 전송하지 않는다.

## NAS 연구 엔진 이벤트 자동 수집

```bash
CONSUMER_EVENT_DATA=/data/consumer-bridge \
CONSUMER_RESEARCH_ROOT=/data/badminton_validation \
node apps/consumer-event-bridge/src/watch-research.mjs --once
```

`--once`는 현재 미완료 논문 검토 작업과 새로 발견된 연구 진행 이벤트를 **한 번만** 인덱싱한다. 인자 없이 실행하면 60초 간격으로 감시한다(최소 30초). 어떤 경우에도 모델/CLI 기반 추론을 호출하지 않는다. 생성된 이벤트는 기존 ChatGPT에 열어 둔 위젯이 요청할 때만 전달된다.

## 완료 증빙 (호스트 접수만으로 완료 처리 금지)

```json
{"event_id":"evt-<발행된 정확한 UUID>","ref":"<발행된 참조>","result_saved":true,"artifact":"trusted NAS path or hash","note":"Validated by trusted Connector result pipeline"}
```

결과 파일을 로컬에서 검증한 뒤 다음 명령으로 완료 상태를 기록한다.

```bash
CONSUMER_EVENT_DATA=/data/consumer-bridge \
node apps/consumer-event-bridge/src/cli.mjs complete '<event-id>' '/path/to/verified-result-receipt.json'
```

`result_saved` 필드가 있는 JSON만으로 과학적 검증을 대신하지 않는다. 호출하는 신뢰된 로컬 실행기가 실제 결과 내용과 출처까지 검증해야 한다. 완료 처리 기능을 public MCP로 제공하지 않는다.

## 제한

- v0.3 열린 위젯의 실제 다중 턴 2건은 실사용 입증. 장시간 무인 실행·앱 background/closed-window 기상은 지원·검증되지 않았다.
- 유효한 claim 뒤 호스트 오류가 발생하면 자동 재시도하지 않는다. 안전하지만 수동 정리가 필요할 수 있다.
- 15분/6건 제한은 의도된 안전장치다. 승인 없이 24시간 무한 자동 응답을 실행하지 않는다.
- 개인 ChatGPT의 정확한 GPT-6 모델 ID, 추론 강도, 소비자 플랜 사용량 영수증은 발급·확인되지 않았다.
- ChatGPT 응답에 나타나는 이벤트 텍스트는 신뢰하지 말고, 기존 Connector의 작업 승인/출처 검증 정책을 따를 것.

실사용 다중 턴 시험에서는 첫 메시지 이후 **최소 60초 간격**으로 다음 이벤트를 전달한다. 이는 이전 v2의 60초 실험 간격을 따르며 실제 일반 ChatGPT 모델 응답 완료를 보장하지는 않는다.

## 기존 ChatGPT Connector의 플러그인 재설치 없는 연결 (선택형)

새 개인 플러그인이 일반 ChatGPT의 앱 선택 메뉴에 없더라도, 이미 연결된 `ChatGPT Connector` MCP에 **선택형 v0.3 어댑터**를 활성화하면 기존 앱에서 `consumer_event_bridge`와 앱 전용 `consumer_event_session` 도구 및 `ui://webjjonku/consumer-event-bridge.html` 리소스를 제공할 수 있다. 구현은 `src/tools/consumer-event-bridge.js`에 있으며, v0.3 NAS sidecar의 도구와 UI를 프록시할 뿐 모델을 실행하지 않는다.

- Connector를 새로 실행할 때 `WEBJJONKU_CONSUMER_EVENT_BRIDGE_URL=https://trusted-nas.example/v03/mcp` 환경 변수를 설정해야 도구가 등록된다. 미설정 시 기존 도구 목록을 변경하지 않는다.
- 대상 주소는 HTTPS 또는 HTTP 루프백만 허용한다. 사용자가 임의 URL을 지정하거나 ChatGPT 인증 쿠키/API 키를 사용하지 않는다.
- 2026-10-18: beta.5 운영 Connector 파생 이미지에 통합하고, 실제 일반 ChatGPT에서 `consumer_event_bridge` 호출 및 열린 위젯의 이벤트 2건→응답 2건을 확인했다. 응답 완료 영수증과 연구 결과 완료는 별개의 검증 단계다.
- 기존 위젯과 마찬가지로 Start 클릭 이후 열린 ChatGPT 위젯에서만 메시지 생성 가능하다. 앱이 닫히면 자동 기상하지 않는다.

### NAS Browser 디버깅 (선택)

일반 ChatGPT의 호스트 UI를 NAS Chromium으로 검증할 때 Playwright `Route is already handled!`가 발생해 브라우저 워커가 중단된 기록이 있다. 선택형 안전 패치는 저장소 `scripts/browser-route-guard.mjs`, `scripts/browser-worker.js` 및 테스트 `scripts/browser-route-guard.test.mjs`에 포함했고, 브라우저 파생 이미지로만 재현 배포한다. **이후 일반 ChatGPT에서 2개 모델 응답을 실사용 확인했다.**

### 2026-10-18 NAS Chromium 추가 보안·클릭 안정화

리소스 로딩 검증은 `scripts/browser-url-policy.mjs`에서 첫 당사자 HTTPS CDN의 서로 다른 **공개 DNS 응답**을 지원하며, 사설/로컬 IP는 계속 차단한다. `src/tools/cloud-browser.js`의 선택적 `noWaitAfter:true`는 브라우저 메뉴 클릭 뒤 불필요한 탐색 완료 대기를 끌 수 있다. 자세한 재현 및 잔여 호스트 오류는 `docs/consumer-event-bridge.md` 참조. 그 이후 열린 위젯에서 실사용 모델 응답 두 건을 확인했다.

## 일반 GPT 응답 관찰 기록 (2026-10-18)

MCP Apps `ui/message`의 `host_accepted` 응답은 **ChatGPT가 메시지 요청을 받았다는 뜻**이지, GPT 모델 응답이 화면에 출력되었다는 뜻이 아니다. 다음 세 상태를 구분한다.

- `accepted`: 살아 있는 위젯을 통한 호스트 메시지 수락, 기존 `deliveries/` 파일
- `responseObserved`: 신뢰된 **로컬 운영자가 실제 ChatGPT 대화에서 확인한 무해한 테스트 응답**을 `responses/`에 별도 저장한 누적 건수. 증빙 해시와 `operator_observed_not_host_signed` 표기. **호스트 자동 완료 알림이 아니다.** TTL 만료 이후에도 누적 카운트가 유지된다.
- `completed`: 기존의 **실제 연구 결과 파일 검증**을 마친 `completions/` 건수. 무해한 GPT 확인 응답만으로 증가시키지 않는다.

운영자가 실제 대화와 정확한 이벤트 ID를 확인한 후 아래 제한된 JSON을 로컬 파일로 작성한다. 공개 MCP 앱·위젯에 응답 완료 기록 도구를 제공하지 않는다.

```json
{"event_id":"evt-...정확한_실제_ID...","ref":"발행_시의_20자리_참조","source":"visible_chat_transcript","observed_by":"trusted_local_operator","response_text":"NAS 이벤트 확인"}
```

```bash
CONSUMER_EVENT_DATA=/data/consumer-bridge node src/cli.mjs response-observed '<event-id>' '/trusted/local/evidence.json'
CONSUMER_EVENT_DATA=/data/consumer-bridge node src/cli.mjs status
```

`response-observed`는 이미 `host_accepted` 상태인 `nas.harmless.probe`에만 허용된다. 이벤트 불일치, 미확인 응답 텍스트, 심볼릭 링크 등 불신 파일은 거부하며, 동일 이벤트 기록은 중복해서 생성되지 않는다. 과학적 연구 결과에 대한 자동 완료 판단은 하지 않는다.

## 창을 닫은 뒤 새 일반 ChatGPT 턴 시작하기

**현재 이 MCP Apps 위젯 방식으로는 미지원이다.** `ui/message`/`sendFollowUpMessage`는 활성화된 iframe에서 호스트로 전송하는 인터페이스이며, 이 위젯은 `pagehide` 이후 폴링을 중단한다. 서버는 사용자 대신 ChatGPT 브라우저를 재개하거나 모델 API를 호출하지 않는다. 페이지 닫힘을 흉내 낸 위젯 수명주기 테스트에서 종료 후 폴링/메시지가 발생하지 않음을 검증했다. 이 테스트는 실제 닫힌 모바일 앱을 원격으로 조작해 성공했다는 증명이 아니다.

완전 무인 모니터링이 필요하면 별도의 승인된 스케줄러/에이전트 워크플로가 필요하다. 이는 **현재 열려 있는 일반 ChatGPT 대화의 새 턴을 깨우는 기능과 같다고 주장하지 않는다.**
