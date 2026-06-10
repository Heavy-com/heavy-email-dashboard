// api/campaigns.js
// Vercel serverless function: pulls sent campaigns + per-campaign summaries
// from Campaign Monitor for an explicit current period AND the preceding
// equal-length comparison period, tags each campaign, and returns both.
//
// Required environment variables:
//   CM_API_KEY    - Campaign Monitor API key
//   CM_CLIENT_ID  - Client ID (Heavy + EntertainmentNow share one)
// Optional:
//   DASHBOARD_PASSWORD - if set, requests must include header x-dashboard-key

const API = 'https://api.createsend.com/api/v3.3';

// ---------------------------------------------------------------------------
// BRAND CLASSIFICATION
// ---------------------------------------------------------------------------
const EXCLUDE_PATTERNS = [
  /ahora\s*mismo/i,
  /ahoramismo/i,
];

const ENTERTAINMENT_PATTERNS = [
  /entertainment/i,
  /entnow/i,
  /now!/i,                   // the "...Now!" newsletter family
  /90s\s*tv\s*stars\s*now/i, // no exclamation mark on this one
  /hgtv/i,                   // "HGTV News!" doesn't follow the Now! convention
];

function classify(name, subject) {
  const haystack = `${name || ''} ${subject || ''}`;
  if (EXCLUDE_PATTERNS.some((p) => p.test(haystack))) return 'excluded';
  if (ENTERTAINMENT_PATTERNS.some((p) => p.test(haystack))) return 'entertainment';
  return 'sports';
}

// ---------------------------------------------------------------------------
// Rate-limit strategy. CM allows ~1,000 calls/hour. Two layers of defense:
//
// 1. Per-campaign summary cache. A summary for a campaign sent days ago
//    barely changes, so it's cached for 6 hours; recent sends (opens/clicks
//    still accruing) are cached for 15 minutes. Repeat loads and period
//    switches cost almost nothing.
// 2. A hard budget of fresh summary fetches per request. If the window
//    needs more than the budget allows, campaigns are dropped from the
//    MIDDLE of each period (newest + oldest kept) so BOTH periods stay
//    represented, and the response says exactly how many were skipped.
// ---------------------------------------------------------------------------
const SUMMARY_BUDGET = 700;                  // max fresh summary calls per request
const SUMMARY_TTL_RECENT = 15 * 60 * 1000;   // sent within last 48h
const SUMMARY_TTL_SETTLED = 6 * 60 * 60 * 1000;
const RESPONSE_TTL = 10 * 60 * 1000;         // whole-response cache

const summaryCache = new Map(); // campaignId -> { ts, ttl, summary }
const responseCache = new Map(); // key -> { ts, payload }

