import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// HDFC 4-wheeler proposal proxy -> POST /partner/motor/getcarproposal.
// Insurer header is always HDFC for this endpoint (per the HDFC four-wheeler
// proposal doc). Body must carry quote + carAddons + carQuoteResponse +
// proposal exactly as the doc specifies, including the intentionally
// misspelled field names (prevoius*, maritialValue, adhaarNumber,
// isVehcileFinance) — we pass the body through unchanged so the frontend is
// the single source of truth for the shape.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = req.body || {};
  if (!body.proposal || !body.quote || !body.carAddons) {
    return res.status(400).json({ error: 'body must have { quote, carAddons, carQuoteResponse, proposal }' });
  }
  if (!envReady()) {
    return res.status(500).json({ error: 'Swapinsurer credentials not configured' });
  }
  try {
    const { insurer: _drop, ...upstreamBody } = body;
    const r = await swapinsurer('/partner/motor/getcarproposal', {
      method: 'POST',
      body: upstreamBody,
      insurer: 'HDFC',
    });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
