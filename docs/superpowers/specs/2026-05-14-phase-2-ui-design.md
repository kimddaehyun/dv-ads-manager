# Phase 2 UI 디자인 Spec

> **상태**: Brainstorm 완료, 구현 계획 작성 직전 (2026-05-14)
> **대상 작업**: ROADMAP Task 003 / 004 / 005 / 006
> **참조 문서**: [`docs/PRD.md`](../../PRD.md) · [`docs/ROADMAP.md`](../../ROADMAP.md) · [`docs/DESIGN.md`](../../DESIGN.md)

## 0. 개요

Phase 2는 디브이 애드 매니저의 **UI/UX 표면을 더미 데이터로 완성**하는 단계입니다. 디자인 시스템 토큰 정리, 공용 React 컴포넌트, 옵션·팝업·콘텐츠 오버레이 시안 — 4개 작업을 묶어 한 번에 마감합니다.

실제 API·storage 연동은 Phase 3로 미루고, **시각적·인터랙션 분기를 모두 더미 상태로 렌더**해 검토 가능하게 합니다. 콘텐츠 오버레이는 셀렉터 미정 단계라 `src/demo/index.html`이라는 별도 Vite 엔트리에서 시안만 검증합니다 (Phase 3 Task 010에서 실제 `ads.naver.com` 주입).

## 1. 범위

| Task | 대상 | 산출물 |
|------|------|--------|
| **Task 003** | 토큰 + 공용 컴포넌트 | `src/styles/theme.css`, `src/styles/overlay.css`, `src/components/*.tsx` |
| **Task 004** | 옵션 페이지 F011 폼 | `src/options/Options.tsx` 갱신, `src/options/credentials-ui.tsx` 신설 |
| **Task 005** | 팝업 F012 | `src/popup/App.tsx` 갱신 |
| **Task 006** | 콘텐츠 오버레이 시안 | `src/demo/{index.html, main.tsx, App.tsx}` + 콘텐츠 오버레이용 R 컴포넌트들 |

## 2. 아키텍처

### 2.1 파일 구조

```
src/
├── styles/                          [신규]
│   ├── theme.css                    Tailwind v4 @theme + DESIGN.md 토큰 + Pretendard import
│   └── overlay.css                  콘텐츠 오버레이 전용 .dvads-* CSS (theme 변수 참조)
├── components/                      [신규]
│   ├── Button.tsx                   variant: default | brand | secondary, size: sm | md | lg
│   ├── Badge.tsx                    variant: success | warning | error | info | neutral | brand
│   ├── StatusDot.tsx                Vercel "● Ready" 패턴, variant: success | warning | error | neutral | live
│   ├── Card.tsx                     flat 카드 (보더·그림자 X)
│   ├── Field.tsx                    label + input + 에러 메시지 슬롯
│   ├── Input.tsx                    Field 내부에서 쓰는 단독 입력
│   └── ActionRow.tsx                수정·삭제 같은 리스트 아이템 (icon + label + chevron)
├── icons/                           [신규]
│   └── index.tsx                    inline SVG (plus, refresh, external, eye, edit, trash, key, settings, x)
├── popup/
│   ├── index.css                    @import "../styles/theme.css"
│   └── App.tsx                      F012 상태별 분기
├── options/
│   ├── index.css                    @import "../styles/theme.css"
│   ├── Options.tsx                  기존 + F011 폼 통합
│   └── credentials-ui.tsx           [신규] customerId/accessLicense/secretKey 폼
├── demo/                            [신규] Vite 엔트리, dev 전용
│   ├── index.html
│   ├── main.tsx
│   └── App.tsx                      F001 정상·미매칭·잠금, F002 그룹, F003 소재 시안 stack
└── content/                         (Phase 3 Task 010에서 overlay.css 주입)

vite.config.ts                       rollupOptions.input에 demo 엔트리 추가 (dev 전용)
manifest.config.ts                   변경 없음 (demo는 확장 빌드에 포함 X)
```

### 2.2 진입점

| 진입점 | URL / 트리거 | 빌드 포함 |
|--------|--------------|----------|
| 팝업 | 브라우저 툴바 아이콘 | ✅ `dist/` |
| 옵션 | `chrome-extension://<id>/src/options/index.html` 또는 chrome://extensions | ✅ `dist/` |
| 데모 | `http://localhost:5173/src/demo/index.html` (`npm run dev` 시에만) | ❌ |
| 콘텐츠 스크립트 | `ads.naver.com/*` 자동 주입 | ✅ `dist/` (Phase 3에서 활성) |