function cmHeaders(apiKey) {
  return {
    Authorization: 'Basic ' + Buffer.from(`${apiKey}:x`).toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function cmFetch(url, apiKey) {
  const r = await fetch(url, { headers: cmHeaders(apiKey) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Campaign Monitor ${r.status} on ${url.split('?')[0]}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

function parseSentDate(s) {
  return new Date(String(s).replace(' ', 'T'));
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// Fetch all sent campaigns from `from` to now, paging newest-first and
// stopping once results pass the start of the window. Date filtering is also
// done client-side so this works even if CM ignores the date params.
async function fetchSentCampaigns(apiKey, clientId, from, to) {
  const out = [];
  let page = 1;
  for (;;) {
    const url =
      `${API}/clients/${clientId}/campaigns.json` +
      `?page=${page}&pagesize=1000&orderfield=date&orderdirection=desc` +
      `&sentfromdate=${fmtDate(from)}&senttodate=${fmtDate(to)}`;
    const data = await cmFetch(url, apiKey);
    const results = data.Results || [];
    let pastWindow = false;
    for (const c of results) {
      const sent = parseSentDate(c.SentDate);
      if (sent < from) {
        pastWindow = true;
        break;
      }
      if (sent <= to) out.push(c);
    }
    if (pastWindow || results.length === 0) break;
    if (page >= (data.NumberOfPages || 1)) break;
    page += 1;
  }
  return out;
}

async function getSummary(apiKey, campaign) {
  const id = campaign.CampaignID;
  const hit = summaryCache.get(id);
  if (hit && Date.now() - hit.ts < hit.ttl) return { summary: hit.summary, fresh: false };

  const summary = await cmFetch(`${API}/campaigns/${id}/summary.json`, apiKey);
  const ageMs = Date.now() - parseSentDate(campaign.SentDate).getTime();
  const ttl = ageMs > 48 * 3600000 ? SUMMARY_TTL_SETTLED : SUMMARY_TTL_RECENT;
  summaryCache.set(id, { ts: Date.now(), ttl, summary });
  return { summary, fresh: true };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Keep `keep` items from a list, dropping from the middle (newest-first input:
// keeps the most recent and the oldest ends so period aggregates stay sane).
function trimMiddle(list, keep) {
  if (list.length <= keep) return { kept: list, dropped: 0 };
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return {
    kept: [...list.slice(0, head), ...list.slice(list.length - tail)],
    dropped: list.length - keep,
  };
}

module.exports = async (req, res) => {
  try {
    const { CM_API_KEY, CM_CLIENT_ID, DASHBOARD_PASSWORD } = process.env;
    if (!CM_API_KEY || !CM_CLIENT_ID) {
      return res.status(500).json({
        error: 'Server is missing CM_API_KEY or CM_CLIENT_ID environment variables.',
      });
    }
    if (DASHBOARD_PASSWORD && req.headers['x-dashboard-key'] !== DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 1), 60);

    // ---- Period boundaries, by calendar date, ending on the last COMPLETE
    // day. Today's in-flight sends are excluded so rates aren't dragged down
    // by partial data. All math is done on date strings (YYYY-MM-DD) to match
    // how Campaign Monitor reports SentDate (the client account's timezone).
    // REPORT_TIMEZONE controls what counts as "today" (default Eastern).
    const tz = process.env.REPORT_TIMEZONE || 'America/New_York';
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()); // "YYYY-MM-DD"

    function shiftDate(ymd, deltaDays) {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
    }

    const currentTo = shiftDate(todayStr, -1);                // yesterday (last full day)
    const currentFrom = shiftDate(currentTo, -(days - 1));    // inclusive
    const previousTo = shiftDate(currentFrom, -1);            // inclusive
    const previousFrom = shiftDate(currentFrom, -days);       // inclusive

    const cacheKey = `d${days}|${currentTo}`;
    const forceRefresh = req.query.refresh === '1';
    const hit = responseCache.get(cacheKey);
    if (hit && !forceRefresh && Date.now() - hit.ts < RESPONSE_TTL) {
      return res.status(200).json({ ...hit.payload, cachedAt: hit.ts, fromCache: true });
    }

    const sent = await fetchSentCampaigns(
      CM_API_KEY,
      CM_CLIENT_ID,
      new Date(`${previousFrom}T00:00:00`),
      new Date(`${currentTo}T23:59:59`)
    );

    // Classify, exclude AhoraMismo, and tag each campaign with its period by
    // calendar send date. Anything sent today (or outside the window) is dropped.
    const tagged = [];
    for (const c of sent) {
      const brand = classify(c.Name, c.Subject);
      if (brand === 'excluded') continue;
      const sentDateStr = String(c.SentDate).slice(0, 10);
      let period = null;
      if (sentDateStr >= currentFrom && sentDateStr <= currentTo) period = 'current';
      else if (sentDateStr >= previousFrom && sentDateStr <= previousTo) period = 'previous';
      if (!period) continue;
      tagged.push({
        raw: c,
        brand,
        sentAt: parseSentDate(c.SentDate),
        period,
      });
    }

    // Budget fresh summary fetches fairly across BOTH periods so the
    // comparison never silently collapses to zero.
    const curList = tagged.filter((t) => t.period === 'current');
    const prevList = tagged.filter((t) => t.period === 'previous');
    const cachedCount = tagged.filter(
      (t) => {
        const h = summaryCache.get(t.raw.CampaignID);
        return h && Date.now() - h.ts < h.ttl;
      }
    ).length;
    const budget = SUMMARY_BUDGET + cachedCount; // cached fetches are free

    let dropped = 0;
    let curKept = curList, prevKept = prevList;
    if (tagged.length > budget) {
      const half = Math.floor(budget / 2);
      const curShare = Math.min(curList.length, Math.max(half, budget - prevList.length));
      const prevShare = budget - curShare;
      const c = trimMiddle(curList, curShare);
      const p = trimMiddle(prevList, prevShare);
      curKept = c.kept; prevKept = p.kept;
      dropped = c.dropped + p.dropped;
    }

    const toFetch = [...curKept, ...prevKept];
    const rows = await mapLimit(toFetch, 5, async (t) => {
      const { summary: s } = await getSummary(CM_API_KEY, t.raw);
      const recipients = s.Recipients || 0;
      const uniqueOpens = s.UniqueOpened || 0;
      const clicks = s.Clicks || 0;
      return {
        id: t.raw.CampaignID,
        name: t.raw.Name,
        subject: t.raw.Subject,
        sentDate: t.sentAt.toISOString(),
        period: t.period,
        brand: t.brand,
        recipients,
        uniqueOpens,
        totalOpens: s.TotalOpened || 0,
        clicks,
        unsubscribes: s.Unsubscribed || 0,
        bounces: s.Bounced || 0,
        spamComplaints: s.SpamComplaints || 0,
        openRate: recipients ? uniqueOpens / recipients : 0,
        ctr: recipients ? clicks / recipients : 0,
        webVersionUrl: s.WebVersionURL || null,
      };
    });

    const payload = {
      days,
      currentPeriod: { from: currentFrom, to: currentTo },
      previousPeriod: { from: previousFrom, to: previousTo },
      counts: {
        current: curList.length,
        previous: prevList.length,
        droppedForRateLimit: dropped,
      },
      campaigns: rows,
    };

    responseCache.set(cacheKey, { ts: Date.now(), payload });
    return res.status(200).json({ ...payload, cachedAt: Date.now(), fromCache: false });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
};
