-- F-Accounts — 이관 완료 마커.
-- "서버에 데이터가 있는지"로 방향을 정하면 부분 업로드 후 재시도가 download로 뒤집혀
-- 로컬을 지워버린다. 서버가 명시적으로 "이관 완료"를 기록한 경우에만 download.
alter table public.profiles add column migrated_at timestamptz;

-- security definer RPC — 사용자가 profiles의 status/is_admin은 못 건드리게
-- migrated_at만 본인 행에 기록하는 전용 함수.
create function public.mark_migrated()
returns void
language sql
security definer
set search_path = public
as $$
  update profiles set migrated_at = now() where id = auth.uid()
$$;
