-- 승인제 -> 가입 즉시 사용(2026-07-17 결정). 가입하면 바로 approved, 관리자는 차단만 한다.
-- pending 상태값 자체는 남겨둔다(과거 가입자·차단 해제 흐름과의 호환).
alter table public.profiles alter column status set default 'approved';

-- 이미 대기 중인 가입자가 있다면 소급 적용 (차단된 계정은 그대로).
update public.profiles set status = 'approved' where status = 'pending';
