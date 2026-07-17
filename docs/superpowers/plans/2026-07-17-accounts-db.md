# F-Accounts 1단계 (회원 체계 + 서버 DB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가입·로그인·관리자 승인 체계를 만들고, 로컬(chrome.storage) 자격증명·계정 설정·그룹을 Supabase DB로 이사시킨다 (설계: `docs/superpowers/specs/2026-07-17-accounts-db-design.md`).

**Architecture:** Supabase Auth + Postgres(RLS) + `@supabase/supabase-js`. 서버가 원본, 로컬은 캐시. Secret Key만 Edge Function(`credentials-vault`) 경유 암호화. 미승인/미로그인은 확장 전체 잠금.

**Tech Stack:** React 19, TS 5.7, Vite 6 + @crxjs, Supabase (프로젝트 `gvyvrjncpwmcwycebrhf`, dvcompany 조직), vitest.

## Global Constraints

- 사용자 노출 문구는 전부 일상 한글 — 영문 기술용어 금지 (`friendly-error.ts` 패턴). em dash(—)/minus(−) 금지, 하이픈만.
- UI는 `docs/DESIGN.md` 준수 (DV 주황 `#E6783B` 절제, 버튼 radius 8px/height 32px).
- 크로스 feature import는 `@/` 별칭만 (상대경로 `../` 금지).
- `src/` 수정 후 반드시 `npm run build`.
- 커밋 co-author: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Supabase 배포: `supabase functions deploy <name> --no-verify-jwt` / DB는 `supabase db push`. 프로젝트 ref `gvyvrjncpwmcwycebrhf`.
- manifest `host_permissions`는 이미 `https://gvyvrjncpwmcwycebrhf.supabase.co/*` 포함 (F-Brief 때 추가) — 새 도메인 추가 금지.

---

### Task 1: DB 스키마 + RLS 마이그레이션

**Files:**
- Create: `supabase/migrations/20260717000000_accounts.sql`

**Interfaces:**
- Produces: 테이블 `profiles`(id uuid PK=auth.users.id, email, display_name, status, is_admin), `credentials`(user_id PK, customer_id, access_license, secret_key_enc), `account_meta`(user_id, ad_account_no, meta jsonb, added, PK(user_id, ad_account_no)), `account_groups`(id uuid PK, user_id, name, ord, account_nos int[]). 이후 모든 Task가 이 이름/컬럼을 그대로 쓴다.

- [ ] **Step 1: 마이그레이션 SQL 작성**

```sql
-- 회원 프로필. 가입(auth.users insert) 시 트리거로 자동 생성.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','blocked')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.credentials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  customer_id text not null,
  access_license text not null,
  secret_key_enc text not null, -- credentials-vault가 암호화한 문자열. 평문 저장 금지.
  updated_at timestamptz not null default now()
);

create table public.account_meta (
  user_id uuid not null references public.profiles(id) on delete cascade,
  ad_account_no bigint not null,
  meta jsonb not null default '{}', -- MultiAccountUserMeta 그대로 (adAccountNo 제외)
  added boolean not null default false, -- "내 계정 목록" 포함 여부 (multi_account_added_list 흡수)
  added_order int not null default 0,   -- 추가 목록 내 표시 순서
  updated_at timestamptz not null default now(),
  primary key (user_id, ad_account_no)
);

create table public.account_groups (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  ord int not null default 0,
  account_nos bigint[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- 가입 시 프로필 자동 생성
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, coalesce(new.email, ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 승인 여부 헬퍼 (RLS에서 재사용)
create function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'approved')
$$;
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_admin)
$$;

alter table public.profiles enable row level security;
alter table public.credentials enable row level security;
alter table public.account_meta enable row level security;
alter table public.account_groups enable row level security;

-- profiles: 본인은 자기 행 조회(승인 전에도 — 대기 화면이 상태를 읽어야 함), 관리자는 전체 조회+상태/관리자 변경
create policy "own profile read" on public.profiles for select using (id = auth.uid());
create policy "admin read all" on public.profiles for select using (public.is_admin());
create policy "admin update" on public.profiles for update using (public.is_admin());

-- 데이터 테이블: 승인된 본인만 (미승인은 빈 결과)
create policy "own rows" on public.credentials for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
create policy "own rows" on public.account_meta for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
create policy "own rows" on public.account_groups for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
```

