-- Callbacks and to-dos now go to Google Tasks instead of calendar blocks. cal_kind says what cal_event_id points to:
-- 'event' (older calendar blocks) or 'task' (a Google Task in the owner's default list).
alter table public.callbacks add column if not exists cal_kind text not null default 'event';
alter table public.tasks     add column if not exists cal_kind text not null default 'event';
create index if not exists callbacks_open_gtask_idx on public.callbacks (owner) where status = 'open' and cal_kind = 'task';
create index if not exists tasks_open_gtask_idx     on public.tasks (owner)     where done = false and cal_kind = 'task';
