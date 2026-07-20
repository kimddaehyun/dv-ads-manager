-- 사용자 설정 한 덩어리. 그전엔 chrome.storage.local 전용이라 PC를 바꾸면 초기화됐다.
-- 특히 change_watch_actors가 비면 외부 수정 알림이 조용히 꺼져 "알림이 안 온다"로 보인다.
-- 항목별 컬럼 대신 단일 행(jsonb 아닌 명시 컬럼)으로 둬서 설정이 늘어도 테이블 추가가 없다.
create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  change_watch_actors text[] not null default '{}',   -- 알림 제외할 변경자 표시명
  agency_manager_nos bigint[] not null default '{}',  -- 대행권 점검 기준 관리 계정 번호
  platform_sa boolean not null default true,          -- 검색광고 표시
  platform_da boolean not null default true,          -- 디스플레이광고 표시
  report_author text not null default '',             -- 리포트 담당자명 (마지막 입력)
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
create policy "own rows" on public.user_settings for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
