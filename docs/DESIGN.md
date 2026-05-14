# 디브이 애드 매니저 디자인 시스템

> **출처**: 디노트 디자인 시스템을 기반으로 디브이 애드 매니저에 적용. brand 컬러만
> 우리 DV 브랜드(`#E6783B`)로 교체하고, 나머지 토큰·원칙·컴포넌트 패턴은 그대로 사용.
>
> **단일 진실의 원천 (Single Source of Truth)**: 모든 시각 결정의 근거는
> 이 문서. 새 패턴이 필요하면 즉흥적으로 도입하지 말고 이 문서를 먼저
> 갱신한 뒤 코드에 반영. 갱신 흐름:
> `DESIGN.md → src/styles/theme.css → @theme → 컴포넌트`.

## 0. Overview

디브이 애드 매니저는 네이버 광고관리자(`ads.naver.com`)에 주입되는 Chrome
확장 — 대행사 AE·인하우스 운영자의 입찰 의사결정을 보조하는 데이터 도구
입니다. 호스트 페이지와 자연스럽게 어우러져야 광고 운영자의 시선을 끊지
않습니다. 화면이 차분해야 입찰가·순위 정보가 잘 보이고, 사용자는 "지금
어떤 키워드의 입찰가를 얼마로 조정할지"에 집중할 수 있습니다.

### 핵심 디자인 철학

1. **Quiet by default, loud when necessary** — 기본은 무채색/평면, 진짜
   강조해야 할 자리(brand CTA, F001 "현재 N위" 배지, 알림)에만 DV 주황 등장.
