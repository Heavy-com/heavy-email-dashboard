# Heavy / EntertainmentNow — Live Email Dashboard

A shareable, always-current view of Campaign Monitor performance. Lives alongside
the weekly report tool (v6) — this is the "anytime" view; the weekly tool stays
the formal RPM & Email Group deliverable.

## What it does

- Pulls all sent campaigns from Campaign Monitor for a selected window
  (7 / 14 / 28 days) plus the preceding equal window for comparison
- Classifies each campaign as **Sports (Heavy)** or **Entertainment
  (EntertainmentNow)** by naming patterns; **AhoraMismo is excluded**
- Summary cards with period-over-period deltas: campaigns, sends, open rate,
  total clicks, CTR (Total Clicks / Recipients, matching the weekly tool)
- Sortable per-campaign table; campaign names link to the web version
- 15-minute server-side cache so the whole team can hammer it without
  touching Campaign Monitor's ~1,000 calls/hour limit; "Refresh data"
  bypasses the cache

## Deploy (same flow as the newsroom dashboards)

1. Push this folder to a GitHub repo (or `vercel` from the CLI inside it)
2. Import the repo at vercel.com → New Project (framework preset: **Other**;
   no build step needed)
3. Add environment variables in Project → Settings → Environment Variables:

   | Variable | Value |
   |---|---|
   | `CM_API_KEY` | Campaign Monitor API key (Account Settings → API keys) |
   | `CM_CLIENT_ID` | The shared Heavy/EntertainmentNow client ID |
   | `DASHBOARD_PASSWORD` | *(optional)* any string — visitors will be prompted once per browser session |

4. Deploy. Done — e.g. `heavy-email-dashboard.vercel.app`

For tighter access control than `DASHBOARD_PASSWORD`, Vercel's built-in
Deployment Protection (password / Vercel Authentication) also works and
requires no code.

## Customizing brand classification

Edit the patterns at the top of `api/campaigns.js`:

```js
const EXCLUDE_PATTERNS = [ /ahora\s*mismo/i, /ahoramismo/i ];
const ENTERTAINMENT_PATTERNS = [ /entertainment/i, /entnow/i, /^EN[\s\-_:]/ ];
```

These are a starting guess — align them with the exact naming-pattern rules
from the v6 weekly tool so the two always agree. Anything not excluded and
not matching Entertainment is classified Sports.

## Notes & known limits

- **Clicks field**: the dashboard uses the `Clicks` value from
  `/campaigns/{id}/summary.json`. Verify against a known campaign that this
  matches the "Total Clicks" figure the weekly tool uses from CSV exports —
  if CM's summary turns out to report unique clicks instead, swap to summing
  the `/campaigns/{id}/clicks.json` endpoint (noting that costs one extra
  call per campaign).
- **Cache**: in-memory per serverless instance, 15-min TTL. Cold starts mean
  an occasional fresh pull; that's fine for the rate limit at this volume.
- **250-campaign cap** per request window as a rate-limit guard. At your send
  volume a 56-day window should fit comfortably; the UI warns if truncated.
- **Subscriber counts / list stats** aren't included yet — easy add via
  `GET /lists/{listId}/stats.json` if you want the list-directory numbers
  from the weekly tool here too.
