# F-Brief 2단계 — 보고 이력(brief_history) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AE가 보고 문구를 복사한 순간 서버(`brief_history`)에 "문구 전문 + 조치 내역 + 성과 스냅샷"을 저장하고, 다음 보고 생성 시 "지난 조치 추적" 후보와 지난 보고 목록 화면을 제공한다.

**Architecture:** 스펙 `docs/superpowers/specs/2026-07-17-accounts-db-design.md` §7. 저장은 원본 구조(후보의 kind/facts/action + 숫자 지표), 소비는 그때그때 변환(AE 목록 화면 / 규칙 엔진의 follow-up 후보). 확장 → Supabase는 기존 패턴 그대로 `@supabase/supabase-js` + RLS(본인 행 + approved). Edge Function 변경은 프롬프트에 새 kind와 보고 유형 카탈로그만 추가.

**Tech Stack:** TypeScript 5.7, vitest(순수 로직), Supabase(Postgres RLS + Edge Function `brief-compose`), Chrome MV3 콘텐츠 스크립트.

## Global Constraints

- 사용자 노출 한글 메시지에 영문 기술용어 금지 (`friendly-error` 패턴). em dash(`—`)/minus(`−`) 금지 — 하이픈 `-`만 (UI 문자열 한정).
- 오버레이 UI는 `dvads-` prefix, backdrop 닫기는 `wireBackdropDismiss`, dropdown은 `createDropdown` (src/shared/CLAUDE.md).
- `collectReportData` 병렬 구조 변경 금지. AI는 번역기 — facts만 전송, 요약은 AI 미경유.
- 소스 수정 후 `npm run build` 필수 (dist/ 사용 중).
- 저장은 서버 먼저 — 단, 이력 저장 실패가 **복사 자체를 막으면 안 된다** (부가 기능).
- Supabase 프로젝트 `gvyvrjncpwmcwycebrhf`. anon 키 공개 안전, RLS가 방어선.
- 커밋 접미: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: DB 마이그레이션 — `brief_history` 테이블 + RLS

**Files:**
- Create: `supabase/migrations/20260718000000_brief_history.sql`

**Interfaces:**
- Produces: 테이블 `public.brief_history(id, user_id, ad_account_no, advertiser_name, period_since, period_until, message, actions jsonb, snapshot jsonb, created_at, updated_at)`. RLS는 기존 데이터 테이블과 동일(승인된 본인만).

- [ ] **Step 1: 마이그레이션 SQL 작성**

```sql
-- 보고 이력 (설계 §7). 저장은 원본 구조 — LLM용으로 미리 가공하지 않는다.
-- actions: [{ kind, facts, action?, actionText?, targets: [{label, cost, revenue, purchaseConv, clicks, impressions}] }]
-- snapshot: { totals: {cost,revenue,roas}, prevTotals: {cost,revenue,roas} }
create table public.brief_history (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  ad_account_no bigint not null,
  advertiser_name text not null,
  period_since date not null,
  period_until date not null,
  message text not null,        -- 보낸 문구 전문 (복사 시점의 편집 반영 텍스트)
  actions jsonb not null default '[]',
  snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index brief_history_lookup on public.brief_history (user_id, ad_account_no, created_at desc);

alter table public.brief_history enable row level security;
create policy "own rows" on public.brief_history for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
```

- [ ] **Step 2: DB에 적용**

기존 마이그레이션과 같은 방식으로 적용: `npx supabase db push` (링크돼 있지 않으면 Supabase 대시보드 SQL 편집기에 위 SQL을 그대로 실행하고, 파일은 기록용으로 커밋).

- [ ] **Step 3: 적용 확인**

