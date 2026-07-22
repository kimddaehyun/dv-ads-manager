# F-Brief — 광고주 보고 문구 생성 (AX 1호)

F-MultiAccount 행 메뉴 "광고 성과 측정" → 기간 선택 → 수집(성과 ∥ 지난 보고) → 규칙 엔진 후보 추출 → **이슈 선택 화면 먼저**(유형 띠 > 캠페인 > 그룹 계층 체크 + 고급 옵션: 보고 유형 칩/이슈 기준/대화 스타일, 2026-07-21 개편) → 선택한 이슈만 AI 조립 → 결과 패널(재생성 버튼군 + 저장/복사). **자동 전체 생성 모드는 폐기**(2026-07-19 구조 개편) — AE가 고른 것만 문구가 된다. **보고는 현재 캠페인 데이터만 본다** — 변경 이력 후보는 완전 제거, 지난 조치 추적(`pastActionFollowUp`)·상품(`productConvDrop`)·그룹 합산(`belowTargetGroup`) 후보도 생성 중단(2026-07-21). 설계 `docs/superpowers/specs/2026-07-16-f-brief-design.md` / 계획 `docs/superpowers/plans/2026-07-16-f-brief.md`.

## 핵심 원칙 — AI는 분석가가 아니라 번역기 (3겹 방어)

1. **안 물어본다**: 요약(인사/3지표/전기대비)은 `brief-data.ts`가 문자열 조립 — AI 미경유.
2. **재료를 안 준다**: 체크된 후보의 `facts`만 서버로. 리포트 전체 전송 금지.
3. **검산한다**: `brief-verify.ts`가 AI 문장의 숫자를 보낸 값 집합과 대조. **차단하지 않고 배지만**(오탐 있음 — "30일" 같은 정상 숫자).
AI 문단 좌측 3px 주황 선 표시는 폐기(2026-07-22 사용자 요청 - `isAiJudgment` 데이터는 유지, 시각 표시만 제거). 결과 문구의 `[캠페인 > 그룹]` 라벨은 서버 프롬프트에 따라 AI가 직접 쓸 수 있어 클라이언트 부착 전 startsWith 중복 검사 필수(brief.ts).

## 파일

