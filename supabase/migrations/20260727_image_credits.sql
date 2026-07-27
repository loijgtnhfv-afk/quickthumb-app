-- 2026-07-27 — quota unit: generations -> IMAGES
--
-- STATUS: ALREADY APPLIED to the production database on 2026-07-27, before the
-- code that reads these columns was deployed. This file exists so the schema
-- the app depends on is recorded next to the app, not only in a chat log: any
-- new environment (a fresh Supabase project, a preview branch, a rebuild after
-- an outage) needs to be able to reproduce it, and the next person to touch
-- billing needs to be able to see what was actually run.
--
-- WHY THE CHANGE
-- The style picker went from 4 fixed styles to 12 selectable ones, so a single
-- generation can now produce up to 12 images. Charging "1 generation" for both
-- a 1-image and a 12-image request stopped making sense — one credit is now
-- one generated image.
--
-- WHY NEW COLUMNS INSTEAD OF REDEFINING THE OLD ONES
-- app/page.tsx queries `profiles` directly from the browser and the Stripe
-- webhook writes it from a separate path, so three readers share these names.
-- A column called `generations_limit` holding 400 images is a trap every one of
-- them steps on forever. With new names an unmigrated row is NULL — self
-- evident — rather than plausible-but-wrong. It is also purely additive: the
-- old columns are untouched, so the previously-deployed code kept working
-- normally in the window between running this and shipping the new code.
--
-- SAFE TO RE-RUN. Every statement is guarded; section 2 only touches rows that
-- have not been migrated yet, so running this twice cannot double-apply the x4.

-- 1) Add the columns. Deliberately nullable at first: that is what makes
--    "not yet migrated" detectable in section 2.
alter table public.profiles
  add column if not exists image_credits_used  int,
  add column if not exists image_credits_limit int;

-- 2) Backfill at 1 generation = 4 images, the ratio the old tier actually
--    delivered, so nobody's balance shrinks. The WHERE is the idempotency
--    guard: a migrated row has a non-null limit and is skipped.
update public.profiles
set image_credits_used  = coalesce(generations_used, 0) * 4,
    image_credits_limit = coalesce(generations_limit, 1) * 4
where image_credits_limit is null;

-- 3) Defaults for new signups. 4 images = the old "1 generation x 4 images"
--    free tier decided 2026-06-06, restated in the new unit.
--    MUST stay in sync with FREE_IMAGE_CREDITS in lib/stripe.ts.
alter table public.profiles
  alter column image_credits_used  set default 0,
  alter column image_credits_limit set default 4;

-- 4) Close the gaps left by any row inserted between steps 1 and 3, then
--    enforce NOT NULL — the app treats both as numbers and a NULL would make
--    the reservation arithmetic silently produce NaN.
update public.profiles set image_credits_used  = 0 where image_credits_used  is null;
update public.profiles set image_credits_limit = 4 where image_credits_limit is null;

alter table public.profiles
  alter column image_credits_used  set not null,
  alter column image_credits_limit set not null;

-- VERIFY
--   select u.email, p.plan, p.image_credits_used, p.image_credits_limit
--   from public.profiles p join auth.users u on u.id = p.id
--   order by p.image_credits_limit desc;
--
-- NOT DONE YET, ON PURPOSE: generations_used / generations_limit still exist.
-- Nothing reads them (the only remaining mention is the back-compat copy of the
-- two keys in /api/generate's JSON response, kept for one release so a browser
-- tab opened before the deploy doesn't render NaN). Drop them once that has
-- rolled through:
--   alter table public.profiles
--     drop column generations_used,
--     drop column generations_limit;
