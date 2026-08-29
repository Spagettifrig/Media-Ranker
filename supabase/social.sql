-- ===================================================================
-- Game Ranker - usernames and friends
--
-- Run this once in the Supabase SQL editor, after awards.sql. It is
-- idempotent: running it again is safe and will not drop data.
--
-- Design notes that matter if you ever change this file:
--
--  * Same rule as awards.sql: the anon key ships inside the installer, so
--    anyone can query this database directly with whatever the policies
--    allow. Every rule below is a policy or a SECURITY DEFINER function.
--    The app only decides what to *draw*.
--
--  * The reviews SELECT policy is EXTENDED, never replaced. Postgres OR's
--    permissive policies for the same command together, so the policy added
--    here can only ever widen what a friend may see - it cannot silently
--    weaken the existing public/private/inherit rules, which live in the
--    base schema and are not reproduced in this repo. Do not "tidy" this
--    into one combined policy without having the original in front of you.
--
--  * Friendship is one row per unordered pair, not two mirrored rows. That
--    makes "are we friends" a single lookup and makes it impossible for the
--    two directions to disagree, at the cost of every read having to check
--    both column orders - which is what are_friends() is for.
--
--  * The membership helpers are SECURITY DEFINER because a friend request
--    inherently has to read a row about someone you cannot otherwise see:
--    finding a user by username, and listing who has asked to be your
--    friend, both cross the profiles-visibility boundary by definition.
--    They only ever return (id, username, display_name) - never an email,
--    never a review, never anything that is not already on a profile card.
-- ===================================================================


-- ------------------------------------------------------------------
-- 1. Usernames
--
-- The column already exists and is already unique - ensureProfile() in
-- electron/supabase.js relies on catching the unique violation. What is
-- missing is a *shape*: without it a username can be empty, 300 characters,
-- or differ from another only by case, none of which can be typed into a
-- search box with any confidence.
-- ------------------------------------------------------------------

-- Case-insensitive uniqueness. Usernames generated so far are lowercased at
-- the source (usernameFromEmail), so this should not conflict with existing
-- rows; if it does, this statement fails and nothing else in the file has
-- been applied yet - resolve the duplicate and re-run.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- NOT VALID on purpose: it constrains everything written from now on
-- without rejecting any row already in the table. Nothing here is worth
-- locking an existing user out of their own profile over.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_username_format'
  ) then
    alter table public.profiles
      add constraint profiles_username_format
      check (username ~ '^[a-z0-9_]{3,24}$') not valid;
  end if;
end
$$;


-- ------------------------------------------------------------------
-- 2. Friendships
-- ------------------------------------------------------------------
create table if not exists public.friendships (
  requester_id uuid not null references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester_id, addressee_id),
  constraint friendships_no_self check (requester_id <> addressee_id)
);

-- One row per unordered pair: without this, A->B and B->A could both exist
-- as separate pending requests and the two would have to be reconciled
-- everywhere they are read.
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- The lookup every read does: "everything involving me".
create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);
create index if not exists friendships_requester_idx on public.friendships (requester_id, status);

alter table public.friendships enable row level security;

-- Read: only rows you are actually party to. There is deliberately no way
-- to enumerate other people's friendships.
drop policy if exists "see your own friendships" on public.friendships;
create policy "see your own friendships"
  on public.friendships for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Either side can walk away: declining, cancelling a request you sent, and
-- unfriending are all the same act - remove the row.
drop policy if exists "leave a friendship" on public.friendships;
create policy "leave a friendship"
  on public.friendships for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Deliberately no INSERT or UPDATE policy. RLS with no policy denies
-- everyone, so the only ways in are send_friend_request() and
-- respond_friend_request() below, which validate first. In particular this
-- makes it impossible to INSERT a row that is already 'accepted', which
-- would otherwise be a one-statement way to read a stranger's whole board.


-- ------------------------------------------------------------------
-- 3. Membership test
--
-- SECURITY DEFINER so it can be called from the reviews policy without the
-- caller needing to see the friendships row itself, and so a future
-- restriction on friendships cannot silently break review visibility.
-- ------------------------------------------------------------------
create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and (
        (f.requester_id = p_a and f.addressee_id = p_b) or
        (f.requester_id = p_b and f.addressee_id = p_a)
      )
  );
$$;

revoke all on function public.are_friends(uuid, uuid) from public;
grant execute on function public.are_friends(uuid, uuid) to authenticated;


-- ------------------------------------------------------------------
-- 4. Friends can read each other's reviews
--
-- ADDITIVE. See the header note: this sits alongside whatever the base
-- schema's SELECT policy already allows, and the two are OR'd. A friend
-- therefore sees a full board even with nothing in common and even when the
-- profile's default visibility is private - which is the whole point - and
-- a non-friend's view is completely unchanged by this file.
--
-- `deleted_at is null` is repeated here rather than assumed: this policy has
-- to stand on its own, because it is reached by OR and cannot rely on any
-- condition in the policy next to it.
-- ------------------------------------------------------------------
drop policy if exists "friends see each other's reviews" on public.reviews;
create policy "friends see each other's reviews"
  on public.reviews for select
  using (deleted_at is null and public.are_friends(auth.uid(), user_id));


