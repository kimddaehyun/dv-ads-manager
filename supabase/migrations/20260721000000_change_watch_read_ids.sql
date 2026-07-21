-- 알림 1건씩 읽음 처리. 그전엔 "이 시각까지 읽음" 기준선(read_*_up_to)뿐이라 하나만
-- 읽으면 그보다 오래된 같은 종류 알림까지 전부 읽음이 됐다.
-- read_ids: 변경이력은 이벤트 id, 광고주센터 알림은 'naver:<제목>'(피드에 id가 없음).
alter table public.change_watch_state
  add column if not exists read_ids jsonb not null default '[]';
