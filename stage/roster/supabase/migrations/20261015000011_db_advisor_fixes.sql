-- Database advisor fixes (October 15, 2026).
--
-- 1. RLS policies call auth.uid() once per query instead of once per row: every policy that uses a bare
--    auth.uid() is rewritten to (select auth.uid()). Policies already in that form are left alone.
-- 2. rep_settings: the FOR ALL write policy also granted SELECT, so reads ran two policies. Split into
--    insert, update and delete.
-- 3. invites.role foreign key gets a covering index.
-- 4. setting_text is only used inside SECURITY DEFINER triggers; signed-in users no longer call it directly.
--
-- Intentional and left as is: service-role-only tables with RLS and no policies (research_queue,
-- company_research, post_call_wake); RLS helper functions callable by authenticated (has_perm, my_role,
-- is_active_member, my_account_companies) because policies evaluate them as the signed-in user; RPCs the app
-- calls that check permissions inside (undo_call, roster_progress, list_cron_jobs, set_cron_job_active).

do $$
declare
  p record;
  v_using text;
  v_check text;
  v_sql text;
begin
  for p in
    select tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') ~ '(?<!SELECT )auth\.uid\(\)' or coalesce(with_check, '') ~ '(?<!SELECT )auth\.uid\(\)')
  loop
    v_using := regexp_replace(p.qual, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    v_check := regexp_replace(p.with_check, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    v_sql := format('alter policy %I on public.%I', p.policyname, p.tablename);
    if v_using is not null then
      v_sql := v_sql || format(' using (%s)', v_using);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;
    execute v_sql;
  end loop;
end
$$;

drop policy if exists rep_settings_write on public.rep_settings;
drop policy if exists rep_settings_insert on public.rep_settings;
drop policy if exists rep_settings_update on public.rep_settings;
drop policy if exists rep_settings_delete on public.rep_settings;
create policy rep_settings_insert on public.rep_settings for insert to authenticated
  with check (public.is_active_member() and public.has_perm('manage_users'));
create policy rep_settings_update on public.rep_settings for update to authenticated
  using (public.is_active_member() and public.has_perm('manage_users'))
  with check (public.is_active_member() and public.has_perm('manage_users'));
create policy rep_settings_delete on public.rep_settings for delete to authenticated
  using (public.is_active_member() and public.has_perm('manage_users'));

create index if not exists invites_role_idx on public.invites(role);

revoke execute on function public.setting_text(text, text, text) from public, anon, authenticated;
grant  execute on function public.setting_text(text, text, text) to service_role;
