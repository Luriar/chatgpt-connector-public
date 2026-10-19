# 설치와 배포

## 로컬

Node.js 20 이상에서 `npm ci`를 실행합니다. `webjjonku.config.example.json`을 `webjjonku.config.json`으로 복사하고 `roots`를 실제 허용할 프로젝트 폴더로 바꿉니다. 실제 토큰, 연결 계정, 사용자 파일과 상태는 Git에 추가하지 않습니다.

`npm test` 후 `npm start`를 실행하고 `http://127.0.0.1:8747/health`를 확인합니다. stdio는 `npm run stdio`를 사용합니다.

Windows의 명령 실행, UI Automation, Office 연동 등은 해당 프로그램이 설치된 Windows 장치에서 따로 검증합니다.

## Docker

`deploy/docker-compose.yml`은 Connector와 선택적인 터널을 실행하는 예제입니다. bind mount의 범위를 먼저 검토하고 허용할 파일 경로만 연결합니다. 터널 주소에 포함된 MCP secret은 비밀번호와 같이 보관합니다.

`deploy/coordinator-compose.yml`은 Coordinator와 브라우저 worker 예제입니다. `WEBJJONKU_COORDINATOR_TOKEN`에 충분히 긴 임의 값을 설정한 뒤 실행합니다. 기본 포트 바인딩은 localhost입니다.

## NAS 복합 구성

`deploy/nas-compose.yml`의 host 경로는 환경변수로 지정합니다. `deploy/.env.example`을 `deploy/.env`로 복사하고 모든 token placeholder를 교체합니다.

Coordinator의 상태 암호화 키 파일을 `WEBJJONKU_DATA_DIR` 아래 `secrets/coordinator-state.key`에 준비합니다. 예를 들어 `node -e "require('fs').writeFileSync('coordinator-state.key',require('crypto').randomBytes(32).toString('base64'),{mode:0o600})"`로 새 파일을 생성한 뒤 해당 위치로 옮깁니다. 이 파일을 공개하거나 기존 운영 키를 덮어쓰지 않습니다.

관리 token으로 Coordinator를 먼저 시작하고, Coordinator의 `/v1/auth/tokens` API로 Connector와 browser worker에 맞는 subject와 scope의 token을 등록합니다. 정확한 request schema와 권한은 `scripts/coordinator-server.js`, `src/tools/coordinator.js`를 확인합니다. 등록한 값을 로컬 `.env`의 두 scoped token에 넣은 뒤 나머지 서비스를 시작합니다.

`qnap-host-tuning` profile의 NFS shutdown guard와 CPU governor는 호스트 권한이 필요한 선택 기능입니다. 자신의 NAS에 맞게 검토한 경우에만 사용합니다.

`MONITOR_NFS_HOST`가 비어 있으면 외부 NFS 서버 점검은 생략합니다. `WEBJJONKU_BIND_IP`의 기본값은 localhost입니다. 실제 원격 연결은 인증, 방화벽, TLS 또는 신뢰할 수 있는 사설망 구성을 별도로 준비합니다.

## 검증

로컬 smoke와 보안 검증 이후 실제 배포 환경에서 health, worker 등록, 명령 왕복, 브라우저 작업을 확인합니다. 결과가 확인된 범위만 배포 완료로 기록합니다.
