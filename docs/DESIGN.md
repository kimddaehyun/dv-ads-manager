# Design System - 디브이 애드 매니저

> 이 문서는 **현재 출시된 디자인을 그대로 문서화**한 retrospective DESIGN.md 입니다.
> 모든 토큰은 `src/` 코드에서 추출한 실제 값이며, 신규 UI 추가 시 이 문서를
> **단일 디자인 소스**로 참조합니다. 갱신 흐름:
> `DESIGN.md → src/styles/theme.css → @theme → 컴포넌트 / src/styles/overlay.css`.
>
> 디자인 톤은 자매 프로젝트 [디브이 SEO 매니저](https://github.com/.../dv-mkt-naver-tag-picker)와
> 의도적으로 통일했습니다 — 같은 셀러가 두 확장을 함께 쓰는 워크플로우라 시각 정체성이
> 어긋나면 안 됩니다.

---

## Product Context

- **What this is:** 네이버 광고 대시보드(`ads.naver.com`)에 주입되는 Chrome MV3 확장.
  키워드별 **파워링크 예상 입찰가**, **쇼핑검색 순위**, **다른 순위의 예상 입찰가**를
  광고 화면 옆에 실시간 표시.
- **Who it's for:** 대행사 AE · 인하우스 운영자. 입찰 의사결정의 보조 데이터 도구.
- **Space/industry:** 한국 디지털 광고 운영, 네이버 검색광고.
- **Project type:** Chrome MV3 확장 — 세 가지 UI 컨텍스트를 동시에 가짐.
  - **콘텐츠 오버레이** (`src/features/bid/index.ts` + `src/styles/overlay.css`): `ads.naver.com`의
    광고 테이블에 inline 주입되는 배지·펼침 행·popover. 순수 CSS, Tailwind 미사용 (호스트
    페이지와 CSS 충돌 회피용 격리 — `dvads-` prefix).
  - **팝업** (`src/popup/`): 툴바 아이콘 클릭 시 열리는 React 19 + Tailwind v4 미니 페이지.
  - **옵션 페이지** (`src/options/`): chrome://extensions 또는 팝업의 "옵션 열기"로 진입.
    검색광고 API 자격증명(`customerId`/`accessLicense`/`secretKey`) 등록 · 데이터 처리 사항.
    **계정/로그인 UI는 골격이 작성되어 있으나 현재 활성화되어 있지 않음** — 향후 라이선스
    재도입 시 마운트 가능한 상태로 준비.

---

## Aesthetic Direction

- **Direction:** 실용 정보 밀도형 (information-dense utility). 사용자가 광고 테이블 옆에서
  입찰가·순위를 빠르게 확인하고 의사결정하는 워크플로우가 핵심.
- **Decoration level:** minimal. 장식 거의 없음, 숫자/지표가 주인공.
- **Mood:** 차분한 라이트 톤 베이스(`#f4f5f7`) 위에 브랜드 주황 `#E6783B`로 액션/강조만
  강하게 찍는다. 오버레이의 주황 보더(1.5px)는 "여기는 우리 확장이 그린 영역"이라는
  영역 정체성 신호. 호스트 페이지와의 시각 경계.

---

## Typography

- **Display/Hero:** Pretendard Variable — 한글 가독성 + variable axis로 굵기 한 폰트로 해결.
- **Body / UI / Labels / Data:** 동일 (Pretendard Variable). 숫자가 정렬되어야 하는 자리(입찰가
  표, 순위 배지, API 키 입력)도 모두 Pretendard로 통일하고 정렬은 `font-feature-settings: "tnum"`
  (tabular-nums)로 해결.
- **Code/Mono:** 현재 사용처 없음. `--font-mono` 토큰만 향후 옵션을 위해 보존.
- **Loading 전략:**
  - 옵션/팝업: NPM 패키지 `pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css`
    import (`src/styles/theme.css`에서 단일 import → popup/options/demo 진입점 공유).
    동적 서브셋 - 필요한 글자만 로드.
  - 오버레이 (Shadow 미사용, 호스트 페이지에 inline 주입): 동일 폰트 스택을 `.dvads`
    셀렉터에 inline 지정 (`src/styles/overlay.css` line 14-20).
- **Font stack:** `"Pretendard Variable", Pretendard, system-ui, -apple-system,
  "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`
- **Tailwind v4 주의:** `--font-sans`는 `@theme {}` 안에 등록해야 `font-sans`/`placeholder:font-sans`
  유틸이 Pretendard로 작동. `:root { font-family }`만으론 시스템 폰트로 fallback.
  (`src/styles/theme.css` `@theme` 블록 참조.)

### Scale (실측)

| 컨텍스트 | 용도 | 크기 | 굵기 | 위치 |
|----------|------|------|------|------|
| 옵션 | h1 | text-xl (20px) | bold (700) | `Options.tsx` 헤더 |
| 옵션 | h2 / 섹션 제목 | text-base (16px) | semibold (600) | API키 섹션, 계정 섹션 |
| 옵션 | h3 | text-sm (14px) | semibold (600) | 계정 삭제, 이용권 등 sub-section |
| 옵션 | 본문 | text-sm (14px) | normal (400) | 기본 |
| 옵션 | 보조/캡션 | text-xs (12px) | normal (400) | 작은 라벨, 안내 |
| 옵션 | leading | `leading-relaxed` | - | 안내 텍스트 |
| 팝업 | 헤더 제목 | text-sm (14px) | semibold (600) | `App.tsx` 헤더 |
| 팝업 | 섹션 제목 | text-xs (12px) | medium (500) | Row label |
| 팝업 | 약관 링크 | text-[11px] | - | 푸터 |
| 오버레이 | 카드 제목 (배지) | 12px | 600 | `.dvads-rank-badge` |
| 오버레이 | 팝오버 키워드 헤더 | 16px | 600 | `.dvads-popover-hdr .kw` |
| 오버레이 | 입찰가 표 헤더 | 14px | 500 | `.dvads-bid-table th` |
| 오버레이 | 입찰가 표 셀 | 14px | 400 (입찰가 컬럼만 600) | `.dvads-bid-table td` |
| 오버레이 | 다이얼로그 제목 | 16px | 600 | `.dvads-confirm-title` |
| 오버레이 | 다이얼로그 본문 | 14px | 400 (`<b>`는 600) | `.dvads-confirm-body` |
| 오버레이 | 버튼 라벨 | 13px | 500 | `.dvads-btn` |
| 오버레이 | 토스트 본문 | 13px | 400 | `.dvads-toast-body` |
| 오버레이 | 면책 푸터 | 12px | 400 | `.dvads-disclaimer` |
| 오버레이 | 토글 버튼 | 12px | 500 | `.dvads-toggle-btn` |
| 오버레이 | 페이지 배너 | 12px | 400 | `.dvads-page-banner` |

**텍스트 최소 크기는 12px** — 보조 캡션·메타 정보도 11px 이하로 내려가지 않는다.
스케일에 없는 크기(11px, 15px 등)는 새로 도입하지 말 것. 15px 제목류는 16px로,
11px 캡션류는 12px로 스냅. (2026-07-20 전수 정리 완료.)

예외 (텍스트가 아닌 요소 — 최소 크기 규칙 미적용):
- **아이콘 글리프**: 문자로 그린 화살표(▾)·닫기(×) 등. 10px/15px 허용.
- **원형 카운터 배지 숫자**: 16~18px 원 안의 카운트(`.dvads-multi-btn-badge` 등).
  8~11px 허용(자릿수가 늘면 단계 축소) — 12px는 물리적으로 안 들어감.
- **팝업 약관 링크**: `text-[11px]` (위 표 등재).

---

## Color

### Approach

Restrained — 베이스는 무채색 라이트 그레이, 액션/강조만 브랜드 주황. State 색(success/warning/
error/info/neutral)이 추가 의미 색.

### Brand

- **Primary:** `#E6783B` (브랜드 주황) — primary 버튼, 포커스 ring, 오버레이 카드 보더,
  강조 셀, 링크, F001 "현재 N위 ▾" 배지.
- **Primary hover:** Tailwind `hover:enabled:brightness-95` 또는 직접 `#C66024`/`#F08A4F`.
- **Subtle:** `rgba(230, 120, 59, 0.10)` — 배지 배경, 강조 셀 배경, 안내 박스.
- **Border:** `rgba(230, 120, 59, 0.40)` — 배너 하단 보더 등.
- **Ring:** `rgba(230, 120, 59, 0.50)` — focus ring (input 50%, 일반 30%).

**사용 면적: 화면 전체의 ~3% 이내** (점이 아닌 한 두 곳).

### Surfaces — 옵션/팝업 (React + Tailwind 컨텍스트)

- **페이지 배경:** `#f4f5f7` (`src/styles/theme.css` `--color-bg-soft`)
- **카드 배경:** `bg-white` (`--white`)
- **카드 보더:** **없음** (그림자만)
- **카드 그림자:** `shadow-[0_1px_3px_rgba(15,23,42,0.04),0_1px_2px_rgba(15,23,42,0.03)]`
  → Tailwind `shadow-card` utility로 등록 (`--shadow-card`)
- **카드 라운드:** `rounded-2xl` (16px) — 메인 카드 / `rounded-xl` (12px) — 작은 박스
- **구분선:** `border-[#eef0f3]` (`--color-divider`)
- **팝업 배경:** `#fafafa` (`src/popup/index.css`) — 옵션과 살짝 다른 톤

### Surfaces — 콘텐츠 오버레이 (호스트 페이지 inline 주입)

- **카드 배경:** `#ffffff`
- **카드 보더:** `1.5px solid #E6783B` (브랜드 주황) — **영역 정체성 신호**. 호스트 페이지의
  네이버 광고 테이블 안에서 "이건 우리가 그린 영역"이라고 시각적으로 분리.
- **카드 라운드:** 10px
- **카드 그림자:** `0 1px 6px rgba(0,0,0,0.06)`
- **옅은 배경:** `#fafafa` (펼침 행 td 배경)
- **테이블 구분선:** `#ECEEF0` / `#eee`
- **확장 패널/Popover 그림자:** `0 4px 16px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.05)`

### Text

| 의미 | 옵션/팝업 (Tailwind) | 오버레이 (hex) |
|------|----------------------|----------------|
| Primary | `text-gray-900` (≈ `#111`) | `#171717` |
| Body | `text-gray-700` | `#171717` / `#333` |
| Secondary | `text-gray-600` / `text-gray-500` | `#666666` |
| Disabled | `text-gray-400` | `#a3a3a3` |
| Placeholder | `placeholder:text-gray-400` | `#a3a3a3` |
| Error | `text-red-700` / `text-red-600` | `#DC2626` |

### Input

| 항목 | 옵션 | 오버레이 |
|------|------|----------|
| Fill (대기) | `bg-[#f4f5f7]` | `#fff` |
| Fill (disabled) | `disabled:opacity-50` | `#f0f0f0` |
| Fill (focus) | `bg-white` | (변화 없음) |
| Focus 표시 | `ring-2 ring-[#E6783B]/30` | 보더 색 변화 |
| Border | 없음 | `1px solid #f0f0f0` |
| Radius | `rounded-lg` (8px) | 12px / 10px |
| Height | h-10 (40px) | 26~36px |

### Semantic (State Colors)

플랫폼/시스템 상태 표시. Badge·StatusDot·테이블 셀에 일관 사용.

```css
--color-state-success: #16a34a;    /* Active / Connected / 등록됨 */
--color-state-warning: #d97706;    /* Pending / 만료 임박 / 적은검색량 */
--color-state-error:   #DC2626;    /* Failed / 위험 (= shadcn destructive) */
--color-state-info:    #0072f5;    /* 정보 / 카운트 */
--color-state-neutral: #808080;    /* Disabled / 데이터 없음 */
```

| State | 의미 | dvads 도메인 예시 |
|-------|------|-------------------|
| success | 정상 | API 등록됨 · 동기화 완료 |
| warning | 주의 | 적은검색량 · 호출 한도 임박 |
| error | 실패/위험 | API 키 만료 · 401/403 · 순위 수집 실패 |
| info | 정보/카운트 | "8개 키워드" · 시스템 메시지 |
| neutral | 비활성 | 비활성 · 데이터 없음 |

배지 패턴: 항상 `bg-state-{X}/10` + `text-state-{X}` (subtle 배경 + solid 텍스트).

### Brand-tinted UI (오버레이 강조 셀)

F001 "현재 N위" 배지 / 펼침 표의 현재 행 / popover 헤더 등 사용자의 현재 위치를 강조하는 자리.

| 자리 | 배경 | 텍스트 |
|------|------|--------|
| 배지 기본 | `rgba(230, 120, 59, 0.10)` | `#E6783B` |
| 배지 hover | `rgba(230, 120, 59, 0.18)` | `#E6783B` |
| 펼침 표 현재 행 | `rgba(230, 120, 59, 0.10)` | `#E6783B`, weight 600 |
| 안내 박스 (info) | `#E6783B`/10 (= `rgba(230,120,59,0.10)`) | `text-gray-800` |
| API키 발급 가이드 박스 | `#fdf6f2` (옅은 주황) | `text-gray-700` |

### Role Badge (옵션 admin 패널 — 현재 비활성, 향후 라이선스 재도입 시)

| Role | 배경 / 텍스트 |
|------|---------------|
| admin | `bg-purple-100 text-purple-700` |
| moderator | `bg-cyan-100 text-cyan-700` |
| advertiser (파트너사) | `bg-blue-100 text-blue-700` |
| viewer | `bg-green-100 text-green-700` |
| pending_advertiser | `bg-amber-100 text-amber-700` |
| expired_advertiser | `bg-gray-200 text-gray-600` |
| none | `bg-gray-100 text-gray-500` |

### Dark mode

**없음.** 현재 라이트 모드만 지원. 미래 결정 사항.

---

## Spacing

- **Base unit:** 4px (Tailwind 기본)
- **Density:** 옵션/팝업은 여유 — 카드 padding 36px(`p-9`). 오버레이는 compact —
  배지 패딩 0 8px (높이 22px), 펼침 패널 14px 16px.

### Scale (옵션/팝업)

| 토큰 | px | 사용처 |
|------|-----|--------|
| 2xs | 2 | - |
| xs | 4 | - |
| sm | 8 | 모달 헤더 패딩, 폼 gap |
| md | 16 | 섹션 내부 (`space-y-4`) |
| lg | 24 | 섹션 사이 (`space-y-6`, `mb-6`) |
| xl | 32 | 모달 패딩 (`px-8`), 인증 카드 좌우 |
| 2xl | 36 | 메인 카드 패딩 (`p-9`) |
| 3xl | 40 | 옵션 페이지 외부 패딩 (`p-10`) |

### 오버레이 패딩

- 배지: `0 8px`, height 22px
- 펼침 패널: `14px 16px`
- Popover: `14px 20px`, width 620px (5컬럼 한글 헤더 줄바꿈 방지 실측치)
- 페이지 배너: `8px 14px`
- 테이블 셀: `6px 8px`

### 컨테이너 max-width

| 컨테이너 | 값 |
|----------|-----|
| 옵션 페이지 | `max-w-6xl` (1152px) |
| 인증 카드 (로그인/회원가입) | `max-w-md` (448px) — 향후 활성화용 |
| 팝업 | 340px 고정 |
| 오버레이 popover | 620px |
| 오버레이 배너 | 100% (호스트 페이지 폭) |

---

## Layout

- **Approach:** grid-disciplined. 옵션 페이지는 좌우 정렬된 단일 컨테이너 + 내부 grid.
- **Grid:**
  - 옵션 페이지: `max-w-6xl mx-auto p-10` 단일 컬럼 + 내부에 `grid grid-cols-1 md:grid-cols-2`
    (좌: 계정 영역, 우: API키). 라이선스 미사용 시 단일 컬럼으로 fallback.
  - 팝업: 340px 고정 폭 단일 컬럼.
  - 오버레이: 호스트 테이블 내 cell-anchor absolute (배지) 또는 row-span 100% (펼침 행).

### Border radius scale

| 값 | Tailwind | 사용처 |
|----|----------|--------|
| `9999px` | `rounded-full` | 배지(상태), 상태 점, 토글 핸들 |
| 16px | `rounded-2xl` | 메인 카드, 인증 카드 |
| 12px | `rounded-xl` | 작은 카드/박스 (옵션 안내), partner radio 카드 |
| 10px | (직접) | 오버레이 카드 |
| 8px | `rounded-lg` | 버튼, 입력, 오버레이 펼침 패널/popover |
| 6px | `rounded-md` | 오버레이 배지·토글 버튼, sub-button |
| 4px | `rounded` | small chip |

### z-index 규칙

| 레이어 | z-index |
|--------|---------|
| 모달 오버레이 | `z-50` |
| Portal popup | `z-[60]` (모달 안 dropdown 위해 모달보다 높음) |
| 오버레이 popover | 1 (호스트 테이블 row 위) |
| 오버레이 페이지 배너 | 2147483647 (호스트 페이지 최상단 고정) |

---

## Motion

- **Approach:** minimal-functional. 의미 있는 피드백만, 장식 트랜지션 없음.
- **Easing:**
  - 입력/버튼: `ease` (Tailwind `transition` 기본)
  - 토글/탭 인디케이터: `ease-out`
  - 펄스/스피너: `linear`

### Duration

| 카테고리 | 값 | 사용처 |
|----------|-----|--------|
| micro | 120ms | 배지 hover bg 전이 (`.dvads-rank-badge`, `.dvads-toggle-btn`) |
| short | 160ms | input bg 전이 |
| medium | 200ms | 탭 인디케이터 슬라이딩 |
| long | 800ms | 스피너 1회전 |

### 주요 keyframe (overlay.css)

| 이름 | 동작 | 위치 |
|------|------|------|
| `dvads-spin` | 로딩 스피너 (0.8s linear infinite) | `.dvads-rank-badge.loading::before` |

### Hover / Active

- 버튼 (옵션 primary): `hover:enabled:brightness-95`
- 버튼 (옵션 secondary): `hover:bg-gray-200/70`
- 오버레이 배지: `transition: background 120ms ease`
- 오버레이 펼침 헤더 refresh: hover 시 `bg: #F3F4F6`

### Cursor

| 상태 | cursor |
|------|--------|
| 클릭 가능 | `pointer` |
| 비활성 | `not-allowed` (Button)/`default` (오버레이 lock 배지) |

---

## Component Catalog

### Card (옵션/팝업)

```
className: "bg-white rounded-2xl shadow-card"
패딩: p-9 (메인 카드), px-8 pt-8 pb-7 (인증 카드 max-w-md), p-3 (팝업 작은 박스)
보더: 없음
```

`shadow-card`는 Tailwind `@theme`에 등록한 토큰
(`0 1px 3px rgba(15,23,42,0.04), 0 1px 2px rgba(15,23,42,0.03)`).

### Primary Button (옵션)

```tsx
<Button variant="brand">저장</Button>
```

```
inline style 또는 utility로 background: #E6783B
hover: brightness-95
disabled: opacity-50 (회색 fill로 바꾸지 않음 — 주황 유지하고 opacity만)
radius: rounded-lg (8px)
weight: 500
사이즈: sm h-7 / md h-8 / lg h-10
```

### Secondary Button (옵션)

```
className: "bg-gray-100 text-gray-700 hover:bg-gray-200/70"
```

### Destructive Button (옵션)

```
className: "bg-red-50 text-red-600 hover:bg-red-100/70"
```

### Input (옵션)

```
className: "w-full h-10 px-3.5 py-2.5 text-sm bg-input rounded-lg outline-none ring-0
            focus:bg-white focus:ring-2 focus:ring-brand/30
            placeholder:text-gray-400 placeholder:font-sans transition"
```

API 키 등 mono 입력은 추가로 `font-mono` 적용.

### Field (label + input wrapper)

```tsx
<Field label="CUSTOMER_ID">
  <Input mono value={...} onChange={...} />
</Field>
```

label은 `text-sm font-medium text-gray-800 mb-1` (옵션 표준)
또는 `text-xs font-medium text-gray-700 mb-1` (인증 폼 컴팩트).

### Tabs (인증 토글 — 향후 활성화)

```
바: relative grid grid-cols-2 p-1 bg-[#f4f5f7] rounded-lg
인디케이터: absolute white pill + shadow + transition-transform 200ms ease-out
탭 라벨: 활성 text-gray-900 font-medium / 비활성 text-gray-500 hover:text-gray-700
```

### Checkbox (sr-only + svg 패턴)

```tsx
<label>
  <input type="checkbox" className="peer sr-only" />
  <span className="inline-flex size-4 ... bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.12)]
                  peer-checked:bg-brand peer-checked:shadow-none transition">
    <CheckIcon />
  </span>
</label>
```

### Radio Card (파트너사 / 일반 사용자 선택)

```
className: "rounded-xl bg-input px-[18px] py-[18px] cursor-pointer
            hover:bg-[#eef0f3] has-[:checked]:bg-brand/10 transition"
```

### Selection Card (오버레이 다중 선택 — F-Brief 이슈 선택)

체크박스 리스트의 카드형 대체. 실제 `<input type="checkbox">`는 시각적으로 숨기고(접근성 유지)
카드 전체가 클릭 영역. 구조: 아이콘 칩(32px, radius 10px) + 제목/근거 데이터 + 우측 원형 체크(20px).

```
기본:   background #fff / border 1.5px #e2e5ea / radius 12px / padding 12px 14px / gap 12px
hover:  background #fafafa
선택:   border #E6783B (오버레이 카드 보더와 동일 1.5px) + background rgba(230,120,59,0.05)
        원형 체크 → #E6783B 채움 + 흰 체크 (11px svg)
카드 간격: 8px (flex column)
```

- **아이콘 칩**: `bg-state-{X}/10` + solid state 색 — 색이 곧 의미(error=전환 없음, warning=목표
  미달/하락, success=기회, info=이력/격차). 아이콘은 16px inline SVG, `stroke="currentColor"`
  stroke-width 2 — 문자 글리프로 표현이 안 되는 자리에 한해 허용.
- 클래스: `.dvads-brief-pick-row` / `-icon` / `-check` (overlay.css)

### Modal Overlay

```
오버레이: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
컨테이너: Card 스타일 + onClick={(e) => e.stopPropagation()}
```

### Status Badge (Role / API 상태)

```
className: "inline-flex items-center justify-center h-5 px-2 py-0.5 text-xs font-medium rounded-full
            bg-state-{X}/10 text-state-{X}"
```

### StatusDot — Vercel "● Ready" 패턴

```tsx
<StatusDot variant="success" label="등록됨" />
<StatusDot variant="live" label="실시간 조회 중" />   {/* DV 주황 + 펄스 */}
```

variants: `success` / `warning` / `error` / `info` / `neutral` / `live`.
`live`만 `animate-pulse motion-reduce:animate-none`.
사이즈: `sm` (1.5/1.5 dot) / `md` (2/2 dot, 기본).

### ActionRow (카드 안 리스트 아이템)

```
className: "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer
            transition-colors hover:bg-button-light text-sm border-0 bg-transparent text-left"
```

icon + label + chevron 패턴.

### Overlay Card (오버레이 — F001 펼침 패널 / F002 쇼핑 패널 / Popover)

```css
background: #fff;
border: 1.5px solid #E6783B;       /* 영역 정체성 */
border-radius: 10px;
padding: 12px 18px;
box-shadow: 0 1px 6px rgba(0,0,0,0.06);
```

Popover는 보더 없이 더 강한 그림자(`0 4px 16px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.05)`)
+ 8px radius로, 펼침 패널(테이블 row 안 삽입)과 시각적으로 구분.

### F001 Rank Badge (오버레이)

```css
display: inline-flex;
height: 22px;
padding: 0 8px;
background: rgba(230, 120, 59, 0.10);
color: #E6783B;
border-radius: 6px;
font: 600 12px ui-monospace;
cursor: pointer;
```

states: `.warn` (앰버) / `.lock` (회색 disabled) / `.loading` (정사각 22x22 + 스피너).

### F002 Toggle Button (쇼핑 그룹 펼침)

```css
height: 22px;
padding: 0 8px;
background: #F3F4F6;
color: #171717;
border-radius: 6px;
font: 500 11px;
&.expanded { background: rgba(230,120,59,0.10); color: #E6783B; }
```

### Page Banner (오버레이 — 페이지 상단 고정 안내)

```css
display: flex; justify-content: space-between;
padding: 8px 14px;
font-size: 12px;
background: rgba(230, 120, 59, 0.10);
color: #E6783B;
border-bottom: 1px solid rgba(230, 120, 59, 0.4);
z-index: 2147483647;
```

variants: 기본(brand 톤) / `.warn` (앰버) / `.lock` (회색).

### Bid Table (오버레이 — 순위 / 입찰가 / 예상 노출수 / 예상 클릭수 / 예상 광고비)

```css
.dvads-bid-table th {
  font: 500 14px "Pretendard Variable";
  color: #666666;
  padding: 7px 16px;
  border-bottom: 1px solid #ECEEF0;
}
.dvads-bid-table td {
  font: 400 14px "Pretendard Variable";
  font-feature-settings: "tnum";
  padding: 7px 16px;
  text-align: right;
  color: #171717;
}
.dvads-bid-table td:nth-child(2) { font-weight: 600; } /* 입찰가 컬럼은 항상 강조 */
.dvads-bid-table tr.current td {
  background: rgba(230, 120, 59, 0.10);
  color: #171717;          /* 텍스트는 일반 ink — 배경 tint만으로 부드럽게 강조 */
}
.dvads-bid-table tbody tr.dvads-clickable {
  cursor: pointer;          /* 입찰가 변경 가능 행 (현재 행은 비활성) */
}
.dvads-bid-table tbody tr.dvads-clickable:hover td {
  background: #f5f5f5;
}
```

### Popover Header (오버레이 — 입찰가 표 상단)

```css
.dvads-popover-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.dvads-popover-hdr .kw {
  font: 600 16px "Pretendard Variable";
  color: #171717;
  text-decoration: none;     /* <a>지만 호버에만 underline */
  cursor: pointer;
}
.dvads-popover-hdr a.kw:hover {
  text-decoration: underline;
  text-decoration-color: #E6783B;
  text-underline-offset: 3px;
  text-decoration-thickness: 1.5px;
}
.dvads-popover-close {
  background: transparent;
  border: 0;
  color: #a3a3a3;            /* 은은하게 — 호버에만 진해짐 */
  font-size: 18px;
  width: 24px; height: 24px;
  border-radius: 4px;
  cursor: pointer;
}
.dvads-popover-close:hover {
  background: #F3F4F6;
  color: #666666;
}
```

키워드명은 `<a>`로 렌더되어 클릭 시 네이버 광고 검색결과
(`ad.search.naver.com/search.naver?where=ad&query=<키워드>`)를 새 탭으로 연다.

### Confirm Dialog (오버레이 — 입찰가 변경 확인)

호스트 페이지 위 fixed backdrop + 카드. 카드 내부 클릭/ESC가 부모 popover로 전파되지
않도록 backdrop·card·버튼에 `stopPropagation()` 적용.

```css
.dvads-confirm-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.40);
  z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
}
.dvads-confirm-card {
  background: #fff;
  border-radius: 10px;
  padding: 20px 22px 18px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.05);
  width: min(420px, calc(100vw - 32px));      /* 본문 2줄 구성 — 짧은 키워드도 안 휑함 */
}
.dvads-confirm-header { display: flex; justify-content: space-between; align-items: center;
                          margin-bottom: 8px; }
.dvads-confirm-title { font: 600 16px Pretendard; }
.dvads-confirm-close { background: transparent; border: 0; color: #a3a3a3; font-size: 18px;
                        width: 24px; height: 24px; border-radius: 4px; cursor: pointer; }
.dvads-confirm-close:hover { background: #F3F4F6; color: #666666; }
.dvads-confirm-body  { font: 400 14px Pretendard; color: #333; margin-bottom: 18px;
                        word-break: keep-all; }              /* 어절 단위 줄바꿈 */
.dvads-confirm-line + .dvads-confirm-line { margin-top: 2px; } /* 2줄 본문 간격 */
.dvads-confirm-body b { font-weight: 600; color: #171717;
                         white-space: nowrap; }              /* 키워드/가격 한 덩어리 */
.dvads-confirm-arrow  { color: #E6783B; }     /* "1,000원 → 440원" 강조 */
.dvads-confirm-delta-up   { color: #DC2626; font-weight: 600; } /* 인상 — 한국 시세 컨벤션 */
.dvads-confirm-delta-down { color: #0072f5; font-weight: 600; } /* 인하 */
.dvads-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

같은 폰트 토큰(제목 16px/600, 본문 14px/400)을 모든 다이얼로그류 팝업에 일관 적용.

본문은 2줄 구성 — 라인1 `<키워드> 입찰가를`, 라인2 `<현재>원 → <목표>원(±차액)으로
변경하시겠습니까?`. 차액 부호는 한국 주식 시세 컨벤션을 따라 **인상=빨강(#DC2626)**,
**인하=파랑(#0072f5)**. 차액이 0이면 부호 자체를 표시하지 않음.

### Toast (오버레이 — 우하단 stack, Undo 지원)

```css
.dvads-toast-root {
  position: fixed; right: 20px; bottom: 20px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 2147483647;
}
.dvads-toast {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05);
  min-width: 280px; max-width: 420px;
  overflow: hidden;
}
.dvads-toast-body { display: flex; align-items: center; gap: 10px;
                     padding: 12px 14px; font: 400 13px Pretendard; }
