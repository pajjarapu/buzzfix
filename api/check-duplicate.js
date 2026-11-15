// BuzzFix · AI duplicate check (Vercel serverless function)
//
// POST /api/check-duplicate
// Body: { report: {description, category, building, room, lat, lng, photo?},
//         candidates: [{id, title, category, building, room, status, votes, ageDays, distanceM}] }
// Reply: { duplicateId: number|null, confidence: 0..1, reason: string, source: "claude" }
//
// Setup: add ANTHROPIC_API_KEY in Vercel → Project → Settings → Environment Variables.
// The key stays on the server; the browser never sees it.

const MODEL = 'claude-haiku-5-5';
const MAX_CANDIDATES = 12;

const SYSTEM = `You check whether a new campus maintenance report at Georgia Tech describes the SAME physical problem as one of the existing open reports nearby.

Count it as a duplicate only when it is the same problem at the same place: the same fixture, room, floor or entrance, even if worded differently (e.g. "room is freezing" vs "heat not working in 4th floor east wing").
It is NOT a duplicate when it is a different problem in the same building, the same kind of problem at a different spot, or when you cannot tell.
Use the building, room/floor, distance between pins, category and description. If a photo is attached, use it as extra evidence.

Reply with ONLY a JSON object, no other text:
{"duplicate_id": <id of the matching existing report, or null>, "confidence": <0 to 1>, "reason": "<one short, friendly sentence for the student explaining the match, or why there is none>"}`;

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const report = body && body.report;
  const candidates = Array.isArray(body && body.candidates) ? body.candidates.slice(0, MAX_CANDIDATES) : [];
  if (!report || !report.description) return res.status(400).json({ error: 'bad_request' });
  if (!candidates.length) return res.status(200).json({ duplicateId: null, confidence: 0, reason: 'No open reports nearby.', source: 'claude' });

  const clean = {
    new_report: {
      description: clip(report.description, 600),
      category: clip(report.category, 40),
      building: clip(report.building, 80),
      room_or_floor: clip(report.room, 80),
    },
    existing_open_reports: candidates.map(c => ({
      id: Number(c.id),
      description: clip(c.title, 300),
      category: clip(c.category, 40),
      building: clip(c.building, 80),
      room_or_floor: clip(c.room, 80),
      meters_from_new_report: Math.round(Number(c.distanceM) || 0),
      status: clip(c.status, 20),
      people_affected: Number(c.votes) || 0,
      reported_days_ago: Math.round((Number(c.ageDays) || 0) * 10) / 10,
    })),
  };

  const content = [];
  const m = typeof report.photo === 'string' && report.photo.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (m && m[2].length < 3_000_000) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  content.push({ type: 'text', text: JSON.stringify(clean, null, 1) });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content }] }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Anthropic API error', r.status, detail.slice(0, 500));
      return res.status(502).json({ error: 'upstream_error' });
    }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const json = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const ids = new Set(clean.existing_open_reports.map(c => c.id));
    const id = ids.has(Number(json.duplicate_id)) ? Number(json.duplicate_id) : null;
    const confidence = Math.max(0, Math.min(1, Number(json.confidence) || 0));
    return res.status(200).json({ duplicateId: id, confidence: id ? confidence : 0, reason: clip(json.reason, 240), source: 'claude' });
  } catch (e) {
    console.error('check-duplicate failed', e);
    return res.status(502).json({ error: 'upstream_error' });
  }
};
