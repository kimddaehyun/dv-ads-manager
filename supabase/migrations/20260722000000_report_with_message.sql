-- F-Report "문구 생성" 토글 마지막 상태 저장 (날짜 선택기에서 복원)
alter table public.user_settings
  add column if not exists report_with_message boolean not null default false;
