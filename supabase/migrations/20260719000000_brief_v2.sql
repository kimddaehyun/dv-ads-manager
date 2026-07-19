-- 보고 구조 개편 (선택 우선 흐름): brief_history 확장 + AE 개인 말투(brief_tone).
-- 기존 upsert-on-copy 의미 유지 — 컬럼 추가만, 기본값으로 구버전 클라이언트도 안전.

alter table public.brief_history
  add column report_type text not null default 'post_action_report',   -- 사후보고 | 사전제안(pre_action_proposal)
  add column tone text not null default 'detailed',
  add column ai_draft text not null default '',                        -- compose 직후 초안 (message는 최종 편집본)
  add column included_previous_history boolean not null default false,
  add column included_change_history boolean not null default false,
  add column related_change_ids jsonb not null default '[]',           -- 반영한 변경이력 이벤트 id 배열
  add column sent_status text not null default 'copied';               -- copied | saved_only

-- AE 개인 말투: 붙여넣은 채팅 이력 원문 + AI가 뽑은 말투 프롬프트. 사용자당 1행.
create table public.brief_tone (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  samples text not null default '',
  tone_prompt text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.brief_tone enable row level security;
create policy "own rows" on public.brief_tone for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
