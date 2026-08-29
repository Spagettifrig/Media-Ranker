-- ===================================================================
-- Game Ranker - annual awards
--
-- Run this once in the Supabase SQL editor. It is idempotent: running it
-- again is safe and will not drop data.
--
-- Design notes that matter if you ever change this file:
--
--  * The anon key ships inside the installer, so anyone can query this
--    database directly with whatever the policies allow. Every rule below
--    is therefore a policy or a SECURITY DEFINER function. Nothing is
--    enforced in the app - the app only decides what to *draw*.
--
--  * Ballots are never INSERTed directly. `award_ballots` has RLS on and
--    no write policy at all, which denies everyone. The only way in is
--    `cast_ballot()`, which validates every eligibility rule first.
--
--  * Nothing is scheduled. The shortlist and the winners are computed
--    lazily, by the first person who asks for them after the deadline has
--    passed. No pg_cron, no admin has to be awake, and the result is the
--    same whoever triggers it.
--
--  * The aggregate functions are SECURITY DEFINER because awards must
--    count *private* reviews too - a private profile still gets a vote.
--    They only ever return aggregates and winners, never rows.
--
--  * One caveat on "idempotent": `create or replace function` cannot change
--    a function's *return type*. Adding or removing a column from a
--    `returns table (...)` needs an explicit `drop function` first, or the
--    re-run fails with 42P13 partway through - see get_award_trophies().
--    Changing an argument list is worse: it creates a second overload
--    instead of failing, so drop the old signature by name.
-- ===================================================================

-- ------------------------------------------------------------------
-- 0. Columns the awards need on existing tables
-- ------------------------------------------------------------------

-- Eligibility is read off these two. `first_played` used to be a purely
-- local field and never left the device, so it has to start syncing.
alter table public.reviews add column if not exists first_played date;
alter table public.reviews add column if not exists release_year int;

-- A category marked N/A on an item must not drag its Critics' Choice
-- average around, so the exclusions have to come up with the scores.
alter table public.reviews add column if not exists disabled_categories text[] not null default '{}';

create index if not exists reviews_awards_idx
  on public.reviews (library_key, provider, provider_id)
  where deleted_at is null;

-- Editing a season (dates, categories) is an admin act. Everything else
-- about the awards runs itself.
alter table public.profiles add column if not exists is_admin boolean not null default false;


-- ------------------------------------------------------------------
-- 1. Category defaults
--
-- Edit this table to change what next year's awards look like - new
-- seasons are built from it, so nothing here needs an app release.
--
--   basis          which items may be nominated:
--                    'release_year'      released in the season's window
--                    'first_played_year' you first played it that year
--                    'library'           anything you own (pure opinion)
--   basis_years    width of the release window, for 'release_year' only.
--                  Bump this to 2 if a thin year leaves too few nominees.
--   computed_key   which category score backs the Critics' Choice award,
--                  '__overall__' for the overall score, NULL for none.
--   requires_mode  nominee must carry this mode tag in the voter's own
--                  library (this is how Best Multiplayer is restricted).
--   direction      'best'  - the highest score wins (almost everything)
--                  'worst' - the lowest score wins (Worst of the Year).
--                  Only affects the Critics' Choice half and the order
--                  nominees are offered in; the community vote is a count
--                  either way, since voting for the worst thing is still
--                  just voting.
-- ------------------------------------------------------------------
create table if not exists public.award_category_defaults (
  library_key   text    not null,
  key           text    not null,
  label         text    not null,
  sort_order    int     not null,
  basis         text    not null check (basis in ('release_year', 'first_played_year', 'library')),
  basis_years   int     not null default 1 check (basis_years >= 1),
  computed_key  text,
  requires_mode text,
  blurb         text,
  primary key (library_key, key)
);

-- Added after the first release; every category that predates it is a
-- 'best' one, which is exactly what the default gives them.
alter table public.award_category_defaults
  add column if not exists direction text not null default 'best'
  check (direction in ('best', 'worst'));

insert into public.award_category_defaults
  (library_key, key, label, sort_order, basis, basis_years, computed_key, requires_mode, blurb, direction)