- `brief-rules.ts` — 규칙 엔진(순수 함수, vitest 테스트). `roasBand`(green/yellow/none, 노랑 하한=목표x0.75) 하나를 색칠과 후보 조건이 공유 — 두 곳에 따로 쓰면 어긋난다. 후보 5종 + 확장 카탈로그는 설계 §5. 임계값은 `BriefThresholds`로 파라미터화(`input.thresholds`, 기본 `DEFAULT_THRESHOLDS`) — 상수를 직접 쓰지 말 것.
- `brief-thresholds.ts` — 이슈 기준 커스텀(순수+vitest). ①비용 문턱은 광고비의 1.5%로 자동 보정(1만~20만, 천원 반올림) ②프리셋 민감/기본/핵심(x0.5/x1/x2) ③맞춤(양수만 유효). **비용 문턱은 캠페인별**(2026-07-21) — `brief.ts buildCostFloors`가 캠페인별 광고비에 같은 공식을 적용해 `ruleInput.campaignCostFloor`(캠페인명→원)로 주입, 맞춤의 `costFloorPct`(%)가 있으면 그 비율 우선(원 단위 costFloor는 레거시 폴백). 캠페인 머리글에 "/ 최소 금액 N원"(파랑)으로 표기. 광고주별 저장 `MultiAccountUserMeta.briefSensitivity/briefThresholds`. 기준 변경 시 **재수집 없이** `rebuildCandidates`(ctx.ruleInput)로 규칙 엔진만 재실행 — 선택 인덱스는 무효라 유형·톤만 유지. `brief-threshold-panel.ts`는 데드코드(미참조).
- `brief-verify.ts` — 숫자 검산(순수, 테스트). `brief-table.ts` — 표를 캡처가 아니라 canvas로 생성 → PNG 클립보드. `document.fonts.ready` 후 렌더, dpr 반영, 20행 초과 시 "외 N개" 명시.
- `brief-data.ts` — `collectReportData` 재사용 + 전기 상품 1회 추가 수집(동시 출발) + 파워링크 등록 키워드 입찰가 맵(`fetchPowerlinkBidMap`).
- `brief-compose.ts` — Edge Function 호출 + 검산 적용. `FN_URL`은 manifest `host_permissions`와 동일 도메인 필수.
- `brief.ts` — 오케스트레이터(report.ts 미러). 진행 오버레이는 report.ts에서 import(복제 금지 — DOM 2개 생김), **취소 함수는 각자**(report의 cancelRun을 쓰면 남의 실행을 취소한다).
- `brief-panel.ts` — 결과 패널(블록별 복사) + 후보 선택 화면(`renderBriefPickPanel`). blob URL은 dispose에서 revoke. 결과 문구 textarea는 높이를 내용에 맞춰도(overflow:hidden) 내용이 1px만 넘치면 **휠을 삼켜 패널이 안 굴러간다** — wheel을 preventDefault 후 body.scrollTop으로 직접 전달(ctrl+휠 제외).
- `brief-history.ts` — 서버 이력 저장/조회(테이블 `brief_history`, RLS 본인+approved). **저장 시점 = 복사한 순간**(패널 1회당 upsert 1건, id 고정) - 생성만 하고 닫으면 기록 없음. 저장 실패는 복사를 막지 않는다(토스트 1회). 저장은 원본 구조(kind/facts/action + 숫자 targets) - LLM용 가공 금지.
- `brief-followup.ts` — 지난 조치 추적 후보(`pastActionFollowUp`, 순수+vitest). **생성은 잠시 내림(2026-07-21)** — brief.ts의 followCand 주석 한 줄 복원하면 되살아난다. 라벨 문자열 매칭 - 키워드명 변경 시 추적 끊김(허용된 한계).
- `brief-history-panel.ts` — 지난 보고 목록/상세(결과 패널 "지난 보고" 버튼). 저장은 원본 구조, 화면은 그때그때 변환(설계 §7).
- **변경 이력 후보(`changeFollowUp`)는 완전 제거(2026-07-21)** — 보고는 현재 캠페인 데이터만 본다. `brief-change-data.ts`/`brief-change-rules.ts`(+테스트) 삭제. kind·`changeEventId`·이력 필드(`includedChangeHistory`=false 고정)는 지난 이력 표시/스키마 호환용으로만 유지.
- `brief-tone.ts` / `brief-tone-panel.ts` — AE 개인 말투(테이블 `brief_tone`, 사용자당 1행). 채팅 이력 붙여넣기 → 서버 `mode:"distillTone"`으로 말투 프롬프트 생성 → 미리보기 수정 → 저장. compose 때는 **서버가 JWT 사용자 id로 tone_prompt를 직접 읽는다**(payload로 안 보냄 - 조작 방지), 없으면 기본 `TONE_SAMPLES`.
- 보고 유형/톤은 광고주별로 기억(`MultiAccountUserMeta.briefReportType/briefTone`) — "보고문 만들기" 확정 시 조용히 저장, 실패해도 진행.
- 결과 패널 재생성 버튼군(다시 생성/더 짧게/더 부드럽게/숫자 중심)은 톤만 바꿔 재compose — 편집분이 있으면 확인 후 덮어씀. 패널 uuid 유지(같은 보고로 upsert, `ai_draft` 갱신).
- 서버: `supabase/functions/brief-compose/index.ts` — 프로젝트 `gvyvrjncpwmcwycebrhf`(dvcompany). 말투 샘플·프롬프트는 서버에 — 확장 재배포 없이 튜닝. 배포: `npx supabase functions deploy brief-compose --no-verify-jwt`. 문단 규칙은 "진단/조치 2줄 고정" 폐기 → **진단→조치 흐름 2~3문장 + 연결어 허용**(2026-07-22, 뚝뚝 끊긴다는 사용자 피드백) — 대신 "진단에 준 숫자 외 새 숫자·근거 금지"를 명시해 창작 여지를 막는다. reportSummary 모드의 금지 표현은 프롬프트 규칙 + 사후 `BANNED` 정규식 검출→고쳐쓰기 2겹 — **정규식은 서술형 어미만 매칭**(예: `탄탄하`, `탄탄` 금지 - [탄탄면] 같은 실제 키워드명이 걸리면 고쳐쓰기가 이름을 변형한다). **프롬프트 예시 문단은 사실상 출력 템플릿** — 소형 모델이 문장 구조·프레임까지 복창하므로 예시는 가상 숫자/이름으로 쓰고("광고비 줄었는데 ROAS 상승" 같은 착시 프레임 예시 금지), 실계정 데이터로 예시를 쓰면 그 계정 문구가 예시를 토씨까지 재현한다(2026-07-22 실사고). 다양화는 규칙 추가로 안 풀린다 — 규칙을 쌓을수록 한 정답으로 수렴. 해법은 **클라이언트가 생성마다 무작위 시작 각도(`angleHint`)를 뽑아 주입** + 문단 구성 자유화(reportSummary, 2026-07-22). "~를 우선적으로 다뤄라" 류 규칙은 전 보고의 도입을 획일화시키니 금지.