데모 엔트리는 `vite.config.ts`의 `build.rollupOptions.input`에 추가하되, `manifest.config.ts`에는 등록 안 함 → `dist/`에 들어가지 않아 확장 zip 크기 증가 X.

## 3. 디자인 시스템 적용

**단일 진실의 원천**: [`docs/DESIGN.md`](../../DESIGN.md). 본 spec은 그 원칙을 dv-ads 표면에 적용하는 매핑만 정의합니다.

### 3.1 핵심 토큰 (Tailwind v4 `@theme`)

```css
/* src/styles/theme.css */
@import "tailwindcss";
@import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";

@theme {
  /* Brand */
  --color-brand: #E6783B;
  --color-brand-hover: #F08A4F;
  --color-brand-subtle: rgba(230, 120, 59, 0.10);
  --color-brand-ring: rgba(230, 120, 59, 0.50);

  /* Ink & Neutral */
  --color-ink: #171717;
  --color-ink-warm: #1F1714;
  --color-ink-warm-hover: #2A1F1A;
  --color-gray-300: #a3a3a3;
  --color-gray-400: #808080;
  --color-gray-500: #666666;
  --color-gray-600: #4d4d4d;

  /* Surfaces */
  --color-white: #ffffff;
  --color-bg-soft: #fafafa;
  --color-card-border: #ECEEF0;
  --color-button-light: #F3F4F6;
  --color-button-light-hover: #E5E7EB;

  /* State */
  --color-state-success: #16a34a;
  --color-state-success-subtle: rgba(22, 163, 74, 0.10);
  --color-state-warning: #d97706;
  --color-state-warning-subtle: rgba(217, 119, 6, 0.10);
  --color-state-error: #DC2626;
  --color-state-error-subtle: rgba(220, 38, 38, 0.10);
  --color-state-info: #0072f5;

  /* Radius */
  --radius-btn: 6px;
  --radius-card: 8px;
  --radius-popover: 12px;
  --radius-pill: 9999px;

  /* Font */
  --font-sans: "Pretendard Variable", Pretendard, system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Consolas, monospace;

  /* Shadow (popover만, 카드는 shadow 없음) */
  --shadow-popover:
    0 2px 4px rgba(0, 0, 0, 0.04),
    0 12px 24px rgba(0, 0, 0, 0.08),
    0 32px 64px -16px rgba(0, 0, 0, 0.10);
}

:root {
  font-family: var(--font-sans);
  font-feature-settings: "tnum";
  background: var(--color-bg-soft);
  color: var(--color-ink);
  color-scheme: light;
}
```

### 3.2 핵심 원칙 재확인 (DESIGN.md 인용)

- **카드 v5 flat**: 보더·그림자 X. `--color-bg-soft` 페이지 위 `--color-white` 카드 1% 명도차로만 떠 보임.
- **버튼 Vercel strict**: sm 28h / md 32h / lg 40h, padding-x 10/12/16, font 13/14/14, weight 500, radius 6px, **`box-shadow` 절대 X**.
- **DV 주황 ~3% 면적**: 로고 + 브랜드 CTA + F001 순위 배지 + focus ring. 그 외는 default(ink-warm) 검정.
- **3-weight type**: 400 / 500 / 600. 700 bold 금지.
- **콘텐츠 오버레이는 `dvads-` prefix 격리**.

## 4. 공용 컴포넌트

### 4.1 Button

```tsx
type Variant = "default" | "brand" | "secondary";
type Size = "sm" | "md" | "lg";

<Button>등록</Button>                       // default md (95% 케이스)
<Button variant="brand">등록</Button>        // 화면당 1개 브랜드 CTA
<Button variant="secondary">취소</Button>    // 보조
<Button size="sm" variant="default">관리</Button>
<Button variant="brand" block><PlusIcon /> 옵션 열기</Button>  // empty state
```