SQL 편집기 또는 psql에서: `select relrowsecurity from pg_class where relname = 'brief_history';` → `t` 확인.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260718000000_brief_history.sql
git commit -m "feat(F-Brief): brief_history 테이블 + RLS (보고 이력 2단계)"
```

---

### Task 2: 규칙 엔진 — 후보에 `targets`(수치 지표) 부착

이력의 "조치 대상들의 당시 지표"는 표의 문자열이 아니라 **숫자**로 저장해야 다음 보고에서 비교 계산이 된다. 각 후보를 만드는 지점에서 원본 지표를 붙인다.

**Files:**
- Modify: `src/features/brief/brief-rules.ts`
- Test: `src/features/brief/brief-rules.test.ts`

**Interfaces:**
- Produces: `interface BriefTargetSnapshot { label: string; cost: number; revenue: number; purchaseConv: number; clicks: number; impressions: number }`, `BriefCandidate.targets: BriefTargetSnapshot[]` (필수 필드, 전 후보 13종이 채움).

- [ ] **Step 1: 실패하는 테스트 작성** — `brief-rules.test.ts`에 추가

```ts
describe("targets 스냅샷", () => {
  it("zeroConvKeyword 후보에 대상 키워드의 수치 지표가 붙는다", () => {
    const out = extractCandidates({
      keywords: [{ campaign: "C", group: "G", keywords: [
        { keyword: "가방", metrics: { impressions: 100, clicks: 10, cost: 20000, purchaseConv: 0, revenue: 0 } },
      ] }],
      placements: [],
    });
    const c = out.find((c) => c.kind === "zeroConvKeyword")!;
    expect(c.targets).toEqual([
      { label: "가방", cost: 20000, revenue: 0, purchaseConv: 0, clicks: 10, impressions: 100 },
    ]);
  });
});
```

(기존 테스트의 metrics fixture 헬퍼가 있으면 그것을 사용 — 파일 상단 확인. `ReportMetrics`에 위 5필드 외 항목이 있으면 fixture에 채워 넣는다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/features/brief/brief-rules.test.ts`
Expected: FAIL (`targets` undefined)

- [ ] **Step 3: 구현**

`brief-rules.ts`에 타입 추가 + 헬퍼:

```ts
/** 이력 저장용 대상 스냅샷 — 표(문자열)와 달리 숫자 그대로. 다음 보고의 비교 계산 재료. */
export interface BriefTargetSnapshot {
  label: string;
  cost: number;
  revenue: number;
  purchaseConv: number;
  clicks: number;
  impressions: number;
}

function toTarget(label: string, m: ReportMetrics): BriefTargetSnapshot {
  return { label, cost: m.cost, revenue: m.revenue, purchaseConv: m.purchaseConv, clicks: m.clicks, impressions: m.impressions };
}
```

`BriefCandidate`에 `targets: BriefTargetSnapshot[];` 필드 추가(필수). `extractCandidates`의 **13개 후보 생성 지점 전부**에 `targets:`를 채운다:

- `zeroConvKeyword`: `zeroConv.map((r) => toTarget(r.keyword, r.metrics))`
- `belowTargetKeyword`: `below.map((r) => toTarget(r.keyword, r.metrics))`
- `highRoasLowRank`: `lowRank.map((r) => toTarget(r.keyword, r.metrics))`
- `belowTargetGroup`: `badGroups.map((g) => toTarget(`${g.campaign} > ${g.group}`, g.metrics))`
- `zeroConvPlacement` / `lowRoasPlacement`: 해당 지면 배열 `.map((p) => toTarget(p.label, p.metrics))`
- `lowCtrAd`: `lowCtr.map((a) => toTarget(a.label, a.metrics))`
- `productConvDrop`: `dropped.map((p) => toTarget(p.label, p.cur))`
- skew 5종(`genderBidSkew`/`ageBidSkew`/`deviceBidSkew`/`hourWeekdaySkew`/`regionBidSkew`): `[toTarget(skew.best.label, skew.best.metrics), toTarget(skew.worst.label, skew.worst.metrics)]`

skew는 공통 생성 함수 한 곳이면 거기 한 번만.

- [ ] **Step 4: 전체 테스트 통과 확인**

Run: `npx vitest run src/features/brief/brief-rules.test.ts` → PASS (기존 테스트 포함 전부)
Run: `npm run typecheck` → 에러 0 (필수 필드 추가로 다른 파일이 깨지면 그 지점도 채운다)

- [ ] **Step 5: Commit**

```bash
git add src/features/brief/brief-rules.ts src/features/brief/brief-rules.test.ts
git commit -m "feat(F-Brief): 후보에 targets 수치 스냅샷 부착 - 이력 비교 계산 재료"
```

---

### Task 3: `brief-history.ts` — 저장/조회 모듈 + 변환(순수) 테스트

**Files:**
- Create: `src/features/brief/brief-history.ts`
- Test: `src/features/brief/brief-history.test.ts`

**Interfaces:**
- Consumes: `getSupabase()` (`@/shared/supabase`), `BriefCandidate`/`BriefTargetSnapshot` (Task 2).
- Produces:

```ts
export interface BriefHistoryAction {
  kind: BriefKind;
  facts: Record<string, string | number>;
  action?: BriefAction;
  actionText?: string;
  targets: BriefTargetSnapshot[];
}
export interface BriefHistoryRecord {
  id: string;
  adAccountNo: number;
  advertiserName: string;
  periodSince: string; // YYYY-MM-DD
  periodUntil: string;
  message: string;
  actions: BriefHistoryAction[];
  snapshot: { totals: BriefTotals; prevTotals: BriefTotals };
  createdAt: string;
}
export interface BriefTotals { cost: number; revenue: number; roas: number }
export function candidatesToActions(cands: BriefCandidate[]): BriefHistoryAction[];
export async function saveBriefHistory(rec: Omit<BriefHistoryRecord, "createdAt">): Promise<void>; // upsert by id
export async function fetchBriefHistory(adAccountNo: number, limit?: number): Promise<BriefHistoryRecord[]>; // 최신순
```

