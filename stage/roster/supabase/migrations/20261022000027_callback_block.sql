-- Google Tasks keeps only the date, so each callback also gets a short timed Calendar event at the callback time.
-- cal_event_id stays the Google Task (ticked off from Google); cal_block_id is the calendar event.
alter table public.callbacks add column if not exists cal_block_id text;
