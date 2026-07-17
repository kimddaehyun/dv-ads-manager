# F-Brief — 광고주 보고 문구 생성 (AX 1호)

F-MultiAccount 행 메뉴 "보고 문구" → 기간 선택 → `collectReportData` 재사용(엑셀 제외) → 규칙 엔진 후보 추출 → AI가 문장만 조립 → 블록별 복사(카톡은 텍스트/이미지를 한 메시지에 못 붙임). 설계 `docs/superpowers/specs/2026-07-16-f-brief-design.md` / 계획 `docs/superpowers/plans/2026-07-16-f-brief.md`.

## 핵심 원칙 — AI는 분석가가 아니라 번역기 (3겹 방어)

1. **안 물어본다**: 요약(인사/3지표/전기대비)은 `brief-data.ts`가 문자열 조립 — AI 미경유.
2. **재료를 안 준다**: 체크된 후보의 `facts`만 서버로. 리포트 전체 전송 금지.
3. **검산한다**: `brief-verify.ts`가 AI 문장의 숫자를 보낸 값 집합과 대조. **차단하지 않고 배지만**(오탐 있음 — "30일" 같은 정상 숫자).
못 막는 구간(일반 상식 문장)은 좌측 3px 주황 선(`.dvads-brief-block-ai`)으로 AE에게 표시.

## 파일

- `brief-rules.ts` — 규칙 엔진(순수 함수, vitest 테스트). `roasBand`(green/yellow/none, 노랑 하한=목표x0.75) 하나를 색칠과 후보 조건이 공유 — 두 곳에 따로 쓰면 어긋난다. 후보 5종 + 확장 카탈로그는 설계 §5.
- `brief-verify.ts` — 숫자 검산(순수, 테스트). `brief-table.ts` — 표를 캡처가 아니라 canvas로 생성 → PNG 클립보드. `document.fonts.ready` 후 렌더, dpr 반영, 20행 초과 시 "외 N개" 명시.
- `brief-data.ts` — `collectReportData` 재사용 + 전기 상품 1회 추가 수집(동시 출발) + 파워링크 등록 키워드 입찰가 맵(`fetchPowerlinkBidMap`).
- `brief-compose.ts` — Edge Function 호출 + 검산 적용. `FN_URL`은 manifest `host_permissions`와 동일 도메인 필수.
- `brief.ts` — 오케스트레이터(report.ts 미러). 진행 오버레이는 report.ts에서 import(복제 금지 — DOM 2개 생김), **취소 함수는 각자**(report의 cancelRun을 쓰면 남의 실행을 취소한다).
- `brief-panel.ts` — 결과 패널(블록별 복사) + 후보 선택 화면(`renderBriefPickPanel`). blob URL은 dispose에서 revoke.
- 서버: `supabase/functions/brief-compose/index.ts` — 프로젝트 `gvyvrjncpwmcwycebrhf`(dvcompany). 말투 샘플·프롬프트는 서버에 — 확장 재배포 없이 튜닝. 배포: `supabase functions deploy brief-compose --no-verify-jwt`.

## 확장 규칙 (Task 12~17, 2026-07-17 완료)

- 후보 13종. 확장분: `belowTargetGroup`(그룹 합산, **KeywordGroup 항목별 집계** — 이름 키 재집계 금지),
  `lowRoasPlacement`, `genderBidSkew`/`ageBidSkew`/`deviceBidSkew`/`hourWeekdaySkew`/`regionBidSkew`(공통 `findSkew`),
  `lowCtrAd`(노출 1,000+ & CTR 0.5% 미만 → 문구 교체).
- **advanced-report 차원 enum**(SPA 번들 정찰): `pcMblTp` 기기 / `dayw` 요일 / `hh24` 시간대 / `regnNo` 지역(시도명) / `schTp` 매체.
  잘못된 attribute는 400. 신규 세그먼트는 `brief-data.ts`의 `fetchSegment()`로 — `collectReportData` 병렬 구조 불변.
- 요일은 `dayw` 대신 이미 수집된 `model.byDay`를 `foldByWeekday`로 접는다(호출 1회 절약).
- skew 가드: 양쪽 비용 1만원+ / 1.5배+ / "알 수 없음·기타" 제외 / 전 세그먼트 매출 0이면 미생성(0%vs0% 오탐).

## Gotchas

- **리포트 키워드 행은 검색어(expKeyword)라 입찰가가 없다.** 순위 보강의 userBid는 ncc 등록 키워드에서 가져와 정규화 텍스트 매칭 — 맵에 없는 검색어(확장 매칭)는 순위 미기재, 후보에서 자연히 빠짐. 순위 조회는 green+비용 임계 통과 후보로 좁힌 뒤에만(전체면 수백 회).
- 목표 ROAS(`MultiAccountUserMeta.targetRoas`) 미설정 시 구간 분류 후보를 만들지 않는다 — 자동 추정(계정 평균) 금지: 계정이 통째로 부진하면 전부 "정상"으로 나옴.
- 상품 후보는 소재ID로 전기와 매칭(`shProductAdRows`/`shProductInfo`). 이름 못 얻은 소재는 ID 폴백 금지(광고주에게 `nad-...` 노출 불가) — 제외.
- Gemini 모델은 신규 키 제공 중단이 있을 수 있음(2.5 → 3.1 flash-lite 교체 사례). 502 upstream이면 키로 모델 목록부터 조회.
- 인증은 F-Accounts 도입(2026-07-17)으로 로그인 세션(JWT) + `approved` 확인으로 교체됨 — 이용 코드(`brief_token`) 화이트리스트 방식은 폐기. `BRIEF_TOKENS` 시크릿은 롤백 창(안정화 확인) 뒤 삭제 예정.
