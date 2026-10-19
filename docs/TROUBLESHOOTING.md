# 트러블슈팅 + 기존 도구 4대 버그가 웹쫀쿠에 없는 이유

## 커뮤니티 도구(chat-on-steroids류)의 4대 문제 → 웹쫀쿠의 구조적 해결

| # | 기존 문제 | 원인 | 웹쫀쿠 해법 |
|---|---|---|---|
| 1 | **goal 에이전트 호출 안 됨** | 크롬 확장이 턴 종료를 감지해 자동 타이핑하는 방식 — UI 변경·타이밍에 취약, OpenRouter 키 필요 | goal 상태를 **서버가 모든 도구 응답에 주입** → 모델이 한 턴 안에서 도구 체이닝으로 완주. 감지할 UI도, 두 번째 모델도 없음 |
| 2 | **채팅화면 오버라이드 시 멈춤** | 확장이 chatgpt.com DOM에 UI를 주입 | 웹쫀쿠는 **DOM을 안 건드림**(주입할 화면 자체가 없음) |
| 3 | **크롬 외 브라우저 불가** | 기능이 크롬 확장에 들어 있음 | 순수 MCP 커넥터 = **서버사이드** → 엣지·파폭·사파리·모바일 웹 전부 OK |
| 4 | **서브워커 메모리 끊김** | 새 탭에 "일반 지침"만 심고 시작 | `worker_spawn`이 goal·effort·메모·추가맥락을 **컨텍스트 패킷으로 통째 동봉** + codex 위임 시 프롬프트에 포함 |

---

## 자주 겪는 문제

### 연결
- **커넥터 등록이 안 보여** → 유료 플랜 + 웹(모바일 앱 X)인지, 설정 → 앱 → Advanced에서 Developer mode 켰는지 확인.
- **연결은 됐는데 도구가 안 보여/예전 것만 보여** → ChatGPT가 스키마를 캐시함. 커넥터 새로고침(또는 삭제 후 재등록) + **새 대화** 시작.
- **터널 URL이 자꾸 바뀌어** → cloudflared 퀵 터널은 원래 그래. 고정: Cloudflare 계정 터널 또는 OpenAI Secure MCP Tunnel.
- **`/health`는 되는데 ChatGPT에서 실패** → URL 끝에 `/mcp/<시크릿>`까지 정확히 넣었는지 확인. 시크릿은 `.webjjonku/http-secret`.

### 도구 동작
- **"승인되지 않은 경로야"** → `webjjonku.config.json`의 `roots`에 해당 폴더 추가 후 서버 재시작.
- **쓰기/실행이 다 막혀 있어** → config `readOnly: true` 상태. 킬스위치니까 의도 확인 후 false로.
- **DB 드라이버 없대** → 안내대로 `npm i pg`(또는 mysql2/mssql/oracledb/mongodb/redis) 실행하면 즉시 활성화.
- **SQLite가 disk I/O error** → 네트워크 드라이브/특수 마운트 폴더에선 파일잠금이 안 될 수 있음. 로컬 디스크 경로 사용.
- **exec가 60초에 끊겨** → `timeout_ms` 늘리거나, 장기 작업은 `session:true` 또는 `worker_spawn`으로.
- **desktop_*이 안 돼** → Windows 로컬 인스턴스에서만 동작(원격 리눅스 배포판은 화면이 없음). RDP 세션이 잠겨 있으면 입력이 막힐 수 있음.
- **codex_delegate가 미설치라고 해** → 정상(구독 전). `queue_if_missing:true`로 쌓아두고, 설치 후 `codex_process_queue`.

### 모델 행동
- **부트스트랩을 안 해** → ChatGPT 프로젝트 지침에 `harness/CHATGPT_PROJECT_PROMPT.md`를 넣었는지 확인. 첫 메시지로 "부트스트랩"이라고 직접 시켜도 됨.
- **goal 중간에 자꾸 멈추고 물어봐** → 지침이 로드 안 된 상태일 가능성. 부트스트랩 후엔 응답 푸터의 goal 힌트 때문에 계속 진행함. "묻지 말고 goal_finish까지 가"라고 한 번 말해주면 확실.
- **긴 대화에서 멍청해져** → `session_compact` → 새 대화 → "session_recall 하고 이어서". (Compact & Resume)

### 진단 순서
1. `http://127.0.0.1:8747/health` — 서버 살아있나
2. `npm test` — 도구 자체는 정상인가 (29항목)
3. `logs_tail{source:"journal"}` 또는 `.webjjonku/journal.jsonl` — 어떤 호출이 어떤 에러였나
4. 서버 콘솔(stderr) — 연결/HTTP 레벨 오류
