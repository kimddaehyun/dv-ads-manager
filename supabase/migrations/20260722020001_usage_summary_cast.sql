-- 20260722020000 보정: sum(bigint)은 numeric을 반환해 선언된 bigint와 어긋나
-- 호출 시 "structure of query does not match" 에러가 난다 — 캐스팅해 재생성.
create or replace function public.admin_usage_summary(p_since date, p_until date)
returns table (user_id uuid, event text, total_count bigint, total_tokens_in bigint, total_tokens_out bigint)
language sql security definer set search_path = public as $$
  select u.user_id, u.event, sum(u.count)::bigint, sum(u.tokens_in)::bigint, sum(u.tokens_out)::bigint
  from usage_daily u
  where public.is_admin() and u.day between p_since and p_until
  group by u.user_id, u.event
$$;
