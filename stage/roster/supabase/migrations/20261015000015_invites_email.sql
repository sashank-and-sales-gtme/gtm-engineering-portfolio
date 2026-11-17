-- Email invitations. invited_at marks a profile created by an emailed invite; signed_in_at is copied from Auth on
-- every sign-in, so the Users table can show "Invite sent" until the person actually arrives.
alter table public.profiles add column if not exists invited_at timestamptz;
alter table public.profiles add column if not exists signed_in_at timestamptz;

create or replace function public.track_sign_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
    update public.profiles set signed_in_at = new.last_sign_in_at where id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.track_sign_in() from public, anon, authenticated;
drop trigger if exists track_sign_in on auth.users;
create trigger track_sign_in after update of last_sign_in_at on auth.users for each row execute function public.track_sign_in();

-- Everyone who has signed in before now counts as arrived.
update public.profiles p set signed_in_at = u.last_sign_in_at from auth.users u where u.id = p.id and p.signed_in_at is null;