- [ ] **Step 1: 실패하는 테스트 작성** — 순수 변환만 (네트워크 함수는 vitest 대상 아님, 설계 §9)

```ts
import { describe, it, expect } from "vitest";
import { candidatesToActions } from "./brief-history";

describe("candidatesToActions", () => {
  it("후보의 kind/facts/action/targets만 추려 담는다 (표 spec은 제외)", () => {
    const out = candidatesToActions([
      {
        kind: "zeroConvKeyword",
        facts: { 기준: "전환 0", keywords: "가방", count: 1, 비용합계: 20000 },
        table: { title: "t", columns: [], rows: [] },
        selected: true,
        action: "lower",
        targets: [{ label: "가방", cost: 20000, revenue: 0, purchaseConv: 0, clicks: 10, impressions: 100 }],
      },
    ]);
    expect(out).toEqual([
      {
        kind: "zeroConvKeyword",
        facts: { 기준: "전환 0", keywords: "가방", count: 1, 비용합계: 20000 },
        action: "lower",
        actionText: undefined,
        targets: [{ label: "가방", cost: 20000, revenue: 0, purchaseConv: 0, clicks: 10, impressions: 100 }],
      },
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/features/brief/brief-history.test.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```ts
/**
 * F-Brief 보고 이력 — 서버 저장/조회 (설계 §7).
 *
 * 저장은 원본 구조(kind/facts/action + 숫자 targets) — LLM용 가공 금지.
 * 저장 시점은 "복사한 순간"이며 실패해도 복사를 막지 않는다(호출부 책임).
 */
import { getSupabase } from "@/shared/supabase";
import { type BriefCandidate, type BriefKind, type BriefAction, type BriefTargetSnapshot } from "./brief-rules";

// (위 Interfaces 블록의 타입 선언 그대로)

export function candidatesToActions(cands: BriefCandidate[]): BriefHistoryAction[] {
  return cands.map((c) => ({ kind: c.kind, facts: c.facts, action: c.action, actionText: c.actionText, targets: c.targets }));
}

