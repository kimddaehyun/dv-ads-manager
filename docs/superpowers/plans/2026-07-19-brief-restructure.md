# F-Brief 구조 개편 - 선택 우선 보고 흐름 (진행 상황)

> 2026-07-19 세션 기록. 다른 컴퓨터에서 이어서 작업할 때 이 문서부터 볼 것.
> 원본 스펙: 사용자 제공 `naver-ai-report-feature-spec.md` (1차+2차 범위만, 3차는 미착수).

## 무엇이 바뀌었나

기존 "자동으로 전체 보고 생성 → 원하면 직접 고르기"를 **선택 우선**으로 뒤집음:
데이터 취합(성과 ∥ 지난 보고 ∥ 변경 이력) → 이슈 선택 화면(필수) → 선택분만 AI 조립 → 결과 패널.
자동 전체 생성 모드는 폐기.

## 완료된 작업 (전부 커밋됨)

- [x] T1 변경 이력 후보 순수 로직 — `brief-change-rules.ts` (kind `changeFollowUp`, 우리 팀 작업자 포함 매칭, ROAS ±10% 평가, 기간 중간 변경은 "판단 보류", 대상당 1건·상한 8건)
- [x] T2 fetch 계층 — `brief-change-data.ts` (조회 창 = 기간 시작 14일 전~끝, `change_watch_identity` 재사용, 실패해도 흐름 계속)
- [x] T3 DB — `20260719000000_brief_v2.sql` **원격 적용 완료** (brief_history에 report_type/tone/ai_draft/included_*/related_change_ids/sent_status + brief_tone 테이블)
- [x] T4 광고주별 유형·톤 기억 — `MultiAccountUserMeta.briefReportType/briefTone`
- [x] T5 선택 화면 — 보고 유형(사후보고/사전제안) + 톤 6종 드롭다운, 이전 이력/변경 이력 토글(비활성 사유는 아래 회색 줄)
- [x] T5.5 AE 개인 말투 — `brief_tone` 테이블 + `mode:"distillTone"` + "내 말투" 다이얼로그. compose 시 서버가 JWT로 tone_prompt 직접 조회(payload 아님)
- [x] T6 흐름 반전 — `brief.ts` 재구성 (BriefContext, 다시 고르기 = 재수집 없이 복귀)
- [x] T7 Edge Function — 유형/톤/지난 보고/개인 말투/AI 상투어 금지("흐름입니다" 등) 프롬프트. **배포 완료**
- [x] T8 결과 패널 — 재생성 버튼군(다시 생성/더 짧게/더 부드럽게/숫자 중심, 편집분 확인 후 덮어씀) + 저장 버튼(saved_only)
- [x] 이슈 기준 커스텀 — `brief-thresholds.ts` + 다이얼로그: 비용 문턱 자동 보정(총광고비 1.5%, 1만~20만) + 프리셋(민감하게/보통/느슨하게) + 직접 설정. `MultiAccountUserMeta.briefSensitivity/briefThresholds`. 기준 변경 시 재수집 없이 `rebuildCandidates`
- [x] UX 다듬기 — 문구 간소화, em dash 제거, 이슈 목록을 "제목 + 근거 데이터 한 줄"로(액션 드롭다운 제거 - 조치는 항상 AI가 판단)

검증: vitest 118개 통과 / typecheck / build 전부 성공. 상세 파일 설명은 `src/features/brief/CLAUDE.md`.

## 남은 일

- [ ] 실계정 수동 QA: ①선택 화면 먼저 뜨는지 ②사전제안 문체("~괜찮을까요?") ③톤 반영 ④변경 이력 후보(작업자 등록 계정) ⑤복사 후 brief_history 행 확인 ⑥재생성 ⑦내 말투 등록 전/후 비교 ⑧이슈 기준 프리셋 변경 시 후보 수 변화
- [ ] 3차 범위(별도 플랜 필요): 사전제안 동의 후 변경안 미리보기 → 네이버 화면 자동 입력 → 적용 완료 기록