규칙:
- height: 28 / 32 / 40 (sm/md/lg)
- padding-x: 10 / 12 / 16
- font-size: 13 / 14 / 14 — 모두 weight 500
- radius 6px, letter-spacing 0
- `box-shadow` 절대 사용 X
- disabled: `opacity-40 cursor-not-allowed` (색 변경 X)

### 4.2 Badge

```tsx
<Badge variant="success">활성</Badge>
<Badge variant="warning">미등록</Badge>
<Badge variant="error">등록 실패</Badge>
<Badge variant="brand">F001</Badge>
```

- h-5 / text-xs / rounded-full / px-2
- 모두 `bg-{X}-subtle` + `text-{X}` (subtle 배경 + solid 텍스트)

### 4.3 StatusDot (Vercel "● Ready" 패턴)

```tsx
<StatusDot variant="success" label="활성" />
<StatusDot variant="warning" label="미등록" />
<StatusDot variant="live" label="조회 중" />  // brand orange + 펄스
```

- 작은 색점(8px) + 텍스트, 카드 row의 v 컬럼에서 차분한 상태 표시
- `live` variant만 펄스 애니메이션

### 4.4 Card (v5 flat)

```tsx
<Card>
  ...content...
</Card>

<Card padding="sm">  // KPI/metric 류
  ...
</Card>

<Card padding="none">  // 내부에서 직접 padding 관리 (action-list 등)
  ...
</Card>
```

- `bg-white border-0 rounded-lg p-6 shadow-none`
- hover 효과 X (인터랙션 피드백은 내부 요소가 담당)

### 4.5 Field + Input

```tsx
<Field label="customerId" error={errorMessage}>
  <Input value={...} onChange={...} mono />
</Field>
```

- Input: `bg-white border-transparent rounded-lg h-8 px-2.5 text-sm`
- hover: `bg-bg-soft`
- focus-visible: `border-brand ring-3 ring-brand-ring`
- error: `border-state-error ring-3 ring-state-error-subtle`
- `mono` prop → font-mono

### 4.6 ActionRow (수정/삭제 리스트)

```tsx
<ActionList>
  <ActionRow icon={<EditIcon />} label="수정" onClick={...} />
  <ActionRow icon={<TrashIcon />} label="삭제" variant="danger" onClick={...} />
</ActionList>
```

- 카드 내부 padding 8px, rounded-lg 8px item, hover bg-button-light
- icon 16px (gray-500 또는 state-error), chevron 우측

## 5. 옵션 페이지 (Task 003 + 004)

### 5.1 레이아웃

```
[로고 36px] 디브이 애드 매니저
            네이버 광고 대시보드 보조

라이선스                          ← section-label
[card · F010 관리]

검색광고 API                       ← section-label
[card · F011 폼 또는 등록됨 요약]
```

### 5.2 상태 분기 (4개)

| 상태 | 라이선스 | API 카드 | 브랜드 CTA |
|------|----------|----------|-----------|
| 1 · 미등록 | 활성 dot + 관리 | 폼 (customerId/accessLicense/secretKey + 표시 토글) | "등록" (brand) |
| 2 · 등록됨 | 활성 dot + 관리 | 마스킹 요약 + action-list (수정 / 삭제) | 없음 (안정 상태) |
| 3 · 등록 실패 | 활성 dot + 관리 | 폼 + err 인풋 + err-text | "등록" (brand) + "취소" (secondary) |
| 4 · 라이선스 미설정 | 라이선스 입력 + "등록" (brand) | lock-banner (`먼저 라이선스 키를 등록해주세요.`) | "등록" (브랜드, 라이선스 쪽 1개) |

규칙: **화면당 brand 버튼 1개 이하** (DESIGN.md).

### 5.3 폼 검증

- `customerId`: trim 후 1자 이상의 숫자 — 정규식 `/^\d+$/`
- `accessLicense`: trim 후 non-empty
- `secretKey`: trim 후 non-empty (등록 시) / 수정 시는 빈칸이면 기존 값 유지
- 검증은 submit 시점에 일괄 — onChange는 dirty 처리만

### 5.4 등록 흐름

1. 사용자가 폼 채우고 "등록" 클릭
2. (Task 004 더미 단계) `console.log(formValues)` 후 즉시 상태 2로 전환
3. (Phase 3 Task 008) `searchad.ts`의 `saveCredentials()` 호출 → `chrome.storage.local`
4. (Phase 3) HMAC 헤더 테스트 호출 1회 → 401/403/네트워크 에러 시 `friendly-error.ts`로 상태 3
5. 성공 시 상태 2