values
  ('games', 'goty',        'Game of the Year',      1, 'release_year',      1, '__overall__', null,          'Released this year. The big one.', 'best'),
  ('games', 'discovery',   'Discovery of the Year', 2, 'first_played_year', 1, '__overall__', null,          'Any age - you just got to it this year.', 'best'),
  ('games', 'gameplay',    'Best Gameplay',         3, 'first_played_year', 1, 'gameplay',    null,          'Systems, controls, the moment-to-moment.', 'best'),
  ('games', 'story',       'Best Story',            4, 'first_played_year', 1, 'story',       null,          'Writing, characters, how it lands.', 'best'),
  ('games', 'art',         'Best Art',              5, 'first_played_year', 1, 'art',         null,          'Direction and style.', 'best'),
  ('games', 'music',       'Best Music',            6, 'first_played_year', 1, 'music',       null,          'Soundtrack and sound design.', 'best'),
  ('games', 'feel',        'Best Feel',             7, 'first_played_year', 1, 'feel',        null,          'Weight, feedback, responsiveness.', 'best'),
  ('games', 'multiplayer', 'Best Multiplayer',      8, 'first_played_year', 1, '__overall__', 'multiplayer', 'Must be tagged Multiplayer in your library.', 'best'),
  ('games', 'ongoing',     'Best Ongoing Game',     9, 'library',           1, null,          null,          'Still going, still worth it. Pure opinion - nominate anything you own.', 'best'),
  -- Same window and same score as Game of the Year, read from the other
  -- end. Revealed last, which is the right place for it.
  ('games', 'worst',       'Worst Game of the Year', 10, 'release_year',     1, '__overall__', null,          'Released this year. Someone has to say it.', 'worst'),

  ('movies', 'moty',      'Movie of the Year',     1, 'release_year',      1, '__overall__', null, 'Released this year.', 'best'),
  ('movies', 'discovery', 'Discovery of the Year', 2, 'first_played_year', 1, '__overall__', null, 'Any age - you just got to it this year.', 'best'),
  ('movies', 'story',     'Best Story',            3, 'first_played_year', 1, 'story',       null, 'Writing, structure, how it lands.', 'best'),
  ('movies', 'acting',    'Best Acting',           4, 'first_played_year', 1, 'acting',      null, 'Performances, casting, chemistry.', 'best'),
  ('movies', 'music',     'Best Music',            5, 'first_played_year', 1, 'music',       null, 'Score, songs, sound design.', 'best'),
  ('movies', 'visuals',   'Best Visuals',          6, 'first_played_year', 1, 'visuals',     null, 'Cinematography, effects, production design.', 'best'),
  ('movies', 'rewatch',   'Best Rewatch',          7, 'library',           1, null,          null, 'The one you keep going back to. Pure opinion - nominate anything you own.', 'best'),
  ('movies', 'worst',     'Worst Movie of the Year', 8, 'release_year',    1, '__overall__', null, 'Released this year. Someone has to say it.', 'worst'),

  -- A series is filed under the year it *premiered*, so 'release_year' here
  -- means "new this year" and nothing else - a show that started in 2019 is
  -- never eligible for it again. That is what 'ongoing' is for, exactly as
  -- Best Ongoing Game works for a live-service title.
  ('series', 'soty',        'Series of the Year',    1, 'release_year',      1, '__overall__', null,       'Premiered this year. The big one.', 'best'),
  ('series', 'discovery',   'Discovery of the Year', 2, 'first_played_year', 1, '__overall__', null,       'Any age - you just got to it this year.', 'best'),
  ('series', 'story',       'Best Story',            3, 'first_played_year', 1, 'story',       null,       'Writing, arcs, how the run lands.', 'best'),
  ('series', 'acting',      'Best Acting',           4, 'first_played_year', 1, 'acting',      null,       'Performances, casting, chemistry.', 'best'),
  ('series', 'music',       'Best Music',            5, 'first_played_year', 1, 'music',       null,       'Score, theme, sound design.', 'best'),
  ('series', 'visuals',     'Best Visuals',          6, 'first_played_year', 1, 'visuals',     null,       'Cinematography, effects, production design.', 'best'),
  ('series', 'consistency', 'Most Consistent',       7, 'first_played_year', 1, 'consistency', null,       'Holds its quality season to season.', 'best'),
  ('series', 'animated',    'Best Animated Series',  8, 'first_played_year', 1, '__overall__', 'animated', 'Must be tagged Animated in your library.', 'best'),
  ('series', 'ongoing',     'Best Ongoing Series',   9, 'library',           1, null,          null,       'Still running, still worth it. Pure opinion - nominate anything you own.', 'best'),
  -- "Premiered this year", same as Series of the Year - a show that started
  -- badly in 2019 is not dragged back in every year to be booed again.
  ('series', 'worst',       'Worst Show of the Year', 10, 'release_year',    1, '__overall__', null,       'Premiered this year. Someone has to say it.', 'worst')
on conflict (library_key, key) do nothing;

alter table public.award_category_defaults enable row level security;

drop policy if exists "category defaults are public" on public.award_category_defaults;
create policy "category defaults are public"
  on public.award_category_defaults for select to authenticated using (true);


-- ------------------------------------------------------------------
-- 2. Seasons
--
-- One row per (year, library). Every date is a timestamptz built from
-- Europe/Berlin wall-clock time, so "December 5th" is one instant
-- worldwide rather than whatever midnight means where you happen to be.
-- ------------------------------------------------------------------
create table if not exists public.award_seasons (
  id                      uuid primary key default gen_random_uuid(),
  year                    int  not null,
  library_key             text not null,
  nominations_open_at     timestamptz not null,
  nominations_close_at    timestamptz not null,
  voting_open_at          timestamptz not null,
  voting_close_at         timestamptz not null,
  results_published_at    timestamptz not null,
  -- Categories unlock one at a time from the reveal instant, which is the
  -- whole ceremony: no live infrastructure, just arithmetic on a clock
  -- everyone already agrees on.
  reveal_stagger_seconds  int  not null default 90,
  shortlist_size          int  not null default 5,
  -- Integrity thresholds. All tunable here, none of them in the app.
  min_library_size        int  not null default 5,
  min_votes_per_category  int  not null default 3,
  min_reviews_for_computed int not null default 3,
  categories              jsonb not null,
  created_at              timestamptz not null default now(),
  unique (year, library_key)
);

