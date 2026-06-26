# 성능/속도 점검 결과 (2026-06-25, 2026-06-26 재감사 반영)

> dv-ads 전체 코드베이스 성능 감사. 멀티 에이전트 점검 + 코드 직접 확인 + 적대적 검증을 거친 결과.
> **1차 감사(2026-06-25):** 치명적 병목 없음 결론. 손볼 가치 11건.
> **2차 재감사(2026-06-26):** 1차가 놓친 사각지대(F-Report 파이프라인 `report-build.ts`, 번들/코드스플릿 축)를 7개 영역 병렬 재점검 + 적대적 검증으로 보강. 신규 28건 발견. 그중 **상시·전역으로 동작하는 high 1건(재감사 R1)이 1차의 "치명적 병목 없음" 전제를 사실상 깸** → 통합 우선순위 1순위로 재배치.
> 아래는 손볼 가치 순. 각 항목에 위치/원인/체감/수정안. 고친 항목은 `- [x]`로 체크.

---

## 구현 결과 (2026-06-26)

7개 파일 그룹 병렬 구현 → typecheck/build 통과 → 5개 영역 적대적 리뷰(전부 ship, blocker 0) → 리뷰가 짚은 미세 회귀 3건 추가 수정 → 재빌드 통과.

- **구현 완료(28건):** R1, R2, R5, R6, R7, R8, R10, R12, R13, R15, R16, R17, R21, R22, R25, R26, R27, R28, R18(scroll throttle만), 1차 #1, #2, #5, #8, #9, #10, #11, R4.
  - **R20 되돌림(2026-06-26):** 적용 후 키워드 고정 열(position: sticky) 레이아웃 깨짐 라이브 확인 → getComputedStyle 가드 복원. 그 getComputedStyle 읽기가 sticky 고정 열을 보호하는 핵심이라 제거하면 안 됨(코드 주석에 경고 명시).
  - **R3 코드스플릿 효과 측정됨:** 콘텐츠 본체 번들 282KB → **약 150KB**(report 52KB·setup 17KB·writeXlsxFileBrowser 59KB가 별도 lazy 청크로 분리). 모든 페이지 진입 파싱량 약 절반.
  - **#2(보수적 병렬화):** searchad estimate를 직렬 → **동시성 2 풀**(기존 429 백오프 유지 + 동시 재시도 분산 지터). 라이브 측정 못 해 보수적 2 채택 — 한계 측정 후 상향 가능. 첫 로딩 약 2배 단축.
  - **R4(안전 병렬화):** 일괄 리포트 광고주 **동시성 2** + 디스플레이 다운로드 POST를 **모듈 전역 게이트**로(계정 병렬에도 7초 간격 유지 → 403 구조적 회피). 검색광고 수집이 겹쳐 돌아 단축.
  - **리뷰 후 회귀 수정:** #11 popstate 백오프 리셋 누락, R10 디스플레이 1회 재시도 비대칭 복원, R22 중복 키 orphan promise dedupe, #2 동시 429 재시도 burst 지터.
- **데이터 계층만(비활성, 무회귀):** R24(collectAccount optional 인자만 추가, 호출부는 옵션페이지 필터 staleness 위험으로 미연결).
- **보류(9건):**
  - R9·R11(이미지 CDN variant) - broken image 응답 위험, 소형 variant 정상응답 라이브 확인 선행.
  - #3(전후비교 경로 가드) - GFA 디스플레이·대시보드·전체캠페인 페이지의 버튼을 죽일 수 있어 화이트리스트 라이브 확정 선행(리뷰에서 회귀 확인).
  - R19(window.top 가드)·#6(옵저버 통합) - 서브프레임/네비게이션 라이브 검증 선행.
  - #4(엑셀 단일패스)·R23 - 출력 바이트 동일성 검증 필요, 별도 진행.
  - #7(cache-prune)·R14(스크레이프 취소) - 저가치, 보류.
  - R18(paint 증분) - 시각 버그 위험 대비 이득 작아 scroll throttle만 적용.

> 미커밋 상태. 사용자가 dist/를 chrome://extensions에 로드 중이라 빌드는 갱신됨. 라이브 테스트 권장 흐름은 아래 "검증 권장" 참조.

