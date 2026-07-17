-- 관리자 계정 삭제 RPC. 클라이언트는 auth.users를 직접 못 지우므로 security definer로 제공.
-- auth.users 삭제가 profiles -> credentials/account_meta/account_groups까지 cascade로 정리한다.
create function public.admin_delete_user(target uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if target = auth.uid() then
    raise exception 'cannot delete self';
  end if;
  delete from auth.users where id = target;
end $$;

-- 기본 public 실행 권한을 회수하고 로그인 사용자에게만 (내부에서 is_admin 재확인)
revoke all on function public.admin_delete_user(uuid) from public;
grant execute on function public.admin_delete_user(uuid) to authenticated;