alter table public.award_seasons enable row level security;

drop policy if exists "seasons are public" on public.award_seasons;
create policy "seasons are public"
  on public.award_seasons for select to authenticated using (true);

drop policy if exists "admins manage seasons" on public.award_seasons;
create policy "admins manage seasons"
  on public.award_seasons for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));


-- ------------------------------------------------------------------
-- 3. Ballots
--
-- One row per user per category per round. `title` and `cover_image_url`
-- are snapshots on purpose: deleting the game later must not delete the
-- vote, and after the reveal the ballot has to still know what it named.
-- ------------------------------------------------------------------
create table if not exists public.award_ballots (
  id              uuid primary key default gen_random_uuid(),
  season_id       uuid not null references public.award_seasons(id) on delete cascade,
  round           text not null check (round in ('nominate', 'vote')),
  user_id         uuid not null references auth.users(id) on delete cascade,
  category_key    text not null,
  provider        text not null,
  provider_id     text not null,
  title           text not null,
  cover_image_url text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (season_id, round, user_id, category_key)
);

create index if not exists award_ballots_tally_idx
  on public.award_ballots (season_id, round, category_key);

alter table public.award_ballots enable row level security;

-- You may read your own ballot at any time, and everyone's once the
-- results are out - that is the "who voted for what" reveal. In between
-- there is no query that returns a tally, which is what keeps it secret.
drop policy if exists "own ballots, or everyone's after the reveal" on public.award_ballots;
create policy "own ballots, or everyone's after the reveal"
  on public.award_ballots for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.award_seasons s
      where s.id = season_id and now() >= s.results_published_at
    )
  );

-- Deliberately no insert/update/delete policy. RLS with no policy denies
-- everyone, including the anon key in the installer. cast_ballot() is the
-- only door, and it checks every rule before it writes.


-- ------------------------------------------------------------------
-- 4. Shortlist and winners (both computed, never hand-entered)
-- ------------------------------------------------------------------
create table if not exists public.award_shortlist (
  season_id        uuid not null references public.award_seasons(id) on delete cascade,
  category_key     text not null,
  provider         text not null,
  provider_id      text not null,
  title            text not null,
  cover_image_url  text,
  nomination_count int  not null,
  primary key (season_id, category_key, provider, provider_id)
);

alter table public.award_shortlist enable row level security;

-- The shortlist is the round-one result, so it appears exactly when
-- voting opens - not a moment earlier.
drop policy if exists "shortlist once voting opens" on public.award_shortlist;
create policy "shortlist once voting opens"
  on public.award_shortlist for select to authenticated
  using (
    exists (
      select 1 from public.award_seasons s
      where s.id = season_id and now() >= s.voting_open_at
    )
  );

create table if not exists public.award_winners (
  season_id       uuid not null references public.award_seasons(id) on delete cascade,
  category_key    text not null,
  -- 'community' is what people voted for; 'critics' is what the scores
  -- already said. Both are awarded, and they are often not the same game.
  kind            text not null check (kind in ('community', 'critics')),
  year            int  not null,
  library_key     text not null,
  provider        text not null,
  provider_id     text not null,
  title           text not null,
  cover_image_url text,
  vote_count      int,
  average_score   numeric,
  computed_at     timestamptz not null default now(),
  primary key (season_id, category_key, kind)
);

create index if not exists award_winners_lookup_idx
  on public.award_winners (provider, provider_id);

alter table public.award_winners enable row level security;

drop policy if exists "winners after the reveal" on public.award_winners;
create policy "winners after the reveal"
  on public.award_winners for select to authenticated
  using (
    exists (
      select 1 from public.award_seasons s
      where s.id = season_id and now() >= s.results_published_at
    )
  );


-- ------------------------------------------------------------------
-- 5. Season bootstrap
--
-- Seasons build themselves from the category defaults the first time
-- anyone opens the Awards tab in a new year, so there is no yearly chore
-- and no release needed. Edit the row afterwards to move any date.
--
-- Timeline, in Europe/Berlin wall-clock time:
--     Dec 1  00:00  nominations open   (also the release-eligibility cutoff)
--     Dec 2  00:00  nominations close, shortlist locks, voting opens
--     Dec 3  00:00  voting closes
--     Dec 3  20:00  the reveal, same night
--
-- Tight on purpose: one day to nominate, one day to vote, results that
-- night. Nobody has to remember to come back across a two-week window.
-- ------------------------------------------------------------------
create or replace function public.ensure_award_season(p_year int, p_library_key text)
returns public.award_seasons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season public.award_seasons;
  cats   jsonb;
