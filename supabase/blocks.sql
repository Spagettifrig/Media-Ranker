-- ===================================================================
-- Game Ranker - hiding one title from one person
--
-- Run this once in the Supabase SQL editor, after social.sql. It is
-- idempotent: running it again is safe and will not drop data.
--
-- Design notes that matter if you ever change this file:
--
--  * Every other review policy in this project is PERMISSIVE, and Postgres
--    OR's permissive policies together - which means none of them can ever
--    take access away. Hiding a row is the opposite operation, so the policy
--    below is RESTRICTIVE: restrictive policies are AND'd with the OR'd set,
--    so this one can veto a read that the base schema's public/private rule
--    or social.sql's friends rule already granted. Adding another permissive
--    policy here would do precisely nothing.
--
--  * The visibility check goes through a SECURITY DEFINER function rather
--    than reading review_blocks inline. A policy's USING expression runs as
--    the calling user, so an inline subquery would itself be filtered by
--    review_blocks' own RLS - the blocked viewer would see no block row,
--    `not exists` would come back true, and the review would be visible to
--    exactly the person it was hidden from. Same reasoning as are_friends()
--    in social.sql.
--
--  * Only the owner can read their own block rows. That is deliberate: being
--    able to list what someone has hidden from you tells you it exists, and
--    the whole point is that it does not appear to exist at all.
--
--  * Known limit: award BALLOTS become public after a season's reveal, by
--    design (see awards.sql). If you nominate something for an award, that
--    nomination is visible after the reveal even to someone you have hidden
--    the review from. Hiding a title does not retract a nomination.
-- ===================================================================


-- ------------------------------------------------------------------
-- 1. The blocks themselves
--
-- Keyed on the same (provider, provider_id) pair that identifies a title
-- everywhere else in this schema, so a block follows the game rather than a
-- local row id - re-adding a deleted item does not quietly unhide it.
-- ------------------------------------------------------------------
create table if not exists public.review_blocks (
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  blocked_id  uuid        not null references auth.users (id) on delete cascade,
  provider    text        not null,
  provider_id text        not null,
  created_at  timestamptz not null default now(),
  primary key (owner_id, blocked_id, provider, provider_id),
  -- Hiding something from yourself would make it invisible in your own app,
  -- because the restrictive policy below applies to every reader equally.
  constraint review_blocks_not_self check (owner_id <> blocked_id)
);

-- The policy's lookup is by (owner, blocked, provider, provider_id), which
-- the primary key already serves. This index is for the other direction:
-- "everything I have hidden", which the Settings summary lists.
create index if not exists review_blocks_owner_idx
  on public.review_blocks (owner_id, created_at desc);

alter table public.review_blocks enable row level security;

-- Read, add and remove your own blocks. No policy grants anyone sight of a
-- block row aimed at them - see the header note.
drop policy if exists "own blocks only" on public.review_blocks;
create policy "own blocks only"
  on public.review_blocks for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());


-- ------------------------------------------------------------------
-- 2. The visibility test
--
-- SECURITY DEFINER so the reviews policy can consult review_blocks without
-- the caller being able to read it - which is the entire point, since the
-- caller is the person being blocked.
-- ------------------------------------------------------------------
create or replace function public.is_review_hidden(
  p_owner       uuid,
  p_viewer      uuid,
  p_provider    text,
  p_provider_id text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.review_blocks b
    where b.owner_id    = p_owner
      and b.blocked_id  = p_viewer
      and b.provider    = p_provider
      and b.provider_id = p_provider_id
  );
$$;

revoke all on function public.is_review_hidden(uuid, uuid, text, text) from public;
grant execute on function public.is_review_hidden(uuid, uuid, text, text) to authenticated;


-- ------------------------------------------------------------------
-- 3. The veto
--
-- RESTRICTIVE, so it is AND'd with every permissive SELECT policy on the
-- table rather than OR'd alongside them. This is the one policy in the
-- project that can make a row disappear.
--
-- The owner is never affected: a block always has blocked_id <> owner_id
-- (enforced above), so reading your own rows can never match one.
-- ------------------------------------------------------------------
drop policy if exists "hidden reviews stay hidden" on public.reviews;
create policy "hidden reviews stay hidden"
  on public.reviews
  as restrictive
  for select
  using (not public.is_review_hidden(user_id, auth.uid(), provider, provider_id));


-- ------------------------------------------------------------------
-- 4. Managing blocks from the app
--
-- Hiding is only offered for people you are actually friends with, because
-- a non-friend cannot see the review in the first place - a block against a
-- stranger would be a row that does nothing. The friendship check also stops
-- this table being used to enumerate account ids.
-- ------------------------------------------------------------------
create or replace function public.hide_review_from(
  p_blocked     uuid,
  p_provider    text,
  p_provider_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if p_blocked = auth.uid() then
    raise exception 'You cannot hide something from yourself.';
  end if;
  if not public.are_friends(auth.uid(), p_blocked) then
    raise exception 'You can only hide titles from people you are friends with.';
  end if;

  insert into public.review_blocks (owner_id, blocked_id, provider, provider_id)
  values (auth.uid(), p_blocked, p_provider, p_provider_id)
  on conflict do nothing;
end;
$$;

revoke all on function public.hide_review_from(uuid, text, text) from public;
grant execute on function public.hide_review_from(uuid, text, text) to authenticated;


-- Unhiding is deliberately NOT friendship-gated: unfriending someone must
-- never strand a block you can no longer reach to remove.
create or replace function public.unhide_review_from(
  p_blocked     uuid,
  p_provider    text,
  p_provider_id text
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  delete from public.review_blocks
   where owner_id    = auth.uid()
     and blocked_id  = p_blocked
     and provider    = p_provider
     and provider_id = p_provider_id;
$$;

revoke all on function public.unhide_review_from(uuid, text, text) from public;
grant execute on function public.unhide_review_from(uuid, text, text) to authenticated;


-- Everything you have hidden, with enough profile detail to draw a list and
-- enough review detail to name the title. The title is read from your own
-- reviews row, so it stays right if you rename an entry.
--
-- One call powers both surfaces: the per-item control filters it by
-- (provider, provider_id), the Settings summary groups it by person.
create or replace function public.list_review_blocks()
returns table (
  blocked_id   uuid,
  username     text,
  display_name text,
  provider     text,
  provider_id  text,
  title        text,
  library_key  text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.blocked_id,
    p.username,
    p.display_name,
    b.provider,
    b.provider_id,
    r.title,
    r.library_key,
    b.created_at
  from public.review_blocks b
  join public.profiles p on p.id = b.blocked_id
  left join public.reviews r
    on  r.user_id     = b.owner_id
    and r.provider    = b.provider
    and r.provider_id = b.provider_id
    and r.deleted_at is null
  where auth.uid() is not null
    and b.owner_id = auth.uid()
  order by p.username, r.title;
$$;

revoke all on function public.list_review_blocks() from public;
grant execute on function public.list_review_blocks() to authenticated;