## 캠페인 > 그룹 단위 구조 (2026-07-20 전면 개편)

- **모든 이슈는 광고그룹 단위로 생성** — `BriefCandidate.scope`(캠페인/그룹/id)가 붙고, 선택 화면이 캠페인 > 그룹 > 이슈 계층으로 렌더(scope로 "광고관리자에서 이 그룹 열기" 링크). scope 없는 후보(이력·변경·상품)는 "계정 공통" 섹션.
- **계정 합산 세그먼트 판정 금지** — 그룹 특성이 섞여 부정확(사용자 필수 요구). `extractCandidates`는 키워드 규칙(①②④)을 KeywordGroup별로, 차원 규칙(③⑦⑧⑨⑪)을 `BriefGroupData`별로 돌린다.
- **세그먼트 대조군 원칙(2026-07-21 1~2단계)** — ①활성 구간(노출 또는 비용>0)이 2개 미만이면 그 차원 이슈 전부 생략(모바일 전용 그룹 등) ②문제 판정(전환0/미달/클릭률)은 "문제 아닌 활성 구간"이 1개 이상 있어야, 목표 이상(상향 여지)은 전 구간이 다 좋으면 생략 — 전부 나쁘면 그 차원 조정으로 풀 문제가 아니다(그룹·키워드 규칙 몫). ③전환0(`zeroConvSegment`)은 **전환이 실제로 나는 활성 구간**이 있어야 생성 — 문턱 미만이라 '문제'로 안 잡힌 구간도 전환 0이면 대조가 아니다(2026-07-22). ④**가중치 방향 단일화(2026-07-22)** — 같은 차원에서 상향(`highRoasSegment`)·하향(전환0/미달)을 동시에 만들지 않는다. 좋은 구간이 나쁜 구간(전환0+미달)보다 **적을 때만** 상향, 같거나 많으면 하향만.
- **그룹별 차원 수집** = `fetchGroupDims`(brief-data.ts): attributes `["nccCampaignId","nccAdgroupId",<차원>]` 호출 1회/차원. 차원 attr: 지면 `mediaNm` / 성별 `criterionGenderNm` / 연령 `criterionAgeTpNm` / 기기 `pcMblTp` / 시간 `hh24` / 지역 `regnNo` / 일자 `ymd`(ISO 변환 후 `foldByWeekday`로 요일 접기 — 요일 전용 attr 없음). 잘못된 attribute는 400. `collectReportData` 병렬 구조 불변.
- entity 셀은 `"[이름](id)"` → `parseEntity`. 이름 못 얻은 캠페인/그룹은 제외(id 노출 금지 원칙).
- `plAds`는 `BriefAdRow`(그룹 정보 포함) — `lowCtrAd`는 **그룹 안에서만** 같은 문구 합산(그룹 넘어 합치면 노출 임계 오탐 — 테스트로 잠금).
- **세그먼트는 상대 비교(skew) 폐기(2026-07-21 A안)** — 절대 판정 4종: 전환0(`zeroConvSegment`) / 목표 미달(기존 `…Skew` kind 유지 - 이력 호환) / 목표 이상(`highRoasSegment`, good=초록 행) / 클릭률(`lowCtrSegment`). 목표 ROAS 필요 판정은 미설정 시 미생성. "알 수 없음·기타" 제외 유지. 기기(PC/모바일)·성별(남/여)·요일(월~일)은 응답에 없는 구간을 0값 행으로 채움(`padSegments` — 수집 필터 impCnt>0 보완).
- 상품(`productConvDrop`)·그룹 합산(`belowTargetGroup`) 후보는 생성 폐기(2026-07-21) — kind는 지난 이력 표시 호환용으로만 유지. 그룹 합산은 한 키워드가 광고비를 지배하면 개별 키워드 이슈와 중복이라 뺐다. 상품별 데이터 수집(`products`)은 유지(전기 비교 재료).
- 표 강조는 `BriefTableRow.problem`(빨강 7%)/`good`(초록 7%) + `boldColumns`(판정에 쓴 지표 열만 굵게, 강조 행 없으면 전 행). `band`는 판정 공유용으로만.
- 사용자 표기는 "수익률" 대신 **ROAS**. facts 키(수익률 등)는 이력·검산 호환 위해 유지. 이슈 상세의 "기준 -" 문구는 화면에서 미표시(facts로 AI에는 전달).
- 선택 화면(2026-07-21 개편): **캠페인 유형 띠**(파랑, sticky 상단 고정 + 이전/다음 유형 이동 화살표 - 목적지는 띠 앞 높이 0 anchor 기준, 끝에서는 비활성) > 캠페인 > 그룹 계층. 정렬은 유형 → 캠페인 광고비 desc → 그룹 광고비 desc(재료는 `campGroups` 재사용, `campaignInfo`). **브랜드검색 캠페인 이슈는 제외**(`dropBrandCandidates`). 제목 행 오른쪽 필터 아이콘(줄 3개) → 전체/목표 달성/개선 필요 드롭다운(아이콘 상태색 기준, 보기 전용이라 선택 유지, 자식 없는 머리글·띠는 함께 숨김). 캠페인/그룹 머리글 클릭=자식 일괄 선택, 머리글 **제목 글자** 클릭=광고관리자 새 탭(캠페인 `/sa/campaigns/{id}`, 그룹 `/sa/adgroups/{id}`).
- 고급 옵션: 보고 유형·이슈 기준=칩 + i 툴팁(클릭 토글, 바깥 클릭으로 닫힘, 스크롤 따라 재배치), 맞춤 라벨은 최소 광고비(%)/최소 클릭률/최소 노출/낮은 순위 기준. 맞춤은 칩 클릭 시 **폼만 열리고 취소/적용 버튼으로 확정**(2026-07-22, 자동 적용·디바운스 폐기 — 칩만 눌러도 새로고침되는 게 어색하다는 사용자 결정). `sensitivity`(화면 선택)와 `appliedSensitivity`(실제 반영)를 분리 — 취소는 applied로 복귀, 적용만 `onChange` 호출. 제목 아래 "기준 변경 시 성과 측정이 새로고침됩니다" 안내 고정. 대화 스타일은 인라인(화살표로 생성, 자동 저장) — 입력칸은 **포커스 중에만** 휠 스크롤, 끝에 닿아도 목록으로 안 넘어감. `brief-tone-panel.ts`는 데드코드(미참조, 삭제 예정). "지난 보고 보기" 버튼은 내림 — 저장(brief-history)은 유지.
- 사용자 노출 텍스트에 **가운뎃점(·) 금지**(em dash와 동일 취급) — 서버 brief-compose 프롬프트에도 출력 금지 규칙 있음.