begin
  select * into season
    from public.award_seasons
   where year = p_year and library_key = p_library_key;
  if found then
    return season;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'key', d.key,
               'label', d.label,
               'basis', d.basis,
               'basis_years', d.basis_years,
               'computed_key', d.computed_key,
               'requires_mode', d.requires_mode,
               'blurb', d.blurb,
               'direction', d.direction
             )
             order by d.sort_order
           ),
           '[]'::jsonb
         )
    into cats
    from public.award_category_defaults d
   where d.library_key = p_library_key;

  if cats = '[]'::jsonb then
    raise exception 'No award categories are defined for library %.', p_library_key;
  end if;

  insert into public.award_seasons (
    year, library_key,
    nominations_open_at, nominations_close_at,
    voting_open_at, voting_close_at, results_published_at,
    categories
  )
  values (
    p_year, p_library_key,
    (make_timestamp(p_year, 12, 1,  0, 0, 0) at time zone 'Europe/Berlin'),
    (make_timestamp(p_year, 12, 2,  0, 0, 0) at time zone 'Europe/Berlin'),
    (make_timestamp(p_year, 12, 2,  0, 0, 0) at time zone 'Europe/Berlin'),
    (make_timestamp(p_year, 12, 3,  0, 0, 0) at time zone 'Europe/Berlin'),
    (make_timestamp(p_year, 12, 3, 20, 0, 0) at time zone 'Europe/Berlin'),
    cats
  )
  on conflict (year, library_key) do nothing;

  select * into season
    from public.award_seasons
   where year = p_year and library_key = p_library_key;
  return season;
end;
$$;