-- ------------------------------------------------------------------
-- 5. Finding people
--
-- Prefix-first search on username and display name. SECURITY DEFINER
-- because finding someone you have never met necessarily means reading a
-- profile row you have no other reason to be allowed to read.
--
-- `friend_status` comes back with each hit so the UI can draw the right
-- button without a second round trip per result:
--   'none' | 'pending_out' | 'pending_in' | 'friends'
-- ------------------------------------------------------------------
-- A prefix pattern with the LIKE metacharacters neutralised. Without this,
-- `%` is a wildcard the searcher can type: a two-character search for "%%"
-- would match every row and turn "find my friend" into "list every user of
-- this app". `_` matters too - it is legal in a username, so a literal one
-- must not quietly match any character.
create or replace function public.like_prefix(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select replace(replace(replace(btrim(p_text), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

create or replace function public.search_profiles(p_query text)
returns table (
  id uuid,
  username text,
  display_name text,
  friend_status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.username,
    p.display_name,
    case
      when f.status = 'accepted' then 'friends'
      when f.status = 'pending' and f.requester_id = auth.uid() then 'pending_out'
      when f.status = 'pending' then 'pending_in'
      else 'none'
    end as friend_status
  from public.profiles p
  left join public.friendships f
    on (f.requester_id = auth.uid() and f.addressee_id = p.id)
    or (f.addressee_id = auth.uid() and f.requester_id = p.id)
  where auth.uid() is not null
    -- Never list the searcher back to themselves.
    and p.id <> auth.uid()
    and length(btrim(p_query)) >= 2
    -- ILIKE's default escape character is the backslash that like_prefix()
    -- doubles, so no ESCAPE clause is needed here.
    and (
      p.username ilike public.like_prefix(p_query) or
      p.display_name ilike public.like_prefix(p_query)
    )
  -- Exact match first, then prefix matches alphabetically, so typing
  -- someone's whole username always puts them at the top.
  order by (lower(p.username) = lower(btrim(p_query))) desc, p.username
  limit 20;
$$;

revoke all on function public.like_prefix(text) from public;
grant execute on function public.like_prefix(text) to authenticated;

revoke all on function public.search_profiles(text) from public;
grant execute on function public.search_profiles(text) to authenticated;


-- ------------------------------------------------------------------
-- 6. Sending, answering and ending
-- ------------------------------------------------------------------

-- Returns the resulting status, so the caller does not have to re-query.
-- Requesting someone who has already requested you accepts instead of
-- creating a second row - two people reaching for each other at the same
-- time is a success, not a conflict.
create or replace function public.send_friend_request(p_target uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_existing public.friendships;
begin
  if v_me is null then
    raise exception 'Not signed in.';
  end if;
  if p_target is null or p_target = v_me then
    raise exception 'You cannot add yourself.';
  end if;
  if not exists (select 1 from public.profiles where id = p_target) then
    raise exception 'No such user.';
  end if;

  select * into v_existing
  from public.friendships f
  where (f.requester_id = v_me and f.addressee_id = p_target)
     or (f.requester_id = p_target and f.addressee_id = v_me);

  if found then
    if v_existing.status = 'accepted' then
      return 'friends';
    end if;
    -- They asked first: treat this as the acceptance it plainly is.
    if v_existing.addressee_id = v_me then
      update public.friendships
        set status = 'accepted', responded_at = now()
        where requester_id = v_existing.requester_id
          and addressee_id = v_existing.addressee_id;
      return 'friends';
    end if;
    return 'pending_out';
  end if;

  insert into public.friendships (requester_id, addressee_id, status)
  values (v_me, p_target, 'pending');
  return 'pending_out';
end;
$$;

revoke all on function public.send_friend_request(uuid) from public;
grant execute on function public.send_friend_request(uuid) to authenticated;


-- Only the addressee may answer, which is what stops a requester from
-- accepting on their target's behalf.
create or replace function public.respond_friend_request(p_requester uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not signed in.';
  end if;

  if not exists (
    select 1 from public.friendships
    where requester_id = p_requester and addressee_id = v_me and status = 'pending'
  ) then
    raise exception 'No pending request from that user.';
  end if;

  if p_accept then
    update public.friendships
      set status = 'accepted', responded_at = now()
      where requester_id = p_requester and addressee_id = v_me;
    return 'friends';
  end if;

  delete from public.friendships
    where requester_id = p_requester and addressee_id = v_me;
  return 'none';
end;
$$;

revoke all on function public.respond_friend_request(uuid, boolean) from public;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;


-- ------------------------------------------------------------------
-- 7. Reading your own lists
--
-- SECURITY DEFINER for the profile join only: the friendships rows
-- themselves are already readable under the SELECT policy above, but the
-- profiles rows on the other end of them are not necessarily.
-- ------------------------------------------------------------------
create or replace function public.list_friends()
returns table (
  id uuid,
  username text,
  display_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.username, p.display_name
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where auth.uid() is not null
    and f.status = 'accepted'
    and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by p.username;
$$;

revoke all on function public.list_friends() from public;
grant execute on function public.list_friends() to authenticated;


-- Both directions in one call: what you have been asked, and what you have
-- asked for and are still waiting on.
create or replace function public.list_friend_requests()
returns table (
  id uuid,
  username text,
  display_name text,
  direction text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.username,
    p.display_name,
    case when f.addressee_id = auth.uid() then 'incoming' else 'outgoing' end as direction,
    f.created_at
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where auth.uid() is not null
    and f.status = 'pending'
    and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  order by f.created_at desc;
$$;

revoke all on function public.list_friend_requests() from public;
grant execute on function public.list_friend_requests() to authenticated;


-- Unfriending is a plain DELETE under the "leave a friendship" policy, so
-- it needs no function of its own - see removeFriend() in supabase.js.
