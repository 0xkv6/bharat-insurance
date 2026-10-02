import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// HDFC eKYC proxy - POST /partner/ekyc/getekycresponse.
// The Insurer header is always HDFC for this endpoint (per doc); we ignore
// any insurer field in the query or body. The body is passed through
// unchanged so all documented ekycType scenarios work without per-scenario
// branching here:
//   1. Pan Number                      (kycPan)
//   2. PAN + DOI                       (kycPan, kycDob)
//   3. Pan Number web-KYC initiation   (kycPan, ekycNumber, ReturnUrl, domain, ...)
//   4. KYC Id                          (kyc_id)
//   5. KYC Id + Date Of Birth          (kyc_id, kycDob)
//   6. Aadhar Number + Date Of Birth   (kycAadharNo, kycDob)
//   7. CIN + DOI                       (kycCinNo, kycDob)
//   8. CKYC NUMBER + DOI               (ckycNumber, kycDob)
//   9. kyc id (post-web-KYC fetch)     (transID, module, kyc_id)
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = req.body || {};
  if (!body.ekycType || typeof body.ekycType !== 'string') {
    return res.status(400).json({ error: 'body.ekycType is required' });
  }

  if (!envReady()) {
    return res.status(500).json({
      error: 'Swapinsurer credentials not configured',
      need: ['SWAPINSURER_CLIENT_NAME (or SIMSON_CLIENT_NAME)',
             'SWAPINSURER_USERNAME (or SIMSON_USERNAME)',
             'SWAPINSURER_PASSWORD (or SIMSON_PASSWORD)'],
    });
  }

  try {
    const { insurer: _drop, ...upstreamBody } = body;
    const r = await swapinsurer('/partner/ekyc/getekycresponse', {
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
