# ChatGPT Connector

Windows PC와 NAS의 파일, 명령 실행, 브라우저, Windows UI, 문서 작업을 MCP로 연결하는 개인용 브리지입니다. 장기 작업의 상태와 체크포인트를 저장하고 Coordinator를 통해 호스트별 작업을 전달합니다.

이 저장소는 공개 배포용 소스입니다. 버전은 **2.1.0-beta.5**이며 개인 운영 설정, 취업 자료, 런타임 상태와 기존 개발 커밋 이력은 포함하지 않습니다. OpenAI 공식 제품이 아닙니다.

## 포함 기능

- 승인된 경로의 파일 읽기와 편집, 셸 실행, Git 및 프로젝트 작업
- DOM 브라우저 작업, Windows UI Automation, 문서와 스프레드시트 작업
- 지속 Task, Goal, 체크포인트와 세션 복원
- NAS Coordinator, Windows worker, 브라우저 worker
- 권한 정책, 승인, 자격증명 브로커, 상태 보존과 복구

기능별 외부 프로그램과 연결 계정이 필요할 수 있습니다. Windows 전용 기능은 Windows 호스트에서 실행합니다. 외부 이벤트만으로 일반 ChatGPT의 닫힌 대화를 자동 시작하는 기능은 검증된 배포 기능으로 안내하지 않습니다.

## 로컬 실행

Node.js 20 이상이 필요합니다.

```bash
git clone https://github.com/Luriar/chatgpt-connector-public.git
cd chatgpt-connector-public
npm ci
cp webjjonku.config.example.json webjjonku.config.json
# webjjonku.config.json의 roots를 실제로 허용할 프로젝트 폴더로 수정
npm test
npm start
```

PowerShell에서는 `Copy-Item webjjonku.config.example.json webjjonku.config.json`을 사용합니다. 기본 HTTP 주소는 `http://127.0.0.1:8747`이며 `/health`로 상태를 확인합니다. stdio 모드는 `npm run stdio`로 실행합니다.

MCP URL에는 접근용 secret이 포함될 수 있습니다. 실제 URL과 설정은 개인 환경에 보관하고 저장소나 이슈에 올리지 않습니다. 호스트에서 원래 사용 중인 서비스의 설정을 이 예제로 덮어쓰지 않습니다.

## NAS와 Windows

- 일반 Connector Docker 예제: `deploy/docker-compose.yml`
- Coordinator와 브라우저 worker 예제: `deploy/coordinator-compose.yml`
- 여러 서비스가 포함된 NAS 예제: `deploy/nas-compose.yml`
- Windows worker: `scripts/windows-tool-worker.js`
- Windows 실행 및 복구 도우미: `scripts/start-chatgpt-connector.ps1`, `scripts/windows-recovery-watchdog.ps1`

NAS 예제의 경로와 토큰은 `deploy/.env.example`을 참고해 구성합니다. 예제는 실제 운영 설정이 아닙니다. 새 Coordinator의 인증 및 토큰 등록 절차는 [배포 가이드](docs/SETUP_GUIDE.md)를 확인합니다. QNAP 호스트 튜닝 서비스는 별도 profile이며 기본 실행 대상이 아닙니다.

Windows worker는 기본적으로 `windows-<hostname>`을 사용합니다. 기존 별칭이 필요한 경우 [장치별 설정](docs/device-independent-skills.md)을 확인합니다.

## 확인 명령

```bash
npm test
npm run test:parity
npm run test:session
npm run test:security
node scripts/count-tools.js
```

테스트 성공은 각 사용자 환경의 실제 배포나 브라우저 로그인, Windows UI, 호스트 간 E2E 성공을 대신하지 않습니다.

## 문서

- [설치와 배포](docs/SETUP_GUIDE.md)
- [구성 개요](docs/V2.md)
- [문제 해결](docs/TROUBLESHOOTING.md)
- [Windows 자동 시작](docs/WINDOWS_AUTOSTART.md)
- [공개 배포 관리](PUBLICATION.md)

VM 기능의 Alpine rootfs는 공개본에 동봉하지 않습니다. 필요한 rootfs를 직접 준비하고 `vm_prepare`의 `rootfs_tar`로 지정합니다. 일반 Connector 실행에는 필요하지 않습니다.

## 추가 플러그인 소스

Consumer Event Bridge v0.3, Web SDK Probe, Codex Relay Events의 서버와 UI 소스, 테스트, 플러그인 정의 및 연결 예제가 포함되어 있습니다. [플러그인 구성과 패키징](plugins/README.md)을 확인합니다.

각 플러그인은 선택 구성입니다. 실제 개인 접속 주소와 OAuth 설정은 포함하지 않으며, 소스 추가로 설치된 플러그인이나 운영 서비스가 바뀌지 않습니다. Node.js 22 이상에서 `npm run test:plugins`로 로컬 검증을 실행합니다.
