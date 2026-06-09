// api/campaigns.js
// Vercel serverless function: pulls sent campaigns + per-campaign summaries
// from Campaign Monitor and returns classified, ready-to-render rows.
//
// Required environment variables (set in Vercel project settings):
//   CM_API_KEY    - Campaign Monitor API key
//   CM_CLIENT_ID  - Client ID (Heavy + EntertainmentNow share one)
// Optional:
//   DASHBOARD_PASSWORD - if set, requests must include header x-dashboard-key

const API = 'https://api.createsend.com/api/v3.3';

// ---------------------------------------------------------------------------
// BRAND CLASSIFICATION - edit these to match your campaign naming conventions.
// A campaign is checked against EXCLUDE first, then ENTERTAINMENT.
// Anything that doesn't match either is classified as Sports (Heavy).
// ---------------------------------------------------------------------------
const EXCLUDE_PATTERNS = [
  /ahora\s*mismo/i,
  /ahoramismo/i,
];

const ENTERTAINMENT_PATTERNS = [
  /entertainment/i,
  /entnow/i,
  /^EN[\s\-_:]/, // campaigns prefixed "EN - ..." etc.
];

function classify(name, subject) {
  const haystack = `${name || ''} ${subject || ''}`;
  if (EXCLUDE_PATTERNS.some((p) => p.test(haystack))) return 'excluded';
  if (ENTERTAINMENT_PATTERNS.some((p) => p.test(haystack))) return 'entertainment';
  return 'sports';
}

// ---------------------------------------------------------------------------
// In-memory cache (per warm serverless instance). 15 minute TTL keeps us far
// under Campaign Monitor's ~1,000 calls/hour limit even with heavy team use.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CAMPAIGNS = 250; // safety cap on summary fetches per request
const cache = new Map(); // key -> { ts, payload }

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

// CM SentDate looks like "2026-06-02 09:30" - normalize to a Date.
function parseSentDate(s) {
  return new Date(String(s).replace(' ', 'T'));
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// Fetch all sent campaigns in the window, paging as needed. Results come back
// newest-first, so we stop paging once we pass the start of the window.
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
    if (pastWindow) break;
    if (page >= (data.NumberOfPages || 1)) break;
    page += 1;
  }
  return out;
}

// Run async fn over items with limited concurrency (gentle on the rate limit).
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

    // Date window. Defaults to the last 56 days (enough for 4-week trends
    // plus the comparison period).
    const to = req.query.to
      ? new Date(`${req.query.to}T23:59:59`)
      : new Date();
    const from = req.query.from
      ? new Date(`${req.query.from}T00:00:00`)
      : new Date(Date.now() - 56 * 86400000);
    if (isNaN(from) || isNaN(to) || from > to) {
      return res.status(400).json({ error: 'Invalid from/to dates. Use YYYY-MM-DD.' });
    }

    const cacheKey = `${fmtDate(from)}|${fmtDate(to)}`;
    const forceRefresh = req.query.refresh === '1';
    const hit = cache.get(cacheKey);
    if (hit && !forceRefresh && Date.now() - hit.ts < CACHE_TTL_MS) {
      return res.status(200).json({ ...hit.payload, cachedAt: hit.ts, fromCache: true });
    }

    const sent = await fetchSentCampaigns(CM_API_KEY, CM_CLIENT_ID, from, to);
    const capped = sent.slice(0, MAX_CAMPAIGNS);

    const rows = await mapLimit(capped, 5, async (c) => {
      const brand = classify(c.Name, c.Subject);
      if (brand === 'excluded') return null;

      const s = await cmFetch(`${API}/campaigns/${c.CampaignID}/summary.json`, CM_API_KEY);
      const recipients = s.Recipients || 0;
      const uniqueOpens = s.UniqueOpened || 0;
      const totalOpens = s.TotalOpened || 0;
      const clicks = s.Clicks || 0;

      return {
        id: c.CampaignID,
        name: c.Name,
        subject: c.Subject,
        sentDate: parseSentDate(c.SentDate).toISOString(),
        brand,
        recipients,
        uniqueOpens,
        totalOpens,
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
      from: fmtDate(from),
      to: fmtDate(to),
      totalSentInWindow: sent.length,
      truncated: sent.length > MAX_CAMPAIGNS,
      campaigns: rows.filter(Boolean),
    };

    cache.set(cacheKey, { ts: Date.now(), payload });
    return res.status(200).json({ ...payload, cachedAt: Date.now(), fromCache: false });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
};
