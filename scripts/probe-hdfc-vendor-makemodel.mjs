// Vendor shared HDFC_Make Model.xlsx (2026-10-13) with suggested make/model/
// variant/RTO combos they want validated on HDFC UAT (bike + car tracks).
// Rows are the vendor's recommended testing matrix; we iterate the full HDFC
// chain per row and tabulate the result.
//
// Full chain per combo:
//   Simson GetBike/CarVarient     (resolve exact variant string)
//   MIALTUS insertbike/carquote   (TP, validPolCopy=Yes, prev policy)
//   Swapinsurer getbike/carquote  (Insurer: HDFCTP)
//   Swapinsurer getekycresponse   (reuse known-good PAN)
//   Simson GetDetailsbyPincode    (resolve state/city for proposal)
//   Swapinsurer getbike/carproposal (Insurer: HDFC)
//
// Usage:  node scripts/probe-hdfc-vendor-makemodel.mjs
//           --only=bike|car           (optional, default: both)
//           --limit=N                 (optional, cap rows for a smoke run)
//           --failures-from=<json>    (optional, re-run only failed rows from prior JSON)
//           --html=<path>             (optional, emit per-call HTML log for vendor)
// Writes probe-hdfc-vendor-makemodel.json + probe-hdfc-vendor-makemodel.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

try {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch {}

const SIMSON_BASE  = process.env.SIMSON_BASE_URL      || 'https://swapmasteruat.getpolicy.in';
const MIALTUS_BASE = process.env.MIALTUS_BASE_URL     || 'https://uatswapapi.pushbutton.in';
const SWAPINS_BASE = process.env.SWAPINSURER_BASE_URL || 'https://swapinsureruat.getpolicy.in';
const CLIENT       = process.env.SIMSON_CLIENT_NAME   || 'MIALTUS';
const USERNAME     = process.env.SIMSON_USERNAME      || '';
const PASSWORD     = process.env.SIMSON_PASSWORD      || '';
const USER_CODE    = process.env.SIMSON_USER_CODE     || '3614';
const KYC_PAN      = process.env.HDFC_TEST_PAN        || 'BAPPN1467E';

if (!USERNAME || !PASSWORD) {
  console.error('Missing SIMSON_USERNAME / SIMSON_PASSWORD in .env.local');
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ONLY  = args.only || 'both';
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const FAILURES_FROM = args['failures-from'] || null;
const HTML_OUT      = args.html || null;

// ---------- capture layer (per-call req/res, for vendor-share HTML) ----------
const captures = [];
let currentRow = null;
const OK_STATUS = new Set(['proposal-ok']);

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    out[k] = /^authorization$/i.test(k) ? 'Bearer ***redacted***' : v;
  }
  return out;
}
function redactBody(b) {
  if (!b || typeof b !== 'object') return b;
  const c = JSON.parse(JSON.stringify(b));
  if (c.password) c.password = '***';
  if (c.Password) c.Password = '***';
  return c;
}

// ---------- Vendor combos (de-duped from HDFC_Make Model.xlsx 2026-10-13) ----------
// Shape: { make, model, variantHint, cc, rto }
// variantHint is used to pick the best match from GetBike/CarVarient output.

const bikeCombos = [
  { make: 'Suzuki',        model: 'Access',       variantHint: '125',               cc: '125', rto: 'TN01 (Chennai)' },
  { make: 'KTM',           model: 'Duke',         variantHint: '250',               cc: '250', rto: 'AP09 (Hyderabad)' },
  { make: 'Yamaha',        model: 'Fazer',        variantHint: '25',                cc: '249', rto: 'DL01 (New Delhi)' },
  { make: 'Royal Enfield', model: 'Bullet',       variantHint: '350',               cc: '350', rto: 'KA01 (Bengaluru)' },
  { make: 'Piaggio',       model: 'Vespa',        variantHint: 'Elegante',          cc: '125', rto: 'RJ14 (Jaipur)' },
  { make: 'Honda',         model: 'Activa',       variantHint: '3G',                cc: '109', rto: 'PB07 (Hoshiarpur)' },
  { make: 'Bajaj',         model: 'Aspire',       variantHint: 'STD',               cc: '100', rto: 'PB08 (Jalandhar)' },
  { make: 'KTM',           model: 'Duke',         variantHint: '200',               cc: '200', rto: 'TS15 (Medak)' },
  { make: 'Piaggio',       model: 'Vespa',        variantHint: 'Lx 125',            cc: '125', rto: 'UA10 (Uttarkashi)' },
  { make: 'Honda',         model: 'Aviator',      variantHint: 'Dlx',               cc: '110', rto: 'UK14 (Rishikesh)' },
  { make: 'Piaggio',       model: 'Vespa',        variantHint: 'Elegante',          cc: '125', rto: 'TN05 (Chennai)' },
  { make: 'Jawa',          model: 'Jawa',         variantHint: 'STD',               cc: '250', rto: 'UP16 (Noida)' },
  { make: 'Hero',          model: 'Pleasure',     variantHint: 'Self Start',        cc: '102', rto: 'GA12 (Ponda)' },
  { make: 'Suzuki',        model: 'Access',       variantHint: '125',               cc: '125', rto: 'CG01 (Raipur)' },
  { make: 'Suzuki',        model: 'Access',       variantHint: '125',               cc: '125', rto: 'CH01 (Chandigarh)' },
  { make: 'Honda',         model: 'Activa',       variantHint: 'Self Start',        cc: '110', rto: 'AS01 (Guwahati)' },
  { make: 'Hero',          model: 'Cd Deluxe',    variantHint: 'Self Start',        cc: '100', rto: 'AR01 (Papum Pare)' },
  { make: 'TVS',           model: 'Apache',       variantHint: 'Rr 310',            cc: '312', rto: 'BR01 (Patna)' },
  { make: 'Mahindra',      model: 'Duro',         variantHint: 'Scooter',           cc: '125', rto: 'JH01 (Ranchi)' },
  { make: 'Jawa',          model: 'Jawa',         variantHint: 'STD',               cc: '250', rto: 'WB08 (Kolkata)' },
  { make: 'LML',           model: 'Freedom',      variantHint: 'Std',               cc: '110', rto: 'TN14 (Chennai)' },
  { make: 'Royal Enfield', model: 'Bullet',       variantHint: '350',               cc: '350', rto: 'TS11 (Hyderabad)' },
  { make: 'KTM',           model: 'Duke',         variantHint: '250',               cc: '250', rto: 'AP36 (Warangal)' },
  { make: 'Yamaha',        model: 'Fazer',        variantHint: '25',                cc: '249', rto: 'GJ01 (Ahmedabad)' },
  { make: 'Honda',         model: 'Activa',       variantHint: '3G',                cc: '109', rto: 'MH01 (Mumbai)' },
  { make: 'Jawa',          model: 'Jawa',         variantHint: 'STD',               cc: '250', rto: 'WB01 (Kolkata)' },
  { make: 'Suzuki',        model: 'Access',       variantHint: '125',               cc: '125', rto: 'TN14 (Chennai)' },
];

