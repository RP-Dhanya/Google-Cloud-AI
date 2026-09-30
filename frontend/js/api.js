/* =========================================================================
   api.js — Connection to the Python backend.

   LIVE mode   : page served by the backend (http://localhost:8000) → real
                 login, data from SQL, predictions/alerts/simulation/
                 redistribution computed by the server.
   DEMO mode   : page opened as a file, or backend not reachable → demo
                 data from data.js and analytics from engine.js.

   To use a backend on another address, run in the browser console:
     localStorage.setItem('phc_api_base', 'http://localhost:8000')
   ========================================================================= */
const Api = (() => {
  const TOKEN_KEY = 'phc_token';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  const BASE = (store.get('phc_api_base') || '').replace(/\/$/, '');
  let enabled = false;

  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const FAR = () => DB.dayOffset(9999);

  async function detect() {
    if (!BASE && !location.protocol.startsWith('http')) return (enabled = false);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
      clearTimeout(t);
      enabled = r.ok;
    } catch (e) { enabled = false; }
    return enabled;
  }

  async function call(path, { method = 'GET', body, query } = {}) {
    let url = `${BASE}/api${path}`;
    if (query) {
      const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (q.length) url += '?' + new URLSearchParams(q).toString();
    }
    const token = store.get(TOKEN_KEY);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401 && path !== '/login') {
      store.set(TOKEN_KEY, null); store.set('phc_session', null);
      location.replace('index.html');
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      const d = data && data.detail;
      throw new Error(Array.isArray(d) ? d.map((x) => `${x.loc[x.loc.length - 1]}: ${x.msg}`).join('; ') : d || res.statusText);
    }
    return data;
  }

  // ---------------- Auth ----------------
  async function login(username, password) {
    const r = await call('/login', { method: 'POST', body: { username, password } });
    store.set(TOKEN_KEY, r.access_token);
    const u = r.user;
    return { username: u.username, role: u.role, name: u.name, districtId: u.district_id, phcId: u.phc_id };
  }
  const logout = () => store.set(TOKEN_KEY, null);
  const hasToken = () => !!store.get(TOKEN_KEY);

  // ---------------- Mapping helpers ----------------
  const LINK = {
    stock: () => 'redistribution.html', emergency: () => 'simulation.html',
    expiry: (a) => `medicines.html?phc=${a.phc_id}`, bed: (a) => `phc.html?id=${a.phc_id}`, staff: (a) => `phc.html?id=${a.phc_id}`,
  };
  const mapAlert = (a) => ({
    id: a.id, type: a.type, rule: a.rule, severity: a.severity, phc: DB.getPHC(a.phc_id), district: a.district,
    title: a.title, message: a.message, acked: !!a.acked_at, link: LINK[a.type](a),
  });
  const mapTransfer = (t) => ({
    id: t.id, medId: t.med_id, from: t.from_phc, to: t.to_phc, qty: t.qty, priority: t.priority, status: t.status,
    by: t.decided_by, decidedAt: t.decided_at, fromName: t.from_name, toName: t.to_name, medName: t.medicine,
  });
  const mapPhcRef = (p) => ({ id: p.id, name: p.name, districtId: p.district_id });
  const mapPlanItem = (t) => ({
    id: t.id, medId: t.med_id, med: { id: t.med_id, name: t.medicine, unit: t.unit },
    from: t.from_phc.id, to: t.to_phc.id, fromPhc: mapPhcRef(t.from_phc), toPhc: mapPhcRef(t.to_phc),
    qty: t.quantity, priority: t.priority, day: t.stockout_in_days, km: t.distance_km, etaHours: t.eta_hours,
    nearExpiry: t.near_expiry, crossDistrict: t.cross_district, reason: t.reason, shortReason: t.short_reason,
    canApprove: t.can_approve,
  });
  const mapMedPrediction = (phcId, m) => ({
    stock: DB.getStock(phcId, m.med_id) || { qty: m.current_stock, minQty: m.min_qty },
    med: DB.getMedicine(m.med_id) || { id: m.med_id, name: m.name, unit: m.unit },
    total: m.predicted_demand, risk: m.risk_percent, shortfall: m.shortfall,
    stockOutDay: m.stockout_in_days == null ? 9999 : m.stockout_in_days,
    stockOutDate: m.expected_stockout_date ? parseDate(m.expected_stockout_date) : FAR(),
  });

  // ---------------- Data loading ----------------
  async function loadSnapshot() {
    const [snap, alerts, transfers] = await Promise.all([
      call('/get_phc_data', { query: { include_history: true } }),
      call('/get_alerts', { query: { include_acknowledged: true } }),
      call('/transfers'),
    ]);
    DB.hydrate(snap);
    DB.serverAlerts = alerts.alerts.map(mapAlert).filter((a) => a.phc);
    DB.serverTransfers = transfers.map(mapTransfer);
    // Acknowledge on the server (optimistic update so the page re-renders instantly)
    DB.isAcked = (id) => !!(DB.serverAlerts.find((a) => a.id === id) || {}).acked;
    DB.ack = (id) => {
      const a = DB.serverAlerts.find((x) => x.id === id);
      if (a) a.acked = true;
      call(`/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' }).catch((e) => UI.toast(e.message, 'warn'));
    };
    Engine.clearCache();
  }

  // ---------------- Server analytics ----------------
  async function predictions(phcId, horizon) {
    const p = await call('/get_predictions', { query: { phc_id: phcId, horizon } });
    return {
      phc: DB.getPHC(phcId), mape: p.backtest_mape ?? 0, model: p.model,
      patients: p.patients.daily.map((d) => ({ mean: d.mean, lo: d.lo, hi: d.hi, sd: d.sd })),
      meds: p.medicines.map((m) => mapMedPrediction(phcId, m)),
    };
  }

  async function earlyWarnings(horizon, minRisk = 60) {
    const r = await call('/get_predictions', { query: { horizon, min_risk: minRisk } });
    return r.phcs.flatMap((p) => p.medicines.map((m) => ({ p: DB.getPHC(p.phc_id), m: mapMedPrediction(p.phc_id, m) })))
      .filter((x) => x.p);
  }

  async function simulate(params, districtId) {
    const r = await call('/simulate', {
      method: 'POST',
      body: { patient_increase: params.patient, medicine_increase: params.medicine, staff_reduction: params.staff,
        bed_increase: params.beds, horizon: params.horizon, district_id: districtId || null },
    });
    const rows = r.phcs.map((x) => ({
      phc: DB.getPHC(x.phc_id), level: x.level, issues: x.issues, patients: x.predicted_patients,
      peakDaily: x.peak_daily_patients, bedsNeeded: x.beds_needed, bedDeficit: x.bed_deficit,
      staffAvail: x.staff_available, staffNeeded: x.staff_needed, staffDeficit: x.staff_deficit,
      shortages: x.shortages.map((s) => ({ med: { id: s.med_id, name: s.name, unit: s.unit }, stock: s.stock, demand: s.demand, deficit: s.deficit })),
    })).filter((x) => x.phc);
    return {
      rows,
      critical: rows.filter((x) => x.level === 'critical'),
      warning: rows.filter((x) => x.level === 'warning'),
      requiredBeds: r.summary.required_beds,
      requiredStaff: r.summary.required_staff,
      requiredMeds: r.required_medicines.map((m) => ({ med: { id: m.med_id, name: m.name, unit: m.unit }, deficit: m.deficit, phcs: m.phcs })),
    };
  }

  async function redistribution({ horizon, scenario, district }) {
    const r = await call('/get_redistribution', {
      query: { horizon, district_id: district, patient_increase: scenario && scenario.patient, medicine_increase: scenario && scenario.medicine },
    });
    return r.transfers.map(mapPlanItem);
  }

  async function decide(t, status, horizon, scenario) {
    await call('/redistribution/decision', {
      method: 'POST',
      body: { transfer_id: t.id, status, horizon, patient_increase: scenario ? scenario.patient : 0, medicine_increase: scenario ? scenario.medicine : 0 },
    });
    await loadSnapshot();   // stock and alerts changed on the server
  }

  const reseed = () => call('/admin/reseed', { method: 'POST' });

  // ---------------- Page start-up ----------------
  let boot = null;
  function ready(fn) {
    boot = boot || (async () => {
      await detect();
      if (enabled && hasToken()) {
        try { await loadSnapshot(); }
        catch (e) { console.error(e); document.addEventListener('DOMContentLoaded', () => UI.toast(`Backend error: ${e.message}`, 'warn')); }
      }
    })();
    boot.then(() => fn());
  }

  return {
    get enabled() { return enabled; },
    detect, call, ready, login, logout, hasToken,
    loadSnapshot, predictions, earlyWarnings, simulate, redistribution, decide, reseed,
  };
})();

// Pages start with App.ready(() => { ... }) so live data is loaded before rendering
const App = { ready: Api.ready };