### 5.5 수정·삭제

- **수정** action-row 클릭 → 폼 재오픈 + customerId/accessLicense prefill, secretKey 빈칸
- **삭제** action-row 클릭 → `confirm("등록 정보를 삭제할까요?")` → 상태 1로

## 6. 팝업 페이지 (Task 005)

### 6.1 레이아웃

```
[로고 24px] 디브이 애드 매니저
─────────────────────────────────
   KPI 카드 — 라이선스 상태
   [활성 dot] · 등급 / 만료 / 검증

   미니 row — 검색광고 API
   [검색광고 API] · [등록됨 dot]
─────────────────────────────────
[옵션 열기 secondary]   [지금 다시 조회 default]
```

폭 340px, 라운드 12px, popover shadow.

### 6.2 상태 분기 (3개)

| 상태 | 콘텐츠 | 푸터 |
|------|--------|------|
| 1 · 정상 (라이선스 활성 + API 등록) | 라이선스 KPI + API 등록됨 row | "옵션 열기" (secondary sm) + "지금 다시 조회" (default sm) — **brand 0개** |
| 2 · API 미등록 | 라이선스 KPI + API 미등록(warn) row | "옵션 열기" (brand lg block) — **brand 1개** |
| 3 · 라이선스 미설정/만료 | empty state (키 아이콘 + 안내) | "옵션 열기" (brand lg block) — **brand 1개** |

### 6.3 F012 "지금 다시 조회"

(Phase 3 Task 011에서 실구현) 클릭 시:
1. `chrome.tabs.query({active: true, currentWindow: true})` → 활성 탭 host 확인
2. host가 `ads.naver.com`이면 활성 탭 키워드 캐시(`volume_cache:*`) 만료
3. 콘텐츠 스크립트에 `REFRESH_ACTIVE_TAB` 메시지 전송 → 재조회 트리거

Task 005 더미 단계에서는 클릭 → `console.log("refresh")`만.

## 7. 콘텐츠 오버레이 시안 (Task 006)

데모 페이지(`src/demo/`)에서 React로 렌더하는 **시각 시안**. 실제 `ads.naver.com` 주입은 Phase 3 Task 010.

### 7.1 F001 파워링크 (1~15위)

#### 7.1.1 페이지 banner (호스트 페이지 상단 주입)

| 상태 | 톤 | 텍스트 |
|------|----|--------|
| 활성 | brand subtle | `[DV 로고] 디브이 애드 매니저 활성 · X개 키워드 분석 (1~15위)` + 우측 캐시 시각 |
| 자격증명 미등록 | warn subtle | `⚠ 검색광고 API 키가 등록돼 있지 않아 분석이 비활성입니다. [옵션에서 등록 →]` |
| 라이선스 미설정 | gray | `🔒 라이선스 키가 필요합니다. [옵션에서 등록 →]` |

#### 7.1.2 키워드 행 inline 배지 (자격증명 매칭 시만)

- 위치: 호스트 키워드 셀 **우측 끝** (flex spacer로 키워드명과 분리)
- 텍스트: `N위 ▾` (1~15 정확한 숫자) 또는 `순위권 밖 ▾` (시장 15위 입찰가보다 낮음) 또는 `분석 중…` (로딩)
- 톤:
  - **brand subtle** (`#E6783B`): 1~15위
  - **warning subtle** (`#d97706`): 순위권 밖
  - **gray**: 분석 중 (spinner)
- 클릭 시: 그 행 바로 아래에 펼침 행 인서트, 1~15위 입찰가 미니 테이블 표시
- 호스트의 sub-tag (`적은검색량` 등)와도 같은 셀에 자연 공존

#### 7.1.3 펼침 패널 (1~15위 입찰가 미니 테이블)

```
┌─────────────────────────────────────────────────────────────────┐
│ 1~15위 예상 입찰가 · 시장 단위 추정 · 2분 전 캐시      ↻ 새로고침 │
│                                                                 │
│ 순위    1    2    3   ...  13   14   15                          │
│ 예상가  3,200 2,400 1,950 ... 510 460 420                        │
│         ↑ 현재 추정 순위 컬럼은 brand subtle 배경                │
└─────────────────────────────────────────────────────────────────┘
```

