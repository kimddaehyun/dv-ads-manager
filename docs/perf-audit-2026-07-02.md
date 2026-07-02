# 성능/속도 점검 결과 (2026-07-02, 3차 감사)

> dv-ads 전체 성능·효율 감사 3차. 관점 6개(유휴/누수/네트워크/번들/렌더/스토리지) 병렬 점검 + 기존 감사(docs/perf-audit-2026-06-25.md) 항목 재검증 + 발견별 교차 검증(단독 보고된 medium 이상은 코드 재확인)을 거친 결과.
> 점검 범위: 전체 코드 + 특히 2026-06-26 이후 신규 커밋(F-AgencyCheck·리포트 날짜선택기·캠페인 시트 3단계 f3739a4 / 디스플레이 50건 한도 0172c78 / F-MultiAccount 그룹 탭 6d527e6 / 표지 도면 530f7d0).
> 이번 감사는 점검·보고까지만 - 코드 미수정.

---

## ① 요약

**한 줄 결론: 상시 브라우저를 느리게 하는 high급 병목은 없다(지난 R1 수정 유지 확인). 이번에 잡힌 것은 "특정 동작이 필요 없는 네트워크·초기화 비용을 2배 안팎으로 낭비하는" medium 4건과 위생성 low 다수이며, 기존 [x] 수정 14건은 이후 커밋에 의한 훼손 0건으로 전부 유효하다.**

최우선 3건:
1. **N1 - 세팅안 예상순위 보강이 안 쓰는 성과 API까지 강제 호출** (medium, 확실): 세팅안 생성 시 검색광고 API 호출 ~20% 낭비 + 완료 시간 지연 + 429 확률 상승 + 안 읽을 캐시 수천 건 저장. 플래그 1개로 차단 가능.
2. **N2 - 다계정 "새로고침"(전체 강제 재수집)에 재진입 가드 없음** (medium, 확실): 유일한 중복 방지 장치가 코드 어디서도 생성되지 않는 버튼 셀렉터(죽은 가드). 진행 중 한 번 더 누르면 계정당 ~10콜 × N계정이 통째로 이중 발사.
3. **N4 - multi-account 초기화(디렉터리 갱신 등)가 URL·프레임 가드 없이 모든 페이지·모든 iframe에서 실행** (medium, 경로 확실/배수 추정): 아침 탭 복원처럼 디렉터리가 stale한 순간에 광고계정과 무관한 페이지·프레임마다 계정 전체 명단 fetch가 중복 발화. 기존 R19(window.top 가드)의 가장 비싼 구체 사례.

---

## 구현 결과 (2026-07-02)

감사 직후 확정 수정 11건 전부 구현 → `npm run typecheck` / `npm run build` 통과. dist/ 갱신됨(미커밋).

- **구현 완료(11건):** N1(skipPerformance 플래그: messages.ts + background 2·3단계 생략 + setup 전달), N2(refreshAllStale in-flight 가드 - refreshAllStaleImpl 분리), N3(autoUpdateActiveAccount 계정번호 Set 가드), N4+N6(multi-account를 index.ts에서 top frame + `/manage/ad-accounts/` URL 게이트로 동적 import - 초기 번들 제외와 iframe·무관 페이지 실행 차단 동시 해결, SPA 후진입은 URL 옵저버에서 `maybeInitMultiAccount` 재시도), N5(cache-prune에 snapshot prefix 7일 TTL + 계정 삭제 4경로에 `clearSnapshots` 배치 헬퍼 연결), N8(syncMount 버튼·컨테이너 생존 시 조기 return), N10(`cacheGetFresh` 헬퍼로 in-memory 캐시 4h TTL 검사+만료 삭제, 조회 7곳 교체), N11(대행권 검색 140ms 디바운스), N12(잔존 popover 안전망 500ms 스로틀), N14(refreshAllStale/backgroundRefreshStale 시작 시 필터·메타 1회 로드 → refreshRow/collectAccount 인자 주입 - R24 연결 완료).
- **측정된 효과(N6):** 콘텐츠 본체 청크 164.3KB → **109.5KB**(-33%), multi-account 60.6KB가 lazy 청크로 분리. 프레임당 초기 주입 JS ~236KB → **~181KB**.
- **의도된 동작 변화 4가지:** ①오래 켠 탭이 4h 지난 낡은 입찰가 대신 재조회(N10) ②새로고침 진행 중 재클릭 무시(N2) ③7일 미갱신 스냅샷 자동 정리·계정 삭제 시 스냅샷 동시 삭제(N5) ④세팅안이 성과 캐시를 부수적으로 데워주던 효과 소멸(N1). 그 외 산출물·UX 동일.
- **수정 안 함(감사 시 판단대로):** N9·N13·N15·N16(제품 의도 유지)·N18(라이브 확인 선행)·E-3·N19·N20, 기존 #3(화이트리스트 라이브 확정 선행)·#4·#6·#7·R9/R11·R14·R18 잔여·R23.

### 라이브 측정 (2026-07-02, GFA 다운로드 POST 403 rate-limit)

리포트 속도의 지배 요인인 디스플레이 상세 7초 게이트(`report-gfa-detail.ts` POST_GAP_MS)의 근거를 로그인된 실브라우저 페이지 컨텍스트에서 재측정 (계정 2342598/404590, 실제 확장과 동일한 요청 형태·헤더).

| 시나리오 | 결과 |
|---|---|
| 서로 다른 두 계정 동시 POST (8ms 차) | 둘 다 200 |
| 같은 계정 2초 간격 | 200 |
| 같은 계정 0.2~0.3초 간격 8연사 | 전부 200 |
| 31일 범위 보고서 6연사 | 전부 200, 5초 내 전부 생성 완료 |
| 총량 | 19 POST / 약 2.5분, **403 0건** |

**결론: 2026-06-24에 측정됐던 "1.5초 간격 403"이 현재는 어떤 조건에서도 재현되지 않는다.** 7초 전역 게이트는 현시점 과잉 보수. 단 6/24의 403은 실재했으므로(시간대·물량 조건부 제한 또는 정책 변경 가능성), 게이트를 삭제하지 말고 **간격 대폭 축소(0.5~1초) + 403 시 8초 백오프 후 1회 재시도(adaptive)** 형태로 바꾸는 것을 권장. 예상 효과: 디스플레이 상세 계정당 ~28초 → ~3-6초, 일괄(디스플레이 10계정) 디스플레이 구간 ~5분 → ~30초-1분. 주의: 오늘 표본은 19 POST — 일괄 30계정×4=120 POST 규모에서 시간당 총량 제한이 있을 수 있어 adaptive 백오프가 보험. 테스트 생성 다운로드 19건은 전부 삭제 완료(기존 항목 무접촉).