## Gotchas

- **리포트 키워드 행은 검색어(expKeyword)라 입찰가가 없다.** 순위 보강의 userBid는 ncc 등록 키워드에서 가져와 정규화 텍스트 매칭 — 맵에 없는 검색어(확장 매칭)는 순위 미기재, 후보에서 자연히 빠짐. 순위 조회는 green+비용 임계 통과 후보로 좁힌 뒤에만(전체면 수백 회).
- 목표 ROAS(`MultiAccountUserMeta.targetRoas`) 미설정 시 구간 분류 후보를 만들지 않는다 — 자동 추정(계정 평균) 금지: 계정이 통째로 부진하면 전부 "정상"으로 나옴.
- 상품 후보는 소재ID로 전기와 매칭(`shProductAdRows`/`shProductInfo`). 이름 못 얻은 소재는 ID 폴백 금지(광고주에게 `nad-...` 노출 불가) — 제외.
- Gemini 모델은 신규 키 제공 중단이 있을 수 있음(2.5 → 3.1 flash-lite 교체 사례). 502 upstream이면 키로 모델 목록부터 조회.
- 인증은 F-Accounts 도입(2026-07-17)으로 로그인 세션(JWT) + `approved` 확인으로 교체됨 — 이용 코드(`brief_token`) 화이트리스트 방식은 폐기. `BRIEF_TOKENS` 시크릿은 롤백 창(안정화 확인) 뒤 삭제 예정.