- 테이블 `table-layout: fixed` 로 1~15 컬럼 자동 폭 조정
- 현재 추정 순위 컬럼만 brand subtle 배경 + brand text
- 새로고침 버튼 클릭 시 (Phase 3) 그 키워드의 캐시만 만료 → 재조회

#### 7.1.4 1~15위 범위 근거

- 네이버 검색결과 PC 1페이지 파워링크 영역 ≈ 10~15개
- 검색광고 API `POST /estimate/average-position-bid/keyword`는 `items` 배열로 한 번에 여러 position 요청 가능 — **Spike C(Phase 3 Task 010 1일차)에서 단일 호출 max 확정**
- 범위 결정 원칙: **단일 API 호출로 받을 수 있는 max position까지**. 추가 API 호출로 범위를 늘리지는 않음 (rate limit 보호)
- Spike C 결과에 따라 14 또는 16 등으로 조정 가능. PRD·ROADMAP은 spec 시점에 "1~15위"로 통일하되, 실제 범위는 코드 상수(`MAX_POSITION = 15`)로 단일화

### 7.2 F002 쇼핑검색광고 그룹 inline 펼침

데이터 소스는 **Spike B(Phase 4 Task 012)에서 확정** — 데모 페이지에는 placeholder 시안만:

- 호스트 소재 행 우측에 `키워드 분석 ▾` / `키워드 닫기 ▴` 토글 버튼 (secondary 톤)
- 펼침 시 행 바로 아래에 자동매칭 키워드 × 1~15위 입찰가 미니 테이블
- 다중 소재 동시 펼침 가능
- 키워드별 현재 순위 컬럼 + 미노출 키워드는 "미노출" 표기

### 7.3 F003 쇼핑검색광고 소재 상세 풀패널

데이터 소스 TBD. 데모 페이지에는 시안:

- 카드 상단: 소재명 + 정렬·검색 인풋
- 본문: 자동매칭 키워드 전체 목록 (키워드 / 현재 순위 / 1~15위 입찰가)
- 풋: 캐시 시각 + 새로고침 버튼

### 7.4 호스트 페이지 격리 전략

#### 7.4.1 CSS 격리

- 모든 클래스 `dvads-` prefix
- `src/styles/overlay.css`에 핸드롤 CSS (Tailwind 미사용 — 콘텐츠 스크립트는 React 트리 외부의 DOM 조작)
- theme.css에 정의된 CSS custom property (`--color-brand` 등) 직접 참조

```css
/* src/styles/overlay.css 발췌 */
.dvads {
  font-family: "Pretendard Variable", system-ui, sans-serif;
  font-feature-settings: "tnum";
  color: #171717;
}
.dvads-rank-badge {
  display: inline-flex; align-items: center; gap: 4px;
  height: 22px; padding: 0 8px;
  background: rgba(230, 120, 59, 0.10);
  color: #E6783B;
  border-radius: 6px; font-size: 12px; font-weight: 600;
  font-family: ui-monospace, monospace;
  cursor: pointer;
}
.dvads-rank-badge.warn { background: rgba(217, 119, 6, 0.10); color: #d97706; }
.dvads-rank-badge.loading { background: #F3F4F6; color: #808080; }
/* ... 나머지 콘텐츠 오버레이 클래스 ... */
```

#### 7.4.2 z-index

- 모든 dvads 요소 (특히 floating banner): `z-index: 2147483647` (max int32)
- 펼침 행은 호스트 테이블의 일부라 z-index 불필요

#### 7.4.3 CSS 주입 방식 (Phase 3 Task 010에서 활성)

```ts
// src/content/index.ts (Phase 3에서 작성)
import overlayCss from "../styles/overlay.css?inline";

function injectStyles() {
  if (document.getElementById("dvads-styles")) return;
  const el = document.createElement("style");
  el.id = "dvads-styles";
  el.textContent = overlayCss;
  document.head.appendChild(el);
}
```

`?inline` Vite 쿼리로 CSS를 문자열로 import → 한 번 주입. Shadow DOM 안 씀(Pretendard 통합과 토큰 cascade 까다로움).

#### 7.4.4 호스트 cascade 방어

호스트 CSS가 우리 요소에 영향 미치지 않도록:

