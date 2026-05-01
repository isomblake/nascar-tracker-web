# Rollback & Upgrade Paths

This is the escape hatch. Current state is **polling-based, free tier**. Every reversible decision
is documented here with the exact commands to flip it.

---

## Decision 5: Edge function JWT verification — disabled

**Current:** All three edge functions (`detect-session`, `poll-nascar`, `stop-session`) have
"Verify JWT with legacy secret" **OFF**.

**Why:** The Vercel env var `REACT_APP_SUPABASE_ANON_KEY` holds the new publishable key format
(`sb_publishable_*`), which is not a JWT. With verification on, every START tap returned
"Invalid JWT". The functions have no user identity to verify anyway — they use the service_role
key internally and are called by either pg_cron or the public PWA.

**To re-enable** (only needed if you switch to a legacy `eyJ*` anon key):
1. Dashboard → Functions → each function → Settings → toggle "Verify JWT with legacy secret" ON
2. Or via Management API:
   ```bash
   curl -X PATCH "https://api.supabase.com/v1/projects/ofqqgbgxoywnqoukvwth/functions/<slug>" \
     -H "Authorization: Bearer <sbp_PAT>" \
     -H "Content-Type: application/json" \
     -d '{"verify_jwt": true}'
   ```
   Repeat for detect-session, poll-nascar, stop-session.

---

## Decision 1: Polling vs Realtime

**Current:** PWA polls Supabase every 3s for lap/position data, every 15s for session discovery.
**Why:** Supabase free tier caps realtime messages at 2M/month. Kansas race alone burned 2.4M (119%).
Polling uses egress instead (5GB/mo allowance, plenty of headroom for single-user PWA).

### To restore realtime (requires Pro plan upgrade — $25/mo):

**Step 1:** Upgrade the Supabase org to Pro at
https://supabase.com/dashboard/org/mdlxwgmoptnrzeblubiy/billing

**Step 2:** Re-enable realtime publication on the tables:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE laps;
ALTER PUBLICATION supabase_realtime ADD TABLE positions;
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
```

**Step 3:** Revert the PWA to realtime mode — `git revert 3fe23c4` (the polling commit)
and push. Or cherry-pick the relevant block back into `src/useLiveSession.js`.

**When it'd be worth it:** if you add multiple users (friends watching the same session),
or if you start posting X threads mid-race and need the fastest possible update latency.
For solo use, the 3s polling latency is invisible — laps tick in every 20-45 seconds anyway.

---

## Decision 2: Cloud poller vs Desktop poller

**Current:** Supabase Edge Function `poll-nascar` runs every minute via `pg_cron`,
polls NASCAR every 5s while a session is active.
**Backup:** Desktop `race_tracker.py` on the HP — still installed, still functional.

### To disable cloud polling and use desktop only:

```sql
-- Pause the cron job (doesn't delete it)
UPDATE cron.job SET active = false WHERE jobname = 'poll-nascar-every-minute';
```

To re-enable later: same query with `active = true`.

### To permanently delete cloud poller:

```sql
SELECT cron.unschedule('poll-nascar-every-minute');
```

Then delete the three edge functions in the Supabase dashboard.

---

## Decision 3: Start/Stop button vs always-on

**Current:** Manual Start button on phone. `poll-nascar` exits immediately if no active session
(costs near-zero edge function invocations when idle — well within 500k/mo free tier).

### To make it always-on auto-detecting (less tapping, more background activity):

Modify `poll-nascar` to call the detection logic inline if no active session exists,
auto-starting whenever NASCAR is live. Costs ~43,200 invocations/month (once per minute).
Still within the 500k free tier.

Not worth doing unless the manual Start button becomes annoying.

---

## Decision 4: Scan window for race IDs

**Current:** `detect-session` scans race IDs 5605-5640 (36 IDs, ~3 seconds).
Kansas was 5607. Works for all of 2026 season if IDs stay sequential.

### When to widen:

If `detect-session` ever returns `no_live_session` during a session you know is live,
bump the constants in `supabase/functions/detect-session/index.ts`:

```ts
const SCAN_START = 5605;  // lower this
const SCAN_END = 5640;    // or raise this
```

Keep the window under ~60 IDs or the 3s HTTP timeout starts eating into legitimate scans.

---

## Usage Quota Monitoring

Check monthly:
- Realtime: https://supabase.com/dashboard/org/mdlxwgmoptnrzeblubiy/usage (should stay at 0 now)
- Egress: same page — ~2GB per race weekend expected with polling
- Edge function invocations: same page — ~45k/month with cron + manual starts
- DB size: same page — ~50MB per race, manageable

Billing cycle: 5th of each month.

---

## Nuclear Rollback: Back to Desktop-Only

If the cloud setup ever breaks during a race and you need to recover in 60 seconds:

1. On your HP desktop, `cd ~/Desktop/nascar-build-v2/nascar-build/backend`
2. Update `config.json` with today's `lap_times_url` and `track_name`
3. `py race_tracker.py`
4. Desktop tracker writes directly to Supabase (same tables), PWA still reads it

The cloud poller and desktop poller don't conflict — they write to the same tables
with upsert semantics. Either one working is enough to feed the PWA.
