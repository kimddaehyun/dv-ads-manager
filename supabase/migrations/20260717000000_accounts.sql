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