```css
/* overlay.css 상단 */
.dvads, .dvads * {
  all: revert;  /* 호스트 cascade 끊기 */
}
.dvads {
  /* 다시 우리 스타일 적용 */
  font-family: ...;
  /* ... */
}
```

`all: revert`는 user-agent 기본값으로 되돌림 → 호스트의 글로벌 `* { box-sizing: border-box; }` 같은 규칙도 무력화. 그 위에 우리 스타일 다시 깔기.

## 8. 데모 페이지 구조 (Task 006)

### 8.1 Vite 설정

```ts
// vite.config.ts (관련 부분만)
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: "src/popup/index.html",
        options: "src/options/index.html",
        // demo는 manifest에 등록 안 됨 — dev에서만 접근
      },
    },
  },
  server: {
    // dev에서 http://localhost:5173/src/demo/index.html 접근 가능
  },
});
```

`manifest.config.ts`는 변경 없음 — demo는 확장 zip에 포함되지 않음.

### 8.2 데모 App 구조

```tsx
// src/demo/App.tsx
export default function Demo() {
  return (
    <div className="demo-stack">
      <DemoSection title="옵션 · 미등록"        ><OptionsPage state="empty" /></DemoSection>
      <DemoSection title="옵션 · 등록됨"        ><OptionsPage state="registered" /></DemoSection>
      <DemoSection title="옵션 · 등록 실패"      ><OptionsPage state="error" /></DemoSection>
      <DemoSection title="옵션 · 라이선스 미설정"><OptionsPage state="locked" /></DemoSection>
      <DemoSection title="팝업 · 정상"          ><PopupApp state="ok" /></DemoSection>
      <DemoSection title="팝업 · API 미등록"    ><PopupApp state="no-cred" /></DemoSection>
      <DemoSection title="팝업 · 라이선스 미설정"><PopupApp state="no-license" /></DemoSection>
      <DemoSection title="F001 · 정상"          ><PowerlinkOverlay state="ok" /></DemoSection>
      <DemoSection title="F001 · 미매칭"        ><PowerlinkOverlay state="no-cred" /></DemoSection>
      <DemoSection title="F001 · 잠금"          ><PowerlinkOverlay state="locked" /></DemoSection>
      <DemoSection title="F002 · 쇼핑 그룹"     ><ShoppingGroupOverlay /></DemoSection>
      <DemoSection title="F003 · 쇼핑 소재"     ><ShoppingDetailOverlay /></DemoSection>
    </div>
  );
}
```

각 시안은 `<DemoSection title="">` 래퍼 안에 실제 컴포넌트 렌더. props로 더미 상태 주입.

### 8.3 더미 데이터

- 라이선스: `{ tier: "basic", expires_at: "2026-12-31", verified_at: "3분 전" }`
- 자격증명: `{ customerId: "12345", accessLicense: "0100000000abcdef...", secretKey: "•••" }`
- 키워드 더미 5~7개 + rank_to_bid 매핑 (1~15위)

`src/demo/fixtures.ts`에 더미 데이터 모음.

## 9. 데이터 흐름

Phase 2에서는 실 데이터 없이 props로 상태 주입. 컴포넌트는 추후 Phase 3에서 실 storage·API 콜로 연결될 수 있게 **상태를 외부에서 받는 형태**로 설계:

```tsx
// Bad — 컴포넌트가 직접 storage 호출
function OptionsForm() {
  const [creds, setCreds] = useState(null);
  useEffect(() => { loadCredentials().then(setCreds); }, []);
  // ...
}

// Good — props로 받음, Phase 3에서 부모가 storage 연결
function OptionsForm({ initialCreds, onSubmit }) {
  // ...
}

// 데모에서는: <OptionsForm initialCreds={DUMMY} onSubmit={console.log} />
// Phase 3에서: <OptionsForm initialCreds={await loadCredentials()} onSubmit={saveCredentials} />
```

## 10. 에러 처리

Phase 2에서는 상태별 시안만. 실제 에러는 Phase 3에서 `friendly-error.ts` 재사용:

