# F-Brief — 광고주 보고 문구 생성 (AX 1호)

F-MultiAccount 행 메뉴 "보고 문구" → 기간 선택 → 수집(성과 ∥ 지난 보고 ∥ 변경 이력) → 규칙 엔진 후보 추출 → **이슈 선택 화면 먼저**(체크 + 보고 유형 사후보고/사전제안 + 톤 6종 + 이전 이력/변경 이력 토글) → 선택한 이슈만 AI 조립 → 결과 패널(재생성 버튼군 + 저장/복사). **자동 전체 생성 모드는 폐기**(2026-07-19 구조 개편) — AE가 고른 것만 문구가 된다. 설계 `docs/superpowers/specs/2026-07-16-f-brief-design.md` / 계획 `docs/superpowers/plans/2026-07-16-f-brief.md`.

## 핵심 원칙 — AI는 분석가가 아니라 번역기 (3겹 방어)

1. **안 물어본다**: 요약(인사/3지표/전기대비)은 `brief-data.ts`가 문자열 조립 — AI 미경유.
2. **재료를 안 준다**: 체크된 후보의 `facts`만 서버로. 리포트 전체 전송 금지.
3. **검산한다**: `brief-verify.ts`가 AI 문장의 숫자를 보낸 값 집합과 대조. **차단하지 않고 배지만**(오탐 있음 — "30일" 같은 정상 숫자).
못 막는 구간(일반 상식 문장)은 좌측 3px 주황 선(`.dvads-brief-block-ai`)으로 AE에게 표시.

## 파일

- `brief-rules.ts` — 규칙 엔진(순수 함수, vitest 테스트). `roasBand`(green/yellow/none, 노랑 하한=목표x0.75) 하나를 색칠과 후보 조건이 공유 — 두 곳에 따로 쓰면 어긋난다. 후보 5종 + 확장 카탈로그는 설계 §5. 임계값은 `BriefThresholds`로 파라미터화(`input.thresholds`, 기본 `DEFAULT_THRESHOLDS`) — 상수를 직접 쓰지 말 것.
- `brief-thresholds.ts` / `brief-threshold-panel.ts` — 이슈 기준 커스텀(순수+vitest / 다이얼로그). ①비용 문턱은 기간 총광고비의 1.5%로 자동 보정(1만~20만, 천원 반올림; 매출 낙폭 = x10) ②프리셋 민감하게/보통/느슨하게 ③직접 설정(양수만 유효, 나머지는 자동값). 광고주별 저장 `MultiAccountUserMeta.briefSensitivity/briefThresholds`. 기준 변경 시 **재수집 없이** `rebuildCandidates`(ctx.ruleInput)로 규칙 엔진만 재실행 — 선택 인덱스는 무효라 유형·톤만 유지.
- `brief-verify.ts` — 숫자 검산(순수, 테스트). `brief-table.ts` — 표를 캡처가 아니라 canvas로 생성 → PNG 클립보드. `document.fonts.ready` 후 렌더, dpr 반영, 20행 초과 시 "외 N개" 명시.
- `brief-data.ts` — `collectReportData` 재사용 + 전기 상품 1회 추가 수집(동시 출발) + 파워링크 등록 키워드 입찰가 맵(`fetchPowerlinkBidMap`).
- `brief-compose.ts` — Edge Function 호출 + 검산 적용. `FN_URL`은 manifest `host_permissions`와 동일 도메인 필수.
- `brief.ts` — 오케스트레이터(report.ts 미러). 진행 오버레이는 report.ts에서 import(복제 금지 — DOM 2개 생김), **취소 함수는 각자**(report의 cancelRun을 쓰면 남의 실행을 취소한다).
- `brief-panel.ts` — 결과 패널(블록별 복사) + 후보 선택 화면(`renderBriefPickPanel`). blob URL은 dispose에서 revoke.
- `brief-history.ts` — 서버 이력 저장/조회(테이블 `brief_history`, RLS 본인+approved). **저장 시점 = 복사한 순간**(패널 1회당 upsert 1건, id 고정) - 생성만 하고 닫으면 기록 없음. 저장 실패는 복사를 막지 않는다(토스트 1회). 저장은 원본 구조(kind/facts/action + 숫자 targets) - LLM용 가공 금지.
- `brief-followup.ts` — 지난 조치 추적 후보(`pastActionFollowUp`, 순수+vitest). 최신 이력 1건의 targets를 현재 지표와 **라벨 문자열 매칭** - 키워드명 변경 시 추적 끊김(허용된 한계). 후보 목록 맨 앞에 unshift.
- `brief-history-panel.ts` — 지난 보고 목록/상세(결과 패널 "지난 보고" 버튼). 저장은 원본 구조, 화면은 그때그때 변환(설계 §7).
- `brief-change-rules.ts` — 변경 이력 후보(`changeFollowUp`, 순수+vitest). change-watch 판정의 **역방향**(우리 팀 작업자 포함 매칭). 전/후 성과는 추가 API 호출 없이 전기/현기 지표 라벨 매칭 — 기간 중간 변경은 "판단 보류"로 성과 단정 금지(프롬프트 이중 방어). 대상당 최신 1건, 상한 8건.
- `brief-change-data.ts` — 변경이력 fetch(조회 창 = 기간 시작 14일 전~기간 끝). 작업자 목록(`change_watch_identity`) 비면 후보 0 + 선택 화면 토글 비활성. 실패해도 흐름 계속.
- `brief-tone.ts` / `brief-tone-panel.ts` — AE 개인 말투(테이블 `brief_tone`, 사용자당 1행). 채팅 이력 붙여넣기 → 서버 `mode:"distillTone"`으로 말투 프롬프트 생성 → 미리보기 수정 → 저장. compose 때는 **서버가 JWT 사용자 id로 tone_prompt를 직접 읽는다**(payload로 안 보냄 - 조작 방지), 없으면 기본 `TONE_SAMPLES`.
- 보고 유형/톤은 광고주별로 기억(`MultiAccountUserMeta.briefReportType/briefTone`) — "보고문 만들기" 확정 시 조용히 저장, 실패해도 진행.
- 결과 패널 재생성 버튼군(다시 생성/더 짧게/더 부드럽게/숫자 중심)은 톤만 바꿔 재compose — 편집분이 있으면 확인 후 덮어씀. 패널 uuid 유지(같은 보고로 upsert, `ai_draft` 갱신).
- 서버: `supabase/functions/brief-compose/index.ts` — 프로젝트 `gvyvrjncpwmcwycebrhf`(dvcompany). 말투 샘플·프롬프트는 서버에 — 확장 재배포 없이 튜닝. 배포: `supabase functions deploy brief-compose --no-verify-jwt`.

