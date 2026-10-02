import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// HDFC "get policy after payment" proxy -> POST /partner/motor/getpolicyafterpayment.
// Called after the payment gateway returns to /api/payment/hdfc-return with
// a successful payment. Body wraps identifiers in a `paramater` object
// (deliberate misspelling per the doc) with PascalCase field names for
// TransactionID / ProposalNumber / Amount.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = req.body || {};
  if (!body.paramater || typeof body.paramater !== 'object') {
    return res.status(400).json({ error: 'body must have a `paramater` object (note the doc spelling)' });
  }
  if (!envReady()) {
    return res.status(500).json({ error: 'Swapinsurer credentials not configured' });
  }
  try {
    const r = await swapinsurer('/partner/motor/getpolicyafterpayment', {
      method: 'POST',
      body,
      insurer: 'HDFC',
    });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
