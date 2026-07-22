-- 20260722010000 보정: service_role은 RLS만 우회하고 함수 execute 권한은 우회 못 한다.
-- revoke ... from public 이후 Edge Function(service_role)의 bump_usage 호출이 막히므로 명시 grant.
grant execute on function public.bump_usage to service_role;