### 검증 권장 (라이브)
- **F001 키워드 페이지:** 배지가 뜬 채 가만히 둘 때 CPU가 idle로 내려가는지(개발자도구 Performance), 입찰가 변경 시 순위 배지 갱신, 로딩→데이터→에러 전환 정상(R1 핵심).
- **자동 리포트:** 단건/일괄 모두 기존과 동일 산출인지(디스플레이/브랜드 운영 계정 1개씩). 단건 리포트의 날짜선택기가 메뉴 옆에 정상 위치하는지(R3 프록시 앵커).
- **다계정:** ↻전체 새로고침 속도/정확, 일괄 삭제·임계값 설정, 전체계정 검색 타이핑(R7/R8/#1).
- **세팅안:** 띄어쓰기·영문 키워드의 예상순위가 채워지는지(R6).

---

## 통합 우선순위 (2026-06-26 재배치)

1차(`#`)와 2차 재감사(`R`)를 영향도·위험·노력 기준으로 합친 권장 착수 순서.

| 순위 | 항목 | 등급 | 한 줄 | 위험/선행조건 |
|------|------|------|-------|----------------|
| 1 | **R1** 배지 무한 재렌더 루프 | high | 유휴 탭에서도 매 프레임 scan+배지 재생성 영구 반복 | 낮음(1파일 idempotent화) |
| 2 | **#1** 다계정 새로고침 storage 제곱 읽기 | medium | refreshBadge 디바운스 + 배치 읽기 | 낮음 |
| 3 | **R2** poll() 재진입 stampede | medium | 응답 대기 중 같은 키워드 중복 요청(429 유발) | in-flight 가드, 429 실측 권장 |
| 4 | **R3** 엑셀/리포트 정적 번들(282KB) | medium | 모든 페이지 주입마다 파싱 → 동적 import 코드스플릿 | 낮음(동작 동일) |
| 5 | **#3** 전후비교 버튼 전체 문서 스캔 | medium | 경로 가드로 비대상 페이지 스캔 skip | 낮음(대상 페이지 커버 확인) |
| 6 | **R6** enrichRanks 키 불일치 | medium | 띄어쓰기·영문 키워드 예상순위 폐기(1줄 수정) | 낮음 |
| 7 | **R5** 키워드 다차원보고서 2회 중복 호출 | medium | 1회 받아 클라이언트 분배로 절반 절감 | 낮음 |
| 8 | **R4** 일괄 리포트(runBatch) 광고주 직렬 | medium | worker pool 2~3 병렬 | 디스플레이 상세 7초 토큰버킷 라이브 확인 |
| 9 | **#2** searchad 직렬 배치 + sleep(300) | medium | 동시 2~3 제한 병렬 풀 | **429 실측 선행 필수** (R2·R22와 연계) |
| 10 | **#4** 리포트 엑셀 셀별 전체 치환 | medium | 시트당 단일 패스 적용 | 낮음(출력 동일성 검증) |
| 11 | **R10/R12/R13** 리포트 파이프라인 중복 정리 | low | GFA 2회·brand 직렬·time-contracts 동일응답 재요청 | 낮음 |
| 12 | 나머지 low (**R7~R22**, **#5~#11**) | low | 자원 위생 개선 | 낮음 |
| 13 | negligible (**R23~R28**) | negligible | 측정 불가 수준, 여유 시 | 낮음 |

---

## 2차 재감사 신규 발견 (2026-06-26)

### [x] R1. 배지 재렌더가 자기 MutationObserver를 재발화 → 유휴 탭에서도 매 프레임 무한 scan (high, 신규 최우선)
- **위치:** `src/content/index.ts:159-167`(ensureBadge 기존 mount 분기), `191-251`(renderBadge), `1084-1090`(schedule), `1109-1110`(body observer); poll 가산 `944, 1007`
- **원인:** `document.body` 옵저버(childList+subtree)가 `schedule`→rAF→`scan`을 돌린다. `scan`은 이미 붙어있는 같은 키워드 배지에도 무조건 `renderBadge(existing)`를 호출(165). `renderBadge`는 **바뀐 게 없어도** 매번 `m.badge.replaceChildren()`(192) 후 `textContent=label`(246)로 텍스트 노드를 제거→추가하는데, 이게 body subtree의 childList 변경이라 같은 옵저버가 다시 발화 → 다음 프레임 `scan` → 또 `renderBadge`로 이어지는 self-feeding 루프. 라벨/입찰가/상태가 직전과 같아도 DOM을 건드리는 게 근본 원인. poll()도 250ms마다 `for ... renderBadge`(944, 1007)로 churn을 보탬. **(라이브 코드 직접 확인 완료.)**
- **체감:** 배지가 떠 있는 키워드 페이지를 그냥 열어두기만 해도(입력 0) 매 프레임(60fps) `querySelectorAll` + 모든 배지 DOM 재생성이 영구 반복. 키워드 수십~수백 개에 비례해 메인스레드가 idle로 못 내려가 배터리 소모·미세 입력/스크롤 끊김. 1차의 "치명적 병목 없음" 전제를 깨는 상시 동작 항목.
- **수정안:** `renderBadge`를 idempotent하게 만든다. 기존 mount의 keyword/currentBid/credentialState/lastError/데이터 유무가 직전과 모두 같으면 renderBadge를 건너뛰거나, 목표 label/className/onclick을 먼저 계산해 현재 내용과 동일하면 `replaceChildren`/`textContent` 재기록 없이 early return. "바뀐 게 없으면 DOM을 안 건드린다" → 자기 mutation으로 옵저버가 안 깨어나 루프가 끊긴다.

### [x] R2. poll() 재진입 가드 부재로 응답 대기 중 같은 키워드 중복 재요청 (medium, 캐시 stampede)
- **위치:** `src/content/index.ts:911-918`(schedulePoll), `920-1008`(poll)
- **원인:** `schedulePoll`은 setTimeout 콜백 진입 즉시 `pollTimer=null`로 풀고(915) `void poll()`을 띄우는데, `poll()`은 응답 도착 후(980-982)에야 in-memory `dataCache`/`perfCache`를 채운다. poll() 본문에 "이미 한 poll이 await 중"을 막는 재진입 가드가 없어서, 첫 poll이 5개씩 직렬 배치 + sleep(300)으로 수 초 기다리는 동안 새 셀 mount/옵저버로 schedulePoll이 다시 불리면 두 번째 poll이 동일 키워드를 여전히 cache miss로 보고 똑같이 요청한다. (`inflightDevice`/`inflightMounts` 가드는 device 토글·단건 변경용이라 batched poll엔 적용 안 됨.) **(라이브 코드 직접 확인 완료.)**
- **체감:** 키워드 많은 계정 첫 진입·스크롤 로딩 시 같은 키워드 API 호출 2배 이상 → 애써 피하던 429(1차 #2)를 오히려 앞당기고 배지가 깜빡임.
- **수정안:** poll()에 in-flight 플래그. `let polling=false; if(polling){schedulePoll();return;} polling=true; try{...}finally{polling=false;}`. 응답이 와 캐시가 채워진 뒤에만 다음 poll이 실제 요청. (background 측 코얼레싱 R22와 보완 관계 — 멀티탭은 background에서 별도로 막아야 함.)

### [x] R3. 엑셀(write-excel-file)+fflate+리포트/세팅안 전체가 콘텐츠 스크립트에 정적 번들 → 매 페이지·매 iframe 주입마다 282KB 파싱 (medium)
- **위치:** `src/content/multi-account.ts:46-47`(정적 import) + `setup-excel.ts:15` + `report.ts:11` / 호출부 `multi-account.ts:1262·1512·1522`
- **원인:** `index.ts → multi-account.ts(openSetupFlow/openReportFlow) → setup.ts → setup-excel.ts(write-excel-file/browser) / report.ts(fflate)`가 모두 top-level 정적 import 체인이라, 콘텐츠 본체 번들(`dist/assets/index.ts-*.js` 약 282KB)에 엑셀·리포트 라이브러리가 통째로 인라인된다. 정작 이 코드는 F-MultiAccount 팝오버에서 "세팅안 생성"/"리포트 생성"을 누를 때만 쓰인다.
- **체감:** ads.naver.com 진입·SPA 화면 전환·재주입마다 282KB JS 파싱·컴파일. 평소 안 쓰는 엑셀/리포트 코드가 절반가량. `all_frames:true`라 본문이 iframe이면 프레임 수만큼 곱. 모든 사용자가 모든 페이지에서 부담하는 가장 넓은 영향 범위. 단 async 동적 로드라 렌더를 동기 블록하진 않아 체감은 중간.
- **수정안:** 정적 import → 동적 import 코드스플릿. `multi-account.ts:46-47` top-level import 제거 후 클릭 핸들러(1262·1512·1522)에서 `const { openSetupFlow } = await import("./setup")` / `await import("./report")`로 호출 시점 로드. @crxjs/rollup가 별도 청크로 분리 → 초기 파싱에서 제외. 동작 동일(첫 클릭 시 수십 ms 1회 로드).

### [x] R4. 일괄 리포트(runBatch)가 광고주별로 완전 직렬 생성 (medium)
- **위치:** `src/content/report.ts:107-137`(114-123 for 루프)
- **원인:** `runBatch`가 targets를 for 루프에서 `await buildReportBytes(t, ...)`로 한 광고주씩 순차 생성. buildReportBytes 1건은 advanced-report ~10건 + GFA + brand 수집을 포함하는 무거운 작업인데, 광고주 N명이면 직렬로 N배 누적. 계정 내부는 병렬이나 계정 간은 직렬.
- **체감:** 여러 광고주 일괄 리포트 시 총 소요시간이 광고주 수에 정비례. 대행사 수십 계정에서 대기 블록 큼.
- **수정안:** worker pool 패턴(동시성 2~3)으로 buildReportBytes 병렬. **단 디스플레이_상세(`report-gfa-detail.ts`)의 다운로드 POST는 `POST_GAP_MS=7000` 토큰버킷(403) 4차원 순차라 계정당 ~28초+이고, 이 rate-limit이 계정 간 공유되는지 라이브 확인 필요.** 안전 우선이면 검색광고 전용 계정만 우선 병렬화 또는 동시성 2 제한.

### [x] R5. 키워드 다차원보고서를 동일 쿼리로 2번 호출 (medium, 파워링크/쇼핑검색 분리 fetch)
- **위치:** `src/lib/report-build.ts:394-429, 457-458`
- **원인:** `buildReportBytes`의 Promise.all에서 `fetchKeywordGroups`를 "파워링크"·"쇼핑검색"으로 두 번 호출하는데, 둘 다 `fetchAdvancedReport({attributes:['nccCampaignTp','nccCampaignId','nccAdgroupId','expKeyword'], ...})`로 attributes가 완전 동일. 응답 100% 같고 차이는 받은 뒤 `nccCampaignTp` 클라이언트 필터(403)뿐. 이 쿼리는 (유형x캠페인x그룹x검색어) 조합이라 카디널리티 최대 + `fetchAdvancedReport`는 pageSize 1000/maxRows 5000으로 직렬 페이지네이션(최대 5 round-trip)인데 이를 통째로 2번 수행.
- **체감:** 검색어 많은 계정(특히 쇼핑검색)에서 최대 응답을 두 번 다운로드·페이지네이션. 같은 Promise.all 안이라 wall-clock 2배는 아니나 대역폭·서버부하 2배 + 동시연결 슬롯 잠식. 일괄 생성 시 광고주 수만큼 누적.
- **수정안:** advanced-report를 1번 호출하고 rows를 `nccCampaignTp`로 클라이언트에서 파워링크/쇼핑검색 분리 후 각 type에 기존 topN 슬라이싱/그룹핑 적용. 호출·페이지네이션 절반.

### [x] R6. enrichRanks 순위 맵 키 불일치 — 띄어쓰기/영문 대문자 키워드 예상순위 폐기 (medium, 정확성+낭비)
- **위치:** `src/content/setup.ts:352`(set) vs `359`(get)
- **원인:** 응답을 `rankByKeyword.set(vc.keyword, ...)`로 원본(trim만) 키워드로 저장하는데, 조회는 `rankByKeyword.get(normalizeKeyword(k.keyword))`로 정규화 키 사용. `normalizeKeyword`(`storage-keys.ts:33`)는 NFC+공백 전부 제거+소문자화. 따라서 공백 포함("캠핑 의자")·영문 대문자("Nike") 키워드는 set/get 키가 달라 항상 miss → rank=null. 공백 없는 한글 단일 키워드만 우연히 일치.
- **체감:** 순위 보강은 전체에서 가장 느린 구간(background 5개 배치 + 배치마다 300ms + 429 백오프)인데, 이 비싼 호출로 받아오고도 다단어·영문 키워드는 매칭 실패로 통째로 버림 → 네트워크·시간 낭비 + 엑셀 예상순위 칸 "-". 한국 검색광고는 다단어·브랜드 영문 비중이 높아 흔함.
- **수정안:** set 측도 정규화: `rankByKeyword.set(normalizeKeyword(vc.keyword), vc.rank_to_bid)`. 양쪽 모두 normalizeKeyword로 공백·대소문자·NFC 차이 흡수. 1줄 수정.

### 신규 low / negligible 일람 (R7~R28)

| # | 등급 | 위치 | 원인 요약 | 수정안 요약 |
|---|------|------|-----------|-------------|
| R7 | low | `multi-account.ts:1284·1304·1318·1719·1724·1746·1751`, `multi-account-storage.ts:38-51,75-91` | 일괄 추가/삭제/알림설정이 계정마다 `for...await` 직렬 read-modify-write → N번 get+set + set마다 onChanged | 배치 헬퍼(`addAccountsToList`/`updateUserMetaMany`)로 load 1회+save 1회 |
| R8 | low | `multi-account.ts:790-812,815,843-899` | 전체계정 검색 input 키 입력마다 tbody 전체 행 재빌드(디바운스 없음) | 120~150ms 디바운스 또는 `dataset.searchHaystack` display 토글 |
| R9 | low | `asset-bulk-popup.ts:706-753`, `product-page-scrape.ts:133-141` | 6열 60px 타일에 1000x1000 원본 이미지 src 로드 → 메모리 스파이크 | 표시용 소형 CDN variant src, 업로드용 o1000은 별도 보관(variant 정상응답 실측 선행) |
| R10 | low | `report-build.ts:156-165,451`, `report-gfa.ts:66-156` | 현재 기간 `fetchGfaData`를 2번 실행(`fetchGfaTotal` + 직접 호출), dedup/캐시 없음 | 현재 기간 1회 호출해 `.total` 재사용, 전주만 `fetchGfaTotal` 유지 |
| R11 | low | `setup.ts:377-406`, `setup-excel.ts:206-227`, `background/index.ts:153-191` | 쇼핑 소재 이미지를 원본 해상도로 엑셀 임베드(60px 표시인데 풀사이즈 보관·전송·저장) | pstatic `?type=fNNN` 소형 variant 또는 OffscreenCanvas 다운스케일 |
| R12 | low | `report-build.ts:440-459` | `fetchBrandContracts` 3-hop 체인을 메인 Promise.all 앞에서 직렬 블로킹 | brand promise를 비-brand 수집과 동시 출발, 소비처에서 각자 await |
| R13 | low | `report-build.ts:300-331` | time-contracts가 파라미터 무시·계정 전체 반환인데 chunk마다 직렬 재요청 → 전부 dedup으로 버려짐 | chunk 루프 제거, 1회만 호출(dedup 유지) |
| R14 | low | `background/index.ts:109-147,211-226`, `product-page-extract.ts:40-65` | hidden tab 상품 스크레이프에 취소/single-flight 가드 없음 → 팝업 닫아도 ~15.8초 로딩 | in-flight tabId 추적 + 새 요청 시 이전 탭 제거, teardown에 취소 메시지 |
| R15 | low | `product-page-scrape.ts:47-56,70-81,217-298` | 정적 SSR PRELOADED_STATE 대형 JSON을 재시도 루프에서 최대 9회 반복 파싱 | inline state 파싱을 루프 밖 1회+캐시, 실패 시 DOM fallback만 재시도 |
| R16 | low | `period-compare-adapters.ts:387-396`, `period-compare.ts:90-91,166-168` | 캡처마다 전체 정규화(팝오버 안 열어도) + path-3 배열 합산 상한 없음 + pickBestCapture 재계산 | 캡처 시엔 얕은 판정만, 추출은 팝오버 열 때 + 결과 캐시 + path-3 상한 |
| R17 | low | `setup.ts:97-104,59-63` | 세팅안 모달 keydown(Escape) capture 리스너가 닫을 때 미해제 → 세션 내 누적 | 핸들러를 변수 보관하고 `closeModal`에서 removeEventListener |
| R18 | low | `report-datepicker.ts:137-174,196-215,254-267` | 달력 ~600셀 전수 순회 paint + scroll에서 offsetTop 반복 읽기(throttle 없음) | 증분 강조 갱신, scroll rAF throttle + offsetTop 사전 캐시 |
| R19 | low(중간 confidence) | `manifest.config.ts:50`, `index.ts:1094-1110` | `all_frames:true`로 상단 문서 전용 init(멀티계정·asset-bulk·shopping)이 서브프레임에서 헛돔 + 300ms 인터벌 프레임마다 | 상단 전용 init을 `if(window.top===window)` 가드(period-compare·F001은 제외) |
| R20 | ~~low~~ 되돌림 | `index.ts:178-180` | ensureBadge가 `getComputedStyle` 읽고 곧바로 `style.position` 써서 신규 셀마다 강제 style recalc 교차 | ~~조건 없이 설정~~ → **되돌림.** 키워드 셀이 sticky 고정 열이라 무조건 relative가 sticky를 덮어 레이아웃 깨짐. getComputedStyle static 가드 유지(제거 금지) |
| R21 | low | `background/index.ts:355-357,372-378` | 결과 재정렬에 `fresh.find` 선형 탐색 → 콜드 캐시면 O(n²) | `fresh`를 Map으로 인덱싱해 O(1) 조회 |
| R22 | low | `background/index.ts:54-71,262-358` | GET_BID_ESTIMATE에 in-flight 코얼레싱 없음 → 동시 동일 요청이 캐시 우회(멀티탭/프레임) | `Map<string,Promise>`로 진행 중 fetch 공유. R2의 background 짝 |
| R23 | negligible | `report-build.ts:99-103,157,159,335-372` | 파생 가능한 집계를 별도 호출(total은 ymd 합, 유형요약은 캠페인-그룹 합산) | ymd 합산으로 total 도출, 유형요약 재집계(합계 정합 검증 선행) |
| R24 | negligible | `multi-account-data.ts:491-497` | collectAccount가 계정마다 `loadPlatformFilter` storage 중복 조회 | 모듈 전역 platformFilter 재사용/인자 주입 |
| R25 | negligible | `searchad.ts:217-234` | HMAC CryptoKey를 매 호출 importKey 재생성 | secret 기준 모듈 레벨 CryptoKey 캐시 |
| R26 | negligible | `toast.ts:48-50,109-117` | 토스트 큐 초과 제거 시 자동 닫힘 setTimeout 미해제(orphan) | 카드에 타이머 id 보관 후 evict 시 clearTimeout |
| R27 | negligible | `background/index.ts:211-226` | waitForTabComplete 타임아웃 타이머를 조기 완료 시 clearTimeout 안 함 | 핸들 보관 후 finish()에서 clearTimeout |
| R28 | negligible | `background/index.ts:195-203` | arrayBufferToBase64가 청크마다 `Array.from`으로 32K 배열 불필요 할당 | Uint8Array subarray를 fromCharCode.apply에 직접 전달 |

> **재감사 적대적 검증 메모:** 후보 34건 중 5건 탈락. 그중 3건(고정 sleep throttle / `get(null)` 전체 역직렬화 / stats·디렉터리 직렬 페이지네이션)은 1차 감사 #2/#7/#8과 **동일 메커니즘**으로 판정 → 1차 감사가 해당 패턴을 이미 정확히 잡아둔 것이 역으로 확인됨. 나머지 2건은 도달 불가능 경로 또는 negligible.

---

## 1차 감사 — 손볼 가치 있음 (중간 등급) (2026-06-25)

### [x] 1. 다계정 새로고침 시 저장소 읽기 폭증 (최우선)
- **위치:** `src/content/multi-account.ts:1765-1822`, `src/lib/multi-account-storage.ts:118-124`
- **원인:** `refreshBadge`가 호출될 때마다 모든 계정 스냅샷을 **하나씩 순차로** 읽음(`loadSnapshot` 단건 `chrome.storage.local.get(key)`). 그런데 저장소 변경 리스너(`registerStorageListener` 1808-1822)가 스냅샷 저장마다 `refreshBadge`를 다시 트리거 → "↻ 전체" N계정 새로고침 = 약 2N번 배지 재계산 × 각 N회 순차 읽기 = **계정 수 제곱에 가까운 storage get**.
- **체감:** 30~50계정 대행사에서 전체 새로고침 중 처리 지연·배지 갱신 늦음. (5~10계정이면 무시 가능)
- **수정안:**
  1. `refreshBadge`에 디바운스(250ms) → 연속 저장 burst를 1회 재계산으로 합침.
  2. `loadSnapshotMany(nos[])` 배치 헬퍼 추가 → `chrome.storage.local.get(키 배열)` 1회로. `renderListView`(512)·`refreshBadge`(1776) 호출부 교체.
  3. `refreshRow`가 직접 `refreshBadge` 부르는 1642는 리스너와 중복 → 디바운스 도입 후 제거 검토.

### [x] 2. F001 첫 로딩 지연 — 직렬 배치 + 배치마다 고정 0.3초 대기
- **위치:** `src/lib/searchad.ts:33-66, 280-311, 443-472`, `src/background/index.ts:288-323`
- **원인:** 예상 입찰가/성과 조회가 키워드 5개씩 묶어 **순차로 하나씩** 호출 + 배치 사이 `sleep(300)` 고정 대기. 입찰가 단계와 성과 단계 둘 다 끝낸 다음에야 결과 일괄 반환(중간 스트리밍 없음).
- **체감:** 키워드 많은 페이지(50개) 첫 표시까지 수 초. 단, 캐시 후 이후엔 빠름.
- **주의:** 0.3초 대기·직렬 처리는 검색광고 API 호출제한(429) 회피용 **의도적 안전장치**. 무작정 제거 금지.
- **수정안(트레이드오프, 적용 전 429 실측 필요):** 완전 직렬 → 동시 2~3개 제한 병렬 풀(체감 2~3배↓, 점잖음 유지). 또는 입찰가 받는 즉시 먼저 그리고 성과는 나중에 채우기. (재감사 R2·R22 in-flight 가드와 묶어서 처리 권장.)

### [ ] 3. 전후비교 버튼 — 날짜 picker 없는 페이지에서 전체 문서 스캔
- **위치:** `src/content/period-compare.ts:308-327`(mountButton), `219-251`(findDateRangeContainer)
- **원인:** `mountButton`이 `/reports`만 제외하고 그 외 모든 페이지에서 DOM 변경마다 `findDateRangeContainer` = **문서 전체 텍스트 노드 끝까지 순회 + 노드별 날짜 정규식**. 날짜 picker 있는 페이지는 조기 종료+버튼 생존 가드로 저렴하나, picker 없는 페이지는 매번 전체 스캔이 끝까지 돔. 주석(305행)은 "캠페인 리스트·광고그룹에서만 표시"인데 코드는 화이트리스트를 강제 안 함(의도/구현 불일치).
- **체감:** 페이지 멈춤은 아니고 자원 낭비.
- **수정안:** `mountButton` 앞에 `/sa/campaigns-by/`·`/sa/adgroups/` 양성 경로 가드 추가 → 대상 페이지 아니면 전체 스캔 자체 skip. 주석 의도와 일치.

### [ ] 4. 리포트 엑셀 — 셀 하나 쓸 때마다 시트 전체 문자열 재치환
- **위치:** `src/lib/report-excel.ts:64-108`(replaceCell/setNumber/setString), `515-559`(centerCells/addCenteredStyle), `src/lib/report-fill.ts`, `src/lib/report-variable.ts`
- **원인:** 시트 XML을 단일 거대 문자열로 두고 셀 값 하나 넣을 때마다 **문자열 전체를 정규식 스캔+치환**. 상세 시트 하나에 250회+ 반복, 가운데정렬(`centerCells`)에서 또 전체 훑음. `addCenteredStyle`은 styles.xml read-modify-write.
- **체감:** 주간 단일 리포트 30~50ms(앞단 네트워크에 묻혀 체감 0). 월간(일자 행 확장)·다계정 일괄에서 누적.
- **수정안:** 셀별 전체 치환 → 시트당 패치 맵 모아 **단일 패스** 적용(`applyCellsBulk`). 값 주입 시점에 가운데정렬 스타일 직접 부여해 사후 `centerCells` 패스 제거. 우선순위 낮음.

---

## 1차 감사 — 자원만 약간 낭비 (체감 거의 없음, 여유 될 때) (2026-06-25)

### [x] 5. 팝오버 열린 동안 매 프레임 헛도는 reposition 루프
- **위치:** `src/content/index.ts:309-371`, `src/content/period-compare.ts:451-456`
- **원인:** 팝오버 열려 있는 내내 rAF 루프가 매 프레임 `reposition()` → `document.querySelectorAll(".dvads-popover")` + `getBoundingClientRect` + 좌표 안 바뀌어도 `transform` 무조건 재기록.
- **수정안:** 계산한 left/top을 직전값과 비교해 변화 있을 때만 transform 쓰기. querySelectorAll은 루프 밖으로/throttle. (팝오버 열린 짧은 동안만이라 우선순위 낮음)

### [ ] 6. document 전체 MutationObserver 6~7개 fan-out + URL 옵저버 중복
- **위치:** `src/content/index.ts:902,1109-1120`, `src/content/period-compare.ts:1229-1242`, `src/content/asset-bulk.ts:41`, `src/content/shopping-image-import.ts:68`
- **원인:** document/body에 childList+subtree 옵저버 6~7개가 DOM 변경마다 동시에 깨어남. URL 감시 옵저버가 index.ts·period-compare.ts 2곳에서 같은 lastUrl 비교 중복.
- **체감:** 대부분 rAF/플래그 디바운스로 실작업 막혀 있어 자원 낭비 수준.
- **수정안:** URL 감시는 한 곳으로 통합 후 각 모듈 navigation 핸들러 호출. mount 옵저버는 단일 옵저버+구독자 패턴.

### [ ] 7. 캐시 정리 시 저장소 전체 역직렬화
- **위치:** `src/lib/cache-prune.ts:38-61`
- **원인:** `pruneExpiredCache`가 `chrome.storage.local.get(null)`로 자격증명·다계정 스냅샷까지 통째로 읽고 캐시 4개 prefix만 사용.
- **체감:** 시간당 1회, background라 페이지 영향 0. 다계정 스냅샷 수백KB~MB로 커지면 재검토.
- **수정안:** 캐시 키 인덱스 별도 관리 또는 캐시류 별도 storage area 분리. 현 시점 보류 가능.

### [x] 8. 다계정 계정별 internal API 직렬 체인 (대형 계정 stats 청크)
- **위치:** `src/lib/multi-account-data.ts:290-309`(fetchYesterdayStats 청크 직렬), `491-551`(collectAccount)
- **원인:** stats 청크 루프가 `for(i+=80){ await }` 직렬. (GFA campaignStats는 이미 병렬)
- **체감:** 캠페인 200~300개 대형 계정에서만 꼬리 지연. 전형 계정은 2~3 RTT 고정이라 영향 미미.
- **수정안:** `fetchYesterdayStats` 청크 루프를 `Promise.all` 병렬로(GFA에서 검증된 패턴).

### [x] 9. 쇼핑 이미지 스캔 페이지 가드 부재
- **위치:** `src/content/shopping-image-import.ts:66-81`
- **원인:** `scan()`에 location 조기 가드가 없어 쇼핑 소재 모달 무관 페이지에서도 DOM 변경마다 `querySelectorAll(".AdShoppingEditModal")` 실행. (index.ts·asset-bulk.ts는 가드 있음)
- **체감:** 단일 클래스 매칭이라 무시 수준. 코드 일관성/위생 차원.
- **수정안:** `scan()` 진입부에 쇼핑 소재 URL 패턴 조기 검사 추가.

### [x] 10. 키워드 정규화 2회 중복 호출
- **위치:** `src/lib/volume-cache.ts:22-35`, `src/lib/performance-cache.ts:27-33`
- **원인:** 조회 루프에서 같은 키워드에 `keyForVolumeCache`/`keyForPerformanceCache`(내부 NFC 정규화)를 2번 호출.
- **체감:** background, 키워드당 1ms 미만. 무시 수준.
- **수정안:** `[키워드, 키]` 쌍을 한 번만 계산해 재사용.

### [x] 11. 칩 탐색 시 전체 span 스캔
- **위치:** `src/content/multi-account.ts:251-283`(findOperationChip)
- **원인:** 캐시 미스 시(헤더 로딩 중) 300ms마다 `document.querySelectorAll("span")` 전체 순회 + 텍스트 비교.
- **체감:** 캐시가 대부분 커버. 미스 구간만 간헐적, 수십µs~수ms. 무시 수준.
- **수정안:** 매칭 실패 연속 시 tick 간격 백오프(필요 시).

---

## 안심해도 되는 부분 (수정 불필요)
- `fetch-patch-main.ts` — 무거운 작업 전 URL 화이트리스트로 선필터. 일반 요청엔 가벼운 검사만.
- `dom-bid.ts`·`dom-asset.ts` 자동화 — `waitFor`는 이벤트 기반(MutationObserver, 조건 맞으면 즉시 종료), 고정 지연은 50~120ms 의도적 UI 안정화. 사용자 1건씩 트리거라 핫패스 아님.
- 캐시·worker pool·렌더 원자 교체·token guard — 깨끗.

---

## 진행 메모
- 1차 점검일: 2026-06-25 / 2차 재감사: 2026-06-26 (7개 영역 병렬 + 적대적 검증, 신규 28건)
- **통합 권장 착수 순서: 상단 "통합 우선순위" 표 참조** (신규 R1 high가 새 1순위)
  - 빠른 효과·낮은 위험: R1 → #1 → R3 → #3 → R6 → R5
  - 429 실측 선행 묶음: R2 + #2 + R22
  - 라이브 확인 선행: R4(디스플레이 토큰버킷 계정 간 공유 여부)
- 수정 후 항상 `npm run typecheck` → `npm run build`로 `dist/` 갱신.
- `tsc -b` stale 캐시 의심 시: `rm -f tsconfig.*.tsbuildinfo && npm run typecheck`.
