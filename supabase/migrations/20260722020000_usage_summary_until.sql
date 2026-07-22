-- 사용량 조회 기간 직접 지정 지원: 하한만 받던 admin_usage_summary에 상한(p_until) 추가.
drop function public.admin_usage_summary(date);
create function public.admin_usage_summary(p_since date, p_until date)
returns table (user_id uuid, event text, total_count bigint, total_tokens_in bigint, total_tokens_out bigint)
language sql security definer set search_path = public as $$
  -- sum(bigint)은 numeric을 반환해 선언된 bigint와 어긋난다 — 캐스팅 필수 (codex P1).
  select u.user_id, u.event, sum(u.count)::bigint, sum(u.tokens_in)::bigint, sum(u.tokens_out)::bigint
  from usage_daily u
  where public.is_admin() and u.day between p_since and p_until
  group by u.user_id, u.event
$$;
