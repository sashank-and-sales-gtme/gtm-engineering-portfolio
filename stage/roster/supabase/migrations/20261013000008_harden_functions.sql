-- Security advisor fixes: trigger functions are never called directly, the RLS helpers are only needed by
-- signed-in users, and touch_updated_at gets a fixed search_path.

alter function public.touch_updated_at() set search_path = public;

revoke execute on function public.guard_profiles()        from public, anon, authenticated;
revoke execute on function public.guard_roles()           from public, anon, authenticated;
revoke execute on function public.owner_hubspot_default() from public, anon, authenticated;
revoke execute on function public.touch_updated_at()      from public, anon, authenticated;

revoke execute on function public.my_role()                from public, anon;
revoke execute on function public.has_perm(text)           from public, anon;
revoke execute on function public.is_active_member()       from public, anon;
revoke execute on function public.my_account_companies()   from public, anon;
grant  execute on function public.my_role()                to authenticated, service_role;
grant  execute on function public.has_perm(text)           to authenticated, service_role;
grant  execute on function public.is_active_member()       to authenticated, service_role;
grant  execute on function public.my_account_companies()   to authenticated, service_role;
