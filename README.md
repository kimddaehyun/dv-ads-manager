# 디브이 애드 매니저 (DV Ads Manager)

네이버 광고 대시보드(`ads.naver.com`)에 주입되어 키워드별 **현재 순위**·**1~15위 예상 입찰가**를 실시간 표시하는 Chrome 확장. 대행사 AE의 multi-account 운영을 1차 타겟으로 한다.

상세 요구사항은 [`docs/PRD.md`](./docs/PRD.md) 참조.

## ✨ MVP 기능

- **F001 파워링크 순위·입찰가 오버레이** — 키워드 행 옆에 현재 입찰가의 추정 순위 + 1~15위 예상 입찰가
- **F002 쇼핑검색광고 그룹 inline 펼침** — 소재 행 토글 시 자동매칭 키워드별 순위 테이블 (데이터 소스 TBD)
- **F003 쇼핑검색광고 소재 상세 풀 패널** — 단일 소재의 키워드 전체 정렬/검색
- **F010 라이선스 키 검증** — Supabase RPC, 베이직 tier 단일 등급
- **F011 광고주별 자격증명 다중 관리** — customerId 기준 N개 등록·수정·삭제
- **F012 팝업 상태·캐시 갱신** — 라이선스/광고주 매칭 표시 + 캐시 강제 갱신
- **F013 활성 광고주 자동 감지·매칭** — `ads.naver.com` DOM/URL에서 customerId 추출

## 🛠️ 기술 스택

- **확장 플랫폼**: Chrome MV3 (Service Worker + Content Script)
- **번들러**: Vite 6 + `@crxjs/vite-plugin`
- **UI**: React 19 + TypeScript 5.7 + TailwindCSS v4 + Pretendard
- **API**: 네이버 검색광고 API (HMAC SHA-256) — `POST /estimate/average-position-bid/keyword`
- **라이선스**: Supabase RPC `verify_access`

## 👨‍💻 개발

```bash
npm install         # 의존성 설치
npm run dev         # @crxjs HMR 개발 서버
npm run build       # dist/ 생성
npm run package     # dist/ + dist-zip/DV-Ads-Manager vX.Y.Z.zip
npm run typecheck   # tsc -b --noEmit
```

### 환경 변수

`.env.example`을 참고해 `.env`에 Supabase URL/anon key를 설정합니다.

### 폴더 구조

```
src/
├── popup/          # React 팝업 UI (F012)
├── options/        # 라이선스 + 자격증명 다중 관리 (F010/F011)
├── content/        # ads.naver.com 콘텐츠 스크립트 (F001/F002/F003/F013)
├── background/     # MV3 Service Worker (API 위임)
├── lib/            # searchad / license / supabase / cache (naver-tag-picker 공유 코어)
├── types/          # 공유 타입
└── assets/         # 로고·폰트
```

### Release

`v*` 태그 push 시 GitHub Actions(`release.yml`)가 `npm run package` 실행 → `dist-zip/DV-Ads-Manager v{version}.zip`을 GitHub Release에 자동 첨부합니다.

## ⚠️ 주의사항

- 네이버 검색광고 API 자격증명(`customerId` / `accessLicense` / `secretKey`)은 사용자가 직접 발급해 옵션 페이지에 광고주별로 등록합니다.
- 사용자 광고 데이터(키워드·예산·소재 등)는 외부로 전송하지 않습니다. 라이선스 검증 시 디바이스 ID·키만 운영자 Supabase로 전송됩니다.
- F002/F003의 쇼핑검색광고 데이터 소스는 미정 — `docs/PRD.md` 부록 "Spike & 출시 계획" 참조.

## 📄 라이선스

Private — 무단 배포·재사용 금지.
