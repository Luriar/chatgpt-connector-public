# Oracle 프리티어 + DevSpace로 웹쫀쿠 24시간 자동화

PC를 안 켜둬도 되는 원격 웹쫀쿠. 두 가지 방식 중 택1 (병행도 가능).

---

## 방식 A. Oracle Cloud 프리티어 VPS (평생 무료 서버)

### 1) 인스턴스 만들기
1. [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) 가입 (해외결제 카드 필요, 과금은 안 됨)
2. 인스턴스 생성: **Ampere A1 (ARM), 4 OCPU / 24GB RAM까지 무료** — Ubuntu 22.04+ 선택
   (Always Free 문구 확인. ARM 물량이 없으면 리전 바꾸거나 E2.1.Micro로 시작)
3. SSH 키 다운로드, 퍼블릭 IP 확인

### 2) 서버 준비 (SSH 접속 후)
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
```

### 3) 웹쫀쿠 올리기
로컬 PC에서 웹쫀쿠 폴더를 서버로 복사(또는 git):
```bash
scp -i 키파일 -r webjjonku ubuntu@서버IP:~/
ssh -i 키파일 ubuntu@서버IP
cd ~/webjjonku/deploy && docker compose up -d --build
docker compose logs tunnel | grep trycloudflare   # 공개 URL 확인
docker exec webjjonku cat /workspace/.webjjonku/http-secret   # 시크릿 확인
```
→ ChatGPT 커넥터 URL = `https://<터널URL>/mcp/<시크릿>`

⚠️ 퀵 터널 URL은 재시작 시 바뀐다. 고정하려면:
- Cloudflare 계정 터널(무료, 도메인 필요): `cloudflared tunnel create webjjonku` 후 compose의 command를 `tunnel run --token <토큰>`으로 교체
- 또는 OpenAI Secure MCP Tunnel(tunnel-client)을 서버에서 실행

### 4) 로컬 PC의 웹쫀쿠와 연동
- 로컬 config의 `remotes`에 이 서버 등록 → ChatGPT가 `ssh_exec`로 서버 관리
- 반대로 서버 인스턴스는 24시간 코드작업·크론·봇 용도로 사용
- 데스크톱 제어(desktop_*)는 화면이 있는 로컬 PC 인스턴스에서만 동작하는 게 정상

### 보안 필수
- Oracle 보안 목록(Security List)에서 **8747 포트를 외부에 열지 마** — 터널만 쓰면 열 필요 없음
- 서버의 `webjjonku.config.json`에 `"readOnly": true`로 시작해서 필요할 때만 해제하는 것도 방법

---

## 방식 B. DevSpace (GitHub Codespaces / devcontainer)

`.devcontainer/devcontainer.json`이 이미 들어 있다 (Node 22 + Docker-in-Docker + **Rust 프리인스톨**).

### GitHub Codespaces
1. 웹쫀쿠를 GitHub 저장소(private)에 푸시
2. 저장소 → Code → Codespaces → Create
3. 자동으로 `npm install` 완료됨 → 터미널에서:
   ```bash
   npm start &
   npm run tunnel     # cloudflared는 codespace에 설치:
   # curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
   ```
   또는 Codespaces의 포트 포워딩(8747)을 Public으로 바꿔 그 URL 사용 가능
   (`https://xxx-8747.app.github.dev/mcp/<시크릿>`)
4. 무료 한도: 월 120코어시간 — 상시 구동엔 부족하니 상시용은 방식 A 추천

### VS Code devcontainer (로컬)
Docker Desktop 있으면 VS Code에서 "Reopen in Container" → 러스트까지 깔린 격리 개발환경.
sandbox_exec 없이도 컨테이너 안이 통째로 샌드박스가 된다.

---

## 조합 추천

| 용도 | 구성 |
|---|---|
| 평소 코딩 | 로컬 PC 웹쫀쿠 (데스크톱 제어 포함 풀기능) |
| 24시간 작업·자동화 | Oracle VPS 웹쫀쿠 (+ 로컬에서 ssh_exec로 관리) |
| 일회성 실험·러스트 놀이터 | Codespaces devcontainer / sandbox_exec |
