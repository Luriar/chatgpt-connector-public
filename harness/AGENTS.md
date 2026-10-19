# AGENTS.md — 프로젝트 규칙 (템플릿)

이 파일을 **작업할 프로젝트 루트에 복사**해서 프로젝트에 맞게 고쳐 써.
`webjjonku_bootstrap`이 자동으로 읽어서 모델에게 전달한다. (Codex의 AGENTS.md와 동일한 개념 — 하네스 엔지니어링의 핵심 파일)

## 프로젝트 개요
<!-- 예: Next.js 14 + TypeScript 웹앱. src/ 아래 앱 코드, prisma/ 아래 DB 스키마 -->
(여기에 프로젝트 설명)

## 명령어
<!-- 모델이 검증에 사용할 명령들. 정확할수록 좋다 -->
- 개발 서버: `npm run dev`
- 빌드: `npm run build`
- 테스트: `npm test`
- 린트: `npm run lint`

## 코드 스타일
- (예: 세미콜론 사용, 함수형 컴포넌트만, 주석은 한국어)

## 금지 사항
- (예: `src/legacy/` 수정 금지, 마이그레이션 파일 직접 수정 금지, main 브랜치 직접 커밋 금지)

## DB / 로그
- (예: 개발 DB는 `db_connect`로 `postgres://...` 등록해서 사용, 앱 로그는 `logs/app.log`)

## 검증 기준 (Definition of Done)
- 빌드 통과 + 테스트 통과 + 린트 통과
- (프로젝트별 추가 기준)