- [ ] **Step 2: 적용**

Run: `supabase db push` (링크 안 되어 있으면 먼저 `supabase link --project-ref gvyvrjncpwmcwycebrhf`)
Expected: 마이그레이션 적용 성공.

- [ ] **Step 3: 검증** — Supabase SQL Editor 또는 `supabase db diff`로 테이블 4개 + 정책 존재 확인. 테스트 유저 가입(콘솔 Auth > Add user) 시 profiles 행이 자동 생성되는지 확인.

- [ ] **Step 4: Commit** — `git add supabase/migrations && git commit -m "feat(F-Accounts): DB 스키마 + RLS (profiles/credentials/account_meta/account_groups)"`

---

### Task 2: supabase 클라이언트 모듈

**Files:**
- Modify: `package.json` (`npm i @supabase/supabase-js`)
- Create: `src/shared/supabase.ts`
- Test: `src/shared/supabase.test.ts` (storage adapter만 — 클라이언트 자체는 SDK 신뢰)

**Interfaces:**
- Produces: `getSupabase(): SupabaseClient` (lazy 싱글턴), `chromeStorageAdapter` (SDK storage adapter, `chrome.storage.local` 키 `sb_session`).
- 설계 §2: SDK 재도입은 확정 사항 (2026-05-15 제거 결정의 전제가 바뀜 — 근거는 설계 문서에).

- [ ] **Step 1: 실패 테스트** — adapter가 chrome.storage에 get/set/remove 하는지 (전역 `chrome` 모킹):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeStorageAdapter } from "./supabase";

const store: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  vi.stubGlobal("chrome", { storage: { local: {
    get: vi.fn(async (k: string) => ({ [k]: store[k] })),
    set: vi.fn(async (o: Record<string, string>) => { Object.assign(store, o); }),
    remove: vi.fn(async (k: string) => { delete store[k]; }),
  } } });
});

