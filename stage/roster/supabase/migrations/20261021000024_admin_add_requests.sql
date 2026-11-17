-- Super admins and admins (manage_users) can add companies for another rep and run that rep's add-company
-- requests. The request keeps the rep as owner, so the account claim, batch and leads stay theirs.
drop policy if exists add_requests_select on public.add_requests;
create policy add_requests_select on public.add_requests
  for select to authenticated
  using (public.is_active_member()
         and (owner = auth.uid() or public.has_perm('view_all_meetings') or public.has_perm('manage_users')));

drop policy if exists add_requests_insert on public.add_requests;
create policy add_requests_insert on public.add_requests
  for insert to authenticated
  with check (public.is_active_member()
              and (owner = auth.uid()
                   or (public.has_perm('manage_users')
                       and exists (select 1 from public.profiles p where p.id = owner and p.status = 'active'))));

drop policy if exists add_requests_update on public.add_requests;
create policy add_requests_update on public.add_requests
  for update to authenticated
  using (public.is_active_member()
         and (owner = auth.uid() or public.has_perm('view_all_meetings') or public.has_perm('manage_users')))
  with check (public.is_active_member()
              and (owner = auth.uid() or public.has_perm('view_all_meetings') or public.has_perm('manage_users')));
