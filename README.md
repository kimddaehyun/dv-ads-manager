# 디브이 애드 매니저 (DV Ads Manager)

네이버 광고 대시보드(`ads.naver.com`)에 주입되어 키워드별 **현재 순위**·**1~10위 예상 입찰가**를 실시간 표시하는 Chrome 확장. 대행사 AE의 multi-account 운영을 1차 타겟으로 한다.

## ✨ MVP 기능

- **F001 파워링크 순위·입찰가 오버레이** — 키워드 행 옆에 현재 입찰가의 추정 순위 + 1~10위 예상 입찰가
- **F002 쇼핑검색광고 그룹 inline 펼침** — 소재 행 토글 시 자동매칭 키워드별 순위 테이블 (데이터 소스 TBD)
- **F003 쇼핑검색광고 소재 상세 풀 패널** — 단일 소재의 키워드 전체 정렬/검색
- **F011 검색광고 API 자격증명 등록** — customerId · accessLicense · secretKey 1쌍 등록·수정·삭제
- **F012 팝업 상태·캐시 갱신** — 자격증명 등록 상태 표시 + 캐시 강제 갱신

## 🛠️ 기술 스택

- **확장 플랫폼**: Chrome MV3 (Service Worker + Content Script)
- **번들러**: Vite 6 + `@crxjs/vite-plugin`
- **UI**: React 19 + TypeScript 5.7 + TailwindCSS v4 + Pretendard
- **API**: 네이버 검색광고 API (HMAC SHA-256) — `POST /estimate/average-position-bid/keyword`

## 👨‍💻 개발

```bash
npm install         # 의존성 설치
npm run dev         # @crxjs HMR 개발 서버
npm run build       # dist/ 생성
npm run package     # dist/ + dist-zip/DV-Ads-Manager vX.Y.Z.zip
npm run typecheck   # tsc -b --noEmit
```

### 폴더 구조

```
src/
├── popup/          # React 팝업 UI (F012)
├── options/        # 검색광고 API 자격증명 등록 (F011)
├── content/        # ads.naver.com 콘텐츠 스크립트 (F001/F002/F003)
├── background/     # MV3 Service Worker (API 위임)
├── lib/            # searchad / cache (volume / performance)
├── types/          # 공유 타입
└── assets/         # 로고·폰트
```

### Release

`v*` 태그 push 시 GitHub Actions(`release.yml`)가 `npm run package` 실행 → `dist-zip/DV-Ads-Manager v{version}.zip`을 GitHub Release에 자동 첨부합니다.

## ⚠️ 주의사항

- 네이버 검색광고 API 자격증명(`customerId` / `accessLicense` / `secretKey`)은 사용자가 직접 발급해 옵션 페이지에 등록합니다.
- 사용자 광고 데이터(키워드·예산·소재 등)는 외부로 전송하지 않습니다. 모든 데이터는 `chrome.storage.local`에만 보관됩니다.
- F002/F003의 쇼핑검색광고 데이터 소스는 미정.

## 📄 라이선스

Private — 무단 배포·재사용 금지.
