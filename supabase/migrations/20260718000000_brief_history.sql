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