// Car models in vendor master usually carry a "(Fuel)" suffix (e.g.
// "Amaze (Petrol)"); we normalize that during model resolution.
const carCombos = [
  { make: 'Honda',                 model: 'Brio',           variantHint: '1.2 E Manual Transmission',   cc: '1198', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'Honda',                 model: 'Amaze',          variantHint: '1.2 EX Manual Transmission',  cc: '1198', rto: 'KA01 (Bengaluru)', fuel: 'Petrol' },
  { make: 'Renault',               model: 'Kwid',           variantHint: '1.0 Captain America',         cc: '999',  rto: 'TN01 (Chennai)',  fuel: 'Petrol' },
  { make: 'Audi',                  model: 'A3',             variantHint: '40 TFSI Cabriolet',           cc: '1798', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'Toyota',                model: 'Innova Crysta',  variantHint: '2.7 GX AT 7 Seater',          cc: '2694', rto: 'RJ47 (Jaipur)',   fuel: 'Petrol' },
  { make: 'Mahindra And Mahindra', model: 'Scorpio',        variantHint: 'Rev 116',                     cc: '1998', rto: 'TR01 (West Tripura)', fuel: 'Petrol' },
  { make: 'Kia',                   model: 'Carens',         variantHint: '1.4 Luxury Petrol 7 Str',     cc: '1353', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'Honda',                 model: 'Amaze',          variantHint: '1.2 EX Manual Transmission',  cc: '1198', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'BMW',                   model: '3 Series',       variantHint: '316I',                        cc: '1596', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'Maruti',                model: '800',            variantHint: 'AC 4 Speed',                  cc: '796',  rto: 'WB22 (Kolkata)',  fuel: 'Petrol' },
  { make: 'BMW',                   model: '3 Series',       variantHint: '316I',                        cc: '1596', rto: 'PB65 (Mohali)',   fuel: 'Petrol' },
  { make: 'Mahindra',              model: 'Bolero',         variantHint: 'Camper Dx',                   cc: '2523', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'Volkswagen',            model: 'Polo',           variantHint: '1.0 MPI Highline Plus',       cc: '999',  rto: 'AP10 (Hyderabad)', fuel: 'Petrol' },
  { make: 'Skoda',                 model: 'Fabia',          variantHint: '1.2 Active Plus MPI',         cc: '1198', rto: 'HP20 (Una)',       fuel: 'Petrol' },
  { make: 'Volkswagen',            model: 'Polo',           variantHint: '1.0 MPI Highline Plus',       cc: '999',  rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
  { make: 'Maruti',                model: 'Swift',          variantHint: 'LXI',                         cc: '1197', rto: 'WB01 (Kolkata)',  fuel: 'Petrol' },
  { make: 'Tata',                  model: 'Nano',           variantHint: 'Base',                        cc: '624',  rto: 'TN14 (Chennai)',  fuel: 'Petrol' },
  { make: 'Volvo',                 model: 'Xc 90',          variantHint: '3.2 AWD',                     cc: '3192', rto: 'MH01 (Mumbai)',   fuel: 'Petrol' },
];

// ---------- helpers ----------
const toDMY = (s) => {
  const m = String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

async function auth(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ClientName': CLIENT, 'accept': '*/*' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch {
    console.error(`[auth] non-JSON response from ${url} (status ${r.status}): ${text.slice(0, 200)}`);
    return null;
  }
  return j.token || j.Token;
}

async function postJson(url, token, body, extraHeaders = {}, step = '') {
  const t0 = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'accept': '*/*',
    'ClientName': CLIENT,
    'Authorization': `Bearer ${token}`,
    ...extraHeaders,
  };
  const entry = {
    row: currentRow,
    ts: new Date().toISOString(),
    step,
    url,
    method: 'POST',
    reqHeaders: redactHeaders(headers),
    reqBody: redactBody(body),
  };
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    entry.status = r.status;
    entry.resBody = data;
    entry.ms = Date.now() - t0;
    captures.push(entry);
    return { status: r.status, data };
  } catch (e) {
    entry.err = String(e.message || e);
    entry.status = 0;
    entry.ms = Date.now() - t0;
    captures.push(entry);
    return { status: 0, data: null, err: entry.err };
  }
}