**→ 적용 완료(2026-07-02, 같은 날):** ①`report-gfa-detail.ts` 게이트 간격 7000→1000ms(`POST_GAP_FAST_MS`), 403 발생 시 세션 내 7초(`POST_GAP_SAFE_MS`) 복귀 + 8초 백오프 후 1회 재시도. ②`report-build.ts` 디스플레이_상세를 SA 수집(Promise.all)과 겹쳐 시작 — `gfaCurP` 확인 즉시 `detailP` 출발, 소비는 기존 위치(graceful 동일). 진행 팝업(완료 N/M 카운트)은 계정 완료 단위라 기존과 동일하게 표시됨. typecheck/build 통과, 미커밋.

### 검증 권장 (라이브)
- **다계정:** `/manage/ad-accounts/` 진입 시 버튼 정상 mount(동적 로드 후 첫 표시까지 최대 ~0.3초 지연은 정상), 무관 페이지(리포트·설정)→광고계정 페이지 SPA 전환 시에도 버튼 뜨는지(N6 로더), "새로고침" 정상 + 진행 중 재클릭 무시(N2), 계정 상세 탭 빠른 연속 클릭 시 Network에 `bizmoney/account` 중복 없는지(N3).
- **세팅안:** 예상순위가 기존과 동일하게 채워지는지 + SW Network에서 `performance-bulk` 호출이 사라졌는지(N1).
- **F001:** 배지·팝오버·디바이스 토글 정상(N10 캐시 헬퍼 교체 영향 확인), 팝오버 연타 시 잔존 팝오버 없는지(N12).
- **대행권 점검:** 결과 화면 검색 타이핑 정상(N11).

---

## ② 통합 우선순위 (신규 N + 기존 미착수 재평가)

