-- 계정 이슈 이력(F-ChangeWatch) 서버 보관. 그전엔 chrome.storage.local 전용이라
-- 기기·프로필을 바꾸면 이력이 사라지고 팀원과 공유도 안 됐다.
-- events: [{ id, ts, kind, actor, target, summary }] — 보관 기간(60일)은 클라이언트가 정리.
create table public.change_watch_state (
  user_id uuid not null references public.profiles(id) on delete cascade,
  ad_account_no bigint not null,
  events jsonb not null default '[]',
  scanned_until bigint not null default 0,        -- epoch ms. 다음 조회의 since
  read_budget_up_to bigint not null default 0,    -- epoch ms. 예산 알림 확인 기준
  read_external_up_to bigint not null default 0,  -- epoch ms. 외부 수정 알림 확인 기준
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, ad_account_no)
);

alter table public.change_watch_state enable row level security;
create policy "own rows" on public.change_watch_state for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