.dvads-toast-icon { width: 20px; height: 20px; border-radius: 50%;
                     color: #fff; font: 600 12px Pretendard; }
.dvads-toast-success .dvads-toast-icon { background: #16a34a; }
.dvads-toast-error   .dvads-toast-icon { background: #DC2626; }
.dvads-toast-undo { color: #E6783B; background: transparent; border: 0;
                     padding: 4px 8px; border-radius: 6px; font-weight: 500; }
.dvads-toast-bar      { height: 2px; background: #ECEEF0; }
.dvads-toast-bar-fill { height: 100%; background: #a3a3a3;
                         animation: dvads-toast-bar linear forwards; }
```

진행바(`scaleX(1)` → `scaleX(0)`)로 Undo 잔여 시간(기본 5000ms)을 시각화.
큐 최대 3개, 초과 시 가장 오래된 것부터 제거.

### Dropdown (오버레이 공용 — 단일 진실의 원천)

콘텐츠 오버레이의 모든 단일 선택 UI는 **`src/shared/ui-dropdown.ts`의 `createDropdown`**
함수를 사용한다. 네이티브 `<select>`는 OS·브라우저별 외관이 달라 시각 통일이 불가능하므로
**오버레이에서는 사용 금지**. 옵션/팝업(React+Tailwind 컨텍스트)은 별도 — 추후 React용
컴포넌트 도입 시 동일 시각 토큰을 따른다.

**시각 토큰** — 트리거는 `1px #ECEEF0` 보더 + 8px radius + 32px height + Pretendard 13px/500.
열린 상태에서 보더가 `#E6783B`로 전환되고 chevron이 180° 회전하며 색도 주황으로. 패널은
`6px` 내부 패딩 + 10px radius + `box-shadow: 0 8px 24px rgba(0,0,0,0.10)` + 각 옵션은 6px
radius로 호버 시 `#F3F4F6`, 선택된 옵션은 `rgba(230,120,59,0.10)` 배경 + 주황 텍스트.

```css
.dvads-dropdown-trigger { height: 32px; padding: 0 10px; border: 1px solid #ECEEF0; border-radius: 8px; }
.dvads-dropdown-trigger.is-open { border-color: #E6783B; background: rgba(230,120,59,0.04); }
.dvads-dropdown-panel { padding: 6px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.10); }
.dvads-dropdown-option.is-selected { background: rgba(230,120,59,0.10); color: #E6783B; }
```

```ts
const dd = createDropdown<HeadlinePosition>({
  value: "all",
  options: [{ value: "all", label: "모든 위치" }, ...],
  ariaLabel: "노출 위치",
  width: 120,
  onChange: (v) => { ... },
});
row.appendChild(dd.root);
```

패널은 `document.body`에 portal로 mount되어 popup의 `overflow-y:auto` 클리핑을 escape한다.
popup 등 컨테이너가 dismiss될 때 `closeAllOpenDropdowns()`를 호출해 잔여 패널을 정리.

### Common Button (오버레이 — 다이얼로그/토스트용)

```css
.dvads-btn {
  height: 32px;
  padding: 0 14px;
  font: 500 13px Pretendard;
  border: 0; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer;
}
.dvads-btn-primary   { background: #E6783B; color: #fff; }
.dvads-btn-primary:hover:enabled   { filter: brightness(0.95); }
.dvads-btn-secondary { background: #F3F4F6; color: #171717; }
.dvads-btn-secondary:hover:enabled { background: #E5E7EB; }
.dvads-btn-loading::before {
  content: ""; width: 12px; height: 12px; border-radius: 50%;
  border: 1.5px solid currentColor; border-top-color: transparent;
  animation: dvads-spin 0.8s linear infinite;
}
```

### Threshold Alert Cue (F-MultiAccount — 임계값 도달 시각 신호)

행 단위 통합 cue + 셀 단위 디테일의 2단 구조. **펄스/애니메이션 사용 안 함** — 정적 빨강만.

- **행 좌측 빨간 세로 선** (`dvads-multi-tr-threshold-alert`) — 비즈머니/브랜드 둘 중 하나라도
  임계 도달 시. "이 계정에 뭔가 알림 있음" 단일 신호.
- **비즈머니 셀 빨강** (`td.dvads-multi-td-biz-alert`) — 비즈머니 잔액 ≤ 임계값.
- **브랜드검색 계정명 빨강** (`tr.dvads-multi-tr-brand-alert .dvads-multi-name`) — 캠페인
  단위 max(endDate) 기준 D-day ≤ 임계값. `cursor: help`로 호버 가능 신호.

```css
/* 통합 cue — 행 좌측 3px 빨간 세로 선 */
.dvads-multi-tr.dvads-multi-tr-threshold-alert td:first-child { position: relative; }
.dvads-multi-tr.dvads-multi-tr-threshold-alert td:first-child::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; background: #DC2626;
}
/* 셀 단위 디테일 */
.dvads-multi-table td.dvads-multi-td-biz-alert {
  color: #DC2626; font-weight: 600;
}
.dvads-multi-tr.dvads-multi-tr-brand-alert .dvads-multi-name {
  color: #DC2626; font-weight: 600; cursor: help;
}
```

펄스/glow를 쓰지 않는 이유: popover 안에 알림 계정이 여러 개면 펄스가 동시에 깜빡여
시각 노이즈가 되고, 비즈머니 셀 빨강 같은 정적 cue와 톤이 어긋남. 정적 빨강 + bold만으로
충분히 식별 가능. 단 한 가지 — 만료(D-day ≤ 0)는 회색 cue(`dvads-multi-tr-contract-expired`)로
**운영 끝남**과 **임박 알림**을 구분.

### Hover Tooltip — Native-tone (F-MultiAccount 연장하기 등)

네이버 광고관리자 native 툴팁과 동일 톤 — 검은 배경 + 흰 글자 + 작은 꼬리. **다이얼로그류
팝업(흰 배경 + 그림자)과는 다른 톤** — 일시적 호버 컨텍스트라는 신호를 의도적으로 분리.

```css
.dvads-brand-tooltip {
  position: fixed; z-index: 2147483647;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px 8px 14px;
  background: #1F2937;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.18);
  font: 500 13px "Pretendard Variable";
  color: #fff;
  white-space: nowrap;
  animation: dvads-brand-tooltip-fade 140ms ease-out both;
  /* 꼬리 가로 위치 — JS에서 anchor 중심에 맞춰 동적 설정 */
  --dvads-brand-tooltip-arrow-x: 50%;
}
/* 꼬리: 10x10 사각형 45도 회전. placement 속성으로 방향 전환 */
.dvads-brand-tooltip[data-placement="top"]::after {
  content: ""; position: absolute; left: var(--dvads-brand-tooltip-arrow-x);
  bottom: -5px; width: 10px; height: 10px;
  background: #1F2937;
  transform: translateX(-50%) rotate(45deg); border-radius: 2px;
}
.dvads-brand-tooltip[data-placement="bottom"]::after {
  /* 동일하되 top: -5px */
}
/* 인라인 텍스트 링크 버튼 — 살짝 연한 DV 주황, 밑줄 없음, weight 700 */
.dvads-brand-tooltip-btn {
  background: transparent; border: 0; padding: 0; height: auto;
  color: #F2A06E; font: 700 13px "Pretendard Variable";
  text-decoration: none; cursor: pointer;
}
.dvads-brand-tooltip-btn:hover { color: #FFB987; }
```

**위치 규칙** — anchor element(예: 계정명 셀) 상단 가운데 정렬, 8~10px gap. 위쪽 viewport
부족 시 anchor 아래로 fallback(`data-placement="bottom"`)하며 꼬리 방향도 자동 반전.
좌우는 viewport 8px 안쪽으로 clamp하고 꼬리는 anchor 중심 X에 맞춰 동적 오프셋
(`--dvads-brand-tooltip-arrow-x`).

**호버 끊김 방지** — anchor와 툴팁 사이를 마우스가 오갈 때 120ms hide-delay. anchor leave
시 schedule, 툴팁 enter 시 cancel. 호버 → 클릭(인라인 링크) 흐름 자연스럽게.

**dismiss 가드** — 툴팁은 `document.body`에 fixed로 mount되어 popover 외부 클릭 close
핸들러에 잡힐 수 있음. mousedown/click outside 판정에서 `brandTooltipEl.contains(target)`
면제 필수.

---

## Conventions

- **em dash(`—`) / minus sign(`−`, U+2212) 사용 금지** — 모든 짝대기는 일반 하이픈
  `-` (U+002D)만 사용. 코드/UI/주석 모두 통일. 음수 표시(`(-230)`)도 동일.
- **한글 응답 원칙** — 사용자 노출 텍스트·UI·주석은 모두 한글. 코드, 명령어, 파일 경로,
  변수명, 영문 고유명사는 원문 그대로. CLAUDE.md 참조.
- **오버레이 클래스는 `dvads-` prefix로 격리** — `ads.naver.com` 호스트 CSS와 충돌 방지.
  새 오버레이 요소 추가 시 반드시 `dvads-` prefix 사용.
- **Tailwind v4 폰트 토큰은 `@theme {}` 안에** — `--font-sans`를 `:root`에만 적으면 `font-sans`
  유틸이 fallback.
- **카드는 페이지 배경(`#f4f5f7`) 위 흰 카드(`#fff`) + 옅은 그림자로 분리** — 보더 X.
- **오버레이 카드는 호스트 페이지 위 흰 카드(`#fff`) + 1.5px 주황 보더로 분리** — 그림자만으로는
  네이버 광고 테이블 안에서 잘 안 보인다. 보더가 영역 정체성도 함께 표시.
- **Primary 버튼은 항상 DV 주황** — `default` 검정 워밍 잉크 패턴은 폐기. 화면당 primary
  버튼은 1~2개로 제한 (너무 많으면 강조가 사라짐).
- **새 패턴이 필요하면 즉흥 도입 X** — 이 문서 먼저 갱신한 뒤 `src/styles/theme.css`와
  `src/styles/overlay.css`에 반영.
- **오버레이 dropdown은 `createDropdown` 사용 의무** — 네이티브 `<select>`는 OS별 외관이
  갈려 시각 통일 불가. 모든 단일 선택 UI는 `src/shared/ui-dropdown.ts`의 함수를 거치고
  새 dropdown 변종이 필요하면 옵션 추가로 흡수 (별도 컴포넌트 X).
- **숫자 입력 다이얼로그 placeholder는 "예:" prefix 없이 값만** — `"예: 7"` X, `"7"` O.
  금액은 천 단위 구분 포함 (`"100,000"`). placeholder만으로 입력 단위가 자명하니
  "예:" 안내는 시각 노이즈.
- **단일 계정 임계값 다이얼로그엔 description 안 씀** — 제목("브랜드검색 알림 설정")이
  이미 의도를 다 설명. 부제목은 시각 노이즈. **다중 선택(2개 이상 일괄 적용)일 때만**
  부제목으로 "선택된 N개 계정에 일괄 적용" 노출 (일괄 적용 사실은 사용자에게 명시적
  알려야 안전).
- **테이블 체크박스 셀은 좌우 padding 대칭 + `vertical-align: middle`** — 다중 줄 행
  (이름+번호 2줄)에서도 행 세로 가운데 정렬. F-MultiAccount 테이블 패턴
  (`.dvads-multi-td-cb { padding: 0 9px; vertical-align: middle; }`).
- **알림 cue는 정적 빨강만 — 펄스 금지** — 임계값 도달 행이 여러 개면 펄스가 동시에
  깜빡여 노이즈. 행 좌측 빨간 세로 선 + 셀 단위 텍스트 빨강 + bold만으로 충분히 식별.
  자세한 정보(D-day, 액션)는 호버 툴팁에 분리.

---

## 컨텍스트 비교 (오버레이 vs Tailwind)

| 항목 | 오버레이 (순수 CSS) | Tailwind v4 (옵션/팝업) |
|------|---------------------|--------------------------|
| 스타일링 | 순수 CSS, `dvads-` prefix | Tailwind 유틸리티 |
| 폰트 등록 | font-family inline 선언 (`.dvads` 셀렉터) | `@theme { --font-sans }` |
| 보더 (카드) | 1.5px 브랜드 주황 (영역 정체성) | 없음 (그림자만) |
| 라운드 (카드) | 10px | 16px (`rounded-2xl`) |
| 입력 배경 | `#fff` active / `#f0f0f0` disabled | `bg-input` (#f4f5f7) → focus `bg-white` |
| 포커스 표시 | 보더 색 변화 | `ring-2 ring-brand/30` |
| 텍스트 색 | hex 직접 (`#171717`, `#666666`, ...) | Tailwind gray scale |
| 페이지 배경 | (없음 — 네이버 페이지가 배경) | `#f4f5f7` (옵션) / `#fafafa` (팝업) |

**이 비대칭은 의도된 것** — 오버레이는 네이버 광고 페이지 CSS와 격리되어야 하고 Tailwind
번들을 콘텐츠 스크립트에 주입하면 페이지 CSS와 충돌 위험이 있다. 옵션/팝업은 단독 React 환경.
**토큰 값은 가능한 한 동일하게** (`#E6783B`, Pretendard, `#f4f5f7` 등) 유지하되 표현 수단만 다르다.

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-18 | 자매 프로젝트(디브이 SEO 매니저)와 디자인 시스템 통일 — Card v5 flat 폐기, `rounded-2xl + shadow` 패턴 채택. 페이지 배경 `#fafafa`→`#f4f5f7`. Input bg `#fff`→`#f4f5f7`. Primary 버튼 검정→주황 통일. | 같은 셀러가 두 확장을 함께 쓰는데 시각 톤이 다르면 브랜드 분열. dvmkt가 먼저 출시되어 실사용자 학습이 있으므로 dvads를 dvmkt 톤에 맞춤. 오버레이는 dvads 고유(광고 테이블 inline)이므로 호스트 페이지와의 영역 정체성을 위해 1.5px 주황 보더 패턴(dvmkt 패널과 동일 철학)을 채택. |
| 2026-05-18 | 로그인/회원가입/비밀번호 찾기 UI 골격을 미리 작성하되 옵션 페이지에는 마운트하지 않음 (라이선스 없이 사용 가능). | 향후 라이선스 재도입 시 곧바로 활성화 가능하도록. 핸들러는 stub. dvmkt 디자인을 1:1로 옮겨 두 확장의 인증 UX를 통일. |
| 2026-05-18 | F001 팝오버에 행 클릭 → 입찰가 자동 변경 기능 추가. 페이지 UI 자동화(DOM 조작) 방식 — 검색광고 PUT API 미사용. 신규 컴포넌트: 확인 다이얼로그, 토스트(+Undo), 팝오버 닫기 버튼. | 사용자가 "추정 → 적용" 사이 컨텍스트 스위칭을 없애기 위함. DOM 자동화는 사용자가 직접 수정하는 것과 동일한 경로라 즉시 반영·권한 동일·`nccKeywordId` 추출 부담 회피. 깨질 위험은 `src/features/bid/dom-bid.ts` 한 파일에 격리 — ads.naver.com이 클래스명을 갈면 여기만 수정. |
| 2026-05-18 | Typography Scale 문서를 실제 코드 기준으로 동기화. 오버레이 입찰가 표(10→14px), 면책 푸터(10→12px) 등 outdated 값 갱신. 다이얼로그 폰트 토큰 확정 — 제목 16px/600, 본문 14px/400. 신규 다이얼로그류 팝업은 동일 토큰 적용. | 코드와 문서가 어긋나면 신규 작업 시 잘못된 사이즈로 가는 사고가 반복. 입찰가 표는 정보 밀도보다 가독성이 더 중요해 14px로 갱신된 상태였음. |
| 2026-05-19 | F001 popover에 PC/모바일 디바이스 토글 추가 — segmented control (`.dvads-device-toggle` / `.dvads-device-seg`) 높이 28px / radius 6px. 트랙은 `#F3F4F6`, 선택 디바이스만 흰 카드(`#FFFFFF`) + weight 600 + 미세 그림자. **DV 주황 사용 X** — 보조 UI라 화면 주황 면적(≤3%) 규칙 보존. 모바일이 default eager 호출, PC는 토글 시 lazy(첫 호출만 추가, 이후 캐시). | 모바일 광고 비중이 큰 광고주에게 기존 "PC만 표시"가 실측과 동떨어진 추정치를 보여줬음. 디바이스 분리는 popover 안에서만 — 배지·"현재 N위"는 default device 기준 유지로 화면 정보량 늘리지 않음. 토글에 주황을 쓰면 popover 안에 주황 칠이 (현재 행 강조 + 푸터 차액 + 헤더 키워드 hover 밑줄에) 4번째로 들어가 brand color 인플레이션. |
| 2026-05-22 | F-MultiAccount 임계값 알림 cue를 2단 구조로 통일 — **행 좌측 빨간 세로 선**(비즈/브랜드 둘 중 하나라도 도달, `dvads-multi-tr-threshold-alert`) + **셀 단위 디테일**(비즈머니 셀 빨강, 브랜드는 계정명 빨강). 펄스/glow 모두 폐기, 정적 빨강만. 만료(D-0 이하)는 회색 cue로 별도 처리. | 알림 계정이 여러 개 누적될 때 펄스가 동시에 깜빡여 popover가 시각 폭격기가 됨. 또 비즈머니 셀은 처음부터 정적이라 브랜드만 펄스면 톤 어긋남. 좌측 세로 선이라는 단일 "이 계정에 뭔가 알림 있다" 신호 + 어떤 임계인지는 색이 들어간 셀 위치로 자연 식별되도록 분리. |
| 2026-05-22 | 호버 툴팁(`.dvads-brand-tooltip`)을 native-tone(검은 배경 `#1F2937` + 흰 글자 + 작은 꼬리)으로 신설. 인라인 텍스트 링크 버튼은 살짝 연한 DV 주황 `#F2A06E`(weight 700, 밑줄 없음). anchor 상단 가운데 정렬, 위쪽 공간 부족 시 아래로 fallback(꼬리 자동 반전). 행→툴팁 마우스 이동 끊김 방지 120ms hide-delay. | 다이얼로그류(흰 배경 + 그림자)와 톤을 의도적으로 분리해 "일시적 호버 컨텍스트"임을 시각으로 신호. 네이버 광고관리자 native 툴팁과도 톤이 통일됨. 인라인 링크는 popover 안에 이미 주황 면적이 있어 강한 주황 풀 톤을 한 단계 낮춰 noise 감소. |
| 2026-05-22 | 브랜드검색 알림 D-day 계산을 **캠페인 단위 max(endDate) → min** 로 변경. 같은 BRAND_SEARCH 캠페인 안에 후속 광고그룹·next 계약이 마련되어 있으면 자동으로 max가 늦은 종료일을 채택해 알림 자연 OFF. `MultiAccountSnapshot.contracts`에 `nccCampaignId`/`phase("current"\|"next")` 필드 추가. | 사용자가 후속 계약을 이미 만들어둔 상태에서 현재 광고그룹 D-8을 보고 빨간 알림이 발화하면 false alarm. 광고운영 실무에서 갱신 시 "별도 광고그룹/소재 재생성" 패턴이 흔해, 캠페인 단위로 묶어서 보는 게 의도와 일치. |
| 2026-05-22 | 숫자 입력 다이얼로그(비즈머니/브랜드 알림 임계값) 톤 정리 — placeholder는 `"예: 7"` 대신 값만(`"7"`, `"100,000"`). 단일 계정 다이얼로그엔 description 제거. 다중 선택일 때만 "선택된 N개 계정에 일괄 적용" 부제목 유지. | placeholder는 단위(원/일)가 suffix로 보이므로 "예:" 안내가 중복. 부제목도 제목("비즈머니 알림 설정")으로 충분히 의도가 전달돼 시각 노이즈만 됨. 일괄 적용 사실은 사용자에게 명시적으로 알려야 사고 방지. |
| 2026-05-22 | F-MultiAccount 테이블 체크박스 셀 정렬 패턴 확정 — `padding: 0 9px` 좌우 대칭 + `vertical-align: middle`. 다중 줄 행(계정명 + 번호 2줄)에서도 체크박스가 행 세로 가운데로. 헤더 th와 동일 토큰. | 이전 `padding: 7px 6px 7px 12px` 비대칭으로 체크박스가 좌측으로 치우치고, 다중 줄 행에서는 위쪽으로 붙어버려 헤더와 안 맞음. 좌우 동일 + vertical-align로 행 높이와 무관하게 가운데 정렬. |
| 2026-07-01 | F-MultiAccount 그룹(팀원별) 필터를 **캡슐(세그먼트) 탭**으로(`.dvads-multi-grouptabs` 행 + `.dvads-multi-groupchips` 캡슐 + `.dvads-multi-chip`) — 회색 트랙(`#F3F4F6`) 안에 탭, **선택 탭만 흰 카드 + 진한 글씨색 + 미세 그림자**(**주황 미사용**). weight는 선택/비선택 동일(500) — 굵게 하면 글자 폭이 늘어 선택 시 옆 탭이 밀리는 jitter 발생(디바이스 토글은 2칸 고정이라 무관하지만 가변 다탭에선 티남). 그룹이 넘치면 **탭 캡슐 바로 양옆 화살표**(`.dvads-multi-grouptabs-arrow`)로 스크롤 — 넘칠 때만 노출·양끝에서 dim, 스크롤바는 숨기고 화살표로만 이동. `+ 그룹`은 캡슐 밖 회색 텍스트 버튼. | 사용자가 캡슐 탭 + 양옆 화살표 스크린샷으로 요청. 앞선 폴더/밑줄 탭 시안을 거쳐 최종 채택. 이미 검증된 디바이스 토글 세그먼트 패턴과 톤 통일해 popover 내 시각 언어 일관, 주황 인플레이션 회피. 화살표를 far-edge가 아닌 탭 옆에 둬 스크롤 대상과 컨트롤을 근접시킴. |
| 2026-07-16 | F-Brief AI 판단 문단에 **좌측 3px 주황 세로 선**(`.dvads-brief-block-ai`). 텍스트 색은 검은색 유지, 복사 시 미포함(CSS라 텍스트에 안 딸려감). 주황 배경 폐기. | 기술로 막을 수 없는 구간(AI가 일반 상식으로 끼워 넣는 문장)을 AE 눈에 띄게 하는 마지막 방어선. 문단 배경을 주황으로 칠하면 "DV 주황 ~3% 이내"를 크게 넘고, 2026-05-19 디바이스 토글 결정과 같은 brand color 인플레이션. 세로 선은 면적이 사실상 0. 2026-05-22 Threshold Alert Cue와 동일 구조라 새 패턴이 아님(색만 `#DC2626`→`#E6783B`). |