| 순위 | 항목 | 등급 | 한 줄 | 위험/선행조건 |
|------|------|------|-------|----------------|
| 1 | **N1** 세팅안 성과 API 낭비 | medium | GET_BID_ESTIMATE가 항상 2단계 성과 조회까지 수행, setup은 안 씀 | 낮음(메시지 플래그 1개) |
| 2 | **N2** 새로고침 재진입 가드 부재 | medium | 죽은 버튼 셀렉터가 유일한 가드 - 2연타 시 전체 수집 이중 발사 | 낮음(boolean 1개) |
| 3 | **N4** multi-account 초기화 무가드 (기존 R19 흡수·상향) | medium | 전 페이지·전 프레임에서 디렉터리 갱신 + 300ms 인터벌 | 낮음~중(top frame에서 리스너 필요 여부 확인) |
| 4 | **N6** 콘텐츠 본체 청크 164KB - multi-account lazy 분리 | medium | R3 스플릿은 유지, 본체 재증가 원인은 multi-account +1,243줄 | 낮음(버튼 mount 판별만 본체에 잔류) |
| 5 | **N3** 자연 캐싱 in-flight 가드 부재 | low~medium | 계정 내 연속 페이지 이동 시 동일 계정 수집 2~3중 실행 | 낮음(계정번호 키 가드) |
| 6 | **N5** `multi_account_snapshot:*` 키 무정리 | low~medium | 방문한 모든 계정의 스냅샷이 영구 잔존(prune·삭제 경로 전무) | 낮음(prune prefix 추가, TTL 별도 정책) |
| 7 | **#3** 전후비교 비대상 페이지 전체 스캔 (기존, 수정안 갱신 필요) | medium | 여전히 유효 - 단 화이트리스트가 dashboard·전체캠페인·GFA 경로까지 넓어져 기존 수정안은 stale | 화이트리스트 라이브 확정 선행(기존과 동일) |
| 8 | **N11** 대행권 결과 검색 디바운스 부재 | low(현)~medium(300계정) | R8과 동일 패턴, 신규 모달만 미적용 - 한 줄 수정 | 낮음 |
| 9 | **N7** overlay.css 67.5KB 전 프레임 주입 | low~medium | +1,039줄 증가분 포함 특정 페이지 전용 스타일이 전 페이지 파싱 | 중(crx CSS 분리 동작 검증 필요) |
| 10 | **N16** 대행권 점검의 스냅샷 무시 재조회 | low | fresh 스냅샷에 있는 비즈머니·어제 광고비를 계정당 2콜 재요청 | "점검은 최신값" 제품 의도 확인 선행 |
| 11 | 나머지 신규 low (**N8·N9·N10·N12·N13·N14·N15·N18·E-3**) | low | 자원 위생(아래 상세) | 낮음 |
| 12 | 기존 유지 (**#4·#6·#7**, R9/R11 보류, **R23**+C-5 병합) | low~negligible | 재평가 결과 등급 변동 없음(#4는 3단계 확장에도 비용 증가 0 확인) | 기존과 동일 |
| 13 | 하향 (**R14**, **R18 잔여**) + negligible (**N19·N20**) | negligible | 실사용 도달 빈도·비용 재평가로 하향 | - |

---

## ③ 발견 상세 (신규)

### N1. 세팅안 예상순위 보강이 안 쓰는 성과(performance) API까지 강제 호출 (medium, 확실)
- **위치:** `src/content/setup.ts:324-369`(enrichRanks), `src/background/index.ts:263-324`(handleGetBidEstimate 2·3단계)
- **원인:** `enrichRanks`는 background `GET_BID_ESTIMATE` 응답에서 `resp.data`(순위별 입찰가)만 사용하고 `resp.performance`는 한 번도 읽지 않는다(setup.ts 전체에 참조 0건, grep 확인). 그런데 `handleGetBidEstimate`는 분기 없이 항상 2단계로 bid 결과의 모든 순위 입찰가(키워드당 최대 10개)를 펼쳐 `fetchPerformanceWithCache`(`POST /estimate/performance-bulk`)까지 호출한다(background/index.ts:293-316). 요청 메시지에 스킵 옵션이 없다. **(직접 코드 재확인 완료.)**
- **체감:** 키워드 1,500개 계정 세팅안 생성 시 bid 배치 300회는 필수지만 성과 배치 최대 ~75회가 전부 낭비. 검색광고 API 호출량 +20% 안팎, 동시성 2 풀이라 세팅안 완료 시간도 그만큼 늘고 429 확률 상승. 부수적으로 안 읽을 `performance_cache:*` 엔트리 수천 개가 storage(5MB quota)에 쌓임.
- **수정안:** `GetBidEstimateRequest`에 `skipPerformance` 플래그(또는 별도 메시지 타입)를 추가해 setup 경로에선 1단계(bid)만 수행.
- **확신도:** 확실.

### N2. 다계정 "새로고침"(전체 강제 재수집) 재진입 가드 부재 + 죽은 버튼 셀렉터 (medium, 확실)
- **위치:** `src/content/multi-account.ts:2604-2647`(refreshAllStale), `2606`(죽은 셀렉터), 진입점 `2240` 부근(kebab 메뉴 "새로고침")
- **원인:** `refreshAllStale`(force:true)에 in-flight 플래그가 없다. 유일한 중복 방지 장치는 `.dvads-multi-refresh-all` 버튼 disable인데, 이 클래스로 버튼을 **생성하는 코드가 없다**(코드베이스 전체에서 querySelector 1곳뿐 - 옛 "↻ 전체" 버튼이 kebab 메뉴로 흡수되면서 셀렉터만 남은 죽은 가드). **(grep으로 직접 재확인 완료.)** 비교: 자동 갱신 쪽(`backgroundRefreshStale`)은 in-flight 플래그가 있음.
- **체감:** 계정 30개 대행사에서 "새로고침" 진행 중(계정당 ~10콜 × 30 = ~300콜, 4-worker로 30~60초) 메뉴를 다시 열어 한 번 더 누르면 워커 8개가 같은 300콜을 이중 발사 - 순간 동시 요청 ~20+개로 internal API 부담·차단 위험 2배.
- **수정안:** `backgroundRefreshStale`과 동일한 in-flight boolean 가드 1개 추가. (죽은 셀렉터 `.dvads-multi-refresh-all`은 관련 없는 데드코드로 언급만 - 정리 여부는 별도 판단.)
- **확신도:** 확실. 재현 검증: Network 탭에서 "새로고침" 2연타 시 `/apis/sa/api/ncc/campaigns`가 계정당 2세트 찍히는지.

### N3. 자연 캐싱(autoUpdateActiveAccount) in-flight 가드 부재 - 계정 내 연속 이동 시 동일 계정 수집 다중 실행 (low~medium, 확실)
- **위치:** `src/content/multi-account.ts:96-104`(onTick URL 변경 트리거), `129-156`(autoUpdateActiveAccount)
- **원인:** 300ms tick에서 URL이 바뀔 때마다 호출. fresh 스냅샷(1h TTL) 체크(133-134)는 있지만 in-flight 가드가 없어, `collectAccount` 1회(캠페인 5콜+stats+bizmoney+GFA ≈ 10콜, 수 초)가 도는 동안 같은 계정 안에서 캠페인 목록→그룹 상세→키워드 탭처럼 URL이 연속으로 바뀌면 매번 fresh 체크를 통과해 동일 계정 수집이 2~3개 동시 실행된다. **(직접 코드 재확인 완료.)**
- **체감:** 계정 상세를 빠르게 훑는 일상적 탐색 패턴에서 계정당 10콜이 20~30콜로 증폭. 상시 발생 경로라 누적 낭비 큼.
- **수정안:** 계정번호 키 in-flight Map(또는 boolean+계정번호) 가드 추가.
- **확신도:** 가드 부재는 확실. 증폭 실측: Network 탭에서 계정 상세 내 탭 3연속 클릭 시 `bizmoney/account` 요청 횟수 확인.

### N4. multi-account 초기화가 URL·프레임 가드 없이 전 페이지·전 iframe에서 실행 (medium, 경로 확실/배수 추정) - 기존 R19 흡수
- **위치:** `src/content/multi-account.ts:86-123`(initMultiAccount - 119 `ensureDirectoryFresh`, 108 `setInterval 300ms`, 93 storage 리스너), 호출부 `src/content/index.ts:1150` 부근(무조건 호출), `manifest.config.ts:50`(all_frames:true)
- **원인:** `initMultiAccount`에 top-frame 가드가 없다(`syncMount` 내부에만 `window === window.top` 체크, 211행). 그래서 (a) `ensureDirectoryFresh()`가 광고계정과 무관한 페이지(리포트·설정 등) 포함 모든 페이지·모든 same-origin iframe에서 실행 - 디렉터리 stale(24h) 시 계정 50개당 1회 페이지네이션 fetch가 프레임·탭 수만큼 중복 가능(in-flight 가드 `directoryFetchInFlight`는 프레임당 변수라 프레임 간 중복을 못 막음). (b) 300ms 인터벌·storage onChanged 리스너가 프레임마다 영구 등록(iframe에선 조기 return이라 개별 비용은 낮지만 타이머 자체는 상주). **(직접 코드 재확인 완료.)** 참고: `autoUpdateActiveAccount` 자체는 `extractActiveAdAccountNo()`가 null이면 즉시 return이라 URL 게이트가 있음 - 무가드는 디렉터리 갱신과 인터벌 쪽.
- **체감:** 아침에 대행사 직원이 ads.naver.com 탭 여러 개를 복원하면(디렉터리 24h stale) 탭·프레임마다 광고계정 전체 명단 fetch가 동시 발화. 계정 100개면 탭당 2~3콜 × 탭/프레임 수의 불필요 호출 + storage 쓰기 경합.
- **수정안:** `initMultiAccount` 첫 줄에서 `window !== window.top`이면 return(단 top 아닌 프레임에서 message/storage 리스너가 필요한 기능이 있는지 선확인). 디렉터리 갱신은 `ADACCT_URL_PATTERN` 페이지에서만 + 탭 간 중복은 storage에 fetch 시각 마킹으로 완화.
- **확신도:** 코드 경로 확실. iframe 배수는 추정 - 광고관리자 페이지 DevTools에서 same-origin frame 수 확인 필요.

### N5. `multi_account_snapshot:*` storage 키가 어떤 정리 경로에도 안 잡혀 영구 잔존 (low~medium, 확실 - 관점 B·F 독립 교차 확인)
- **위치:** `src/lib/cache-prune.ts:26-31`(CACHE_PREFIXES에 snapshot prefix 없음), `src/lib/multi-account-storage.ts:257-260`(clearSnapshot - export만 있고 **호출부 0건**), `src/content/multi-account.ts:129-156`(방문만 해도 스냅샷 생성), `2296-2299`·`2584-2588`(계정 삭제 시 스냅샷은 안 지움)
- **원인:** 스냅샷 TTL은 1시간인데 만료 후에도 키가 남는다. 주기 prune 미커버 + 계정 삭제 경로에서 미삭제 + 자연 캐싱이 "내 계정" 여부와 무관하게 방문한 모든 계정의 스냅샷을 생성. 삭제되는 경로는 플랫폼 필터 토글(`clearAllSnapshots`)과 옵션 "캐시 삭제" 버튼뿐 - 둘 다 명시적 사용자 액션.
- **체감:** 수백 계정을 오가는 대행사 사용에서 계정당 0.5~5KB(contracts 배열 포함) × 방문 이력 계정 수가 만료 상태로 상주 - 300계정이면 ~0.6-1.5MB가 5MB quota를 영구 점유. quota 근접 시 F001 키워드 캐시 set 실패로 번질 수 있고, #7(get(null) 전체 역직렬화) 비용도 같이 커짐.
- **수정안:** cache-prune 대상에 snapshot prefix를 **별도 TTL(예: 7일)**로 추가(1h를 그대로 쓰면 stale-while-revalidate 표시용 stale 스냅샷까지 지워지므로 주의) 또는 계정 삭제 흐름에 `clearSnapshot` 병행.
- **확신도:** 확실. 실측: SW 콘솔 `chrome.storage.local.getBytesInUse(null)` + `get(null)`에서 snapshot 키 수 세기.

### N6. 콘텐츠 본체 청크 164KB로 재증가 - 원인은 multi-account 비대화 (medium, 확실) - R3 훼손 아님
- **위치:** `dist/assets/index.ts-*.js` 168,271B(164KiB). 소스는 `src/content/index.ts:40`의 `initMultiAccount` 정적 import 체인 - `src/content/multi-account.ts`가 지난 감사 반영 커밋(ac58d6d) 이후 +1,243줄(현재 3,155줄, 대행권 UI + 그룹 탭), `multi-account-storage.ts` +143줄.
- **원인:** R3 코드스플릿 자체는 온전(④ 재검증 참조 - write-excel-file/fflate 흔적 본체에 0건). 하지만 `/manage/ad-accounts/` URL에서만 쓰이는 다계정 대시보드 코드(~40KB 추정, 본체의 1/4)가 정적 import라 모든 ads.naver.com 페이지·iframe에 실려온다. 반면 `report-datepicker.ts`(431줄)는 lazy report 청크로, `agency-check-excel.ts`는 동적 import(multi-account.ts:2005)로 정상 격리됨.
- **체감:** 모든 탭·모든 iframe마다 164KB 파싱+실행. 증가폭 자체는 +14KB로 완만하지만 multi-account가 계속 커지는 추세라 방치 시 본체가 다시 200KB대로 회귀할 궤적.
- **수정안:** URL 판별 후 `await import("./multi-account")` 지연 로드(버튼 mount 판별 최소 로직만 본체에 남김). N4의 top-frame 가드와 같이 처리하면 효과 중첩.
- **확신도:** 확실(dist import 그래프 + git diff 확인).

### N7. overlay.css 67.5KB가 모든 페이지·모든 iframe에 주입 (low~medium, 확실)
- **위치:** `dist/manifest.json` content_scripts css = `assets/index-*.css` 67,507B. 소스 `src/styles/overlay.css` 3,217줄 → 4,098줄(+1,039줄: 다계정 popover·그룹 탭·대행권 모달·세팅안 모달·날짜선택기 스타일 전부 한 파일).
- **원인:** JS와 달리 CSS는 코드스플릿이 없어 iframe마다 67.5KB 파싱 발생. `dvads-` prefix라 셀렉터 매칭 자체는 싸지만 파싱은 무조건.
- **체감:** 페이지당 1회성 파싱(수 ms) × 프레임 수. JS보다 영향 작음.
- **수정안:** 동적 import되는 모듈 쪽에서 `import "./x.css"`로 기능별 CSS를 lazy 청크에 분리(@crxjs가 청크 CSS로 분리해 첫 사용 시 주입하는지 빌드로 검증 선행) - 최소한 다계정/세팅안 블록만이라도.
- **확신도:** 크기·주입은 확실, 분리 방법은 빌드 검증 필요.

### N8. multi-account 300ms 상시 폴링 - 버튼이 살아있어도 매 tick DOM 질의 + rect 읽기 (low, 확실)
- **위치:** `src/content/multi-account.ts:108`(setInterval), `210-267`(syncMount - `findOperationChip()`이 먼저 217, "버튼 생존 시 skip"은 그 다음 224-230), `283-285`(캐시 히트 시에도 `getBoundingClientRect`)
- **원인:** 호출 순서 때문에 steady state(버튼 정상 mount)에서도 매 300ms 칩 질의 + rect 읽기가 실행된다. #11 백오프는 "칩 미발견" 경로만 커버. F001/F-PoP은 옵저버 기반인데 이 모듈만 폴링 방식.
- **체감:** 활성 탭에서 초당 ~3.3회 DOM 질의 + layout 읽기 상시. 개별 비용은 작지만 유휴 CPU가 0이 아니고, 무거운 페이지에서 rect 읽기가 reflow를 유발할 수 있다.
- **수정안:** syncMount 첫 줄에서 `buttonEl?.isConnected && 컨테이너.isConnected`면 즉시 return(칩 탐색 생략). N4의 iframe 인터벌 미시작과 세트.
- **확신도:** 확실(호출 순서 코드 확인).

### N9. 전체 갱신 중 다른 유휴 탭들의 storage 리스너 연쇄 재계산 (low, 확실)
- **위치:** `src/content/multi-account.ts:2864-2878`(onChanged 리스너 - 프레임마다 등록), `2808-2815`(refreshBadge 250ms 디바운스), `2817-2858`(refreshBadgeImpl - storage 읽기 3회)
- **원인:** 한 탭에서 전체 갱신(계정 수만큼 스냅샷 저장 연쇄)이 돌면 다른 모든 ads.naver.com 탭의 리스너가 각자 250ms 창마다 배지 재계산(loadAddedList+loadAllUserMeta+loadSnapshotMany)을 반복.
- **체감:** 탭 20개 상태에서 계정 100개 갱신이 도는 수십 초 동안 유휴 탭 19개가 각각 초당 최대 4회 페이스로 storage 읽기+임계값 계산.
- **수정안:** 디바운스를 1~2초로 상향하거나, 배지 버튼이 실제 마운트된(top frame) 문서에서만 리스너 등록.
- **확신도:** 경로 확실, 부하 크기는 계정·탭 수 비례(라이브 프로파일로 정량화 가능).

### N10. F001 in-memory 캐시(dataCache/perfCache) 무한 성장 + TTL 미적용 (low, 성장 확실/규모 추정)
- **위치:** `src/content/index.ts:97-99`(모듈 전역 Map, eviction 없음), `208`(조회 시 `fetched_at` 미확인), `1163`(SPA 전환에도 의도적 유지)
- **원인:** storage 캐시는 4h TTL을 검사하지만 in-memory 캐시는 무기한 fresh 취급. 부분 삭제는 F012 새로고침의 화면 내 키워드뿐.
- **체감:** 탭을 하루 종일 켜두고 수십 그룹(그룹당 키워드 수백)을 순회하면 perfCache가 키워드×입찰가(최대 10)×디바이스로 증가 - 키워드 5,000개 열람 시 ~5만 엔트리, 수 MB 수준 단조 증가. 부수 효과로 오래 켜둔 탭은 4시간 넘은 낡은 입찰가를 계속 표시(신선도 버그 겸함).
- **수정안:** in-memory 조회 시에도 `fetched_at` TTL 체크(만료 시 delete + miss 처리) - 상한과 신선도 동시 해결.
- **확신도:** 성장 확실 / 규모 추정(장시간 사용 후 DevTools heap snapshot으로 Map retained size 확인).

### N11. 대행권 점검 결과 검색 - 디바운스 없이 매 키 입력 전체 테이블 재빌드 (low, 300계정+면 medium, 패턴 확실)
- **위치:** `src/content/multi-account.ts:1997`(input 리스너 - 디바운스 없음, 직접 재확인), `1879-1995`(paintList - innerHTML 초기화 후 행마다 innerHTML+리스너 2개+attachActionMenu 재생성)
- **원인:** R8(전체계정 검색 140ms 디바운스)과 동일 패턴인데 2026-06-26 신규 대행권 모달만 미적용. 점검 대상 기본값이 디렉터리 전 계정이라 300행 시나리오가 현실적.
- **체감:** 300행 기준 키 입력당 innerHTML 파싱+리스너 부착 ~5-10ms + 레이아웃 ~10-20ms 추정 - 빠른 타이핑에서 프레임 드랍 체감 가능. 50계정이면 미미.
- **수정안:** `renderSearchView`와 동일한 140ms 디바운스 한 줄.
- **확신도:** 패턴 확실, ms 수치 추정(Performance에서 input 핸들러 self-time).

### N12. F001 팝오버 rAF 루프에 매 프레임 document 전체 querySelectorAll 잔존 (#5 부분 수정 잔여) (low, 실행 확실/비용 추정)
- **위치:** `src/content/index.ts:343-348`(reposition 안 잔존 popover 안전망)
- **원인:** #5 수정(transform skip)은 유지됐지만 "querySelectorAll을 루프 밖으로" 부분이 index.ts에는 미반영 - popover 열린 동안 매 프레임 `.dvads-popover` 전체 문서 스캔.
- **체감:** 키워드 200행 페이지에서 프레임당 ~0.1-0.5ms 추정 - popover 열린 동안 프레임 예산의 ~2%를 안전망에 소모.
- **수정안:** 안전망 검사를 오픈 직후 1회 + 저빈도(500ms 간격)로 강등.
- **확신도:** 매 프레임 실행 확실, 비용 추정.

### N13. F001 scan()의 셀×td textContent 파싱 - 가상화 스크롤 중 프레임마다 반복 (low, 추정)
- **위치:** `src/content/index.ts:133-149, 151-193`(ensureBadge가 기존 mount 확인 전에 매번 `findBidCellAndValue`), `82-93`(행의 모든 td textContent 파싱)
- **원인:** R1이 끊은 건 "우리 재렌더→옵저버 재발화" 루프이고, 호스트 React 변이(가상화 스크롤)마다 scan이 도는 것 자체는 정상 - 다만 그 안에서 기존 mount 셀도 매번 전체 td 파싱을 다시 한다. 200행 × ~10td ≈ 프레임당 2,000회 textContent 직렬화 + 정규식.
- **체감:** 스크롤 중 프레임당 ~1-3ms 추정 - layout 읽기가 아니라 thrashing은 아니고 순수 CPU. 스크롤 마이크로 버벅임 기여 가능.
- **수정안:** bidCell의 직전 textContent를 mount에 캐시해 동일하면 파싱 skip.
- **확신도:** 추정 - 키워드 200행 페이지 스크롤 중 Performance로 scan self-time 확인.

### N14. "↻ 전체" 루프 안 단건 storage get 2종 - 배치 인자가 있는데 안 씀 (low, 확실)
- **위치:** (a) `src/content/multi-account.ts:2671`·`139`의 `collectAccount` 호출부가 `platformsArg` 미전달 → `src/lib/multi-account-data.ts:596`에서 계정마다 `loadPlatformFilter()` 1회. 이 인자는 지난 감사 R24에서 정확히 이 용도로 추가됐는데 호출부 전체 미사용(당시 "옵션 페이지 필터 staleness 위험으로 미연결" 보류가 그대로). (b) `2684`·`149` - refreshRow 성공마다 `loadAllUserMeta()` 전체 맵 재읽기.
- **체감:** 계정 50개 "↻ 전체" 1회당 불필요 get ~100회(회당 수 KB). 네트워크가 지배적이라 체감 지연은 미미 - IPC 낭비·위생 수준.
- **수정안:** refreshAllStale 시작 시 filter·meta 1회 로드 후 인자로 전달(R24 연결 완료 겸).
- **확신도:** 확실(호출부 전수 확인).

### N15. 그룹 탭 전환·정렬 클릭마다 storage 전량 재읽기 (low - 정보성, 확실)
- **위치:** `src/content/multi-account.ts:892-897`(그룹 칩 클릭)·`644-654`(정렬 클릭) → `renderListView`(552-569)가 매번 directory+userMeta+addedList+groups+snapshotMany 5회 읽기
- **원인:** 데이터는 안 변했고 필터/정렬만 바뀌는데 전량 재조회. 단 `loadSnapshotMany` 배치 + token guard가 있어 클릭당 수 ms~수십 ms 수준.
- **수정안:** popover 열린 동안 로드 결과를 메모리에 들고 필터/정렬만 재적용.
- **확신도:** 확실.

### N16. 대행권 점검이 fresh 스냅샷을 무시하고 비즈머니·어제 광고비 재조회 (low, 코드 확실/의도 추정)
- **위치:** `src/content/multi-account.ts:1790-1824`(점검 워커 - 계정마다 fetchAgencyOperation+fetchBizMoney+fetchYesterdayCost 3콜 병렬)
- **원인:** 방금 새로고침으로 받은 1h TTL 스냅샷에 비즈머니·어제 지표가 있어도 재조회. 대행권 자체는 캐시가 없어 필수, 나머지 2콜이 잠재 중복.
- **체감:** 30계정 점검 = 90콜 중 60콜 잠재 중복, 소요 ~10-20초.
- **수정안:** fresh 스냅샷 있으면 재사용 - 단 "점검은 최신값이어야 한다"는 제품 의도면 현행 유지가 맞음(의도 확인 선행).
- **확신도:** 코드 확실 / 제품 의도 추정.

### N18. 디스플레이 상세 폴링 상한 15초 고정 - 월간·장기간에서 28초 게이트 통째 낭비 위험 (low, 추정)
- **위치:** `src/lib/report-gfa-detail.ts:23-24`(POLL_MAX 15×1초), `90-114`
- **원인:** 날짜선택기로 월간·커스텀 장기간을 고르면 서버 보고서 생성이 15초를 넘길 수 있고, 초과 시 throw → 디스플레이_상세 시트 누락 + 이미 발사한 gated POST(계정당 4회×7초)와 폴링 GET이 결과 없이 소모. 재시도 폭주는 없음(무재시도).
- **체감:** 월간 일괄 30계정에서 일부 계정만 시트가 무작위로 빠지고 계정당 ~28초 허비.
- **수정안:** 기간 일수 비례로 POLL_MAX 상향(월간 30회) 또는 지수 백오프.
- **확신도:** 추정 - 월간 기간에서 15초 초과 여부 라이브 확인 필요(콘솔 "디스플레이 상세 수집 실패" 경고 + downloads 폴링 횟수).

### E-3. renderListView paint 단계·체크박스 동기화의 O(n²) 셀렉터 패턴 (low~negligible, 패턴 확실/비용 추정)
- **위치:** `src/content/multi-account.ts:685-687`(entry마다 findRows), `3074-3081`(findRows - popover 서브트리 attribute 셀렉터 전체 스캔), `2886-2945`(paintRowEl 셀마다 querySelector ~10회), `2126-2134`·`2072-2081`(select-all/행 체크박스)
- **원인:** render 2단계에서 이미 tr 핸들을 갖고 있는데 4단계에서 셀렉터로 다시 찾는다. 50계정 × ~1,000노드 ≈ render당 1-3ms - 체감 없음. 그룹 다중 소속으로 행 2~3배 중복 + 계정 200-300이면 ~10ms까지.
- **수정안:** paint 단계에서 `paintRowEl(tr, ...)` 직접 호출 또는 `Map<accountNo, tr[]>` 1회 구축.
- **확신도:** 패턴 확실, 비용 추정.

### N19. 다이얼로그 "강제 닫기" 경로가 keydown capture 리스너를 안 뗌 (negligible - 현재 도달 불가, 함정 성격)
- **위치:** `src/content/multi-account.ts:1585-1587`(closeRenameDialog)·`1623-1625`(closeAgencyModal) - `remove()`만 수행, 리스너 해제는 각 다이얼로그 클로저의 cleanup에만 존재
- **원인:** open 함수들이 진입 시 방어용으로 부르는 강제 닫기가 실제로 타면 이전 다이얼로그의 keydown capture + backdrop DOM(클로저 retain)이 고아가 됨. 현재는 backdrop이 화면을 덮어 중첩 오픈이 사실상 불가 + 고아 리스너도 다음 Escape에서 자가 정리(대신 그 Escape 1회가 먹통으로 느껴질 수 있음).
- **수정안:** popover `__cleanup` 패턴처럼 backdrop element에 cleanup을 매달아 close 함수가 호출하게 통일. 앞으로 코드에서 다이얼로그를 강제로 닫는 경로가 생기면 즉시 실누수로 승격되는 함정이라 기록.
- **확신도:** 코드 구조 확실 / 도달 불가 판단은 UI 흐름 추적 기반.

### N20. setTimeout(0) 지연 등록 리스너의 "등록 전 닫힘" race (negligible, 추정)
- **위치:** `multi-account.ts:394`, `ui-dropdown.ts:197-202·405-410`, `report-datepicker.ts:414-419`, `index.ts:412-415`, `period-compare.ts:487-490` (공통 패턴)
- **원인:** cleanup이 0ms 타이머 발화 전에 실행되면 이후 타이머가 리스너를 등록해 잔존(특히 report-datepicker는 dispose=null이라 재제거 경로도 소멸). 닫힘 트리거가 전부 사용자 이벤트(별도 macrotask)라 실사용 재현 거의 불가.
- **수정안:** 타이머 id를 cleanup에서 clearTimeout(또는 "이미 닫힘" 플래그).
- **확신도:** 추정 - `getEventListeners(document)`로 열닫기 반복 후 리스너 수 비교.

### 부수 메모 (성능 무관, 언급만)
- `fetchRelatedKeywords`(`src/lib/searchad.ts:76`)는 호출자 없는 데드코드.
- CLAUDE.md가 언급하는 `src/options/multi-account-ui.tsx`는 현재 존재하지 않음(문서 stale).
- N2의 `.dvads-multi-refresh-all` 죽은 셀렉터(생성부 없음).

---

## ④ 기존 [x] 항목 재검증 결과 - **14건 전부 유효, 이후 커밋에 의한 훼손 0건**

| 항목 | 판정 | 근거 (파일:줄) |
|------|------|----------------|
| R1 renderBadge idempotent | 유효 | `index.ts:195-228` - sig 비교 early return(227), replaceChildren은 변경 시에만. poll 루프(991·1054)도 가드 통과 |
| R2 poll() in-flight | 유효 | `index.ts:943, 952-965` - polling 플래그 + try/finally. F012 직접 poll(1115)도 동일 가드 |
| R3 코드스플릿 | 유효 | `multi-account.ts:66-67` 정적 import 제거 유지, 동적 import 4곳(1082·2005·2535·2556). dist: report 53KB/setup 17KB/writeXlsxFileBrowser 59KB/fflate 15KB/agency-check-excel 1.4KB 전부 lazy 청크, 본체에 write-excel-file·fflate 흔적 0건. **본체 164KB 재증가는 스플릿 붕괴가 아니라 multi-account 소스 증가(N6)** |
| #1 refreshBadge 디바운스+배치 | 유효 | `multi-account.ts:2808-2815`(250ms)·`2828`·`569`(loadSnapshotMany), `multi-account-storage.ts:238-250` |
| R4 runBatch 동시성2+POST 게이트 | 유효 | `report.ts:129-147`(pool 2), `report-gfa-detail.ts:22, 29-40, 212`(전역 gatedPost 7초) - 50건 한도 커밋 이후에도 게이트 그대로 |
| R5 키워드 보고서 1회 | 유효 | `report-build.ts:471-474, 493-494` |
| R6 enrichRanks 키 일치 | 유효 | `setup.ts:358` vs `365` 양쪽 normalizeKeyword |
| R7 배치 스토리지 헬퍼 | 유효 | `multi-account-storage.ts:56·70·120-137`; 신규 그룹 기능도 같은 패턴(removeAccountsFromAllGroups 192) 채택 - 훼손 없음 |
| R8 검색 디바운스 | 유효 | `multi-account.ts:1351-1355`(140ms); 내 계정 view는 display 토글(708-732) |
| R17 모달 keydown 해제 | 유효 | `setup.ts:60-68, 108-109` |
| R22 GET_BID_ESTIMATE 코얼레싱 | 유효 | `background/index.ts:339, 353-377, 387, 400-425`(orphan dedupe 포함) |
| #2 searchad 동시성2+429 backoff | 유효 | `searchad.ts:285, 288-298, 322-325, 490-492`. (33-66 직렬+sleep은 옵션 페이지 자격증명 테스트 전용 fetchVolumes - 핫패스 아님) |
| R26 토스트 타이머 | 유효 | `toast.ts:15, 51-57, 116` |
| R27 waitForTabComplete | 유효 | `background/index.ts:214-219, 225` |

기타 유지 확인: #5(transform skip - 단 N12 잔여분 별도), #9(shopping-image-import 페이지 가드), #10, #11(칩 백오프), R15, R16, R20(getComputedStyle 가드 유지 - sticky 보호용, 제거 금지), R21, R25, R28.

### 기존 [ ] 미착수 항목 재평가

| 항목 | 판정 | 권장 | 이유 |
|------|------|------|------|
| #3 전후비교 전체 스캔 | 유효(존재) | **유지(medium) - 수정안 갱신 필요** | `period-compare.ts:306-312` 네거티브 가드만. **F-PoP 커버리지 확대 확인**: `detectPageScope`(819-828)가 dashboard·all-campaigns·`/da/` GFA 경로까지 지원 - 기존 수정안의 `/sa/campaigns-by/`+`/sa/adgroups/` 화이트리스트는 stale. 라이브 확정 선행 조건 그대로 |
| #4 엑셀 셀별 치환 | 유효(존재) - **3단계 확장 비용 증가 0** | 유지(low) | 캠페인 시트 3단계·키워드·월간 확장 행은 전부 `buildRow`+`replaceRowsFrom`(`report-excel.ts:317-331` 단일 패스) 벌크 경로라 replaceCell을 안 지남. 셀별 치환은 고정 시트 한정(시트당 ~600회 전체 스캔 ≈ 수십~150ms 추정, 1회성 + 진행 오버레이 아래) - 1차 감사 당시와 동일 규모 |
| #6 옵저버 fan-out | 유효(존재) | 유지(low) | 상시 옵저버 7개/프레임(index 933·1156·1160, period-compare 1237·1242, asset-bulk 41, shopping-image-import 71) + URL 감시 중복 그대로. **신규 코드는 옵저버 미추가 - 악화 없음** |
| #7 cache-prune get(null) | 유효(존재) | 유지(low) | `cache-prune.ts:39, 77`. 같은 패턴이 volume-cache 56·performance-cache 63·clearAllSnapshots(storage 270)에도. N5(스냅샷 누적)와 결합해 저장소가 커질수록 비용 동반 상승 - N5 처리 시 함께 재평가 |
| R9/R11 이미지 CDN variant | 유효(존재) | 보류 유지 | `product-page-scrape.ts:119-123`(o1000)·`setup.ts:383-410` 변화 없음. broken image 위험(w1500 invalid 응답) 그대로 - 소형 variant 정상응답 라이브 확인 선행 |
| R14 hidden tab 취소 가드 | 유효(존재) | **하향(negligible)** | `background/index.ts:109-147` 변화 없음. 사용 빈도 낮고 최악 ~15초 1회성 |
| R18 잔여(달력 증분 paint) | 유효하나 무의미 | **하향(negligible) - 사실상 종결** | scroll 축은 처리 완료(`report-datepicker.ts:266-293` rAF+offsetTop 캐시). 남은 전 셀 paint(208-227, ~630셀)는 클릭 시 1회뿐 ≈ 1-3ms - 손댈 가치 소멸 |
| R19 window.top 가드 | 유효(부분 존재) | **N4로 흡수·상향** | init 경로(index.ts:1141-1157) 여전히 무가드. multi-account는 syncMount 내부 가드(211-212)만 확보 - 인터벌·디렉터리 갱신은 전 프레임(N4 참조) |
| R23 파생 집계 | 유효(존재) | 유지(negligible~low) | `report-build.ts:99-119` 그대로. 이번 관점 C도 독립 재발견(fetchTotal은 ymd 합산으로 파생 가능, 일괄 30계정에서 ~60콜 절약) - 다만 Promise.all 병렬 안이라 wall-clock 영향 미미, advanced-report 합계 행과 분해 합산의 완전 일치 라이브 1회 대조 선행 |

---

## ⑤ 안심 목록 (점검했지만 문제없음 - 다음 감사 중복 방지용)

**유휴 비용**
- `background/index.ts` - alarm/interval/keep-alive 0건, 순수 메시지 구동이라 SW 정상 idle 종료. prune은 onInstalled 1회 + 1h 스로틀
- `fetch-patch-main.ts`(MAIN world, 2.8KB) - 설치 1회 + URL 화이트리스트 선필터, 요청 활동 비례 비용만
- `index.ts` watchPageConfirmModal - rAF 스로틀 + "우리 UI 미표시 시 skip" 가드로 유휴 시 즉시 return
- F001/F-PoP popover rAF 루프 - 열린 동안만 + close 시 cancelAnimationFrame 확인
- `report-datepicker.ts` - 리스너 전부 open 시 등록·dispose에서 해제, **닫힌 상태 유휴 비용 0**
- `report.ts`/`setup.ts` - 상시 옵저버·타이머 없음, 클릭 시 동적 import
- 신규 코드(그룹 탭·대행권·날짜선택기)는 **상시 옵저버·타이머를 추가하지 않음**

**메모리 누수** - 열닫기 반복형 리스너/DOM 누수는 사실상 없음(설계 패턴 일관)
- multi-account popover: keydown/mousedown/click 3종을 `wrap.__cleanup`으로 일괄 해제 + 상태 변수 리셋
- 그룹 다이얼로그 3종·대행권 모달: 모든 닫힘 경로가 단일 cleanup 수렴(keydown capture 해제 + closeAllOpenDropdowns + cancelled 플래그 worker 조기 종료)
- ui-dropdown: 리스너는 패널 열린 동안만, closePanel이 전부 제거. trigger detach 시에도 다음 pointerdown/scroll에서 자가 닫힘
- dialog-dismiss/input-dialog/confirm-dialog/toast/asset-bulk-popup: teardown 완결(object URL revoke, portal 정리 포함)
- index.ts mounts Map: scan에서 `isConnected` 정리 + URL 변경 teardown, inflightMounts는 WeakSet
- period-compare recentCaptures: 20개 cap + URL 변경 시 초기화
- background bidInflight/perfInflight: finally에서 자기 키 삭제
- SPA 전환: F001 배지·F-PoP 버튼·다계정 버튼 모두 URL 변경 시 자기 DOM+리스너 회수

**네트워크**
- 그룹 탭/칩 전환 - 데이터 재수집 없음(storage 배치 읽기만). backgroundRefreshStale은 stale 행만+in-flight+행별 fresh 재확인 3중 가드
- 리포트 날짜선택기 - 네트워크 0건(순수 UI), running 플래그로 동시 실행 차단
- 캠페인 시트 3단계 - 그룹 단위 N+1 없음, 3차원 attributes 1회 호출(페이지 1~2장 증가뿐)
- 디스플레이 50건 한도 정리 - 계정당 GET 1회+DELETE 최대 4회, 전 실패 swallow 무재시도, DELETE 직렬이라 폭주 불가, 사용자 수동 리포트는 시그니처 필터 보호
- 429 backoff 실동작 확인(에러 메시지에 "429" 포함 → 분기 탐), 재시도 1회 한정+지터. 재시도 폭주 경로 전수 점검 - 없음(pollJobNo 15회·디렉터리 50페이지·advanced-report maxRows 상한)
- F001 캐시 경로 - TTL·device 키·in-flight 코얼레싱 온전, 캐시 우회 경로 없음
- F-Setup 계층 수집 - pool 4 + 키워드 없는 유형 skip + 이미지 URL dedupe

**번들**
- `Button-*.js` 190KB = React 벤더 청크, popup/options HTML 전용(콘텐츠 경로에 없음)
- 85KB급 CSS 2개 = popup/options Tailwind 빌드(페이지 주입과 무관)
- background 청크 ~15KB - HMAC/searchad 코드가 콘텐츠 본체에 안 섞임
- report-datepicker(431줄)·agency-check-excel은 lazy 청크에 정상 격리
- 현재 초기 주입 총량: JS ~170.5KB + CSS ~66KB ≈ 236KB/프레임 (lazy: report 53KB·setup 17KB·writeXlsxFileBrowser 59KB·fflate 15KB)

**렌더** - 강제 동기 reflow(read/write 교차 루프)는 발견되지 않음
- renderListView/renderSearchView - await 선행→DocumentFragment→replaceChildren atomic swap + token 3중 체크 유지
- 내 계정 검색 필터 - 재빌드 없이 display 토글 + haystack 사전 캐시(디바운스 불필요)
- 그룹 탭 바/인디케이터 - offset 읽기는 rAF 후 1회, scroll 핸들러는 소형 요소 국한
- ui-dropdown - gBCR 읽기→쓰기→rAF 재읽기 프레임 분리(주석 명시), 오픈 시 1회성
- setup 캠페인 선택 모달 - display 토글 + O(n) 1패스, 300행 무리 없음
- report-variable 시트 렌더 - 전부 벌크 행 생성(buildRow+단일 치환), centerCells 스타일 변형 Map 캐시
- animatePopoverBody FLIP의 강제 reflow는 디바이스 토글당 2-3회 의도 패턴
- findOperationChip - 캐시+미스 백오프(#11) 유지

**스토리지**
- 그룹 CRUD - 단일 키 통재저장이지만 payload ~5KB 미만 + 사용자 명시 액션만 + load1/save1 원자적 - 적절
- 그룹 신규 코드의 배치 경로 준수 - #1/R7 우회 없음(전부 배치 헬퍼+디바운스 refreshBadge 경유)
- onChanged 리스너는 코드베이스 전체 1개, 읽기+DOM만(쓰기 0) - 피드백 루프 불가능. 그룹 키는 리스너 대상도 아님
- 검색 입력 storage 접근 0(메모리 변수), 드래그 정렬 기능 자체 없음
- report-datepicker - 열 때 get 1회/확인 시 set 1회
- F001 캐시 4종 전부 cache-prune 4h TTL 커버. 스냅샷 저장 단위는 계정별 개별 키로 올바른 분할(N5는 "정리 부재" 문제)
- 옵션/팝업 페이지 - 1회성 접근만

---

## 진행 메모
- 3차 점검일: 2026-07-02. 방법: 관점 6개(A유휴/B누수/C네트워크/D번들/E렌더/F스토리지) 병렬 + 기존 항목 재검증 1개 = 7 에이전트, 단독 보고 medium 이상(N1·N2·N3·N4·N11)은 본체에서 코드 직접 재확인, N5는 B·F 두 관점 독립 교차 확인.
- 빠른 효과·낮은 위험 착수 순서 제안: N1 → N2 → N3(+N4 top-frame 가드와 세트) → N11(한 줄) → N5 → N6(+N7).
- 라이브 검증 선행 묶음: N18(월간 폴링 15초 초과 여부), #3(F-PoP 페이지 화이트리스트), N16(제품 의도), R9/R11(CDN variant).
- 수정 후 항상 `npm run typecheck` → `npm run build`로 dist/ 갱신.