// Pick the closest-matching variant from a list of {variant} rows.
// Priority: exact substring of hint > any token overlap > first row.
function pickVariant(rows, hint) {
  if (!rows.length) return null;
  const needle = String(hint || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return rows[0].variant || rows[0].Variant;
  // Pass 1: variant contains the whole hint
  for (const r of rows) {
    const v = String(r.variant || r.Variant || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (v.includes(needle)) return r.variant || r.Variant;
  }
  // Pass 2: all hint tokens appear in the variant
  const tokens = String(hint || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const r of rows) {
    const v = String(r.variant || r.Variant || '').toLowerCase();
    if (tokens.every(t => v.includes(t))) return r.variant || r.Variant;
  }
  // Pass 3: fallback — first
  return rows[0].variant || rows[0].Variant;
}

// Synthesize a plausible vehicle number from the RTO code.
// e.g. "TN01 (Chennai)" → "TN-01-NT-5588"
function regFromRto(rto) {
  const m = String(rto || '').match(/^([A-Z]{2})(\d{1,2})/);
  if (!m) return 'MH-12-NT-5588';
  return `${m[1]}-${m[2].padStart(2,'0')}-NT-5588`;
}

// Parse "MH-12-NT-5588" into { regA, regB, regC, regD }
function splitReg(reg) {
  const s = String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/);
  return { regA: m?.[1] || '', regB: m?.[2] || '', regC: m?.[3] || '', regD: m?.[4] || '' };
}

// ---------- auth once ----------
console.log('Authenticating…');
const simsonTok  = await auth(`${SIMSON_BASE}/Authentication/token`,      { Username: USERNAME, Password: PASSWORD });
const mialtusTok = await auth(`${MIALTUS_BASE}/Authentication/token`,     { username: USERNAME, password: PASSWORD });
const swapTok    = await auth(`${SWAPINS_BASE}/Partner/Authentication/token`, { username: USERNAME, password: PASSWORD });
if (!simsonTok || !mialtusTok || !swapTok) {
  console.error('Auth failed', { simson: !!simsonTok, mialtus: !!mialtusTok, swap: !!swapTok });
  process.exit(1);
}
console.log('Auth OK\n');

// ---------- resolve car model (Simson adds "(Fuel)" suffix) ----------
const carModelCache = new Map();  // key = make → list of {model}
async function resolveCarModel(make, modelHint, fuel) {
  const key = make.toLowerCase();
  if (!carModelCache.has(key)) {
    const { data } = await postJson(`${SIMSON_BASE}/Motor/GetCarModelApp`, simsonTok, { Make: make, make }, {}, 'GetCarModelApp');
    carModelCache.set(key, Array.isArray(data) ? data : []);
  }
  const list = carModelCache.get(key);
  const want = modelHint.toLowerCase();
  const fuelRe = new RegExp(`\\(${fuel}\\)`, 'i');
  // Prefer "<Model> (Fuel)" exact match, then any model with the fuel suffix,
  // then any model starting with the hint.
  const hit = list.find(m => new RegExp(`^${modelHint}\\s*\\(${fuel}\\)`, 'i').test(m.model || ''))
    || list.find(m => fuelRe.test(m.model || '') && (m.model || '').toLowerCase().includes(want))
    || list.find(m => (m.model || '').toLowerCase().startsWith(want));
  return hit?.model || `${modelHint} (${fuel})`;
}

// ---------- variant lookup wrappers ----------
async function listBikeVariants(make, model, cc) {
  const { data } = await postJson(`${SIMSON_BASE}/Motor/GetBikeVarient`, simsonTok, {
    Make: make, make, Model: model, model, Cc: cc, cc,
  }, {}, `GetBikeVarient (${make}/${model}/${cc||'—'})`);
  return Array.isArray(data) ? data : [];
}
async function listCarVariants(make, model, cc) {
  const { data } = await postJson(`${SIMSON_BASE}/Motor/GetCarVarient`, simsonTok, {
    Make: make, make, Model: model, model, Cc: cc, cc,
  }, {}, `GetCarVarient (${make}/${model}/${cc||'—'})`);
  return Array.isArray(data) ? data : [];
}

// ---------- bike probe ----------
async function probeBike(combo) {
  const variants = await listBikeVariants(combo.make, combo.model, combo.cc);
  if (!variants.length) {
    // Retry without cc filter — vendor master sometimes stores canonical cc only
    const alt = await listBikeVariants(combo.make, combo.model, '');
    if (!alt.length) return { status: 'no-variants', detail: `master has no variants for ${combo.make}/${combo.model}` };
    variants.push(...alt);
  }
  const variant = pickVariant(variants, combo.variantHint);
  const reg = regFromRto(combo.rto);
  const regDate = toDMY('2017-07-01');
  const PREV_EXPIRY = toDMY('2026-11-30');

  const insertBody = {
    quote: {
      coverType: 'TP', make: combo.make, model: combo.model, variant, rto: combo.rto, regDate,
      mfgMonth: '07', mfgYear: '2017',
      fullname: 'Test Customer', mobile: '9798798797', email: 'test@gmail.com',
      vehicleOwnedBy: 'I', validPolCopy: 'Yes',
      isPreClaimed: 'No', ownershipChange: 'No', preNCB: '',
      vehicleNo: reg,
      previousInsurer: 'ICICI  LOMBARD',
      prepolExpiryDate: PREV_EXPIRY,
      prevoiusPolicyNumber: 'TEST-PREV-POL-123',
      policyType: 'renew',
      previousYearPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
      tpprepolExpiryDate: null,
    },
    bikeAddons: {
      paTenure: '1', isCPACover: true, isNoCPAReason: '',
      paidDriver: false, accidentCoPassenger: false, accidentCoPassengerValue: 0,
      tppd: false, TPPDSI: '0', llPaidDriverCheck: '', llPaidDriverValue: '',
    },
    userCode: USER_CODE,
  };
  const ins = await postJson(`${MIALTUS_BASE}/partner/motor/insertbikequote`, mialtusTok, insertBody, { Server: 'UAT' }, 'insertbikequote (MIALTUS)');
  const transId = ins.data?.transId || ins.data?.TransId;
  if (!transId) return { variant, status: 'insert-failed', detail: String(ins.data?.message || JSON.stringify(ins.data)).slice(0, 160) };

  const gBody = JSON.parse(JSON.stringify(insertBody));
  gBody.quote.quoteId = String(transId);
  gBody.quote.seatingCapacity = '2';
  const q = await postJson(`${SWAPINS_BASE}/partner/bike/getbikequote`, swapTok, gBody, { Server: 'UAT', Insurer: 'HDFCTP' }, 'getbikequote (HDFCTP)');
  if (q.data?.errorStatus === true || q.data?.errorStatus === 'true') {
    return { variant, transId, status: 'quote-failed', detail: String(q.data?.errorText || q.data?.errorMessage || '').slice(0, 160) };
  }
  const premium = Number(q.data?.payablePremium);
  if (!premium) return { variant, transId, status: 'quote-zero', detail: 'payablePremium=0' };

  const ek = await postJson(`${SWAPINS_BASE}/partner/ekyc/getekycresponse`, swapTok, {
    transId: String(transId), ekycInsurer: 'hdfc', module: 'bike', vehicleOwnedBy: 'I',
    kycEmail: 'test@gmail.com', kycName: 'Test Customer', kycPan: KYC_PAN,
    ekycType: 'Pan Number', idVerificationDocType: 'Pan Number',
    ekycNumber: KYC_PAN, customerType: 'I', isKYCDone: false, email: 'test@gmail.com',
    ReturnUrl: 'https://www.bharatinsurance.online/?kyc_return=1',
    domain: 'https://www.bharatinsurance.online/',
  }, { Server: 'UAT', Insurer: 'HDFC' }, 'getekycresponse (HDFC bike)');
  if (!ek.data?.isVerified) return { variant, transId, premium, status: 'ekyc-failed', detail: 'isVerified=false' };

  const kycData = typeof ek.data.kycData === 'string' ? JSON.parse(ek.data.kycData || '{}') : (ek.data.kycData || {});
  const pincode = String(kycData.permanentPincode || '209721');
  const pin = await postJson(`${SIMSON_BASE}/Motor/GetDetailsbyPincode`, simsonTok, { pincode, company: 'HDFC' }, {}, `GetDetailsbyPincode (${pincode})`);
  const pm = Array.isArray(pin.data) ? (pin.data[0] || {}) : (pin.data || {});

  const { regA, regB, regC, regD } = splitReg(reg);
  const kycName = ek.data.fullName || 'Test Customer';
  const [firstName, ...rest] = kycName.split(/\s+/);
  const lastName = rest.join(' ') || 'Customer';
  const propDob = ek.data.kycDob || toDMY('1990-01-01');

  const proposal = {
    salutation: 'Mr', pTransactionId: q.data.pTransactionId || String(transId),
    paymentNumber: null, bankrefnum: null, paymentStatus: null,
    referenceNumber: null, refProposal: null, isAngular: true,
    fullname: kycName, firstName, lastName, dob: propDob,
    email: 'TEST@GMAIL.COM', mobile: '9798798797', landLine: '',
    panCard: KYC_PAN, gender: 'Male',
    maritialValue: 'Divorced', maritialText: 'Divorced',
    occupationValue: 'Retired', tyreRimNo: '', occupationText: 'Retired',
    gstNo: '', adhaarNumber: '',
    nomineefullname: 'DFGDFGDF DFDFGDFDF', nomineeFname: 'DFGDFGDF', nomineeLname: 'DFDFGDFDF',
    nomineeDob: toDMY('1999-11-11'),
    relationshipValue: 'Daughter', relationshipText: 'Daughter',
    orgName: kycName, vehicleOwnedBy: 'I',
    rto: combo.rto, regA, regB, regC, regD, regDate,
    engineNo: 'GT4534YTERGF34TG342', chassisNo: '234TG34VDFGREG34',
    isVehcileFinance: false, financeCity: '',
    isPuc: false, pucNo: '', pucExpiryDate: null,
    inspectionTid: '', transactionRef: '',
    prevoiusInsurerValue: 'CHOLAMANDALAM', prevoiusInsurerText: 'Cholamandalam MS General Insurance',
    prevoiusPolicyNumber: '34T34TGEG334G',
    prevoiusPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
    pdfLink: '', base64PDF: '',
    prevoiusPolicyExpiryDate: PREV_EXPIRY,
    tpPolicyExpiryDate: null, tpPolicyNumber: '',
    tpprevoiusInsurerValue: 'CHOLAMANDALAM', tpprevoiusInsurerText: 'Cholamandalam MS General Insurance',
    policyType: 'renew',
    addrL1: kycData.permanentAddress1 || 'noida', addrL2: kycData.permanentAddress2 || 'noida',
    landmark: '',
    stateName: String(pm.statename || 'UTTAR PRADESH').toUpperCase(), stateCode: String(pm.statecode || '24'),
    cityName:  String(pm.cityname  || 'KANNAUJ').toUpperCase(),       cityCode:  String(pm.citycode  || '469'),
    pincode, areaName: '', areaCode: '', isSameAddressChecked: true,
    rcLandmark: '', rcAddrL1: kycData.permanentAddress1 || 'noida', rcAddrL2: kycData.permanentAddress2 || 'noida',
    rcStateName: String(pm.statename || 'UTTAR PRADESH').toUpperCase(), rcStateCode: String(pm.statecode || '24'),
    rcCityName:  String(pm.cityname  || 'KANNAUJ').toUpperCase(),       rcCityCode:  String(pm.citycode  || '469'),
    rcPincode: pincode, rcAreaName: '', rcAreaCode: '',
    cpaPolicyNo: '', cpaSuminsured: '', cpaPreinsurer: '', cpaPreinsurerName: '',
    cpaPolicyFromdate: null, cpaPolicyTodate: null,
    make: combo.make, model: combo.model, variant,
    idv: '0', coverType: 'tponly',
    mfgYear: '2017', mfgMonth: '07',
    transId: String(transId), quoteId: String(transId),
    logo: '', netPremium: String(q.data.netPremium || ''), payablePremium: String(q.data.payablePremium || ''),
    serviceTax: String(q.data.serviceTax || ''), insurerName: 'hdfc',
    saveForLater: '', typeofButon: '', transSavelaterText: '', transSaveLater: '',
    termsCondition: 'true',
    callbackurl: 'https://www.bharatinsurance.online/privateBike/hdfcbiketransaction',
    proposerLink: '', stage: '6',
    polStartDateToSaiba: q.data.policystartDate || '', polEndDateToSaiba: q.data.policyEndDate || '',
    tPexpiryDateToSaiba: q.data.policyEndDate || '',
    policyStartDate: q.data.policystartDate || '', policyEndDate: q.data.policyEndDate || '',
    currentNCB: q.data.currentNCB || 'NA',
    seatCapacity: '', policyStatus: 'Inforce',
    proposalPDFHTML: '',
    domainName: 'https://www.bharatinsurance.online/',
    InsureAPIDomainName: 'https://www.bharatinsurance.online/',
    ClientDomainName: 'https://www.bharatinsurance.online/',
    odYear: '', isRenewalPolicy: false,
    insuredFullName: kycName,
    tp: Number(q.data.totalTPCalculated || q.data.thirdPartyPremium || 0), od: 0,
    cc: variant, fuel: 'Petrol',
    coverNote: '', refBy: null, saibaAutoid: '', custCode: '',
    zone: q.data.zone || 'A',
    enquiryID: '', applicationId: '',
    ckycNumber: ek.data.ckycNumber || '', insuredPolicyNumber: '', inspectiontype: '',
    share_EmailID: null, share_MobileNo: '', paymentTinyURL: null,
    isKYCDone: true, isKYC: 'No',
    kycPan: KYC_PAN, kycDob: propDob, policy_Gen_Flag: '',
    addressVerificationDocExt: null, eky_Id: ek.data.eky_Id || '',
    photoupload: null, photoDocExt: null, photouploadFileName: null,
    idVerificationDocType: null, idVerificationDocId: null, idVerificationDocExt: null,
    idProofupload: null, addreesProofupload: null,
    addressVerificationDocType: null, addressVerificationDocId: null,
    kycStatus: null, otp: null, isSaveLater: null,
    lvTransactionIDGlobal: null, fatherName: null,
    insured_photoExt: null, paNorForm60: null,
    pan_Form60_Document: null, pan_Form60_Document_Ext: null,
  };
  const propBody = {
    quote: gBody.quote,
    bikeAddons: gBody.bikeAddons,
    quoteResponseBike: q.data,
    proposal,
    bikeProposal: proposal,
  };
  const pr = await postJson(`${SWAPINS_BASE}/partner/bike/getbikeproposal`, swapTok, propBody, { Server: 'UAT', Insurer: 'HDFC' }, 'getbikeproposal (HDFC)');
  if (pr.data?.proposalNo) {
    return { variant, transId, premium, status: 'proposal-ok', detail: `proposalNo ${pr.data.proposalNo}` };
  }
  const err = String(pr.data?.errorMessage || '').replace(/[\r\n\\]+/g, ' ').slice(0, 160);
  return { variant, transId, premium, status: 'proposal-failed', detail: err || JSON.stringify(pr.data).slice(0, 160) };
}

// ---------- car probe ----------
async function probeCar(combo) {
  const resolvedModel = await resolveCarModel(combo.make, combo.model, combo.fuel);
  let variants = await listCarVariants(combo.make, resolvedModel, combo.cc);
  if (!variants.length) {
    const alt = await listCarVariants(combo.make, resolvedModel, '');
    if (!alt.length) return { resolvedModel, status: 'no-variants', detail: `master has no variants for ${combo.make}/${resolvedModel}` };
    variants = alt;
  }
  const variant = pickVariant(variants, combo.variantHint);
  const reg = regFromRto(combo.rto);
  const regDate = toDMY('2019-05-09');
  const PREV_EXPIRY = toDMY('2026-09-30');

  const insertBody = {
    quote: {
      coverType: 'TP', make: combo.make, model: resolvedModel, variant, rto: combo.rto, regDate,
      mfgMonth: '05', mfgYear: '2019',
      fullname: 'Test Customer', mobile: '9798798797', email: 'test@gmail.com',
      vehicleOwnedBy: 'I', validPolCopy: 'Yes',
      isPreClaimed: 'No', ownershipChange: 'No', preNCB: '',
      vehicleNo: reg,
      previousInsurer: 'HDFC ERGO General Insurance',
      prepolExpiryDate: PREV_EXPIRY,
      prevoiusPolicyNumber: 'hfhe45uy3h34y34y6',
      seatingCapacity: '5',
      policyType: 'renewcar',
      previousYearPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
    },
    carAddons: {
      paTenure: '1', isCPACover: true, isNoCPAReason: '',
      paidDriver: false, accidentCoPassenger: false, accidentCoPassengerValue: 0,
      externallyCng: false, externallycngValue: 0, tppd: false,
    },
    userCode: USER_CODE,
  };
  const ins = await postJson(`${MIALTUS_BASE}/partner/motor/insertcarquote`, mialtusTok, insertBody, { Server: 'UAT' }, 'insertcarquote (MIALTUS)');
  const transId = ins.data?.transId || ins.data?.TransId;
  if (!transId) return { resolvedModel, variant, status: 'insert-failed', detail: String(ins.data?.message || JSON.stringify(ins.data)).slice(0, 160) };

  const gBody = JSON.parse(JSON.stringify(insertBody));
  gBody.quote.quoteId = String(transId);
  const q = await postJson(`${SWAPINS_BASE}/partner/motor/getcarquote`, swapTok, gBody, { Server: 'UAT', Insurer: 'HDFCTP' }, 'getcarquote (HDFCTP)');
  if (q.data?.errorStatus === true || q.data?.errorStatus === 'true') {
    return { resolvedModel, variant, transId, status: 'quote-failed', detail: String(q.data?.errorText || q.data?.errorMessage || '').slice(0, 160) };
  }
  const premium = Number(q.data?.payablePremium);
  if (!premium) return { resolvedModel, variant, transId, status: 'quote-zero', detail: 'payablePremium=0' };

  const ek = await postJson(`${SWAPINS_BASE}/partner/ekyc/getekycresponse`, swapTok, {
    transId: String(transId), ekycInsurer: 'hdfc', module: 'car', vehicleOwnedBy: 'I',
    kycEmail: 'test@gmail.com', kycName: 'Test Customer', kycPan: KYC_PAN,
    ekycType: 'Pan Number', idVerificationDocType: 'Pan Number',
    ekycNumber: KYC_PAN, customerType: 'I', isKYCDone: false, email: 'test@gmail.com',
    ReturnUrl: 'https://www.bharatinsurance.online/?kyc_return=1',
    domain: 'https://www.bharatinsurance.online/',
  }, { Server: 'UAT', Insurer: 'HDFC' }, 'getekycresponse (HDFC car)');
  if (!ek.data?.isVerified) return { resolvedModel, variant, transId, premium, status: 'ekyc-failed', detail: 'isVerified=false' };
  const kycData = typeof ek.data.kycData === 'string' ? JSON.parse(ek.data.kycData || '{}') : (ek.data.kycData || {});
  const pincode = String(kycData.permanentPincode || '209721');
  const pin = await postJson(`${SIMSON_BASE}/Motor/GetDetailsbyPincode`, simsonTok, { pincode, company: 'HDFC' }, {}, `GetDetailsbyPincode (${pincode})`);
  const pm = Array.isArray(pin.data) ? (pin.data[0] || {}) : (pin.data || {});

  const { regA, regB, regC, regD } = splitReg(reg);
  const kycName = ek.data.fullName || 'Test Customer';
  const [firstName, ...rest] = kycName.split(/\s+/);
  const lastName = rest.join(' ') || 'Customer';
  const dob = ek.data.kycDob || toDMY('1990-01-01');

  const proposalBlock = {
    salutation: 'Mr',
    pTransactionId: q.data.pTransactionId || String(transId),
    firstName, lastName, dob,
    email: 'TEST@GMAIL.COM', mobile: '9798798797', panCard: KYC_PAN, gender: 'Male',
    maritialValue: 'Single', maritialText: 'Single',
    occupationValue: 'Govt. Service', occupationText: 'Govt. Service',
    gstNo: '', adhaarNumber: '',
    nomineeFname: 'Priya', nomineeLname: 'Singh',
    nomineeDob: toDMY('1995-06-15'),
    relationshipValue: 'Daughter', relationshipText: 'Daughter',
    vehicleOwnedBy: 'I',
    rto: combo.rto, regA, regB, regC, regD, regDate,
    engineNo: 'DF34T34444ERY45UY45Y', chassisNo: 'FGHFGHRTYH54Y5Y5Y5',
    isVehcileFinance: false, financeCity: '',
    isPuc: false, pucNo: '', pucExpiryDate: null,
    prevoiusInsurerValue: 'CHOLAMANDALAM',
    prevoiusInsurerText: 'Cholamandalam MS General Insurance',
    prevoiusPolicyNumber: 'hfhe45uy3h34y34y6',
    prevoiusPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
    prevoiusPolicyExpiryDate: PREV_EXPIRY,
    policyType: 'renewcar',
    addrL1: kycData.permanentAddress1 || 'noidadfgdf',
    addrL2: kycData.permanentAddress2 || 'noidagdfgdf',
    landmark: '',
    stateName: String(pm.statename || 'UTTAR PRADESH').toUpperCase(), stateCode: String(pm.statecode || ''),
    cityName:  String(pm.cityname  || 'KANNAUJ').toUpperCase(),       cityCode:  String(pm.citycode  || ''),
    pincode, isSameAddressChecked: true,
    rcLandmark: '', rcAddrL1: kycData.permanentAddress1 || 'noidadfgdf', rcAddrL2: kycData.permanentAddress2 || 'noidagdfgdf',
    rcStateName: String(pm.statename || 'UTTAR PRADESH').toUpperCase(), rcStateCode: String(pm.statecode || ''),
    rcCityName:  String(pm.cityname  || 'KANNAUJ').toUpperCase(),       rcCityCode:  String(pm.citycode  || ''),
    rcPincode: pincode,
    make: combo.make, model: resolvedModel, variant,
    idv: '0', coverType: 'TPOnly',
    mfgYear: '2019', mfgMonth: '05',
    transId: String(transId),
    netPremium: String(q.data.netPremium || ''), payablePremium: String(q.data.payablePremium || ''),
    serviceTax: String(q.data.serviceTax || ''), insurerName: 'hdfc',
    termsCondition: 'true',
    callbackurl: 'https://www.bharatinsurance.online/privateCar/hdfccartransaction',
    polStartDateToSaiba: q.data.policystartDate || '', polEndDateToSaiba: q.data.policyEndDate || '',
    seatCapacity: '5', cc: String(combo.cc),
    ckycNumber: ek.data.ckycNumber || '', isKYCDone: true, kycPan: KYC_PAN, kycDob: dob, eky_Id: ek.data.eky_Id || '',
  };
  const propBody = {
    quote: gBody.quote,
    carAddons: gBody.carAddons,
    carQuoteResponse: q.data,
    proposal: proposalBlock,
  };
  const pr = await postJson(`${SWAPINS_BASE}/partner/motor/getcarproposal`, swapTok, propBody, { Server: 'UAT', Insurer: 'HDFC' }, 'getcarproposal (HDFC)');
  if (pr.data?.proposalNo || pr.data?.ProposalNo) {
    return { resolvedModel, variant, transId, premium, status: 'proposal-ok', detail: `proposalNo ${pr.data.proposalNo || pr.data.ProposalNo}` };
  }
  const err = String(pr.data?.errorMessage || pr.data?.ErrorMessage || '').replace(/[\r\n\\]+/g, ' ').slice(0, 160);
  return { resolvedModel, variant, transId, premium, status: 'proposal-failed', detail: err || JSON.stringify(pr.data).slice(0, 160) };
}

// ---------- run ----------
const results = { bikes: [], cars: [] };
const flag = s => s === 'proposal-ok' ? '✅' : (s === 'proposal-failed' || s === 'quote-failed' || s === 'insert-failed' || s === 'ekyc-failed') ? '❌' : '⏭ ';

async function runRow(kind, combo, probe) {
  const label = `${combo.make.padEnd(16)} / ${combo.model.padEnd(16)} / ${(combo.variantHint||'').padEnd(28)} / ${combo.rto.padEnd(22)}`;
  currentRow = { kind: kind.trim(), make: combo.make, model: combo.model, variantHint: combo.variantHint, cc: combo.cc, rto: combo.rto };
  process.stdout.write(`  ${kind} ${label} `);
  try {
    const r = await probe(combo);
    const row = { ...combo, ...r };
    console.log(`${flag(r.status)} ${r.status.padEnd(16)} ${(r.detail||'').slice(0,120)}`);
    return row;
  } catch (e) {
    console.log(`💥 exception: ${e.message}`);
    return { ...combo, status: 'exception', detail: String(e.message || e) };
  } finally {
    currentRow = null;
  }
}

// Load failed rows from a prior probe JSON — matches by (make, model, variantHint, cc, rto).
function filterFromFailures(all, prior, kind) {
  const priorFails = (prior?.[kind + 's'] || []).filter(r => !OK_STATUS.has(r.status));
  const keys = new Set(priorFails.map(r => `${r.make}|${r.model}|${r.variantHint}|${r.cc}|${r.rto}`));
  return all.filter(c => keys.has(`${c.make}|${c.model}|${c.variantHint}|${c.cc}|${c.rto}`));
}

let priorResults = null;
if (FAILURES_FROM) {
  priorResults = JSON.parse(readFileSync(join(ROOT, FAILURES_FROM), 'utf8'));
  console.log(`Filtering to failures from ${FAILURES_FROM}`);
}

const bikeRun = priorResults ? filterFromFailures(bikeCombos, priorResults, 'bike') : bikeCombos;
const carRun  = priorResults ? filterFromFailures(carCombos,  priorResults, 'car')  : carCombos;

if (ONLY === 'both' || ONLY === 'bike') {
  console.log(`\n== BIKES (${Math.min(bikeRun.length, LIMIT)}) ==`);
  for (const c of bikeRun.slice(0, LIMIT)) {
    results.bikes.push(await runRow('BIKE', c, probeBike));
    await new Promise(r => setTimeout(r, 400));
  }
}
if (ONLY === 'both' || ONLY === 'car') {
  console.log(`\n== CARS (${Math.min(carRun.length, LIMIT)}) ==`);
  for (const c of carRun.slice(0, LIMIT)) {
    results.cars.push(await runRow('CAR ', c, probeCar));
    await new Promise(r => setTimeout(r, 400));
  }
}

writeFileSync(join(ROOT, 'probe-hdfc-vendor-makemodel.json'), JSON.stringify(results, null, 2));

// ---------- markdown summary ----------
function mdTable(rows, kind) {
  const header = kind === 'bike'
    ? '| # | Make | Model | Variant (resolved) | CC | RTO | Status | Detail |\n|-:|:-|:-|:-|-:|:-|:-|:-|'
    : '| # | Make | Model (resolved) | Variant (resolved) | CC | RTO | Status | Detail |\n|-:|:-|:-|:-|-:|:-|:-|:-|';
  const body = rows.map((r, i) => {
    const model = kind === 'car' ? (r.resolvedModel || r.model) : r.model;
    return `| ${i+1} | ${r.make} | ${model} | ${r.variant || r.variantHint || '—'} | ${r.cc} | ${r.rto} | ${r.status} | ${(r.detail||'').replace(/\|/g,'\\|')} |`;
  }).join('\n');
  return header + '\n' + body;
}
const bikeOk  = results.bikes.filter(r => r.status === 'proposal-ok').length;
const carOk   = results.cars.filter(r => r.status === 'proposal-ok').length;
const md = `# HDFC vendor make/model probe — ${new Date().toISOString().slice(0,10)}

Source: \`Third Party API Docs/HDFC_Make Model.xlsx\` (de-duped).

## Totals

- Bikes: ${bikeOk}/${results.bikes.length} proposal-ok
- Cars:  ${carOk}/${results.cars.length} proposal-ok

## Bikes

${mdTable(results.bikes, 'bike')}

## Cars

${mdTable(results.cars, 'car')}
`;
writeFileSync(join(ROOT, 'probe-hdfc-vendor-makemodel.md'), md);

console.log('\n' + '='.repeat(80));
console.log(`Bikes proposal-ok: ${bikeOk}/${results.bikes.length}`);
console.log(`Cars  proposal-ok: ${carOk}/${results.cars.length}`);
console.log('Full output: probe-hdfc-vendor-makemodel.json + probe-hdfc-vendor-makemodel.md');

// ---------- vendor-share HTML (per-call req/res) ----------
if (HTML_OUT) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const pretty = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  };
  const statusChip = (s) => {
    const cls = s === 'proposal-ok' ? 'ok' : (s === 'no-variants' ? 'warn' : 'err');
    return `<span class="chip ${cls}">${esc(s)}</span>`;
  };

  // Index captures by row key
  const key = (r) => r ? `${r.kind}|${r.make}|${r.model}|${r.variantHint}|${r.cc}|${r.rto}` : '__preamble__';
  const byRow = new Map();
  for (const c of captures) {
    const k = key(c.row);
    if (!byRow.has(k)) byRow.set(k, []);
    byRow.get(k).push(c);
  }

  const allRows = [...results.bikes.map(r => ({ ...r, kind: 'BIKE' })), ...results.cars.map(r => ({ ...r, kind: 'CAR' }))];

  const rowSections = allRows.map((row, i) => {
    const k = key({ kind: row.kind, make: row.make, model: row.model, variantHint: row.variantHint, cc: row.cc, rto: row.rto });
    const calls = byRow.get(k) || [];
    const callBlocks = calls.map((c, j) => `
      <details class="call" ${c.status >= 400 || c.err || (c.resBody && (c.resBody.errorStatus === 'true' || c.resBody.errorStatus === true)) ? 'open' : ''}>
        <summary><b>${j+1}. ${esc(c.step || c.url)}</b> &mdash; <code>${esc(c.method)}</code> &nbsp; <span class="muted">${esc(c.ts)}</span> &nbsp; HTTP <b>${c.status}</b> &nbsp; <span class="muted">${c.ms}ms</span>${c.err ? ` &nbsp; <span class="err">ERROR</span>` : ''}</summary>
        <div class="url"><code>${esc(c.url)}</code></div>
        <div class="pair">
          <div class="col">
            <h5>Request headers</h5>
            <pre>${esc(pretty(c.reqHeaders))}</pre>
            <h5>Request body</h5>
            <pre>${esc(pretty(c.reqBody))}</pre>
          </div>
          <div class="col">
            <h5>Response body</h5>
            <pre>${esc(pretty(c.resBody))}</pre>
            ${c.err ? `<h5>Fetch error</h5><pre class="err">${esc(c.err)}</pre>` : ''}
          </div>
        </div>
      </details>
    `).join('');
    return `
    <section class="row" id="row-${i+1}">
      <h3>#${i+1} &middot; ${esc(row.kind)} &middot; ${esc(row.make)} / ${esc(row.resolvedModel || row.model)} / ${esc(row.variant || row.variantHint || '—')} / ${esc(row.rto)}</h3>
      <div class="meta">
        ${statusChip(row.status)}
        ${row.transId ? `<span class="chip neutral">transId ${esc(row.transId)}</span>` : ''}
        ${row.premium ? `<span class="chip neutral">premium ${esc(row.premium)}</span>` : ''}
        <span class="detail">${esc(row.detail || '')}</span>
      </div>
      ${callBlocks || '<p class="muted">(no captured calls for this row)</p>'}
    </section>`;
  }).join('\n');

  const summary = `
    <ul>
      <li><b>${allRows.length}</b> rows re-run (filtered to failures from <code>${esc(FAILURES_FROM || '—')}</code>)</li>
      <li>Bikes: <b>${results.bikes.filter(r=>r.status==='proposal-ok').length}</b>/${results.bikes.length} proposal-ok</li>
      <li>Cars: <b>${results.cars.filter(r=>r.status==='proposal-ok').length}</b>/${results.cars.length} proposal-ok</li>
      <li>Total captured API calls: <b>${captures.length}</b></li>
    </ul>
  `;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>HDFC vendor make/model — API logs — ${new Date().toISOString().slice(0,10)}</title>