-- ------------------------------------------------------------------
-- 6. Reading a season
--
-- Returns the season plus everything the app needs to decide what to
-- draw: the current phase, and how this user stands against the entry
-- rules. The app never re-derives any of this - it only renders it.
-- ------------------------------------------------------------------
create or replace function public.get_award_season(p_library_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season      public.award_seasons;
  target_year int;
  uid         uuid := auth.uid();
  joined_at   timestamptz;
  library_n   int;
  phase       text;
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  target_year := extract(year from (now() at time zone 'Europe/Berlin'))::int;

  -- Outside December the interesting season is last year's, because that is
  -- the one with results worth showing. Only if it actually ran, though:
  -- conjuring a season whose every deadline is already in the past would
  -- "reveal" an award nobody was ever able to vote in, and stamp trophies
  -- for it. A year that never happened stays not having happened.
  if extract(month from (now() at time zone 'Europe/Berlin'))::int < 12 then
    select * into season
      from public.award_seasons
     where year = target_year - 1 and library_key = p_library_key;
    if found then
      target_year := target_year - 1;
    end if;
  end if;

  -- Otherwise this year's, which before December simply reads as 'upcoming'
  -- and counts down to the 5th.
  if season.id is null then
    season := public.ensure_award_season(target_year, p_library_key);
  end if;

  select u.created_at into joined_at from auth.users u where u.id = uid;

  select count(*) into library_n
    from public.reviews r
   where r.user_id = uid
     and r.library_key = p_library_key
     and r.deleted_at is null;

  phase := case
    when now() <  season.nominations_open_at  then 'upcoming'
    when now() <  season.nominations_close_at then 'nominating'
    when now() <  season.voting_open_at       then 'shortlisting'
    when now() <  season.voting_close_at      then 'voting'
    when now() <  season.results_published_at then 'sealed'
    else 'revealed'
  end;

  return jsonb_build_object(
    'id',                    season.id,
    'year',                  season.year,
    'libraryKey',            season.library_key,
    'phase',                 phase,
    'serverTime',            now(),
    'nominationsOpenAt',     season.nominations_open_at,
    'nominationsCloseAt',    season.nominations_close_at,
    'votingOpenAt',          season.voting_open_at,
    'votingCloseAt',         season.voting_close_at,
    'resultsPublishedAt',    season.results_published_at,
    'revealStaggerSeconds',  season.reveal_stagger_seconds,
    'shortlistSize',         season.shortlist_size,
    'minLibrarySize',        season.min_library_size,
    'categories',            season.categories,
    'eligibility', jsonb_build_object(
      -- Both rules are reported rather than just a yes/no, so the tab can
      -- say *why* someone is locked out instead of just greying out.
      'accountOldEnough', (joined_at < season.nominations_open_at),
      'joinedAt',         joined_at,
      'librarySize',      library_n,
      'libraryBigEnough', (library_n >= season.min_library_size),
      'canParticipate',   (joined_at < season.nominations_open_at and library_n >= season.min_library_size)
    )
  );
end;
$$;


-- ------------------------------------------------------------------
-- 7. What this user is allowed to nominate
--
-- Every rule that cast_ballot() enforces, run in reverse to produce the
-- picker's contents. Keeping both on the same conditions is the point:
-- the app can never offer something the server would then refuse.
-- ------------------------------------------------------------------
create or replace function public.award_eligible_items(p_season_id uuid, p_category_key text)
returns table (
  provider        text,
  provider_id     text,
  title           text,
  cover_image_url text,
  overall_score   int,
  release_year    int,
  first_played    date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season public.award_seasons;
  cat    jsonb;
  uid    uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  select * into season from public.award_seasons where id = p_season_id;
  if not found then
    raise exception 'Unknown season.';
  end if;

  select c into cat
    from jsonb_array_elements(season.categories) c
   where c ->> 'key' = p_category_key;
  if cat is null then
    raise exception 'Unknown category %.', p_category_key;
  end if;

  return query
    select r.provider, r.provider_id, r.title, r.cover_image_url,
           r.overall_score, r.release_year, r.first_played
      from public.reviews r
     where r.user_id = uid
       and r.library_key = season.library_key
       and r.deleted_at is null
       and r.provider is not null
       and r.provider_id is not null
       and case cat ->> 'basis'
             when 'release_year' then
               r.release_year is not null
               and r.release_year between
                     season.year - coalesce((cat ->> 'basis_years')::int, 1) + 1 and season.year
             when 'first_played_year' then
               r.first_played is not null
               and extract(year from r.first_played)::int = season.year
             else true
           end
       and (cat ->> 'requires_mode' is null or (cat ->> 'requires_mode') = any(r.modes))
     -- Nominees for a 'worst' category are offered worst-first, so the
     -- picker opens on the ones the voter is actually looking for.
     order by r.overall_score * (case when cat ->> 'direction' = 'worst' then -1 else 1 end) desc,
              r.title asc;
end;
$$;


-- ------------------------------------------------------------------
-- 8. Casting a ballot - the only write path
-- ------------------------------------------------------------------
create or replace function public.cast_ballot(
  p_season_id    uuid,
  p_round        text,
  p_category_key text,
  p_provider     text,
  p_provider_id  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season    public.award_seasons;
  cat       jsonb;
  uid       uuid := auth.uid();
  joined_at timestamptz;
  library_n int;
  mine      public.reviews;
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  select * into season from public.award_seasons where id = p_season_id;
  if not found then
    raise exception 'Unknown season.';
  end if;

  -- Phase. Checked against the database clock, never the caller's.
  if p_round = 'nominate' then
    if now() < season.nominations_open_at then
      raise exception 'Nominations have not opened yet.';
    end if;
    if now() >= season.nominations_close_at then
      raise exception 'Nominations have closed.';
    end if;
  elsif p_round = 'vote' then
    if now() < season.voting_open_at then
      raise exception 'Voting has not opened yet.';
    end if;
    if now() >= season.voting_close_at then
      raise exception 'Voting has closed.';
    end if;
  else
    raise exception 'Unknown round %.', p_round;
  end if;

  select c into cat
    from jsonb_array_elements(season.categories) c
   where c ->> 'key' = p_category_key;
  if cat is null then
    raise exception 'Unknown category %.', p_category_key;
  end if;

  -- Entry rules. Signing up in December to swing a vote does not work.
  select u.created_at into joined_at from auth.users u where u.id = uid;
  if joined_at >= season.nominations_open_at then
    raise exception 'Only accounts that existed before this season opened can take part.';
  end if;

  select count(*) into library_n
    from public.reviews r
   where r.user_id = uid and r.library_key = season.library_key and r.deleted_at is null;
  if library_n < season.min_library_size then
    raise exception 'Rank at least % items in this library first (you have %).',
      season.min_library_size, library_n;
  end if;

  -- You can only put forward something you actually played and scored.
  -- This is the rule that makes the whole thing mean anything.
  select * into mine
    from public.reviews r
   where r.user_id = uid
     and r.library_key = season.library_key
     and r.provider = p_provider
     and r.provider_id = p_provider_id
     and r.deleted_at is null;
  if not found then
    raise exception 'You can only pick something from your own library.';
  end if;

  -- Eligibility for this category.
  if cat ->> 'basis' = 'release_year' then
    if mine.release_year is null
       or mine.release_year not between
            season.year - coalesce((cat ->> 'basis_years')::int, 1) + 1 and season.year then
      raise exception '% is only for things released in %.', cat ->> 'label', season.year;
    end if;
  elsif cat ->> 'basis' = 'first_played_year' then
    if mine.first_played is null
       or extract(year from mine.first_played)::int <> season.year then
      raise exception '% is only for things you first logged in %.', cat ->> 'label', season.year;
    end if;
  end if;

  if cat ->> 'requires_mode' is not null
     and not ((cat ->> 'requires_mode') = any(mine.modes)) then
    raise exception '% needs the % tag on your copy.', cat ->> 'label', cat ->> 'requires_mode';
  end if;

  -- Round two may only name something the shortlist actually carries.
  if p_round = 'vote'
     and not exists (
       select 1 from public.award_shortlist s
        where s.season_id = p_season_id
          and s.category_key = p_category_key
          and s.provider = p_provider
          and s.provider_id = p_provider_id
     ) then
    raise exception 'That is not one of the nominees in %.', cat ->> 'label';
  end if;

  insert into public.award_ballots (
    season_id, round, user_id, category_key, provider, provider_id, title, cover_image_url
  )
  values (
    p_season_id, p_round, uid, p_category_key, p_provider, p_provider_id,
    mine.title, mine.cover_image_url
  )
  on conflict (season_id, round, user_id, category_key) do update
    set provider        = excluded.provider,
        provider_id     = excluded.provider_id,
        title           = excluded.title,
        cover_image_url = excluded.cover_image_url,
        updated_at      = now();

  return jsonb_build_object('ok', true, 'title', mine.title);
end;
$$;


create or replace function public.withdraw_ballot(
  p_season_id    uuid,
  p_round        text,
  p_category_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season public.award_seasons;
  uid    uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  select * into season from public.award_seasons where id = p_season_id;
  if not found then
    raise exception 'Unknown season.';
  end if;

  -- Changing your mind is fine right up to the deadline, and impossible
  -- after it - the same instant that freezes everyone else's ballot.
  if p_round = 'nominate' and now() >= season.nominations_close_at then
    raise exception 'Nominations have closed.';
  end if;
  if p_round = 'vote' and now() >= season.voting_close_at then
    raise exception 'Voting has closed.';
  end if;

  delete from public.award_ballots
   where season_id = p_season_id and round = p_round
     and user_id = uid and category_key = p_category_key;

  return jsonb_build_object('ok', true);
end;
$$;


-- ------------------------------------------------------------------
-- 9. The shortlist, computed on first read after nominations close
-- ------------------------------------------------------------------
create or replace function public.get_award_shortlist(p_season_id uuid)
returns table (
  category_key     text,
  provider         text,
  provider_id      text,
  title            text,
  cover_image_url  text,
  nomination_count int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season public.award_seasons;
begin
  select * into season from public.award_seasons where id = p_season_id;
  if not found then
    raise exception 'Unknown season.';
  end if;

  -- Voting open, not nominations close: the gap between the two is what
  -- stops anyone peeking at round one's tally while it still matters.
  if now() < season.voting_open_at then
    raise exception 'The nominees are not in yet.';
  end if;

  if not exists (select 1 from public.award_shortlist s where s.season_id = season.id) then
    insert into public.award_shortlist (
      season_id, category_key, provider, provider_id, title, cover_image_url, nomination_count
    )
    with counted as (
      select b.category_key, b.provider, b.provider_id,
             min(b.title)           as title,
             min(b.cover_image_url) as cover_image_url,
             count(*)::int          as nomination_count,
             min(b.created_at)      as first_nominated_at
        from public.award_ballots b
       where b.season_id = season.id and b.round = 'nominate'
       group by b.category_key, b.provider, b.provider_id
    ),
    scored as (
      select c.*,
             (select avg(r.overall_score)
                from public.reviews r
               where r.provider = c.provider
                 and r.provider_id = c.provider_id
                 and r.deleted_at is null) as average_score
        from counted c
    ),
    ranked as (
      select s.*,
             row_number() over (
               partition by s.category_key
               -- Ties break on the community's own scores, then on who got
               -- there first, then on the id - so there is always exactly
               -- one answer and it never depends on row order.
               order by s.nomination_count desc,
                        s.average_score desc nulls last,
                        s.first_nominated_at asc,
                        s.provider_id asc
             ) as rn
        from scored s
    )
    select season.id, r.category_key, r.provider, r.provider_id,
           r.title, r.cover_image_url, r.nomination_count
      from ranked r
     where r.rn <= season.shortlist_size
    on conflict do nothing;
  end if;

  return query
    select s.category_key, s.provider, s.provider_id, s.title,
           s.cover_image_url, s.nomination_count
      from public.award_shortlist s
     where s.season_id = season.id
     order by s.category_key, s.nomination_count desc, s.title;
end;
$$;


-- ------------------------------------------------------------------
-- 10. The results, computed on first read after the reveal instant
--
-- Whoever opens the app first triggers this; everyone after reads the
-- stored rows. Nobody types a winner in, including you - which is the
-- only reason anyone should believe the results.
-- ------------------------------------------------------------------
create or replace function public.get_award_results(p_season_id uuid)
returns table (
  category_key    text,
  kind            text,
  provider        text,
  provider_id     text,
  title           text,
  cover_image_url text,
  vote_count      int,
  average_score   numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season public.award_seasons;
  cat    jsonb;
begin
  select * into season from public.award_seasons where id = p_season_id;
  if not found then
    raise exception 'Unknown season.';
  end if;

  if now() < season.results_published_at then
    raise exception 'The results are still sealed.';
  end if;

  if not exists (select 1 from public.award_winners w where w.season_id = season.id) then

    -- Community Choice: round two, most votes, but only where enough
    -- people turned up for the number to mean something.
    insert into public.award_winners (
      season_id, category_key, kind, year, library_key,
      provider, provider_id, title, cover_image_url, vote_count, average_score
    )
    with counted as (
      select b.category_key, b.provider, b.provider_id,
             min(b.title)           as title,
             min(b.cover_image_url) as cover_image_url,
             count(*)::int          as vote_count,
             min(b.created_at)      as first_voted_at
        from public.award_ballots b
       where b.season_id = season.id and b.round = 'vote'
       group by b.category_key, b.provider, b.provider_id
    ),
    totals as (
      -- Every reference in here stays table-qualified. `vote_count` is also
      -- an OUT parameter of this function, and an unqualified mention of it
      -- is ambiguous between the column and the variable - which Postgres
      -- rejects outright rather than guessing at.
      select c.category_key, sum(c.vote_count)::int as cast_in_category
        from counted c group by c.category_key
    ),
    scored as (
      select c.*,
             (select avg(r.overall_score)
                from public.reviews r
               where r.provider = c.provider
                 and r.provider_id = c.provider_id
                 and r.deleted_at is null) as average_score
        from counted c
    ),
    ranked as (
      select s.*,
             row_number() over (
               partition by s.category_key
               order by s.vote_count desc,
                        s.average_score desc nulls last,
                        s.first_voted_at asc,
                        s.provider_id asc
             ) as rn
        from scored s
    )
    select season.id, r.category_key, 'community', season.year, season.library_key,
           r.provider, r.provider_id, r.title, r.cover_image_url,
           r.vote_count, r.average_score
      from ranked r
      join totals t on t.category_key = r.category_key
     where r.rn = 1
       and t.cast_in_category >= season.min_votes_per_category
    on conflict do nothing;

    -- Critics' Choice: what the scores already said, no ballot involved.
    -- This is the half that still works when only four people show up.
    for cat in select c from jsonb_array_elements(season.categories) c loop
      if cat ->> 'computed_key' is null then
        continue;
      end if;

      insert into public.award_winners (
        season_id, category_key, kind, year, library_key,
        provider, provider_id, title, cover_image_url, vote_count, average_score
      )
      select season.id, cat ->> 'key', 'critics', season.year, season.library_key,
             w.provider, w.provider_id, w.win_title, w.win_cover,
             w.n_reviews, w.avg_score
        from (
          -- Aliased away from the OUT parameter names (`title`,
          -- `cover_image_url`, `average_score`) so the ORDER BY below can
          -- name them without becoming ambiguous.
          select r.provider,
                 r.provider_id,
                 min(r.title)           as win_title,
                 min(r.cover_image_url) as win_cover,
                 count(*)::int          as n_reviews,
                 avg(
                   case when cat ->> 'computed_key' = '__overall__'
                     then r.overall_score::numeric
                     else (r.category_scores ->> (cat ->> 'computed_key'))::numeric
                   end
                 ) as avg_score
            from public.reviews r
           where r.library_key = season.library_key
             and r.deleted_at is null
             and r.provider is not null
             and r.provider_id is not null
             and case cat ->> 'basis'
                   when 'release_year' then
                     r.release_year is not null
                     and r.release_year between
                           season.year - coalesce((cat ->> 'basis_years')::int, 1) + 1 and season.year
                   when 'first_played_year' then
                     -- Averaged over the people who played it this year,
                     -- which is the only reading that matches the category.
                     r.first_played is not null
                     and extract(year from r.first_played)::int = season.year
                   else true
                 end
             and (cat ->> 'requires_mode' is null or (cat ->> 'requires_mode') = any(r.modes))
             and (
               cat ->> 'computed_key' = '__overall__'
               or (
                 r.category_scores ? (cat ->> 'computed_key')
                 -- A category marked N/A on an item is not an opinion
                 -- about it, so it must not be averaged in.
                 and not ((cat ->> 'computed_key') = any(r.disabled_categories))
               )
             )
           group by r.provider, r.provider_id
          having count(*) >= season.min_reviews_for_computed
           -- Flipping the sign rather than branching on the sort keeps this
           -- a single plan: a 'worst' category wants the lowest average, and
           -- -avg descending is the lowest ascending.
           order by avg_score * (case when cat ->> 'direction' = 'worst' then -1 else 1 end) desc,
                    n_reviews desc,
                    r.provider_id asc
           limit 1
        ) w
      on conflict do nothing;
    end loop;
  end if;

  return query
    select w.category_key, w.kind, w.provider, w.provider_id, w.title,
           w.cover_image_url, w.vote_count, w.average_score
      from public.award_winners w
     where w.season_id = season.id;
end;
$$;


-- ------------------------------------------------------------------
-- 11. Trophies
--
-- Every win ever, flat. The app joins this to a board by provider +
-- provider_id, which is why a win belongs to the *game* and not to one
-- person's copy of it: everyone who owns it sees the trophy.
-- ------------------------------------------------------------------
-- `create or replace` cannot change a function's return type, and this one
-- gained a `direction` column. Postgres wants the old one gone first, so it
-- is dropped explicitly rather than replaced.
--
-- Safe to do on a live database: nothing in SQL depends on this function -
-- it is only ever reached as an RPC from the app - and the grants it needs
-- are re-applied further down this same file, on this same run. Any future
-- edit that adds or removes an OUT column here needs the same treatment.
drop function if exists public.get_award_trophies();

create or replace function public.get_award_trophies()
returns table (
  provider     text,
  provider_id  text,
  library_key  text,
  year         int,
  category_key text,
  label        text,
  kind         text,
  direction    text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select w.provider, w.provider_id, w.library_key, w.year, w.category_key,
         coalesce(
           (select c ->> 'label'
              from public.award_seasons s2,
                   jsonb_array_elements(s2.categories) c
             where s2.id = w.season_id and c ->> 'key' = w.category_key),
           w.category_key
         ) as label,
         w.kind,
         -- So the board can tell a trophy from a wooden spoon. Seasons
         -- created before `direction` existed have no such key, and
         -- coalesce reads them as what they were: all 'best'.
         coalesce(
           (select c ->> 'direction'
              from public.award_seasons s3,
                   jsonb_array_elements(s3.categories) c
             where s3.id = w.season_id and c ->> 'key' = w.category_key),
           'best'
         ) as direction
    from public.award_winners w
    join public.award_seasons s on s.id = w.season_id
   where now() >= s.results_published_at
   order by w.year desc, w.category_key;
$$;


-- ------------------------------------------------------------------
-- 12. Hall of Fame - every finished season, newest first
-- ------------------------------------------------------------------
create or replace function public.get_award_history(p_library_key text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'year', s.year,
        'winners', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'categoryKey', w.category_key,
              'label', coalesce(
                (select c ->> 'label' from jsonb_array_elements(s.categories) c
                  where c ->> 'key' = w.category_key),
                w.category_key
              ),
              'kind', w.kind,
              'provider', w.provider,
              'providerId', w.provider_id,
              'title', w.title,
              'coverImageUrl', w.cover_image_url,
              'voteCount', w.vote_count,
              'averageScore', w.average_score
            )
          ), '[]'::jsonb)
          from public.award_winners w where w.season_id = s.id
        )
      )
      order by s.year desc
    ),
    '[]'::jsonb
  )
  from public.award_seasons s
  where s.library_key = p_library_key
    and now() >= s.results_published_at;
$$;


-- ------------------------------------------------------------------
-- 13. Who voted for what - unsealed with the results, never before
-- ------------------------------------------------------------------
create or replace function public.get_award_ballot_log(p_season_id uuid)
returns table (
  category_key text,
  round        text,
  display_name text,
  title        text,
  provider     text,
  provider_id  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  season public.award_seasons;
begin
  select * into season from public.award_seasons where id = p_season_id;
  if not found then
    raise exception 'Unknown season.';
  end if;
  if now() < season.results_published_at then
    raise exception 'The results are still sealed.';
  end if;

  return query
    select b.category_key, b.round,
           coalesce(p.display_name, p.username, 'Anonymous') as display_name,
           b.title, b.provider, b.provider_id
      from public.award_ballots b
      left join public.profiles p on p.id = b.user_id
     where b.season_id = season.id
     -- Repeated rather than named: `display_name` is an OUT parameter here,
     -- so referring to the select-list alias would be ambiguous.
     order by b.category_key, b.round, coalesce(p.display_name, p.username, 'Anonymous');
end;
$$;


-- ------------------------------------------------------------------
-- 14. Grants. `authenticated` only - none of this is public.
-- ------------------------------------------------------------------
revoke all on function public.ensure_award_season(int, text)          from public, anon;
revoke all on function public.get_award_season(text)                  from public, anon;
revoke all on function public.award_eligible_items(uuid, text)        from public, anon;
revoke all on function public.cast_ballot(uuid, text, text, text, text) from public, anon;
revoke all on function public.withdraw_ballot(uuid, text, text)       from public, anon;
revoke all on function public.get_award_shortlist(uuid)               from public, anon;
revoke all on function public.get_award_results(uuid)                 from public, anon;
revoke all on function public.get_award_trophies()                    from public, anon;
revoke all on function public.get_award_history(text)                 from public, anon;
revoke all on function public.get_award_ballot_log(uuid)              from public, anon;

grant execute on function public.get_award_season(text)                  to authenticated;
grant execute on function public.award_eligible_items(uuid, text)        to authenticated;
grant execute on function public.cast_ballot(uuid, text, text, text, text) to authenticated;
grant execute on function public.withdraw_ballot(uuid, text, text)       to authenticated;
grant execute on function public.get_award_shortlist(uuid)               to authenticated;
grant execute on function public.get_award_results(uuid)                 to authenticated;
grant execute on function public.get_award_trophies()                    to authenticated;
grant execute on function public.get_award_history(text)                 to authenticated;
grant execute on function public.get_award_ballot_log(uuid)              to authenticated;

-- ensure_award_season is only ever called from get_award_season, which is
-- itself SECURITY DEFINER - no client needs to reach it directly.


-- ------------------------------------------------------------------
-- 13. Refresh categories on seasons that have not started voting
--
-- A season snapshots its category list into `award_seasons.categories` the
-- moment it is created, so adding a category above does nothing for a
-- season that already exists. This re-reads the defaults into any season
-- that has not opened voting yet.
--
-- The `now() < voting_open_at` guard is the whole point: once a ballot has
-- been cast, the category list is what people voted on and changing it
-- would silently rewrite the question after the answers came in. Seasons
-- already in voting keep the categories they started with and pick the new
-- award up next year.
-- ------------------------------------------------------------------
update public.award_seasons s
   set categories = (
     select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'key', d.key,
                  'label', d.label,
                  'basis', d.basis,
                  'basis_years', d.basis_years,
                  'computed_key', d.computed_key,
                  'requires_mode', d.requires_mode,
                  'blurb', d.blurb,
                  'direction', d.direction
                )
                order by d.sort_order
              ),
              '[]'::jsonb
            )
       from public.award_category_defaults d
      where d.library_key = s.library_key
   )
 where now() < s.voting_open_at;