| 시나리오 | 표시 |
|----------|------|
| API 401/403 | 빨간 ring 인풋 + "API 인증 실패 (401). 광고관리자에서 발급받은 secretKey가 맞는지 확인해주세요." |
| API 429 | "잠시 후 다시 시도해주세요. 검색광고 API 요청이 많아 대기 중입니다." |
| 네트워크 에러 | "네트워크에 연결할 수 없습니다." |
| 라이선스 RPC 실패 | LicenseUi 컴포넌트가 기존 로직 그대로 처리 (코어 동기화) |

## 11. 수동 검증 (Phase 2 완료 체크리스트)

데모 페이지(`npm run dev` → `http://localhost:5173/src/demo/index.html`)에서:

- [ ] 옵션 4가지 상태가 의도대로 렌더 (미등록 / 등록됨 / 등록 실패 / 라이선스 미설정)
- [ ] 팝업 3가지 상태가 의도대로 렌더 (정상 / API 미등록 / 라이선스 미설정)
- [ ] 팝업 정상 상태에 brand 버튼이 0개, 미등록/라이선스 미설정 상태에 brand 버튼이 정확히 1개씩
- [ ] 옵션 미등록 상태에 brand 버튼 1개 ("등록"), 등록됨 상태에 brand 0개
- [ ] F001 정상 시안에 "1위 ~ 15위" / "순위권 밖" / "분석 중…" 배지가 각각 렌더
- [ ] F001 펼침 시안에 1~15 컬럼 미니 테이블, 현재 추정 순위 컬럼만 brand 배경
- [ ] F002 그룹 시안에 토글 + 펼침 키워드 테이블
- [ ] F003 소재 시안에 풀패널 (정렬·검색 UI 포함)
- [ ] 빌드 시 `dist/`에 demo 파일이 포함되지 않음 (`npm run build && ls dist/src/`)

`chrome://extensions`에 `dist/` reload 후:
- [ ] 옵션 페이지 진입 (현재 상태 = Task 002 종료 시점이므로 미등록 상태로 렌더)
- [ ] 팝업 클릭 시 라이선스 상태에 따라 분기 (실제 storage 값 기준)
- [ ] 콘텐츠 스크립트는 아직 비활성 (Phase 3 Task 010)

## 12. PRD / ROADMAP 동기화 영향

본 spec 작성 시점에 다음 문서 변경 필요:

| 문서 | 변경 |
|------|------|
| `docs/PRD.md` §F001 데이터 소스 | "1~10위" → "**1~15위**" (Spike C에서 API max 확정 후 조정) |
| `docs/PRD.md` 데이터 모델 `KeywordVolumeCache.rank_to_bid` | `RankPosition` 타입을 `1...15`로 확장 |
| `docs/ROADMAP.md` Task 010 | `position: 1, ..., position: 10` → `position: 1, ..., position: 15` |
| `src/types/storage.ts` `RankPosition` 타입 | `1 | 2 | ... | 10` → `1 | 2 | ... | 15` |

이 변경은 **Task 003 시작 전에 별도 commit으로 처리** (writing-plans 단계의 첫 plan).

## 13. Out of Scope (Phase 2에서 안 함)

- 실제 `chrome.storage.local` 연동 (Phase 3 Task 008)
- 라이선스 검증 RPC 연결 (Phase 3 Task 009)
- 검색광고 API 실호출 (Phase 3 Task 010)
- 콘텐츠 스크립트의 실제 `ads.naver.com` 셀렉터 (Phase 3 Task 010)
- F002/F003 데이터 소스 확정 (Spike B — Phase 4)
- F001 단축키·키보드 네비게이션 (백로그)
- 다크 모드 (MVP 이후)
- 캐시 prune·LRU (Phase 4 Task 015)

## 14. 참조

- [`docs/DESIGN.md`](../../DESIGN.md) — 디자인 시스템 단일 진실의 원천
- [`docs/PRD.md`](../../PRD.md) — 기능 명세 (F001 / F010 / F011 / F012)
- [`docs/ROADMAP.md`](../../ROADMAP.md) — Task 003 / 004 / 005 / 006
- [`CLAUDE.md`](../../../CLAUDE.md) — 코드베이스 가이드, 디자인 시스템 참조

---

**Brainstorm 산출물**: `.superpowers/brainstorm/1972-1778739033/content/` 에 시안 HTML 보존 (Pretendard CDN, foundation, options-popup states v1~v6, overlay v1~v3, design-system v4~v5).
