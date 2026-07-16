# F-Setup — 세팅안(광고 세팅 제안서) 엑셀 다운로드

F-MultiAccount popover 행 메뉴 "세팅안 생성" → 캠페인 선택 모달(`dvads-setup-modal`, 체크박스 다중선택+유형 필터) → 선택 캠페인의 캠페인-그룹-소재-키워드 계층 수집 → 키워드 예상순위 보강 → 엑셀 생성 → Blob 다운로드. 전부 클라이언트 사이드.

## 파일·흐름

- `setup.ts` — 모달 UI + 오케스트레이션 (multi-account에서 dynamic import).
- `setup-data.ts` — `/apis/sa/api/ncc/{campaigns,adgroups,adgroups/{id},ads,keywords}` 수집 (`authFetch` cross-account, worker pool 4) + background `GET_BID_ESTIMATE` 재사용 + `estimateRank`.
- `setup-adapters.ts` — 유형별 소재/키워드 구조 차이 흡수 (WEB_SITE/BRAND_SEARCH만 키워드 보유, SHOPPING/PLACE는 소재만).
- `setup-excel.ts` — `write-excel-file/browser`로 **캠페인마다 시트 1개**(시트명=캠페인명). 시트 레이아웃(눈금선 off): 상단 캠페인 타이틀+그룹 요약표(그룹/일예산/디바이스/지역/요일시간/소재노출), 중단 소재(제목/설명/URL은 columnSpan 2), 하단 **키워드 가로 블록**(그룹을 옆으로 나란히, 그룹마다 그룹명 헤더(columnSpan 3)+[키워드/입찰가/예상순위]). 폭 다른 표를 columnSpan으로 정렬.
- 타입은 `src/types/setup.ts`. endpoint schema는 메모리 `project_f_setup_endpoints`.

## Gotchas

- **쇼핑검색 소재는 상품 자체** — 소재유형 칸에 상품 이미지(write-excel-file image anchor)+제목(referenceData.productTitle)+상품링크(mallProductUrl), 설명 없음.
- 상품 이미지는 pstatic CDN CORS 차단으로 background `FETCH_IMAGE_BINARY` 경유 (host_permissions에 `shopping-phinf.pstatic.net`).
- 키워드 실효 입찰가는 `useGroupBidAmt`면 그룹 `bidAmt` 상속.
