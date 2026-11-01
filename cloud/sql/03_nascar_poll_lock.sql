-- Adds a single-worker lease to prevent overlapping NASCAR poll invocations.
create table if not exists public.nascar_poll_lock (
  id integer primary key check (id = 1),
  lock_token uuid,
  lease_until timestamptz
);
insert into public.nascar_poll_lock (id, lock_token, lease_until)
values (1, null, null)
on conflict (id) do nothing;
revoke all on public.nascar_poll_lock from public, anon, authenticated;

create or replace function public.claim_nascar_poll_lock()
returns uuid language plpgsql security definer set search_path = public
as $$
declare claimed_token uuid := gen_random_uuid();
begin
  update public.nascar_poll_lock
     set lock_token = claimed_token, lease_until = now() + interval '45 seconds'
   where id = 1 and (lease_until is null or lease_until < now());
  if found then return claimed_token; end if;
  return null;
end;
$$;

create or replace function public.release_nascar_poll_lock(p_token uuid)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  update public.nascar_poll_lock set lock_token = null, lease_until = null
   where id = 1 and lock_token = p_token;
  return found;
end;
$$;

revoke all on function public.claim_nascar_poll_lock() from public, anon, authenticated;
revoke all on function public.release_nascar_poll_lock(uuid) from public, anon, authenticated;
grant execute on function public.claim_nascar_poll_lock() to service_role;
grant execute on function public.release_nascar_poll_lock(uuid) to service_role;