-- ===================================================================
-- Game Ranker - supporters
--
-- Run this once in the Supabase SQL editor, after social.sql. It is
-- idempotent: running it again is safe and will not drop data.
--
-- Design notes that matter if you ever change this file:
--
--  * Same rule as awards.sql and social.sql: the anon key ships inside the
--    installer, so anyone can query this database directly with whatever the
--    policies allow. That is exactly why the supporter flag is NOT a column
--    on profiles - "update your own profile" would then mean "gild your own
--    profile", and the badge would be worth nothing the first time someone
--    unpacked the installer.
--
--  * public.supporters therefore has RLS on and NO policies at all. RLS with
--    no policy denies everyone, including the anon and authenticated roles
--    the app uses. The only writer is the Buy Me a Coffee webhook function,
--    which runs as service_role - a key that lives in Supabase's own
--    environment and is never shipped, never in git, never in the installer.
--
--  * The table is keyed by donor EMAIL, not by user id, because a donation
--    happens on Buy Me a Coffee where nobody has a Game Ranker account id.
--    That email is the only thread tying the two together, and it must never
--    leave this database: supporter_ids() below joins to auth.users
--    internally and returns nothing but ids the caller already had. There is
--    deliberately no way to ask "what is that person's email" or "who has
--    donated" - only "of these people I can already see, which are
--    supporters".
--
--  * A donation with no matching account is still recorded. If someone
--    donates first and signs up afterwards with the same address, the badge
--    appears the moment they sign in - the join is evaluated on every read,
--    not stamped onto a row once.
-- ===================================================================


-- ------------------------------------------------------------------
-- 1. The supporters themselves
--
-- One row per donor email, not one per donation: a second coffee updates
-- the row rather than adding to it. The running total is kept because it is
-- free to keep and impossible to reconstruct later, not because anything
-- reads it today.
-- ------------------------------------------------------------------
create table if not exists public.supporters (
  email text primary key,
  first_supported_at timestamptz not null default now(),
  last_supported_at timestamptz not null default now(),
  -- Minor units of whatever currency was charged, summed across donations.
  -- Mixed currencies would make this meaningless to display, which is part
  -- of why nothing displays it - the badge is binary.
  total_minor bigint not null default 0,
  -- Set when a donation is refunded or charged back. The badge reads this,
  -- rather than the row being deleted, so a refund leaves a trail.
  revoked_at timestamptz
);

-- No policies on purpose. See the header: this is a service_role-only table.
alter table public.supporters enable row level security;

-- Belt and braces. RLS already denies these roles, but a future policy added
-- in haste cannot hand out a write path that was never granted in the first
-- place.
revoke all on table public.supporters from anon, authenticated;


-- ------------------------------------------------------------------
-- 2. Idempotency
--
-- Buy Me a Coffee retries a webhook it did not get a 2xx for, and a retry
-- must not count as a second coffee. Every event id is recorded before the
-- money is, and a repeat is a no-op that still answers 200 - answering
-- anything else would just earn another retry.
-- ------------------------------------------------------------------
create table if not exists public.supporter_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

alter table public.supporter_events enable row level security;
revoke all on table public.supporter_events from anon, authenticated;


-- ------------------------------------------------------------------
-- 3. Recording a donation
--
-- The webhook could write these two tables directly - service_role bypasses
-- RLS - but then the dedupe rule would live in TypeScript in an edge
-- function, where a redeploy could quietly lose it. It lives here instead,
-- and the webhook's whole database vocabulary is this one function.
--
-- Returns what it did, so the function logs say something useful:
-- 'recorded' | 'duplicate' | 'revoked'.
-- ------------------------------------------------------------------
create or replace function public.record_support(
  p_email text,
  p_minor bigint,
  p_at timestamptz,
  p_event_id text,
  p_refund boolean default false
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_at timestamptz := coalesce(p_at, now());
begin
  if v_email = '' or v_email is null then
    raise exception 'A donation needs an email to attach to.';
  end if;
  if p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'A donation needs an event id to be idempotent on.';
  end if;

  -- The dedupe gate. Doing this first means a retry cannot reach the money
  -- below even if everything after it changes.
  insert into public.supporter_events (event_id) values (p_event_id)
  on conflict (event_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  if p_refund then
    update public.supporters
      set revoked_at = v_at
      where email = v_email;
    return 'revoked';
  end if;

  insert into public.supporters (email, first_supported_at, last_supported_at, total_minor)
  values (v_email, v_at, v_at, greatest(coalesce(p_minor, 0), 0))
  on conflict (email) do update
    set last_supported_at = greatest(public.supporters.last_supported_at, v_at),
        total_minor = public.supporters.total_minor + greatest(coalesce(p_minor, 0), 0),
        -- Donating again after a refund is a fresh start, not a permanently
        -- marked record.
        revoked_at = null;

  return 'recorded';
end;
$$;

revoke all on function public.record_support(text, bigint, timestamptz, text, boolean) from public;
revoke all on function public.record_support(text, bigint, timestamptz, text, boolean) from anon, authenticated;
grant execute on function public.record_support(text, bigint, timestamptz, text, boolean) to service_role;


-- ------------------------------------------------------------------
-- 4. Reading the badge
--
-- SECURITY DEFINER because the join it does - auth.users to supporters - is
-- across two tables no ordinary user may read a single row of. What comes
-- back is a subset of the ids that went in, and nothing else. No email, no
-- amount, no date, and no way to run it without already knowing exactly whose
-- badge you are asking about.
--
-- The array cap is what stops this being an enumeration tool: without it,
-- a caller could pass every id it has ever seen and get back a list of
-- everyone who has ever donated. 200 is comfortably more than any one screen
-- in the app shows.
-- ------------------------------------------------------------------
create or replace function public.supporter_ids(p_ids uuid[])
returns table (id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id
  from auth.users u
  join public.supporters s on s.email = lower(u.email)
  where auth.uid() is not null
    and p_ids is not null
    and coalesce(array_length(p_ids, 1), 0) between 1 and 200
    and u.id = any (p_ids)
    and s.revoked_at is null;
$$;

revoke all on function public.supporter_ids(uuid[]) from public;
grant execute on function public.supporter_ids(uuid[]) to authenticated;


-- ------------------------------------------------------------------
-- 5. Granting one by hand
--
-- For the cases the webhook cannot cover: someone donates with a different
-- address than they signed up with, pays by another route entirely, or
-- deserves one for helping. Not granted to anyone - run it as the owner from
-- the SQL editor:
--
--   select public.grant_support('them@example.com');
--   select public.revoke_support('them@example.com');
--
-- The event id is synthetic so these never collide with a real webhook, and
-- so running the same grant twice is still one grant.
-- ------------------------------------------------------------------
create or replace function public.grant_support(p_email text)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.record_support(
    p_email, 0, now(), 'manual:' || lower(btrim(p_email)) || ':' || to_char(now(), 'YYYYMMDDHH24MISS'), false
  );
$$;

create or replace function public.revoke_support(p_email text)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.record_support(
    p_email, 0, now(), 'manual-revoke:' || lower(btrim(p_email)) || ':' || to_char(now(), 'YYYYMMDDHH24MISS'), true
  );
$$;

revoke all on function public.grant_support(text) from public;
revoke all on function public.grant_support(text) from anon, authenticated;
revoke all on function public.revoke_support(text) from public;
revoke all on function public.revoke_support(text) from anon, authenticated;
