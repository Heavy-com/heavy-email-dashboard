# Heavy / EntertainmentNow — Live Email Dashboard

A shareable, always-current view of Campaign Monitor performance. Lives alongside
the weekly report tool (v6) — this is the "anytime" view; the weekly tool stays
the formal RPM & Email Group deliverable.

## What it does

- Pulls one fixed window of data: the **last 14 complete days** (today's
  in-flight sends always excluded). Both views are sliced from this single
  dataset, so switching views costs zero API calls:
  - **Last 7 full days** vs the prior 7 days
  - **Yesterday** vs the same weekday last week (avoids weekday noise)
- Classifies each campaign as **Heavy (Sports)** or **EntertainmentNow**
  by naming patterns; **AhoraMismo is excluded**
- Topline summary panels for both brands with WoW-style delta chips and an
  auto-generated narrative (volume, headline rates, top performers, and
  "worth watching" flags), then a sortable campaign detail table below.
  CTR = Total Clicks / Recipients, matching the weekly tool.

## Deploy (same flow as the newsroom dashboards)

1. Push this folder to a GitHub repo (or `vercel` from the CLI inside it)
2. Import the repo at vercel.com → New Project (framework preset: **Other**;
   no build step needed)
3. Add environment variables in Project → Settings → Environment Variables:

   | Variable | Value |
   |---|---|
   | `CM_API_KEY` | Campaign Monitor API key (Account Settings → API keys) |
   | `CM_CLIENT_ID` | The shared Heavy/EntertainmentNow client ID |
   | `REPORT_TIMEZONE` | *(optional)* IANA timezone defining "today"; defaults to `America/New_York`. Match your CM account timezone. |
   | `DASHBOARD_PASSWORD` | *(optional)* any string — visitors prompted once per browser session |

4. Deploy. Done — e.g. `heavy-email-dashboard.vercel.app`

For tighter access control than `DASHBOARD_PASSWORD`, Vercel's built-in
Deployment Protection (password / Vercel Authentication) also works with no code.

## Customizing brand classification

Edit the patterns at the top of `api/campaigns.js`:

```js
const EXCLUDE_PATTERNS = [ /ahora\s*mismo/i, /ahoramismo/i ];
const ENTERTAINMENT_PATTERNS = [
  /entertainment/i, /entnow/i,
  /now!/i,                   // the "...Now!" newsletter family
  /90s\s*tv\s*stars\s*now/i, // no exclamation mark on this one
  /hgtv/i,                   // "HGTV News!" doesn't follow the convention
];
```

Anything not excluded and not matching Entertainment is classified Sports.

## Rate-limit strategy (CM allows ~1,000 calls/hour)

1. **Per-campaign summary cache**: summaries for campaigns sent >48h ago are
   cached 6 hours; recent sends 15 minutes. Repeat loads are nearly free.
2. **Whole-response cache**: 10 minutes; "Refresh data" bypasses it. The cache
   key includes the window end date, so day rollover invalidates automatically.
3. **Day-stratified sampling**: if the 14-day window somehow exceeds the
   700-fresh-call budget, campaigns are sampled proportionally per day so every
   date stays represented. The UI states exactly how many were sampled out and
   that rates remain representative while totals are partial.

## Tuning the narrative

Flag thresholds live in `narrative()` in `index.html`: open rate −1pp,
CTR −0.25pp, bounce rate 2%, unsubscribes +50% over prior period. Adjust to
match what you'd actually flag in the weekly report.

## Notes & known limits

- **Clicks field**: uses `Clicks` from `/campaigns/{id}/summary.json`. Verify
  against a known campaign that this matches the weekly tool's "Total Clicks"
  from CSV exports; if CM's summary reports unique clicks instead, swap to
  summing `/campaigns/{id}/clicks.json` (one extra call per campaign).
- **Caches are in-memory** per serverless instance; a cold start re-pulls.
  If cold-start latency on the first morning load becomes annoying, Vercel KV
  is the upgrade path for a persistent summary cache.
- **Subscriber counts / list stats** aren't included yet — easy add via
  `GET /lists/{listId}/stats.json` if you want the list-directory numbers here.
