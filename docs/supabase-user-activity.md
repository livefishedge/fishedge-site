# FishEdge user timestamps

## Semantics

- `auth.users.last_sign_in_at` remains Supabase Auth's authentication timestamp. It is not a website-visit timestamp.
- `public.user_presence.last_seen_at` is an approximate server timestamp for foreground FishEdge activity. It is updated by `touch_last_seen()` at most once per five minutes.
- Existing historical activity is intentionally not backfilled: authentication history cannot reconstruct visits.

The app tracker ignores token refreshes and hidden-tab timers. It touches activity on authenticated page bootstrap, foregrounding a tab, and meaningful pointer/keyboard interaction. The tracker is fail-soft until the migration is applied.

## Applying the database change

Apply `supabase/migrations/20260918140000_add_user_presence.sql` in the Supabase SQL editor or through the Supabase CLI using an operator credential. The repository has no database deployment credential or migration runner, so the application deploy cannot safely apply this DDL automatically.

## Admin reporting

There is no FishEdge in-repo admin user list; Supabase's Auth Users screen should continue to label `last_sign_in_at` as authentication. Any FishEdge admin report should label this field **Last active (approx.)**, not **Last login**, and read it server-side with an appropriately protected admin credential.
