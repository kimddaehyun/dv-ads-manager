-- 가입 시 이름을 받는다. 일반 회원은 profiles를 직접 수정할 수 없으므로(관리자만 update),
-- 가입 요청의 metadata(raw_user_meta_data.display_name)를 트리거가 프로필에 옮겨 적는다.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end $$;
