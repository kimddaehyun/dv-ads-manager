-- 관리자 사용량 요약: 클라이언트에서 usage_daily를 그대로 select하면 PostgREST 페이지
-- 한도(1,000행)에서 조용히 잘려 합계가 축소된다(코덱스 리뷰 지적). 서버에서 합산해 반환.
create function public.admin_usage_summary(p_since date)
returns table (user_id uuid, event text, total_count bigint, total_tokens_in bigint, total_tokens_out bigint)
language sql security definer set search_path = public as $$
  -- sum(bigint)은 numeric을 반환해 선언된 bigint와 어긋난다 — 캐스팅 필수 (codex P1).
  select u.user_id, u.event, sum(u.count)::bigint, sum(u.tokens_in)::bigint, sum(u.tokens_out)::bigint
  from usage_daily u
  where public.is_admin() and u.day >= p_since
  group by u.user_id, u.event
$$;