describe("chromeStorageAdapter", () => {
  it("setItem 후 getItem으로 같은 값을 돌려준다", async () => {
    await chromeStorageAdapter.setItem("k", "v");
    expect(await chromeStorageAdapter.getItem("k")).toBe("v");
  });
  it("없는 키는 null", async () => {
    expect(await chromeStorageAdapter.getItem("none")).toBeNull();
  });
  it("removeItem 후 null", async () => {
    await chromeStorageAdapter.setItem("k", "v");
    await chromeStorageAdapter.removeItem("k");
    expect(await chromeStorageAdapter.getItem("k")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/shared/supabase.test.ts` → FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co";
const SUPABASE_ANON_KEY = "<Supabase 콘솔 Settings > API의 anon public 키>"; // anon 키는 공개용 — 확장에 넣어도 안전 (RLS가 방어)

export const chromeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const o = await chrome.storage.local.get(key);
    return (o[key] as string | undefined) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};

let client: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage: chromeStorageAdapter, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    });
  }
  return client;
}
```

- [ ] **Step 4: 통과 확인 + typecheck + build** — `npx vitest run src/shared/supabase.test.ts && npm run typecheck && npm run build`
- [ ] **Step 5: Commit** — `feat(F-Accounts): supabase-js 도입 + chrome.storage 세션 어댑터`

---

### Task 3: 인증 상태 판정 (순수 모듈)

**Files:**
- Create: `src/shared/auth-state.ts`
- Test: `src/shared/auth-state.test.ts`

**Interfaces:**
- Produces: `type AuthState = "signedOut" | "pending" | "blocked" | "approved"`, `deriveAuthState(hasSession: boolean, status?: string): AuthState`, `type ProfileRow = { id: string; email: string; display_name: string; status: string; is_admin: boolean }`, `fetchAuthContext(): Promise<{ state: AuthState; profile: ProfileRow | null }>` (getSupabase로 세션+프로필 조회, 실패 시 signedOut).

- [ ] **Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { deriveAuthState } from "./auth-state";

describe("deriveAuthState", () => {
  it("세션 없으면 signedOut", () => expect(deriveAuthState(false, undefined)).toBe("signedOut"));
  it("세션 + approved → approved", () => expect(deriveAuthState(true, "approved")).toBe("approved"));
  it("세션 + pending → pending", () => expect(deriveAuthState(true, "pending")).toBe("pending"));
  it("세션 + blocked → blocked", () => expect(deriveAuthState(true, "blocked")).toBe("blocked"));
  it("세션은 있는데 프로필을 못 읽었으면 pending 취급 - 잠금이 안전 기본값", () =>
    expect(deriveAuthState(true, undefined)).toBe("pending"));
});
```

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** (deriveAuthState는 위 표 그대로; fetchAuthContext는 `getSupabase().auth.getSession()` + `from("profiles").select().eq("id", uid).single()`) → **Step 4: 통과 + build** → **Step 5: Commit** `feat(F-Accounts): 인증 상태 판정 모듈`

---

### Task 4: 옵션 페이지 로그인/가입/대기 UI

**Files:**
- Create: `src/options/account-ui.tsx` (기존 `auth-ui.tsx`는 네이버 검색광고용이므로 건드리지 않는다 — 이름 충돌 주의)
- Modify: `src/options/Options.tsx` (최상단에 계정 카드 삽입)

**Interfaces:**
- Consumes: Task 2 `getSupabase`, Task 3 `fetchAuthContext`/`AuthState`.
- Produces: `<AccountCard onAuthChange={(state: AuthState) => void} />` — 로그인 폼(이메일/비밀번호), 가입 폼, 상태별 화면: pending "가입 확인 중이에요. 관리자 승인 후 사용할 수 있어요", blocked "사용이 중지된 계정이에요", approved 이메일 + 로그아웃 버튼.

- [ ] **Step 1: 구현** — `getSupabase().auth.signUp({ email, password })` / `signInWithPassword` / `signOut`. 에러 문구는 한글 매핑: `Invalid login credentials` → "이메일 또는 비밀번호가 맞지 않아요", `User already registered` → "이미 가입된 이메일이에요", 그 외 → "잠시 후 다시 시도해 주세요". 이메일 확인 메일은 사용하지 않음(콘솔 Auth 설정에서 Confirm email 끔 — Step 3에서 확인).
- [ ] **Step 2: build + 수동 확인** — 옵션 페이지에서 가입 → "가입 확인 중" 화면. Supabase 콘솔에서 status를 approved로 바꾸면 새로고침 후 로그인 상태 카드.
- [ ] **Step 3: Supabase 콘솔 설정** — Auth > Sign In / Up에서 "Confirm email" OFF (사내 도구 — 메일 인프라 없이).
- [ ] **Step 4: Commit** — `feat(F-Accounts): 옵션 페이지 가입/로그인/승인 대기 UI`

---

### Task 5: 전면 잠금 게이트

**Files:**
- Create: `src/shared/auth-gate.ts`
- Modify: `src/features/bid/index.ts` (콘텐츠 스크립트 진입점 — 각 기능 init 호출 전에 게이트), `src/popup/` 진입 컴포넌트, `src/options/Options.tsx` (계정 카드 제외한 나머지 섹션 숨김)

**Interfaces:**
- Consumes: Task 3 `fetchAuthContext`.
- Produces: `requireApproved(): Promise<boolean>` — approved면 true. 결과를 메모리에 캐시(콘텐츠 스크립트 수명 동안 1회 조회). false면 콘텐츠 스크립트는 **아무 UI도 주입하지 않고 조용히 종료**(광고관리자 화면을 안내문으로 가리지 않는다), popup/options는 "로그인이 필요해요. 설정에서 로그인해 주세요" 안내 + 설정 열기 버튼.

- [ ] **Step 1: 구현** — bid/index.ts 최상단: `if (!(await requireApproved())) return;`. popup: 미승인이면 안내 화면만 렌더.
- [ ] **Step 2: build + 수동 확인** — 로그아웃 상태에서 광고관리자 접속 → 오버레이 미주입. 로그인(approved) 후 정상 동작.
- [ ] **Step 3: Commit** — `feat(F-Accounts): 미로그인/미승인 전면 잠금`

---

### Task 6: credentials-vault Edge Function (Secret Key 암호화)

**Files:**
- Create: `supabase/functions/credentials-vault/index.ts`

**Interfaces:**
- Produces: `POST /functions/v1/credentials-vault` body `{ action: "save", customerId, accessLicense, secretKey }` → 암호화해 `credentials` upsert. `{ action: "load" }` → `{ customerId, accessLicense, secretKey }` (복호화). Authorization: 로그인 JWT. 서버 env `VAULT_KEY`(32바이트 base64), `SUPABASE_SERVICE_ROLE_KEY` 사용.

- [ ] **Step 1: 구현** — JWT 검증은 `createClient(url, anonKey, { global: { headers: { Authorization } } })`로 유저 컨텍스트 클라이언트를 만들어 `auth.getUser()` + profiles.status 확인. 암호화는 AES-GCM:

```ts
import { createClient } from "npm:@supabase/supabase-js@2";

const VAULT_KEY = Deno.env.get("VAULT_KEY") ?? ""; // base64 32바이트
async function key(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(VAULT_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}
async function open(sealed: string): Promise<string> {
  const buf = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, await key(), buf.slice(12));
  return new TextDecoder().decode(plain);
}
```

CORS는 brief-compose와 동일 패턴. DB 접근은 service role 클라이언트로 `credentials` upsert/select (user_id = 검증된 uid).

- [ ] **Step 2: 배포 + 시크릿** — `openssl rand -base64 32`로 키 생성 → `supabase secrets set VAULT_KEY=<값>` → `supabase functions deploy credentials-vault --no-verify-jwt`
- [ ] **Step 3: 검증** — 옵션 페이지 콘솔에서 fetch로 save → load 왕복이 원문을 돌려주는지, 다른 유저 토큰으로는 자기 것만 나오는지.
- [ ] **Step 4: Commit** — `feat(F-Accounts): credentials-vault - Secret Key 암호화 저장/조회`

---

### Task 7: 서버 스토어 모듈 (meta/groups CRUD)

**Files:**
- Create: `src/shared/server-store.ts`
- Test: `src/shared/server-store.test.ts` (행↔모델 변환 순수 함수만)

**Interfaces:**
- Consumes: Task 2 `getSupabase`, `@/types/storage`의 `MultiAccountUserMeta`/`MultiAccountGroup`.
- Produces:
  - `rowToMeta(row): MultiAccountUserMeta` / `metaToRow(userId, m, added, addedOrder)` (순수)
  - `rowToGroup(row): MultiAccountGroup` / `groupToRow(userId, g)` (순수)
  - `pullAll(): Promise<{ metaMap: UserMetaMap; groups: MultiAccountGroup[]; addedList: number[] }>`
  - `pushMeta(m: MultiAccountUserMeta, added: boolean, order: number)`, `pushGroups(groups: MultiAccountGroup[])`, `deleteMeta(adAccountNo)` — 서버 먼저, 성공 시 로컬 캐시 갱신은 호출부(Task 9) 책임.

- [ ] **Step 1: 실패 테스트** (변환 왕복):

```ts
import { describe, it, expect } from "vitest";
import { rowToMeta, metaToRow, rowToGroup, groupToRow } from "./server-store";

describe("row 변환", () => {
  it("meta 왕복 - 모든 필드 보존", () => {
    const m = { adAccountNo: 123, displayName: "별칭", favorite: true, bizMoneyThreshold: 10000,
      brandSearchDaysThreshold: 7, changeWatch: true, targetRoas: 800 };
    const row = metaToRow("uid", m, true, 2);
    expect(row).toMatchObject({ user_id: "uid", ad_account_no: 123, added: true, added_order: 2 });
    expect(rowToMeta(row)).toEqual(m);
  });
  it("group 왕복", () => {
    const g = { id: "g1", name: "팀A", order: 1, accountNos: [1, 2] };
    expect(rowToGroup(groupToRow("uid", g))).toEqual(g);
  });
});
```

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** (meta jsonb에는 adAccountNo 제외 필드만; rowToMeta가 ad_account_no를 되붙임) → **Step 4: 통과 + build** → **Step 5: Commit** `feat(F-Accounts): 서버 스토어 - account_meta/groups CRUD`

---

### Task 8: 로컬 → 서버 마이그레이션

**Files:**
- Create: `src/shared/migrate-local.ts`
- Test: `src/shared/migrate-local.test.ts`

**Interfaces:**
- Consumes: Task 6 vault, Task 7 server-store, `@/features/multi-account/multi-account-storage`(loadAllUserMeta/loadGroups/loadAddedList), `@/shared/searchad`(loadCredentials).
- Produces: `decideMigration(serverHasData: boolean): "upload" | "download"` (순수), `runMigrationOnce(): Promise<void>` — 로그인 직후 호출. `migrated_v1` 플래그를 chrome.storage에 남겨 재실행 방지. 완료 시 `brief_token` 삭제.

- [ ] **Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { decideMigration } from "./migrate-local";

describe("decideMigration", () => {
  it("서버가 비어 있으면 로컬을 올린다", () => expect(decideMigration(false)).toBe("upload"));
  it("서버에 데이터가 있으면 서버가 이긴다 - 로컬을 덮는다", () => expect(decideMigration(true)).toBe("download"));
});
```

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** — serverHasData = `pullAll()` 결과에 meta/groups/credentials 중 하나라도 존재. upload: 로컬 것 push + vault save. download: pullAll 결과로 로컬 키 덮어쓰기. 마지막에 `chrome.storage.local.set({ migrated_v1: true })` + `chrome.storage.local.remove("brief_token")`.
- [ ] **Step 4: 통과 + build** → **Step 5: 수동 확인** — 기존 데이터 있는 프로필로 첫 로그인 → Supabase 콘솔에서 행 생성 확인 → 다른 브라우저 프로필에서 로그인 → 같은 데이터 표시.
- [ ] **Step 6: Commit** — `feat(F-Accounts): 첫 로그인 시 로컬 데이터 자동 이사 (서버 우선 규칙)`

---

### Task 9: 기존 소비자 전환 (읽기/쓰기 경로 교체)

**Files:**
- Modify: `src/features/multi-account/multi-account-storage.ts` — save 계열(saveAllUserMeta/updateUserMeta/saveGroups/saveAddedList 등)이 서버 push 후 로컬 갱신, load 계열은 로컬 캐시 우선(서버 pull은 로그인 직후 + 대시보드 열 때 1회).
- Modify: `src/shared/searchad.ts:621-627` — `loadCredentials`가 로컬 캐시 없으면 vault load, `saveCredentials`가 vault save 후 로컬 캐시.
- Modify: `src/options/credentials-ui.tsx` — 저장 성공/실패 문구를 서버 반영 기준으로.

**Interfaces:**
- Consumes: Task 7 server-store, Task 6 vault.
- Produces: 기존 함수 시그니처 불변 — 호출부(multi-account.ts, brief.ts, background 등)는 수정 없음.

- [ ] **Step 1: 구현** — 함수 내부만 교체. 네트워크 실패 시: load는 캐시 반환, save는 throw → 호출부 토스트 "저장하지 못했어요. 잠시 후 다시 시도해 주세요"(기존 토스트 패턴).
- [ ] **Step 2: 기존 테스트 통과 확인** — `npx vitest run` 전체 (multi-account 관련 테스트가 있으면 chrome 모킹 유지).
- [ ] **Step 3: build + 수동 확인** — 별칭 수정/그룹 생성이 Supabase 콘솔에 반영되는지.
- [ ] **Step 4: Commit** — `feat(F-Accounts): 설정/그룹/자격증명 읽기쓰기를 서버 경유로 전환`

---

### Task 10: brief-compose JWT 인증 + brief_token 폐기

**Files:**
- Modify: `supabase/functions/brief-compose/index.ts` — `TOKENS` 화이트리스트 제거, JWT 검증으로 교체 (Task 6과 동일 패턴: anon 클라이언트 + `auth.getUser()` + profiles.status === "approved").
- Modify: `src/features/brief/brief-compose.ts:29-33` — `brief_token` 대신 `getSupabase().auth.getSession()`의 access_token을 Bearer로.
- Modify: `src/options/Options.tsx` — "보고 문구 이용 코드" 카드 제거.

**Interfaces:**
- Consumes: Task 2 getSupabase, Task 1 profiles.

- [ ] **Step 1: 서버 수정 + 배포** — `supabase functions deploy brief-compose --no-verify-jwt` (JWT 검증을 함수 안에서 직접 하므로 플래그 유지). `BRIEF_TOKENS` 시크릿은 삭제하지 않고 방치(참조 코드만 제거 — 롤백 대비 1주 후 삭제).
- [ ] **Step 2: 확장 수정 + build**
- [ ] **Step 3: 수동 확인** — approved 계정으로 보고 문구 생성 성공, 로그아웃 상태에선 잠금이라 도달 불가(게이트가 먼저 막음).
- [ ] **Step 4: Commit** — `feat(F-Accounts): 보고 문구 인증을 이용 코드에서 로그인 세션으로 교체`

---

### Task 11: 관리자 탭

**Files:**
- Create: `src/options/admin-ui.tsx`
- Modify: `src/options/Options.tsx` (profile.is_admin일 때만 탭 노출)

**Interfaces:**
- Consumes: Task 2 getSupabase, Task 3 ProfileRow.
- Produces: 가입자 목록 표(이메일/이름/상태/가입일) + 행별 승인/차단 버튼 + 관리자 지정 버튼. 동작은 `from("profiles").update({ status })` (RLS admin 정책이 허용).

- [ ] **Step 1: 구현** — 상태 배지: 대기(회색)/사용 중(초록)/중지(빨강). 자기 자신은 차단 불가(버튼 비활성).
- [ ] **Step 2: 수동 확인** — 관리자 bootstrap: Supabase SQL Editor에서 `update profiles set is_admin = true, status = 'approved' where email = '<사장님 이메일>';` 실행(최초 1회). 관리자 로그인 → 탭 표시 → 일반 계정 승인 → 그 계정으로 확장 사용 가능.
- [ ] **Step 3: build + Commit** — `feat(F-Accounts): 관리자 탭 - 가입 승인/차단`

---

### Task 12: 문서 + 마무리 검증

**Files:**
- Create: `src/features/accounts` 없음 — 공유 모듈이라 `src/shared/CLAUDE.md`에 인증 절 추가
- Modify: 루트 `CLAUDE.md` (공통 Gotchas에 인증 관련), `src/options/data-disclosure.tsx` (수집 데이터 표에 서버 저장 항목 반영), `docs/ROADMAP.md`

- [ ] **Step 1: 문서 갱신** — supabase 프로젝트/테이블/vault 키 관리, "서버가 원본, 로컬은 캐시", 마이그레이션 서버 우선 규칙, anon 키는 공개 안전(RLS 방어) 명시.
- [ ] **Step 2: 전체 검증** — `rm -f tsconfig.*.tsbuildinfo && npm run typecheck && npx vitest run && npm run build`
- [ ] **Step 3: 수동 QA 체크리스트** (테스트 계정 2개: 관리자/일반):
  - 미로그인: 오버레이 미주입, popup 안내, 옵션은 계정 카드만
  - 가입 → 대기 화면 → 관리자 승인 → 전 기능 동작
  - 첫 로그인 마이그레이션: 기존 그룹/별칭/자격증명 그대로 보임
  - 두 번째 PC(다른 크롬 프로필) 로그인: 서버 데이터가 내려옴
  - 차단 계정: 즉시 잠금
  - 보고 문구: 이용 코드 없이 생성 성공
- [ ] **Step 4: Commit** — `docs(F-Accounts): 1단계 완료 - CLAUDE/ROADMAP/공개 문서 갱신`
