-- 사용자별 사용량 추적 (관리자 전용 조회).
-- 사용자x날짜x이벤트 1행에 횟수/토큰을 누적(upsert) — 개별 호출 로그는 남기지 않는다.
-- 날짜는 KST 기준(사내 사용자 전원 한국).
create table public.usage_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  event text not null,
  count int not null default 0,
  tokens_in bigint not null default 0,  -- AI 이벤트만 사용
  tokens_out bigint not null default 0, -- AI 이벤트만 사용
  primary key (user_id, day, event)
);

alter table public.usage_daily enable row level security;
-- 일반 사용자는 자기 것도 못 본다 — 조회는 관리자만. 쓰기는 아래 함수 경유만(정책 없음 = 직접 쓰기 차단).
create policy "admin read all" on public.usage_daily for select using (public.is_admin());

-- 내부 누적 함수. RLS 우회(security definer)이므로 직접 노출하지 않는다.
create function public.bump_usage(
  p_user_id uuid, p_event text, p_count int, p_tokens_in bigint, p_tokens_out bigint
) returns void
language sql security definer set search_path = public as $$
  insert into usage_daily (user_id, day, event, count, tokens_in, tokens_out)
  values (p_user_id, (now() at time zone 'Asia/Seoul')::date, p_event, p_count, p_tokens_in, p_tokens_out)
  on conflict (user_id, day, event) do update set
    count = usage_daily.count + excluded.count,
    tokens_in = usage_daily.tokens_in + excluded.tokens_in,
    tokens_out = usage_daily.tokens_out + excluded.tokens_out
$$;
revoke execute on function public.bump_usage from public, anon, authenticated;
-- service_role(Edge Function)만 직접 호출 — AI 토큰 기록용.
-- 주의: service_role은 RLS만 우회하고 함수 execute 권한은 우회 못 한다 — 명시 grant 필수.
grant execute on function public.bump_usage to service_role;

-- 확장 클라이언트용: 승인된 본인의 기능 사용 횟수 +1. 이벤트명 화이트리스트로 쓰레기 값 차단.
create function public.track_usage(p_event text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then return; end if;
  if p_event not in ('report_excel','setup_excel','brief_generate','history_report',
                     'bid_change','asset_bulk','agency_check') then
    return;
  end if;
  perform public.bump_usage(auth.uid(), p_event, 1, 0, 0);
end $$;

-- 알림 사용 계정 수 — 추적이 아니라 account_meta 현재 상태를 조회 시점에 집계.
-- 관리자 전용. meta 내용은 노출하지 않고 숫자만 반환.
create function public.admin_alert_counts()
returns table (user_id uuid, bizmoney_accounts int, brand_accounts int, change_watch_accounts int)
language sql security definer set search_path = public as $$
  select am.user_id,
    count(*) filter (where am.meta ? 'bizMoneyThreshold')::int,
    count(*) filter (where am.meta ? 'brandSearchDaysThreshold')::int,
    count(*) filter (where (am.meta->>'changeWatch')::boolean is true)::int
  from account_meta am
  where public.is_admin()
  group by am.user_id
$$;