export async function saveBriefHistory(rec: Omit<BriefHistoryRecord, "createdAt">): Promise<void> {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("로그인이 만료됐어요. 다시 로그인해 주세요");
  const { error } = await sb.from("brief_history").upsert({
    id: rec.id,
    user_id: session.user.id,
    ad_account_no: rec.adAccountNo,
    advertiser_name: rec.advertiserName,
    period_since: rec.periodSince,
    period_until: rec.periodUntil,
    message: rec.message,
    actions: rec.actions,
    snapshot: rec.snapshot,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error("보고 이력을 저장하지 못했어요");
}

export async function fetchBriefHistory(adAccountNo: number, limit = 10): Promise<BriefHistoryRecord[]> {
  const { data, error } = await getSupabase()
    .from("brief_history")
    .select("id, ad_account_no, advertiser_name, period_since, period_until, message, actions, snapshot, created_at")
    .eq("ad_account_no", adAccountNo)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("지난 보고를 불러오지 못했어요");
  return (data ?? []).map((r) => ({
    id: r.id,
    adAccountNo: Number(r.ad_account_no),
    advertiserName: r.advertiser_name,
    periodSince: r.period_since,
    periodUntil: r.period_until,
    message: r.message,
    actions: (r.actions ?? []) as BriefHistoryAction[],
    snapshot: (r.snapshot ?? { totals: { cost: 0, revenue: 0, roas: 0 }, prevTotals: { cost: 0, revenue: 0, roas: 0 } }) as BriefHistoryRecord["snapshot"],
    createdAt: r.created_at,
  }));
}
```

- [ ] **Step 4: 테스트 통과 + typecheck**

Run: `npx vitest run src/features/brief/brief-history.test.ts` → PASS. `npm run typecheck` → 에러 0.

- [ ] **Step 5: Commit**

```bash
git add src/features/brief/brief-history.ts src/features/brief/brief-history.test.ts
git commit -m "feat(F-Brief): 보고 이력 저장/조회 모듈 (brief_history)"
```

---

### Task 4: "지난 조치 추적" 후보 (순수 함수 + 테스트)

지난 이력의 targets를 현재 데이터와 라벨 매칭해 "그때 → 지금" 비교 후보를 만든다.

**Files:**
- Modify: `src/features/brief/brief-rules.ts` (`BriefKind`에 `"pastActionFollowUp"` 추가)
- Create: `src/features/brief/brief-followup.ts`
- Test: `src/features/brief/brief-followup.test.ts`

**Interfaces:**
- Consumes: `BriefHistoryRecord`(Task 3), `BriefCandidate`/`BriefTargetSnapshot`/`roasPct`(Task 2).
- Produces: `buildFollowUpCandidate(history: BriefHistoryRecord, current: Map<string, BriefTargetSnapshot>): BriefCandidate | null` + `currentTargetMap(cands: BriefCandidate[], keywords: BriefKeywordRow[]): Map<string, BriefTargetSnapshot>`.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, it, expect } from "vitest";
import { buildFollowUpCandidate } from "./brief-followup";
import { type BriefHistoryRecord } from "./brief-history";

const t = (label: string, cost: number, revenue: number): any =>
  ({ label, cost, revenue, purchaseConv: revenue > 0 ? 1 : 0, clicks: 10, impressions: 100 });

const history: BriefHistoryRecord = {
  id: "h1", adAccountNo: 1, advertiserName: "테스트", periodSince: "2026-07-01", periodUntil: "2026-07-10",
  message: "…",
  actions: [{ kind: "zeroConvKeyword", facts: {}, action: "lower", targets: [t("가방", 50000, 0), t("지갑", 30000, 0)] }],
  snapshot: { totals: { cost: 100000, revenue: 400000, roas: 400 }, prevTotals: { cost: 0, revenue: 0, roas: 0 } },
  createdAt: "2026-07-10T09:00:00Z",
};

describe("buildFollowUpCandidate", () => {
  it("지난 조치 대상이 현재도 있으면 그때-지금 비교 후보를 만든다", () => {
    const cur = new Map([["가방", t("가방", 20000, 150000)]]);
    const c = buildFollowUpCandidate(history, cur)!;
    expect(c.kind).toBe("pastActionFollowUp");
    expect(c.facts["지난보고일"]).toBe("2026-07-10");
    expect(String(c.facts["대상"])).toContain("가방");
    expect(c.table.rows).toHaveLength(1);
    expect(c.targets).toHaveLength(1); // 이번에도 저장돼 연쇄 추적 가능
  });

  it("현재 데이터에 하나도 매칭되지 않으면 null", () => {
    expect(buildFollowUpCandidate(history, new Map())).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/features/brief/brief-followup.test.ts` → FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`brief-rules.ts`의 `BriefKind` union 맨 앞에 추가: `| "pastActionFollowUp"  // 지난 보고 조치의 이번 성과 추적 (2단계 §7)`.

`brief-followup.ts`:

```ts
/**
 * 지난 조치 추적 후보 (설계 §7) — "지난 보고(7/10)에서 하향한 키워드 3개 → 이번 광고비 -32%".
 * 순수 함수: 서버 이력 + 현재 지표 맵만 받는다. 라벨 문자열 매칭(키워드/그룹/지면/상품/소재 공통).
 */
import { type BriefCandidate, type BriefKeywordRow, type BriefTargetSnapshot } from "./brief-rules";
import { type BriefHistoryRecord } from "./brief-history";

const ACTION_LABEL: Record<string, string> = {
  raise: "상향", hold: "유지", lower: "하향", exclude: "제외", ask: "문의", custom: "조정",
};

function roasOf(t: BriefTargetSnapshot): number {
  return t.cost > 0 ? (t.revenue / t.cost) * 100 : 0;
}

/** 현재 기간의 라벨 → 지표 맵. 후보 targets(전 카테고리) + 전체 키워드 행으로 구성. */
export function currentTargetMap(cands: BriefCandidate[], keywords: BriefKeywordRow[]): Map<string, BriefTargetSnapshot> {
  const map = new Map<string, BriefTargetSnapshot>();
  for (const r of keywords) {
    map.set(r.keyword, { label: r.keyword, cost: r.metrics.cost, revenue: r.metrics.revenue,
      purchaseConv: r.metrics.purchaseConv, clicks: r.metrics.clicks, impressions: r.metrics.impressions });
  }
  for (const c of cands) for (const t of c.targets) if (!map.has(t.label)) map.set(t.label, t);
  return map;
}

export function buildFollowUpCandidate(
  history: BriefHistoryRecord,
  current: Map<string, BriefTargetSnapshot>,
): BriefCandidate | null {
  // 지난 보고에서 조치가 붙었던 대상 우선, 없으면 언급된 전 대상.
  const acted = history.actions.filter((a) => a.action != null);
  const pool = acted.length > 0 ? acted : history.actions;
  const rows: Array<{ then: BriefTargetSnapshot; now: BriefTargetSnapshot; actionLabel: string }> = [];
  const seen = new Set<string>();
  for (const a of pool) {
    for (const t of a.targets) {
      if (seen.has(t.label)) continue;
      const now = current.get(t.label);
      if (!now) continue;
      seen.add(t.label);
      rows.push({ then: t, now, actionLabel: a.action ? ACTION_LABEL[a.action] ?? "조정" : "점검" });
    }
  }
  if (rows.length === 0) return null;

  const day = history.periodUntil; // "지난 보고(7/10)" 표기용 — 보고 기간 종료일
  const thenCost = rows.reduce((s, r) => s + r.then.cost, 0);
  const nowCost = rows.reduce((s, r) => s + r.now.cost, 0);
  const thenRoas = thenCost > 0 ? (rows.reduce((s, r) => s + r.then.revenue, 0) / thenCost) * 100 : 0;
  const nowRoas = nowCost > 0 ? (rows.reduce((s, r) => s + r.now.revenue, 0) / nowCost) * 100 : 0;

  return {
    kind: "pastActionFollowUp",
    facts: {
      기준: `지난 보고(${day})에서 조치한 항목의 이번 성과 비교`,
      지난보고일: day,
      대상: rows.map((r) => `${r.then.label}(${r.actionLabel})`).join(", "),
      count: rows.length,
      당시광고비: thenCost, 이번광고비: nowCost,
      당시수익률: `${thenRoas.toFixed(0)}%`, 이번수익률: `${nowRoas.toFixed(0)}%`,
    },
    table: {
      title: `지난 조치 항목 성과 (${day} 보고 대비)`,
      columns: ["항목", "조치", "당시 광고비", "이번 광고비", "당시 수익률", "이번 수익률"],
      rows: rows.map((r) => ({ cells: [
        r.then.label, r.actionLabel,
        `${r.then.cost.toLocaleString()}원`, `${r.now.cost.toLocaleString()}원`,
        `${roasOf(r.then).toFixed(0)}%`, `${roasOf(r.now).toFixed(0)}%`,
      ] })),
    },
    selected: false,
    targets: rows.map((r) => r.now),
  };
}
```

- [ ] **Step 4: 테스트 통과 + typecheck**

Run: `npx vitest run src/features/brief/brief-followup.test.ts` → PASS. `npm run typecheck` → 에러 0.

- [ ] **Step 5: Commit**

```bash
git add src/features/brief/brief-rules.ts src/features/brief/brief-followup.ts src/features/brief/brief-followup.test.ts
git commit -m "feat(F-Brief): 지난 조치 추적 후보 (pastActionFollowUp)"
```

---

### Task 5: 저장 훅 + 후보 주입 배선 (brief.ts / brief-panel.ts)

**Files:**
- Modify: `src/features/brief/brief-panel.ts` (복사 시 콜백)
- Modify: `src/features/brief/brief.ts` (이력 fetch → follow-up 주입, 복사 → 저장)

**Interfaces:**
- Consumes: Task 3의 `saveBriefHistory`/`fetchBriefHistory`/`candidatesToActions`, Task 4의 `buildFollowUpCandidate`/`currentTargetMap`.
- Produces: `BriefPanelOpts.onCopyText?: (fullMessage: string) => void` — 텍스트 블록 복사 버튼 클릭 시, **모든 텍스트 블록의 현재(편집 반영) 값**을 `"\n\n"`으로 이어 전달.

- [ ] **Step 1: brief-panel.ts — 복사 콜백 추가**

`BriefPanelOpts`에 추가:

```ts
  /** 텍스트 블록 복사 시 호출 — 전 텍스트 블록의 현재 값(편집 반영)을 합쳐 넘긴다. 이력 저장용(설계 §7: 복사한 순간). */
  onCopyText?: (fullMessage: string) => void;
```

`renderBriefPanel` 안에서 텍스트 블록의 textarea들을 모은다: `const textAreas: HTMLTextAreaElement[] = [];` — 각 텍스트 블록 생성부에서 `textAreas.push(ta);`. 복사 버튼 클릭 핸들러의 `.then(() => ...)` 성공 분기에 추가:

```ts
        void navigator.clipboard.writeText(ta.value)
          .then(() => {
            showToast({ message: "문구를 복사했어요", variant: "success" });
            opts.onCopyText?.(textAreas.map((t) => t.value).filter((v) => v.trim() !== "").join("\n\n"));
          })
          .catch(() => showToast({ message: "복사하지 못했어요. 직접 선택해 복사해 주세요", variant: "error" }));
```

(표 이미지 복사는 이력 갱신 대상 아님 — 문구 전문은 텍스트만.)

- [ ] **Step 2: brief.ts — run()에서 이력 조회 + follow-up 후보 주입**

import 추가:

```ts
import { saveBriefHistory, fetchBriefHistory, candidatesToActions, type BriefHistoryRecord } from "./brief-history";
import { buildFollowUpCandidate, currentTargetMap } from "./brief-followup";
```

`run()`의 `extractCandidates` 호출 **앞**에 (collectBriefData와 순위 보강 사이 아무 곳, stale 가드 뒤):

```ts
    // 지난 보고 이력 — 실패해도 다른 후보는 살린다 (부가 기능).
    let lastHistory: BriefHistoryRecord | null = null;
    try {
      lastHistory = (await fetchBriefHistory(target.adAccountNo, 1))[0] ?? null;
    } catch (e) {
      console.warn("[dv-ads/brief] 지난 보고 조회 실패 - 추적 후보만 생략", e);
    }
    if (stale()) return;
```

`extractCandidates` 호출 **뒤**에:

```ts
    if (lastHistory) {
      const follow = buildFollowUpCandidate(lastHistory, currentTargetMap(candidates, plRows));
      if (follow) candidates.unshift(follow); // 지난 조치 후속이 첫 화제 - 보고 관례
    }
```

- [ ] **Step 3: brief.ts — 복사 → 저장 배선**

`showResult`가 저장에 필요한 맥락(target, range)을 알아야 한다. 시그니처 변경:

```ts
function showResult(
  target: ReportTarget,
  data: BriefData,
  candidates: BriefCandidate[],
  aiBlocks: ComposedBlock[],
  targetRoas: number | undefined,
): void {
```

(호출부 2곳 — `run()`의 `showResult(target.name → target, ...)`, `openPickFlow` 내부 — 함께 변경. `openPickFlow`도 첫 인자를 `target: ReportTarget`으로 바꾸고 `advertiserName` 사용처는 `target.name`으로.)

`showResult` 본문의 `renderBriefPanel({...})`에 저장 훅 추가:

```ts
  // 이력 저장 — 패널 1회당 레코드 1건(id 고정 upsert). 복사할 때마다 최신 편집본으로 갱신.
  const historyId = crypto.randomUUID();
  let saveFailedOnce = false;
  const onCopyText = (fullMessage: string) => {
    void saveBriefHistory({
      id: historyId,
      adAccountNo: target.adAccountNo,
      advertiserName: target.name,
      periodSince: data.range.since,
      periodUntil: data.range.until,
      message: fullMessage,
      actions: candidatesToActions(candidates),
      snapshot: {
        totals: { cost: data.model.totalCurrent.cost, revenue: data.model.totalCurrent.revenue, roas: roasPct(data.model.totalCurrent) },
        prevTotals: { cost: data.model.totalPrev.cost, revenue: data.model.totalPrev.revenue, roas: roasPct(data.model.totalPrev) },
      },
    }).catch((e) => {
      console.warn("[dv-ads/brief] 이력 저장 실패", e);
      if (!saveFailedOnce) { // 복사마다 토스트가 반복되면 소음
        saveFailedOnce = true;
        showToast({ message: "복사는 됐지만 보고 이력은 저장하지 못했어요", variant: "error" });
      }
    });
  };

  renderBriefPanel({
    advertiserName: target.name,
    blocks,
    onCopyText,
    ...
  });
```

주의: `data.range`가 `DateRange`이고 `since`/`until` 필드명이 다르면(`report-period.ts` 확인) 실제 필드명으로 맞춘다. `YYYY-MM-DD` 문자열이 아니면 변환 헬퍼(기존 `report-period.ts`의 포맷 함수) 사용.

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck` → 에러 0. `npm run build` → 성공.

- [ ] **Step 5: Commit**

```bash
git add src/features/brief/brief.ts src/features/brief/brief-panel.ts
git commit -m "feat(F-Brief): 복사 시 이력 저장 + 지난 조치 추적 후보 주입"
```

---

### Task 6: 지난 보고 목록 화면 (AE용)

결과 패널 하단 "지난 보고" 버튼 → 이 계정의 이력 목록(날짜·기간·조치 요약) → 항목 클릭 시 문구 전문 + 조치 표.

**Files:**
- Create: `src/features/brief/brief-history-panel.ts`
- Modify: `src/features/brief/brief-panel.ts` (foot에 버튼 추가용 opt)
- Modify: `src/features/brief/brief.ts` (배선)
- Modify: F-Brief 패널 CSS가 정의된 파일 (`grep -rn "dvads-brief-card" src/`로 위치 확인 - overlay.css류) 에 목록용 클래스 추가

**Interfaces:**
- Consumes: `fetchBriefHistory`(Task 3), `wireBackdropDismiss`, `showToast`.
- Produces: `openBriefHistoryPanel(adAccountNo: number, advertiserName: string, onBack: () => void): void`.

- [ ] **Step 1: brief-panel.ts — foot 버튼 opt 추가**

`BriefPanelOpts`에 `onShowHistory?: () => void;` 추가. foot 구성부(`onPickManually` 버튼 옆)에:

```ts
  if (opts.onShowHistory) {
    const hist = document.createElement("button");
    hist.type = "button";
    hist.className = "dvads-btn";
    hist.textContent = "지난 보고";
    hist.addEventListener("click", () => opts.onShowHistory?.());
    foot.appendChild(hist);
  }
```

- [ ] **Step 2: brief-history-panel.ts 작성**

```ts
/**
 * 지난 보고 목록/상세 (설계 §7 "AE 화면" 갈래) — 저장된 원본 구조를 그때그때 렌더.
 * 기존 brief 패널 스타일(dvads-brief-*) 재사용. 상세는 문구 전문 + 조치 요약 텍스트.
 */
import { showToast } from "@/shared/toast";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { fetchBriefHistory, type BriefHistoryRecord } from "./brief-history";

let dispose: (() => void) | null = null;
export function closeBriefHistoryPanel(): void { dispose?.(); dispose = null; }

const ACTION_LABEL: Record<string, string> = {
  raise: "상향", hold: "유지 관찰", lower: "하향", exclude: "제외", ask: "문의", custom: "조정",
};

function actionSummary(rec: BriefHistoryRecord): string {
  if (rec.actions.length === 0) return "조치 없음";
  return rec.actions
    .map((a) => `${String(a.facts["기준"] ?? a.kind)}${a.action ? ` - ${ACTION_LABEL[a.action] ?? "조정"}` : ""}`)
    .join(" · ");
}

export function openBriefHistoryPanel(adAccountNo: number, advertiserName: string, onBack: () => void): void {
  closeBriefHistoryPanel();
  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-brief-card";
  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.textContent = `지난 보고 - ${advertiserName}`;
  card.appendChild(head);
  const body = document.createElement("div");
  body.className = "dvads-brief-body";
  body.textContent = "불러오는 중...";
  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "dvads-btn dvads-btn-primary";
  back.textContent = "돌아가기";
  back.addEventListener("click", () => { closeBriefHistoryPanel(); onBack(); });
  foot.appendChild(back);
  card.appendChild(foot);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  wireBackdropDismiss(backdrop, () => closeBriefHistoryPanel());
  dispose = () => backdrop.remove();

  void fetchBriefHistory(adAccountNo, 20)
    .then((list) => {
      if (!backdrop.isConnected) return;
      body.textContent = "";
      if (list.length === 0) {
        body.textContent = "저장된 보고가 아직 없어요. 문구를 복사하면 자동으로 기록됩니다";
        return;
      }
      for (const rec of list) {
        const item = document.createElement("div");
        item.className = "dvads-brief-hist-item";
        const title = document.createElement("div");
        title.className = "dvads-brief-hist-title";
        title.textContent = `${rec.createdAt.slice(0, 10)} 보고 (기간 ${rec.periodSince} ~ ${rec.periodUntil})`;
        item.appendChild(title);
        const sum = document.createElement("div");
        sum.className = "dvads-brief-hist-sum";
        sum.textContent = actionSummary(rec);
        item.appendChild(sum);
        const msg = document.createElement("pre");
        msg.className = "dvads-brief-hist-msg";
        msg.textContent = rec.message;
        msg.hidden = true;
        item.appendChild(msg);
        title.addEventListener("click", () => { msg.hidden = !msg.hidden; });
        body.appendChild(item);
      }
    })
    .catch((e) => {
      console.warn("[dv-ads/brief] 지난 보고 조회 실패", e);
      if (backdrop.isConnected) body.textContent = "지난 보고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요";
    });
}
```

- [ ] **Step 3: CSS 추가**

`dvads-brief-card`가 정의된 CSS 파일(`grep -rn "dvads-brief-card" src/`)에:

```css
.dvads-brief-hist-item { padding: 10px 12px; border: 1px solid var(--dvads-border, #e5e5e5); border-radius: 8px; margin-bottom: 8px; }
.dvads-brief-hist-title { font-weight: 600; cursor: pointer; }
.dvads-brief-hist-sum { color: #777; font-size: 12px; margin-top: 4px; }
.dvads-brief-hist-msg { white-space: pre-wrap; font-family: inherit; font-size: 13px; margin: 8px 0 0; }
```

(파일의 기존 변수·색 체계를 따른다 — DESIGN.md 준수. `#777` 등은 기존 brief CSS에서 쓰는 보조 텍스트 색으로 교체.)

- [ ] **Step 4: brief.ts 배선**

`showResult`의 `renderBriefPanel({...})`에 추가:

```ts
    onShowHistory: () => {
      closeBriefPanel();
      openBriefHistoryPanel(target.adAccountNo, target.name, () =>
        showResult(target, data, candidates, aiBlocks, targetRoas));
    },
```

import: `import { openBriefHistoryPanel } from "./brief-history-panel";`

- [ ] **Step 5: typecheck + build + commit**

Run: `npm run typecheck` && `npm run build` → 성공.

```bash
git add src/features/brief/brief-history-panel.ts src/features/brief/brief-panel.ts src/features/brief/brief.ts <CSS파일>
git commit -m "feat(F-Brief): 지난 보고 목록 화면"
```

---

### Task 7: Edge Function 프롬프트 — 새 kind + 보고 유형 카탈로그

**Files:**
- Modify: `supabase/functions/brief-compose/index.ts`

- [ ] **Step 1: 프롬프트에 kind 설명 추가**

파일에서 kind 목록/후보 설명이 들어가는 프롬프트 문자열을 찾아(`grep -n "zeroConv\|kind" supabase/functions/brief-compose/index.ts`) `pastActionFollowUp` 항목 추가:

```
- pastActionFollowUp: 지난 보고에서 조치한 항목의 이번 성과 비교. facts의 당시/이번 숫자를 그대로 써서 "지난 보고에서 하향한 키워드들의 광고비가 줄고 수익률이 개선됐다/아쉽다"류로 서술. 성과가 좋아졌으면 결과 보고(유형3), 나빠졌으면 반성과 새 계획(유형4) 어조.
```

같은 위치에 보고 유형 카탈로그 안내(설계 §7 5종)를 시스템 프롬프트에 추가:

```
보고 문장은 다음 유형을 상황에 맞게 조합한다: 1) 수정 통보 2) 예고+근거 3) 조치 결과 4) 반성+새 계획 5) 조합. action이 지정된 후보는 1·2 어조, pastActionFollowUp은 3·4 어조.
```

- [ ] **Step 2: 배포**

Run: `supabase functions deploy brief-compose --no-verify-jwt`
Expected: 배포 성공 로그.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/brief-compose/index.ts
git commit -m "feat(F-Brief): 프롬프트에 지난 조치 추적 kind + 보고 유형 카탈로그"
```

---

### Task 8: 문서 갱신 + 최종 검증

**Files:**
- Modify: `src/features/brief/CLAUDE.md` (이력 파일 3개 + 저장 시점 규칙 한 줄씩)
- Modify: `docs/superpowers/specs/2026-07-17-accounts-db-design.md` 아님 — 스펙은 그대로. 루트 CLAUDE.md의 brief 항목에 "이력 2단계 완료" 한 줄만.

- [ ] **Step 1: CLAUDE.md 갱신**

`src/features/brief/CLAUDE.md` 파일 절에 추가:

```
- `brief-history.ts` — 서버 이력 저장/조회(테이블 `brief_history`, RLS 본인+approved). **저장 시점 = 복사한 순간**(패널 1회당 upsert 1건, id 고정) — 생성만 하고 닫으면 기록 없음. 저장 실패는 복사를 막지 않는다(토스트 1회).
- `brief-followup.ts` — 지난 조치 추적 후보(`pastActionFollowUp`, 순수+vitest). 라벨 문자열 매칭 — 키워드명 변경 시 추적 끊김(허용된 한계).
- `brief-history-panel.ts` — 지난 보고 목록/상세. 저장은 원본 구조, 화면은 그때그때 변환(설계 §7).
```

- [ ] **Step 2: 전체 검증**

```bash
npx vitest run
rm -f tsconfig.*.tsbuildinfo && npm run typecheck
npm run build
```

Expected: 전부 성공.

- [ ] **Step 3: 수동 QA 체크리스트 (사용자 안내용 — 자동화 불가)**

1. 보고 문구 생성 → 복사 안 하고 닫기 → "지난 보고" 목록에 없음.
2. 복사 → 목록에 1건 생김(편집 후 재복사 시 같은 건이 갱신).
3. 같은 계정으로 재생성 → 첫 후보로 "지난 조치 항목 성과" 표 등장.
4. 다른 회원 계정으로는 이력이 안 보임(RLS).

- [ ] **Step 4: Commit**

```bash
git add src/features/brief/CLAUDE.md CLAUDE.md
git commit -m "docs(F-Brief): 보고 이력 2단계 문서 반영"
```
