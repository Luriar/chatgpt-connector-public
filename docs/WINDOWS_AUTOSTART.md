# Windows 자동 시작 / 재부팅 복구

ChatGPT Connector를 Windows 로그인 후 자동으로 복구하려면 프로젝트에 포함된 시작 스크립트와 작업 스케줄러 등록 스크립트를 사용한다.

## 전제 조건

- Node.js 20+
- Tailscale 설치 및 로그인 완료
- Tailscale Funnel 사용 권한이 현재 계정에 활성화되어 있음
- 이 저장소의 의존성 설치 완료: `npm install`

실제 MCP secret은 `.webjjonku/http-secret`에 보관된다. 이 파일과 전체 MCP URL은 외부에 공유하지 않는다.

## 한 번만 수동 확인

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-chatgpt-connector.ps1
npm run status
```

시작 스크립트는 다음을 수행한다.

1. `http://127.0.0.1:8747/health` 확인
2. 서버가 없으면 `scripts/daemon.js`를 숨김 프로세스로 시작
3. Tailscale이 준비될 때까지 대기
4. `127.0.0.1:8747`을 대상으로 Funnel을 idempotent하게 다시 설정
5. Funnel이 실제로 로컬 MCP 포트를 프록시하는지 검증

공개 hostname이나 MCP secret은 스크립트 출력에 표시하지 않는다.

## 로그인 시 자동 시작 등록

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

등록되는 작업 이름:

```text
ChatGPT-Connector
```

로그인 직후 실패하더라도 작업 스케줄러가 1분 간격으로 최대 10회 재시도한다.

## 제거

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Uninstall
```

## 상태 확인

```powershell
npm run status
& "C:\Program Files\Tailscale\tailscale.exe" funnel status
```

`npm run status`의 MCP URL은 secret 부분을 `<hidden>`으로 마스킹한다.

## 문제 해결

- `health`가 실패하면 먼저 `node scripts\daemon.js`를 직접 실행해 오류를 확인한다.
- Tailscale이 준비되지 않으면 Windows의 Tailscale 서비스와 로그인 상태를 확인한다.
- Funnel이 다른 로컬 포트를 가리키면 시작 스크립트를 다시 실행한다.
- 서버는 정상인데 ChatGPT에서 연결이 끊기면 등록된 MCP 앱의 endpoint가 현재 Funnel과 일치하는지 확인한다.
