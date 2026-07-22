-- 알림 사용 계정 수 보정: 알림은 "내 계정 목록에 추가된(added)" 계정에서만 실제로 동작한다
-- (changeWatchTick이 추가 목록만 스캔). 추가 여부를 안 보면 디렉터리 전 계정에 남은
-- 과거 일괄 설정 흔적까지 세어 742 같은 전체 계정 수가 나온다.
create or replace function public.admin_alert_counts()
returns table (user_id uuid, bizmoney_accounts int, brand_accounts int, change_watch_accounts int)
language sql security definer set search_path = public as $$
  select am.user_id,
    count(*) filter (where am.meta ? 'bizMoneyThreshold')::int,
    count(*) filter (where am.meta ? 'brandSearchDaysThreshold')::int,
    count(*) filter (where (am.meta->>'changeWatch')::boolean is true)::int
  from account_meta am
  where public.is_admin() and am.added
  group by am.user_id
$$;