<style>
  :root { --bg:#fff; --fg:#111; --muted:#666; --card:#f7f7f8; --border:#e5e5e8; --err:#b91c1c; --ok:#047857; --warn:#b45309; }
  html,body { background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  h3 { margin: 24px 0 6px; font-size: 15px; }
  h5 { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
  header { max-width: 1200px; }
  section.row { max-width: 1200px; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 14px 0; background: #fff; }
  .meta { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: var(--card); }
  .chip.ok { background: #ecfdf5; color: var(--ok); border-color: #a7f3d0; }
  .chip.err { background: #fef2f2; color: var(--err); border-color: #fecaca; }
  .chip.warn { background: #fffbeb; color: var(--warn); border-color: #fde68a; }
  .chip.neutral { }
  .detail { color: var(--muted); font-size: 12px; }
  details.call { border-top: 1px dashed var(--border); padding: 8px 0; }
  summary { cursor: pointer; }
  summary > b { font-size: 13px; }
  .url { font-size: 12px; color: var(--muted); margin: 4px 0 6px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin: 0; max-height: 400px; overflow: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  pre.err { color: var(--err); }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color: var(--muted); font-size: 12px; }
</style></head><body>
<header>
  <h1>HDFC vendor make/model probe &mdash; API logs</h1>
  <div class="muted">Generated ${new Date().toISOString()} &middot; Source: Third Party API Docs/HDFC_Make Model.xlsx</div>
  ${summary}
</header>
${rowSections}
</body></html>`;
  const htmlPath = HTML_OUT.startsWith('/') ? HTML_OUT : join(ROOT, HTML_OUT);
  writeFileSync(htmlPath, html);
  console.log(`HTML log: ${htmlPath}`);
}
