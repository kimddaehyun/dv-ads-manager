# 디브이 애드 매니저 (DV Ads Manager)

네이버 광고 대시보드(`ads.naver.com`)에서 키워드별 **예상 입찰가**·**쇼핑검색 순위**·**다른 순위 입찰가**를 실시간 표시하는 Chrome 확장.

## ✨ 주요 기능 (예정)

- **파워링크 예상 입찰가** — 키워드 옆에 1·3·5·10위 노출 입찰가를 직접 표시
- **쇼핑 검색 순위** — 광고 소재(상품)의 현재 검색 노출 순위를 키워드별로 확인
- **순위별 입찰가** — 원하는 순위에 들기 위한 추정 비용을 한눈에

## 🛠️ 기술 스택

- **확장 플랫폼**: Chrome MV3 (Service Worker + Content Script)
- **번들러**: Vite 6 + `@crxjs/vite-plugin`
- **UI**: React 19 + TypeScript 5.7 + TailwindCSS v4
- **백엔드**: 네이버 검색광고 API (HMAC SHA-256 인증) + 스마트스토어 상품 경쟁지표 API
- **라이선스**: Supabase RPC

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
├── popup/          # React 팝업 UI (옵션 진입점)
├── options/        # 라이선스 키 / 검색광고 API 자격증명 입력
├── content/        # ads.naver.com 페이지 주입 콘텐츠 스크립트
├── background/     # MV3 Service Worker (API 위임)
├── lib/            # searchad / search-popular / license / supabase / cache
├── types/          # 공유 타입
└── assets/         # 로고·폰트
```

### Release

`v*` 태그를 push하면 GitHub Actions가 `npm run package` 실행 → `dist-zip/DV-Ads-Manager v{version}.zip`을 GitHub Release에 자동 첨부합니다.

## ⚠️ 주의사항

- 네이버 검색광고 API 자격증명(`customerId` / `accessLicense` / `secretKey`)은 사용자가 직접 발급해 옵션 페이지에 입력합니다.
- 스마트스토어 상품 경쟁지표 API는 **브랜드 스토어 계정**으로 `sell.smartstore.naver.com`에 로그인되어 있어야 동작합니다.
- 라이선스 검증을 위해 디바이스 ID·라이선스 키만 운영자 Supabase로 전송됩니다.

## 📄 라이선스

Private — 무단 배포·재사용 금지.