## 캠페인 > 그룹 단위 구조 (2026-07-20 전면 개편)

- **모든 이슈는 광고그룹 단위로 생성** — `BriefCandidate.scope`(캠페인/그룹/id)가 붙고, 선택 화면이 캠페인 > 그룹 > 이슈 계층으로 렌더(scope로 "광고관리자에서 이 그룹 열기" 링크). scope 없는 후보(이력·변경·상품)는 "계정 공통" 섹션.
- **계정 합산 세그먼트 판정 금지** — 그룹 특성이 섞여 부정확(사용자 필수 요구). `extractCandidates`는 키워드 규칙(①②④⑥)을 KeywordGroup별로, 차원 규칙(③⑦⑧⑨⑪)을 `BriefGroupData`별로 돌린다. `belowTargetGroup`은 항목별 집계(이름 키 재집계 금지) 유지.
- **그룹별 차원 수집** = `fetchGroupDims`(brief-data.ts): attributes `["nccCampaignId","nccAdgroupId",<차원>]` 호출 1회/차원. 차원 attr: 지면 `mediaNm` / 성별 `criterionGenderNm` / 연령 `criterionAgeTpNm` / 기기 `pcMblTp` / 시간 `hh24` / 지역 `regnNo` / 일자 `ymd`(ISO 변환 후 `foldByWeekday`로 요일 접기 — 요일 전용 attr 없음). 잘못된 attribute는 400. `collectReportData` 병렬 구조 불변.
- entity 셀은 `"[이름](id)"` → `parseEntity`. 이름 못 얻은 캠페인/그룹은 제외(id 노출 금지 원칙).
- `plAds`는 `BriefAdRow`(그룹 정보 포함) — `lowCtrAd`는 **그룹 안에서만** 같은 문구 합산(그룹 넘어 합치면 노출 임계 오탐 — 테스트로 잠금).
- skew 가드: 양쪽 비용 1만원+ / 1.5배+ / "알 수 없음·기타" 제외 / 전 세그먼트 매출 0이면 미생성(0%vs0% 오탐).
- 표 강조는 `BriefTableRow.problem`(후보 발화 행만 빨강 7%) — `band`는 판정 공유용으로만 남고 색칠에 안 쓴다.
- 사용자 노출 텍스트에 **가운뎃점(·) 금지**(em dash와 동일 취급) — 서버 brief-compose 프롬프트에도 출력 금지 규칙 있음.

## Gotchas

- **리포트 키워드 행은 검색어(expKeyword)라 입찰가가 없다.** 순위 보강의 userBid는 ncc 등록 키워드에서 가져와 정규화 텍스트 매칭 — 맵에 없는 검색어(확장 매칭)는 순위 미기재, 후보에서 자연히 빠짐. 순위 조회는 green+비용 임계 통과 후보로 좁힌 뒤에만(전체면 수백 회).
- 목표 ROAS(`MultiAccountUserMeta.targetRoas`) 미설정 시 구간 분류 후보를 만들지 않는다 — 자동 추정(계정 평균) 금지: 계정이 통째로 부진하면 전부 "정상"으로 나옴.
- 상품 후보는 소재ID로 전기와 매칭(`shProductAdRows`/`shProductInfo`). 이름 못 얻은 소재는 ID 폴백 금지(광고주에게 `nad-...` 노출 불가) — 제외.
- Gemini 모델은 신규 키 제공 중단이 있을 수 있음(2.5 → 3.1 flash-lite 교체 사례). 502 upstream이면 키로 모델 목록부터 조회.
- 인증은 F-Accounts 도입(2026-07-17)으로 로그인 세션(JWT) + `approved` 확인으로 교체됨 — 이용 코드(`brief_token`) 화이트리스트 방식은 폐기. `BRIEF_TOKENS` 시크릿은 롤백 창(안정화 확인) 뒤 삭제 예정.