2. **Page-card contrast over chrome** — 카드는 보더/그림자 없이 평면,
   페이지 배경(#fafafa)과의 1% 명도차로만 구분. 떠 있는 느낌이 필요한
   곳은 popover뿐.
3. **Vercel Geist UI strict alignment for buttons & typography**, 그 외는
   한국 SaaS 관행에 맞춰 조정 (카드는 Krea/Notion/Linear 톤).
4. **Pretendard 우선 한글 본문**, 자간은 한글에 맞게 보수적으로.
5. **콘텐츠 오버레이는 호스트 페이지를 침범하지 않는다** — `ads.naver.com`의
   파워링크 테이블에 inline 주입되는 배지·펼침 표는 `dvads-` prefix로 격리,
   호스트 디자인을 흉내내지 않고 우리 디자인 언어로 분명히 구분.

### 영감 (참고: Appendix A)

- **Vercel Geist UI** — 버튼 사이즈/radius, 모노크롬 기조, 자간 철학,
  소수 정예 weight (400/500/600).
- **Krea / Notion / Linear** — 평면 카드 패턴, 페이지 배경 + 흰 카드 대비.
- **디노트 디자인 시스템** — 본 문서의 기반 (한국 SaaS 관행 + Vercel 영감 + 평면 카드).

---

## 1. Color

### 1.1 Brand — DV Orange

```css
--brand: #E6783B;                                       /* DV 브랜드 오렌지 (로고와 동일 톤) */
--brand-hover: #F08A4F;                                 /* hover/active 시 */
--brand-subtle: rgba(230, 120, 59, 0.10);               /* badge/배경 tint */
--brand-border: rgba(230, 120, 59, 0.40);               /* 경고 카드 보더 */
--brand-ring: rgba(230, 120, 59, 0.50);                 /* focus ring */
```

**사용 면적: 화면 전체의 ~3% 이내** (점이 아닌 한 두 곳).

✅ Use:
- DV 로고 (`src/assets/icon-128.png`)
- **brand CTA 버튼** (`<Button variant="brand">`) — **화면당 단 1개**
- 콘텐츠 오버레이 "현재 N위 ▾" 배지 (F001 — 클릭 가능한 인터랙티브 요소)
- 포커스 링 (`focus-visible:ring`, 인터랙티브 요소 강조 시)
- 실시간 indicator (`<StatusDot variant="live">` — 펄스 애니메이션, 캐시 갱신 중)

❌ Never:
- 페이지 배경 / 본문 텍스트 / 카드 보더
- **default 버튼** (default = 검정 워밍 잉크, brand만 주황)
- 화면당 brand 버튼 2개 이상
- 그라디언트 (DV 주황은 항상 solid)
- 도트 아이브로우 (• 라벨), 4px 좌측 룰 같은 장식

### 1.2 Surfaces

```css
--white: #ffffff;          /* 카드 / 팝오버 / 다이얼로그 */
--bg-soft: #fafafa;        /* 페이지 배경 — 카드가 자연스럽게 떠 보이도록 */
```

shadcn `--background = var(--bg-soft)`, `--card = --popover = var(--white)`.

**원칙**: 카드를 흰 배경(#ffffff) 위에 직접 두지 않는다 — 사라짐. 항상
`--bg-soft` 페이지 위 또는 회색 surface 안에 배치.

### 1.3 Ink & Neutral Scale

```css
--ink: #171717;            /* 본문 / 헤딩 텍스트 (Vercel Black) */
--ink-warm: #1F1714;       /* default 버튼 배경 — 살짝 따뜻한 검정 */
--ink-warm-hover: #2A1F1A;

--gray-100: #ebebeb;       /* 옅은 보더 (--card-border와 동일) */
--gray-200: #d4d4d4;
--gray-300: #a3a3a3;       /* placeholder, disabled */
--gray-400: #808080;       /* tertiary text, dot disabled */
--gray-500: #666666;       /* sub text */
--gray-600: #4d4d4d;       /* secondary body */
--gray-900: #171717;       /* = ink */

--card-border: #ECEEF0;    /* input/select 디폴트 보더 (focus 시 ring으로 교체) */
--card-border-hover: #D6D9DD;
--button-light: #F3F4F6;   /* secondary 버튼 배경 */
--button-light-hover: #E5E7EB;
```

### 1.4 Platform — Data Source Indicators

플랫폼 식별 색. 차트·배지·Status에서 데이터 출처를 한눈에 구분.

```css
--naver-green: #03C75A;    /* 스마트스토어 데이터 */
--coupang-red: #ED1C24;    /* 쿠팡 데이터 */
```

**State 색과 분리**: `success` 녹색(#16a34a)은 "상태가 정상"이고, `naver-green`은 "스마트스토어 데이터" — 두 녹색은 다른 의미.

### 1.5 State — Status Indicators

시스템 상태 표시. Badge·StatusDot·테이블 셀에 일관 사용.

```css
--state-success: #16a34a;                          /* Active / Connected / Synced */
--state-success-subtle: rgba(22, 163, 74, 0.10);
--state-warning: #d97706;                          /* Pending / 만료 임박 */
--state-warning-subtle: rgba(217, 119, 6, 0.10);
--state-error: #DC2626;                            /* Failed / 위험 (= shadcn destructive) */
--state-error-subtle: rgba(220, 38, 38, 0.10);
--state-info: #0072f5;                             /* 정보 / 카운트 */
--state-info-subtle: rgba(0, 114, 245, 0.10);
--state-neutral: #808080; /* gray-400 */           /* Disabled / 데이터 없음 */
--state-neutral-subtle: rgba(128, 128, 128, 0.10);
```

| State | 의미 | 디노트 도메인 예시 |
|-------|------|-------------------|
| success | 정상 | 모니터링 Active · 광고 Connected · cron 성공 |
| warning | 주의 | 토큰 만료 임박 · cron 부분 실패 · ROAS 저하 임박 |
| error | 실패/위험 | 광고 끊김 · 순위 수집 실패 · API 호출 실패 |
| info | 정보/카운트 | 신규 알림 · "8개 변수" · 시스템 메시지 |
| neutral | 비활성 | Disabled · 데이터 없음 |

배지 패턴: 항상 `bg-state-{X}-subtle` + `text-state-{X}` (subtle 배경 + solid 텍스트).

---

## 2. Typography

### 2.1 Font Family

```css
--font-sans: 'Pretendard Variable',
             var(--font-geist-sans),
             -apple-system, BlinkMacSystemFont, system-ui,
             'Apple SD Gothic Neo', 'Segoe UI', Roboto,
             sans-serif;
```

- **Primary**: `Pretendard Variable` — npm `pretendard` 패키지 self-host
  (variable font 한 파일, weight 45–920). 한글·라틴 모두 Pretendard로 렌더.
- **Latin Fallback**: Geist Sans (Next.js `next/font/google`) → 시스템 폰트.
- **Mono** (코드/터미널 라벨): `Geist Mono`. v1 v1에서는 거의 사용 안 함.

### 2.2 Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Notes |
|------|------|--------|-------------|----------------|-------|
| Display Hero | 48px (3.0rem) | 600 | 1.0–1.17 | -2.4px | 랜딩 hero (만들 시) |
| Section Heading | 40px (2.5rem) | 600 | 1.20 | -2.4px → -1.6px (한글 보수) |
| Sub-heading Large | 32px (2.0rem) | 600 | 1.25 | -1.0px (한글 보수) |
| Card Title | 24px (1.5rem) | 600 | 1.33 | -0.8px (한글 보수) |
| KPI Value | 28px / 32px lg | 600 | 1.1 | -0.6px |
| Body Large | 20px | 400 | 1.80 | 0 | 도입부 |
| Body | 16px | 400 | 1.5 | 0 | 페이지 paragraph 기본 |
| Body Medium | 14px | 500 | 1.5 | 0 | nav, 강조 본문 |
| Form (Input/Select trigger) | 14px | 400 | 1.5 | 0 | |
| Dropdown Item | 14px | 400 | 1.5 | 0 | shadcn Item utility |
| Button sm / md / lg | 13 / 14 / 14px | 500 | 1.0–1.43 | 0 | 음수 자간 절대 X |
| Caption / KPI Label | 12px | 500 | 1.33 | 0 | gray-500 muted |
| Group Label (dropdown 그룹) | 12px | 500 | 1.5 | 0 | muted gray |
| Badge | 12px | 500 | 1.0 | 0 | `text-xs` |

### 2.3 한글 자간 가이드 (Vercel 원본의 보수적 적용)

Vercel Geist Sans는 디스플레이 사이즈에 -2.4px ~ -2.88px의 강한 negative
tracking을 씁니다. 한글에 그대로 적용하면 자모 결합이 깨지므로 디노트는
보수적으로:

- 40px+ 헤드라인: -1.6px ~ -2.4px
- 24~32px 헤드라인: -0.5px ~ -1.0px
- 본문/UI 텍스트 (16px 이하): **0** (음수 자간 X)
- 버튼/배지 라벨: **0**

### 2.4 Principles

- **3-weight system**: 400 (본문/읽기), 500 (UI/상호작용), 600 (헤딩/강조).
  700 bold는 사용 금지 (마이크로 배지 외).
- **Tabular numbers**: 숫자가 정렬되어야 하는 자리(KPI, 테이블, 차트 라벨)에 `font-variant-numeric: tabular-nums`.
- **OpenType ligatures**: Pretendard/Geist 모두 `"liga"` 활성화.

---

## 3. Layout

### 3.1 Page Background & Card Surface

- **페이지 배경**: `var(--bg-soft)` (#fafafa) — 모든 라우트의 body bg.
- **카드 / 팝오버 / 다이얼로그**: `var(--white)` (#ffffff).
- **1% 명도차** (250 vs 255)만으로 카드가 떠 보임 — 보더/그림자 없이.

### 3.2 Spacing Scale

base 4px. 주요 step:

```
1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 120
```

**rule**: 16 → 32 사이 jump. 20px이나 24px는 카드/섹션 padding 외에는 잘
쓰지 않음. 큰 spacing은 80px 이상 (섹션 간 vertical rhythm).

### 3.3 Border Radius Scale

| Size | Token | Use |
|------|-------|-----|
| 4px | `rounded-[4px]` | Checkbox |
| 6px | `rounded-btn` (`--radius-btn: 0.375rem`) | **모든 버튼** |
| 8px (default) | `rounded-lg` (`--radius: 0.5rem`) | **카드 / 카드 안 input·select / 드롭다운 항목** |
| 10px | `rounded-[10px]` | KPI 카드 (선택) |
| 12px | `rounded-xl` (--radius * 1.4 ≈ 11.2px) | featured 카드 / popover 컨테이너 / Dialog |
| 16px+ | `rounded-2xl` 이상 | hero 영역 등 큰 surface |
| 9999px (full pill) | `rounded-full` | 배지 / 상태 점 |

### 3.4 Whitespace Philosophy

- **Section vertical rhythm**: 80px+ (모바일 48px). 섹션 간 큰 여백이 디노트
  특유의 차분함을 만든다.
- **Card padding**: 24px (`.card`) / 20px·24px (`.card-sm` KPI).
- **Compressed text, expanded space**: 헤드라인에 음수 자간으로 글자가
  조밀해지면, 주변 여백을 더 넉넉히.

### 3.5 Container

- Max content width: **1080px** (sticky nav 펼침 상태) / **1000px** (floating
  nav). 디노트는 데이터 도구라 와이드보다 readable 너비 선호.
- Hero: 중앙 정렬, 위쪽 패딩 큼.
- Card grid: 2~4 컬럼. 모바일 단일 컬럼.

---

## 4. Components

### 4.1 Buttons (Vercel Geist UI strict)

3 사이즈 × 3 역할.

#### 사이즈 (Vercel 표준 정확 매칭)

| Size | Height | Padding-X | Font | Use |
|------|--------|-----------|------|------|
| `sm` | 28px | 10px | 13px / 500 / 0 | 토글, 컴팩트 필터 |
| `default` (md) | 32px | 12px | 14px / 500 / 0 | 인라인 폼, 보조 액션, 기본값 |
| `lg` | 40px | 16px | 14px / 500 / 0 | 1차 CTA, 카드 액션, 히어로 |

#### 역할 (디노트 화법)

```css
/* 1. default — 검정 워밍 잉크. 모든 일반 버튼의 기본값 (~95% 케이스) */
.btn-default { background: var(--ink-warm); color: #fff; }
.btn-default:hover { background: var(--ink-warm-hover); }

/* 2. brand — DV 주황. 화면당 단 1개, 정말 강조해야 할 1차 CTA만 */
.btn-brand { background: var(--brand); color: #fff; }
.btn-brand:hover { background: var(--brand-hover); }

/* 3. secondary — 연회색. 보조·취소·필터 */
.btn-secondary { background: var(--button-light); color: var(--ink-warm); }
.btn-secondary:hover { background: var(--button-light-hover); }
```

React `Button`:

```tsx
<Button>등록</Button>                       {/* 95% — default 검정 */}
<Button variant="brand">시작하기 →</Button>  {/* 화면당 1개 — 진짜 1차 CTA */}
<Button variant="secondary">취소</Button>    {/* 보조 */}
```

**`dark` variant**는 `default`의 레거시 alias로 보존. 신규 코드는 `default` 사용.

#### 공통 규칙

- 항상 `border-radius: 6px`, `letter-spacing: 0`, `font-weight: 500`.
- **Box shadow 절대 사용 금지**.
- Disabled: `opacity: 0.4` + `cursor: not-allowed` (색 변경 X).

### 4.2 Cards (v5 — Fully flat)

```css
.card {
  background: #FFFFFF;        /* var(--white) */
  border: none;
  border-radius: 8px;         /* rounded-lg */
  padding: 24px;
  box-shadow: none;
}
```

**호버 효과 없음**. 인터랙션 피드백은 카드 안의 콘텐츠(버튼·행 hover)로.

**예외 — Card-as-Link 패턴 (2026-05-06 추가)**: 카드 전체가 단일 링크/내비게이션 트리거인 경우(예: 모니터링 메인의 상품 카드 → `/monitoring/[id]`)에 한해 `hover:bg-bg-soft`를 허용한다. 정보 카드(KPI·Chart·등록 폼)는 정적 유지. 이 예외를 쓰면 카드 안에 별도 hover 가능 요소(버튼·행)를 넣지 않는다 — 카드 전체가 한 액션이므로 이중 affordance가 생기지 않게 한다.

#### Variants

```css
.card-sm {                    /* KPI/metric */
  border-radius: 8px;
  padding: 20px 24px;
}

.card-featured {              /* 이미지 포함 카드 */
  border-radius: 12px;
}
```

#### 규칙

- ✅ 페이지 배경(`--bg-soft` #fafafa) 위에 흰 카드(`--white` #ffffff)를 두면 1% 명도차로 자연스럽게 떠 보임. 보더/그림자 불필요.
- ❌ 카드에 `border` / `box-shadow` / `0 0 0 1px ring` / `inset #fafafa glow` 모두 금지.
- ❌ 카드를 `--white` 페이지 위에 두지 말 것 (사라짐).
- ❌ 좌측 컬러 룰 (4px 스트라이프), 도트 아이브로우, 색 그림자 같은 장식 금지.

### 4.3 Inputs & Selects (디노트 override — 보더 없는 흰 박스)

```css
.input, .select-trigger {
  background: #FFFFFF;
  border: 1px solid transparent;       /* 디폴트 보더 투명 */
  border-radius: 8px;                  /* rounded-lg */
  height: 32px;                        /* h-8 */
  padding: 0 10px;                     /* px-2.5 */
  font-size: 14px;                     /* text-sm */
  transition: background 160ms;
}

.input:hover, .select-trigger:hover {
  background: var(--bg-soft);          /* 옅은 hover 피드백 */
}

.input:focus-visible, .select-trigger:focus-visible {
  border-color: var(--brand);   /* focus-visible:border-ring */
  box-shadow: 0 0 0 3px rgba(230, 120, 59, 0.5);  /* focus-visible:ring-3 */
  background: #FFFFFF;
}
```

**원칙**: 디폴트는 평면 흰 박스(보더 없음). hover 시 살짝 어두워지고, focus 시 DV 주황 ring으로 강조. 에러(invalid) 시 빨강 ring.

### 4.4 Popover / Dropdown / Dialog

#### 컨테이너

```css
.popover-content {
  background: #FFFFFF;
  border: none;
  border-radius: 12px;                 /* rounded-xl */
  padding: 8px;                        /* p-2 */
  min-width: 240px;                    /* min-w-60 (dropdown만, select는 trigger 따라감) */
  box-shadow: var(--shadow-popover);   /* 3 layer soft drop shadow */
}
```

`--shadow-popover`:

```css
--shadow-popover:
  0 2px 4px rgba(0, 0, 0, 0.04),
  0 12px 24px rgba(0, 0, 0, 0.08),
  0 32px 64px -16px rgba(0, 0, 0, 0.10);
```

**보더 없음 + soft 3-layer drop shadow**로 Krea/Magnific 톤. 떠 있는
인상을 그림자만으로.

#### 항목

```css
.popover-item {
  padding: 8px 12px;                   /* py-2 px-3 */
  border-radius: 8px;                  /* rounded-lg */
  font-size: 14px;                     /* text-sm */
  gap: 10px;                           /* gap-2.5 (icon-text) */
  cursor: default;
}
.popover-item:focus,
.popover-item[data-highlighted] {
  background: var(--button-light);     /* bg-accent */
}
```

#### 그룹 라벨

```css
.popover-label {
  padding: 6px 12px;                   /* py-1.5 px-3 */
  font-size: 12px;                     /* text-xs */
  font-weight: 500;
  color: var(--gray-500);
}
```

#### Dialog 추가

- Backdrop: `bg-black/10` + `backdrop-blur-xs` (옅게 — modal interruption은 약하게).
- 컨테이너: 동일 `--shadow-popover`.

#### 규칙

- 일반 select/dropdown은 backdrop 사용 안 함 (UX 표준 — 빠른 선택).
- 큰 메가 메뉴가 필요하면 `Dialog` 컴포넌트로 만들 것 (backdrop 자동).
- **base-ui 4.x 함정**: `<Menu.GroupLabel>`을 쓰려면 부모에 `<Menu.Group>`(`<DropdownMenuGroup>`) 필수. 없으면 `MenuGroupRootContext is missing` 런타임 에러.

### 4.5 Status — Badge & StatusDot

#### Badge variants

```tsx
<Badge>NEW</Badge>                       {/* default = DV 주황 (강조) */}
<Badge variant="secondary">베타</Badge>    {/* 일반 라벨 */}
<Badge variant="outline">지원 예정</Badge> {/* 테두리만 */}
<Badge variant="success">활성</Badge>     {/* 녹색 subtle */}
<Badge variant="warning">대기</Badge>     {/* 앰버 subtle */}
<Badge variant="destructive">실패</Badge>  {/* 빨강 subtle (= state-error) */}
<Badge variant="info">신규 8건</Badge>    {/* 파랑 subtle (카운트) */}
<Badge variant="neutral">비활성</Badge>   {/* 회색 subtle */}
```

모두 동일 사이즈: `h-5` / `text-xs` / `rounded-full` / `px-2 py-0.5`.

#### StatusDot — Vercel "● Ready" 패턴

```tsx
<StatusDot variant="success" label="정상" />
<StatusDot variant="live" label="실시간 조회 중" />  {/* DV 주황 + 펄스 */}
```

variants: `success` / `warning` / `error` / `info` / `neutral` / `live` (디노트 전용).

- `live`만 `animate-ping` + `motion-reduce:animate-none` (접근성).
- 사이즈: `sm` (6px) / `md` (8px, 기본).

### 4.6 KPI Card

```tsx
<KpiCard
  label="월간 검색량 (모바일)"
  value="38,200"
  trend={{ direction: "up", label: "12% 전월 대비" }}    /* ▲ DV 주황 */
/>

<KpiCard
  label="총 광고비 (7일)"
  value="₩412,800"
  valueSize="lg"                                          /* 32px */
  sub="최저 8,900 · 최고 89,000"
/>
```

- 카드 패턴: v5 flat (보더 X, 그림자 X).
- value: 28px / 32px (`valueSize="lg"`), `font-weight: 600`, `tracking: -0.6px`.
- trend 화살표: `▲` (up, DV 주황) / `▼` (down, gray-400) / `─` (flat, gray-300).

### 4.7 Empty State

```tsx
<EmptyState
  icon={<InboxIcon className="size-5" />}
  title="아직 추적 중인 상품이 없습니다"
  description="상품을 추가하면 선택한 플랫폼의 키워드 순위를 매일 자동 기록합니다."
  action={<Button variant="brand"><PlusIcon /> 상품 추가</Button>}
/>
```

- v5 flat 카드 패턴 (보더 X, 그림자 X).
- 1차 CTA는 `brand` (빈 화면이라 화면당 유일한 강조).

### 4.8 Charts (Recharts wrapper)

shadcn `chart` 컴포넌트 + 디노트 토큰 매핑:

```css
--chart-1: var(--brand);    /* 1순위 — 주력 라인 */
--chart-2: var(--ink-warm);        /* 2순위 */
--chart-3: var(--gray-500);
--chart-4: var(--gray-400);
--chart-5: var(--gray-300);
```

**플랫폼 차트 패턴** (2026-05-06 갱신):

- **모니터링 상세** (단일 플랫폼 추적) → 라인 1개, 등록 시 선택한 플랫폼 색만 사용
  ```tsx
  const config = { rank: { label: platform === "smartstore" ? "스마트스토어" : "쿠팡",
                           color: platform === "smartstore" ? "var(--naver-green)" : "var(--coupang-red)" } };
  ```
- **키워드 워크벤치 F006 / 상품 분석 F007** (분석 모듈, 두 플랫폼 동시 비교) → 라인 2개로 디노트 차별점 시각화
  ```tsx
  const config = {
    smartstore: { label: "스마트스토어", color: "var(--naver-green)" },
    coupang:    { label: "쿠팡",         color: "var(--coupang-red)" },
  };
  ```

순위 차트는 `<YAxis reversed />` (1위가 위쪽).

### 4.9 Header / Logo

#### 가로 로고

- 파일: `public/dnote-logo.png` (1000×350, 비율 ~2.86:1).
- 표시 사이즈: `h-8 w-auto` (높이 32px → 너비 약 92px).
- 헤더 좌측에 단독 노출 (텍스트 워드마크 없음).

#### 심볼

- 파일: `public/dnote-symbol.png` (정사각형).
- favicon, 모바일 아이콘, 작은 마크 자리.

#### Nav 패턴 (sticky → floating)

- 디폴트: `sticky top-0` + `bg-transparent` + `border-transparent`, max-width 1080px.
- `scrollY > 8` 시 floating pill: `top-4` + `bg-white/[.78]` + `backdrop-blur-[14px] saturate-180%` + `--shadow-pill` + max-width 1000px.
- 활성 nav 항목: DV 주황 하단 라인 (얇은 strip).
- nav-link hover: `bg-button-light` (#F3F4F6).

---

## 5. Depth & Elevation

| Level | Token | Use |
|-------|-------|-----|
| **0 — Flat** | `none` | **카드 / KPI / EmptyState** (모든 카드 평면) |
| **1 — Floating Pill** | `--shadow-pill` (3 layer ambient) | 헤더 floating nav |
| **2 — Popover** | `--shadow-popover` (3 layer soft) | Select / Dropdown / Dialog |

### Shadow Tokens (단일 source: `app/globals.css` `@theme inline`)

```css
@theme inline {
  --shadow-pill:
    0 0 0 1px rgba(0, 0, 0, 0.08),
    0 2px 2px rgba(0, 0, 0, 0.04),
    0 8px 8px -8px rgba(0, 0, 0, 0.04);

  --shadow-card: none;            /* 모든 카드 평면 — 잠재적 사용 0 */
  --shadow-card-hover: none;
  --shadow-card-sm: none;

  --shadow-popover:
    0 2px 4px rgba(0, 0, 0, 0.04),
    0 12px 24px rgba(0, 0, 0, 0.08),
    0 32px 64px -16px rgba(0, 0, 0, 0.10);
}
```

**중요**: `:root`에 shadow 토큰 정의 X (자기참조 회피). `@theme inline`이
단일 source — `var(--shadow-popover)` 직접 참조도 가능하고 `shadow-popover`
Tailwind utility class도 자동 생성.

---

## 6. Tokens & Code Mapping

### 6.1 Pipeline

```
DESIGN.md (이 문서)
  ↓
app/globals.css :root          (CSS 변수)
  ↓
app/globals.css :root          (shadcn 매핑: --primary, --background, ...)
  ↓
app/globals.css @theme inline  (Tailwind v4 utility 등록)
  ↓
컴포넌트 (className으로 utility 사용)
```

### 6.2 핵심 매핑

| 디노트 토큰 | shadcn 토큰 | Tailwind utility |
|------------|-------------|------------------|
| `--brand` | `--primary`, `--ring`, `--chart-1`, `--sidebar-primary` | `bg-primary`, `text-primary`, `ring-ring` |
| `--white` | `--card`, `--popover` | `bg-card`, `bg-popover`, `bg-white` |
| `--bg-soft` | `--background`, `--muted` | `bg-background`, `bg-bg-soft` |
| `--ink` | `--foreground` | `text-foreground`, `text-ink` |
| `--ink-warm` | (직접 사용) | `bg-ink-warm`, `text-ink-warm` |
| `--button-light` | `--secondary`, `--accent` | `bg-secondary`, `bg-button-light` |
| `--card-border` | `--border`, `--input` | `border-border`, `border-card-border` |
| `--state-{X}` | (해당 없음) | `bg-state-{X}-subtle`, `text-state-{X}` |

### 6.3 Mockup 동기화

`mockups/shared.css`의 토큰은 `app/globals.css`와 정확히 같은 값으로
유지. 한쪽 변경 시 양쪽 동시 갱신.

`types/enums.ts` ↔ Supabase migration `CHECK` 제약도 같은 원칙
(자세한 표는 `supabase/README.md`).

---

## 7. Do's and Don'ts (디노트 화법 핵심)

### ✅ Do

- 페이지 배경에 `--bg-soft` (#fafafa), 카드에 `--white` (#ffffff). 1% 명도차로 구분.
- 카드는 평면. 떠 있는 느낌이 필요하면 popover/dropdown/dialog로.
- default 버튼은 검정, brand는 주황. 화면당 brand 1개.
- Pretendard 1순위, 한글 자간 보수적 (음수 자간은 헤드라인에만).
- DV 주황을 정말 중요한 1차 액션·강조에만 (화면 면적 ~3% 이내).
- 새 패턴이 필요하면 즉흥적으로 도입하지 말고 이 문서를 먼저 갱신.

### ❌ Don't

- 카드에 border / box-shadow 사용 금지.
- 페이지 배경에 흰색 (#ffffff) 사용 금지.
- 화면당 brand 버튼 2개 이상 금지.
- default 버튼을 주황으로 만들지 말 것 (brand variant만 주황).
- Vercel Workflow Accent (Ship Red / Preview Pink / Develop Blue) 도입 금지.
- 주황 그라디언트, 주황 box-shadow glow 금지.
- 좌측 컬러 룰 (4px 스트라이프), 도트 아이브로우 (`• 라벨`) 금지.
- 헤드라인 외 텍스트에 음수 자간 금지.
- 버튼 라벨에 letter-spacing 적용 (uppercase, tracking-widest 등) 금지.
- DESIGN.md에 없는 새 색·radius·padding을 즉흥 도입 금지.

---

## 8. Responsive

### 8.1 Breakpoints

| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile S | <400px | 단일 컬럼, 최소 padding |
| Mobile | 400–600px | 표준 모바일 |
| Tablet S | 600–768px | 2열 그리드 시작 |
| **Tablet (768px)** | 768–1024px | 헤더 햄버거 → 풀 nav 전환점, 카드 그리드 확장 |
| Desktop S | 1024–1200px | 표준 데스크탑 |
| Desktop | 1200–1400px | 풀 레이아웃, max-width 1080px |
| Large | >1400px | 중앙 정렬, 여백 큼 |

### 8.2 Collapsing

- Hero 48px → 32px 모바일 (자간 비례 축소).
- Nav: 풀 → 햄버거 + Sheet (768px 미만).
- Card grid: 4열 → 2열 → 1열.
- Section vertical rhythm: 80px → 48px 모바일.
- 차트: 비율 유지, 가로 스크롤 또는 단순화.

### 8.3 Touch Targets

- 모든 인터랙티브 요소 최소 32px 높이 (`btn-md`, input/select 동일).
- 모바일 nav toggle은 원형 버튼.

---

## 9. AI Agent 가이드 (코드 생성 시 참조)

### 9.1 빠른 색 참조

- 페이지 배경: `bg-background` 또는 `bg-bg-soft` (#fafafa)
- 카드: `bg-card` 또는 `bg-white` + `rounded-lg` + `p-6` (보더/그림자 X)
- 본문 텍스트: `text-foreground` 또는 `text-ink` (#171717)
- sub 텍스트: `text-gray-500` (#666666)
- brand CTA: `<Button variant="brand">` (#E6783B, 화면당 1개)
- default 버튼: `<Button>` (검정 워밍 잉크)

### 9.2 컴포넌트 prompt 예시

- "Build a section header with h2 (24px / weight 600 / tracking -0.8px / text-ink) + subtitle (14px / gray-500). Section spacing: pb-16 mb-16."
- "Create a KPI card row (4 cards, grid-cols-4). Each: KpiCard with label, value, trend up (▲ DV 주황). v5 flat."
- "Design a moniterring item card: white bg, rounded-lg, p-6. Inside: 상품명 (text-ink 16px) + StatusDot variant=success label='동기화 완료' size=sm aligned right. No hover on card chrome."
- "Make a dropdown menu: rounded-xl, p-2, shadow-popover. Items 14px py-2 px-3 rounded-lg. Group label 12px gray-500. Wrap items in <DropdownMenuGroup> (base-ui requires)."

### 9.3 검증 체크리스트

페이지 작업 후 자체 점검:

- [ ] 화면에 brand 주황 버튼이 1개 이하인가?
- [ ] 카드에 border나 box-shadow가 박혀있지 않은가?
- [ ] 페이지 배경이 `bg-soft`(#fafafa)인가?
- [ ] 새 색이나 새 radius를 즉흥적으로 만들지 않았는가?
- [ ] 한글 텍스트에 음수 자간이 들어간 곳이 본문에 있는가?
- [ ] 영어 라벨이 사용자에게 노출되는 자리에 있는가? (개발자용 갤러리 외)

---

## Appendix A — Vercel Geist UI 영감 (참고용)

디노트는 Vercel Geist UI를 영감원으로 하되, 다음과 같이 채택/수정/배제했습니다.

### 채택 (strict)

- **Button system**: 사이즈 28/32/40px, padding 10/12/16px, radius 6px, letter-spacing 0, font-weight 500. Vercel 1:1.
- **모노크롬 베이스**: `#171717` 텍스트, `#ffffff` 카드 surface. Vercel 1:1.
- **헤드라인 타이포 hierarchy**: -2.4px → -1.28px → -0.96px → 0 자간 스케일 (한글에 보수적으로 적용 — 디노트 §2.3).
- **3-weight system**: 400/500/600. 700 bold 배제.
- **Floating nav pill** (`--shadow-pill`): Vercel marketing nav 패턴.

### 수정 (한국 셀러 SaaS에 맞게 조정)

- **카드**: Vercel은 shadow-as-border + multi-layer + inner #fafafa glow의 정교한 stack. 디노트 v5는 fully flat (보더/그림자 모두 제거). 페이지 배경 contrast로만 구분. → 디노트 §4.2.
- **Brand 컬러**: Vercel은 Workflow Accent 3색(Ship Red/Pink/Blue). 디노트는 단일 brand orange (#E6783B). → §1.1.
- **Popover/Dropdown**: Vercel은 shadow-as-border ring + light shadow. 디노트는 보더 없이 soft 3-layer drop shadow만 (Krea 톤). → §4.4.
- **Input/Select**: Vercel은 shadow-as-border ring. 디노트는 디폴트 보더 transparent + bg-white + hover bg-soft. → §4.3.
- **페이지 배경**: Vercel은 pure white (#ffffff). 디노트는 #fafafa로 띄움 — 흰 카드가 자연스럽게 떠 보이도록. → §1.2, §3.1.
- **폰트**: Vercel은 Geist Sans 우선. 디노트는 Pretendard 우선 (한글 본문). → §2.1.

### 배제

- **Workflow Accent Colors** (Ship Red, Preview Pink, Develop Blue) — 셀러 SaaS에 워크플로우 색 체계 불필요.
- **Vercel `#fafafa` inner ring** (카드 inner glow) — v5 flat 카드와 모순.
- **shadow-as-border 카드** — v5 flat 카드 패턴으로 폐기.
- **Pill button** (radius 9999px) — 디노트는 모든 버튼 radius 6px 고정.
- **Geist Mono** — v1에서는 거의 사용 안 함 (Phase 4 LLM 코드 출력 시 검토).

### 디노트 신규 추가

- **State Colors** (success/warning/error/info/neutral) — 셀러 도구 상태 표시 5개. → §1.5.
- **StatusDot `live` variant** — DV 주황 펄스, 실시간 조회 indicator.
- **Platform Colors** (naver-green / coupang-red) — 플랫폼 데이터 식별.
- **Plat card system v5** — 보더/그림자 모두 없는 평면 카드, 페이지 배경 contrast만으로 구분.

---

> 이 문서는 디노트 디자인 시스템의 단일 진실의 원천입니다. 코드와 모순이
> 발생하면 이 문서가 우선 — 갱신 후 코드 동기화하세요.
