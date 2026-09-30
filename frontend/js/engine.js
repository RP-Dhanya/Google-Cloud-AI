/* =========================================================================
   engine.js — Analytics engine (runs in the browser for the prototype;
   will move to the Python backend later with the same inputs/outputs).
     - Stock status rules
     - Explainable PHC risk score + Resilience Index
     - Demand forecasting: damped Holt trend + weekly seasonality
     - Probabilistic stock-out risk
     - Emergency (what-if) simulation
     - Cross-district, expiry-aware redistribution planner
     - Alert generation
   ========================================================================= */
const Engine = (() => {
  const LEAD_TIME_DAYS = 7;        // typical resupply time from district warehouse
  const PATIENTS_PER_STAFF = 18;   // workload norm used by the simulator
  const ROAD_FACTOR = 1.3;         // straight-line km -> road km
  const TRUCK_KMPH = 40;

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : 0);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const std = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) ** 2))); };

  // Standard normal CDF (Abramowitz–Stegun approximation)
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function haversineKm(a, b) {
    const R = 6371, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------------- Stock status ----------------
  function stockStatus(s) {
    const cover = s.dailyCons > 0 ? s.qty / s.dailyCons : Infinity;
    const daysToExpiry = Math.round((s.expiry - DB.TODAY) / 86400000);
    const base = { cover, daysToExpiry, out: s.qty <= 0 };
    if (s.qty <= 0 || cover < 5 || s.qty < s.minQty * 0.5) return { ...base, level: 'critical', label: s.qty <= 0 ? 'Stock-out' : 'Critical' };
    if (s.qty < s.minQty) return { ...base, level: 'warning', label: 'Warning' };
    return { ...base, level: 'normal', label: 'Normal' };
  }

  // ---------------- PHC risk (explainable) ----------------
  function surgeRatio(phc) {
    const f = phc.footfall;
    const last3 = avg(f.slice(-3));
    const baseline = avg(f.slice(-31, -3));
    return baseline ? last3 / baseline - 1 : 0;
  }

  const riskCache = new Map();
  function phcRisk(phc) {
    if (riskCache.has(phc.id)) return riskCache.get(phc.id);
    const stocks = DB.stocksFor(phc.id);
    let out = 0, crit = 0, warn = 0;
    stocks.forEach((s) => {
      const st = stockStatus(s);
      if (st.out) out++; else if (st.level === 'critical') crit++; else if (st.level === 'warning') warn++;
    });
    const occ = phc.bedsOccupied / phc.bedsTotal;
    const att = phc.staffPresent / phc.staffTotal;
    const surge = surgeRatio(phc);

    const parts = [
      { key: 'Medicine stock', weight: 40, v: clamp01((out * 3 + crit * 2 + warn) / 12),
        text: `${out} stock-out, ${crit} critical, ${warn} low medicines` },
      { key: 'Bed occupancy', weight: 25, v: clamp01((occ - 0.6) / 0.4), text: `${Math.round(occ * 100)}% beds occupied` },
      { key: 'Staff attendance', weight: 20, v: clamp01((0.9 - att) / 0.3), text: `${Math.round(att * 100)}% staff present` },
      { key: 'Patient surge', weight: 15, v: clamp01(surge / 0.5), text: `${surge >= 0 ? '+' : ''}${Math.round(surge * 100)}% footfall vs 4-week baseline` },
    ];
    parts.forEach((p) => (p.points = Math.round(p.weight * p.v)));
    const score = sum(parts.map((p) => p.points));
    const level = score >= 45 ? 'critical' : score >= 28 ? 'warning' : 'normal';
    const label = level === 'critical' ? 'High risk' : level === 'warning' ? 'Moderate' : 'Low risk';
    const reasons = parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points);
    const res = { score, level, label, parts, reasons, out, crit, warn, occ, att, surge };
    riskCache.set(phc.id, res);
    return res;
  }

  // Resilience Index: 100 = fully resilient network, 0 = collapsing
  const resilienceIndex = (phcList) => Math.round(100 - avg(phcList.map((p) => phcRisk(p).score)));

  // ---------------- Forecasting ----------------
  // Damped Holt linear trend on a de-seasonalised series (weekly pattern)
  function forecast(series, h) {
    const n = series.length, P = 7;
    // Seasonal indices = ratio to a centred 7-day moving average (removes trend/surges)
    const idx = Array(P).fill(0), cnt = Array(P).fill(0);
    for (let i = Math.max(3, n - 45); i < n - 3; i++) {
      const ma = avg(series.slice(i - 3, i + 4)) || 1;
      idx[i % P] += series[i] / ma; cnt[i % P]++;
    }
    for (let p = 0; p < P; p++) idx[p] = cnt[p] ? idx[p] / cnt[p] : 1;
    const norm = avg(idx) || 1;
    for (let p = 0; p < P; p++) idx[p] /= norm;
    const des = series.map((v, i) => v / idx[i % P]);

    const a = 0.5, b = 0.2, phi = 0.9;
    let L = des[0], T = 0;
    const resid = [];
    for (let i = 1; i < n; i++) {
      const pred = L + phi * T;
      resid.push(des[i] - pred);
      const Ln = a * des[i] + (1 - a) * pred;
      T = b * (Ln - L) + (1 - b) * phi * T;
      L = Ln;
    }
    const sd = std(resid.slice(-28));
    const out = [];
    let damp = 0;
    for (let k = 1; k <= h; k++) {
      damp += phi ** k;
      const s = idx[(n - 1 + k) % P];
      const mean = Math.max(0, (L + damp * T) * s);
      const w = 1.28 * sd * Math.sqrt(k) * s; // ~80% interval
      out.push({ mean, lo: Math.max(0, mean - w), hi: mean + w, sd: (w / 1.28) });
    }
    return out;
  }

  // Back-test: hide last 7 days, forecast them, measure MAPE
  function backtestMape(series) {
    const train = series.slice(0, -7), test = series.slice(-7);
    const f = forecast(train, 7);
    return avg(test.map((v, i) => Math.abs(v - f[i].mean) / Math.max(1, v))) * 100;
  }

  const fcCache = new Map();
  function phcForecast(phcId, h) {
    const key = `${phcId}|${h}`;
    if (fcCache.has(key)) return fcCache.get(key);
    const phc = DB.getPHC(phcId);
    const patients = forecast(phc.footfall, h);
    const recent = avg(phc.footfall.slice(-7));
    const meds = DB.stocksFor(phcId).map((s) => {
      const perPatient = s.dailyCons / recent;
      const daily = patients.map((p) => p.mean * perPatient);
      const total = sum(daily);
      let cum = 0, day = null;
      if (s.qty <= 0) day = 0;
      else for (let k = 0; k < h; k++) { cum += daily[k]; if (cum >= s.qty) { day = k + (1 - (cum - s.qty) / daily[k]); break; } }
      if (day === null) day = h + (s.qty - cum) / Math.max(0.01, daily[h - 1]);
      // P(demand over horizon > stock) using forecast uncertainty + 10% model error
      const sdTot = Math.sqrt(sum(patients.map((p) => (p.sd * perPatient) ** 2)) + (0.1 * total) ** 2);
      const risk = s.qty <= 0 ? 100 : Math.round(100 * (1 - normCdf((s.qty - total) / Math.max(1, sdTot))));
      return { stock: s, med: DB.getMedicine(s.medId), daily, total, stockOutDay: day, stockOutDate: DB.dayOffset(Math.floor(day)), risk, shortfall: Math.max(0, total - s.qty) };
    });
    const res = { phc, patients, meds, mape: backtestMape(phc.footfall) };
    fcCache.set(key, res);
    return res;
  }

  // ---------------- Emergency simulation ----------------
  function simulate({ patient = 0, medicine = 0, staff = 0, beds = 0, horizon = 14 }, phcList) {
    const pm = 1 + patient / 100, mm = pm * (1 + medicine / 100), sm = 1 - staff / 100, bm = 1 + beds / 100;
    const rows = phcList.map((phc) => {
      const fc = phcForecast(phc.id, horizon);
      const patients = sum(fc.patients.map((p) => p.mean)) * pm;
      const peakDaily = Math.max(...fc.patients.map((p) => p.mean)) * pm;
      const shortages = fc.meds.map((m) => {
        const demand = m.total * mm;
        return { med: m.med, stock: m.stock.qty, demand, deficit: Math.max(0, Math.ceil(demand - m.stock.qty)) };
      }).filter((x) => x.deficit > 0);
      const bedsNeeded = Math.ceil(phc.bedsOccupied * bm);
      const bedDeficit = Math.max(0, bedsNeeded - phc.bedsTotal);
      const staffAvail = Math.floor(phc.staffPresent * sm);
      const staffNeeded = Math.ceil(peakDaily / PATIENTS_PER_STAFF);
      const staffDeficit = Math.max(0, staffNeeded - staffAvail);
      const issues = [];
      if (shortages.length) issues.push(`${shortages.length} medicine shortages`);
      if (bedDeficit) issues.push(`${bedDeficit} beds short`);
      if (staffDeficit) issues.push(`${staffDeficit} staff short`);
      const level = shortages.length >= 5 || bedDeficit > 0 || staffDeficit >= 2 ? 'critical'
        : shortages.length || staffDeficit || bedsNeeded >= phc.bedsTotal * 0.9 ? 'warning' : 'normal';
      return { phc, patients, peakDaily, shortages, bedsNeeded, bedDeficit, staffAvail, staffNeeded, staffDeficit, level, issues };
    });
    const medTotals = new Map();
    rows.forEach((r) => r.shortages.forEach((s) => {
      const t = medTotals.get(s.med.id) || { med: s.med, deficit: 0, phcs: 0 };
      t.deficit += s.deficit; t.phcs++; medTotals.set(s.med.id, t);
    }));
    return {
      rows,
      requiredMeds: [...medTotals.values()].sort((a, b) => b.phcs - a.phcs || b.deficit - a.deficit),
      requiredBeds: sum(rows.map((r) => r.bedDeficit)),
      requiredStaff: sum(rows.map((r) => r.staffDeficit)),
      critical: rows.filter((r) => r.level === 'critical'),
      warning: rows.filter((r) => r.level === 'warning'),
    };
  }

  // ---------------- Redistribution planner ----------------
  // Greedy matching: most urgent receivers first, nearest donors first.
  // Donors keep full horizon demand + safety stock. Near-expiry surplus is preferred,
  // so stock that would otherwise expire unused gets used where it's needed.
  function redistribution({ horizon = 14, multiplier = 1 } = {}) {
    const plan = [];
    DB.medicines.forEach((med) => {
      const receivers = [], donors = [];
      DB.phcs.forEach((phc) => {
        const f = phcForecast(phc.id, horizon).meds.find((m) => m.stock.medId === med.id);
        const s = f.stock, demand = f.total * multiplier;
        const day = multiplier === 1 ? f.stockOutDay : s.qty / Math.max(0.01, demand / horizon);
        if (s.qty < demand) {
          receivers.push({ phc, s, need: Math.ceil(demand + s.minQty * 0.5 - s.qty), day, demand });
        } else {
          const surplus = Math.floor(s.qty - demand - s.minQty);
          const daysToExpiry = (s.expiry - DB.TODAY) / 86400000;
          if (surplus > 0) donors.push({ phc, s, surplus, nearExpiry: daysToExpiry < 60, daysToExpiry });
        }
      });
      receivers.sort((a, b) => a.day - b.day);
      receivers.forEach((rc) => {
        let need = rc.need;
        const ranked = donors.filter((d) => d.surplus > 0).map((d) => {
          const km = haversineKm(d.phc, rc.phc) * ROAD_FACTOR;
          const cost = km * (d.nearExpiry ? 0.5 : 1) * (d.phc.districtId === rc.phc.districtId ? 0.8 : 1);
          return { d, km, cost };
        }).sort((a, b) => a.cost - b.cost);
        for (const { d, km } of ranked) {
          if (need <= 0) break;
          let qty = Math.min(need, d.surplus);
          if (qty >= 50) qty = Math.floor(qty / 10) * 10;
          if (qty < Math.max(2, rc.s.dailyCons)) continue; // not worth a trip
          d.surplus -= qty; need -= qty;
          const priority = rc.day <= 3 ? 'HIGH' : rc.day <= 7 ? 'MEDIUM' : 'LOW';
          const why = [rc.s.qty <= 0 ? 'Already out of stock' : `Predicted stock-out in ${rc.day.toFixed(1)} days`,
            `${horizon}-day demand ${Math.round(rc.demand).toLocaleString('en-IN')} vs stock ${rc.s.qty.toLocaleString('en-IN')}`];
          if (d.nearExpiry) why.push(`donor batch expires in ${Math.round(d.daysToExpiry)} days — prevents wastage`);
          plan.push({
            id: `${med.id}_${d.phc.id}_${rc.phc.id}`,
            medId: med.id, med, from: d.phc.id, to: rc.phc.id, fromPhc: d.phc, toPhc: rc.phc,
            qty, priority, day: rc.day, km, etaHours: km / TRUCK_KMPH, nearExpiry: d.nearExpiry,
            crossDistrict: d.phc.districtId !== rc.phc.districtId,
            reason: why.join('; '), shortReason: rc.s.qty <= 0 ? 'Stock-out' : 'Predicted shortage',
          });
        }
      });
    });
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return plan.sort((a, b) => order[a.priority] - order[b.priority] || a.day - b.day);
  }

  // ---------------- Alerts ----------------
  function alerts(phcList) {
    // Live mode: alerts come from the backend's alert engine
    if (DB.serverAlerts) {
      const ids = new Set(phcList.map((p) => p.id));
      return DB.serverAlerts.filter((a) => ids.has(a.phc.id));
    }
    const list = [];
    const push = (a) => list.push({ ...a, acked: DB.isAcked(a.id) });
    phcList.forEach((phc) => {
      const dName = DB.getDistrict(phc.districtId).name;
      DB.stocksFor(phc.id).forEach((s) => {
        const st = stockStatus(s), med = DB.getMedicine(s.medId);
        if (st.level !== 'normal') {
          push({ id: `stock_${phc.id}_${s.medId}`, type: 'stock', severity: st.level, phc, district: dName,
            title: st.out ? `${med.name} is out of stock` : st.level === 'critical' ? `${med.name} critically low` : `${med.name} below minimum level`,
            message: st.out ? `No stock left. Daily consumption is ${s.dailyCons} ${med.unit}.`
              : `${s.qty.toLocaleString('en-IN')} ${med.unit} left (min ${s.minQty.toLocaleString('en-IN')}) — about ${st.cover.toFixed(1)} days of cover.`,
            link: 'redistribution.html' });
        }
        if (st.daysToExpiry <= 30 && s.qty > 0) {
          push({ id: `exp_${phc.id}_${s.medId}`, type: 'expiry', severity: st.daysToExpiry <= 10 ? 'critical' : 'warning', phc, district: dName,
            title: `${med.name} expiring in ${st.daysToExpiry} days`,
            message: `${s.qty.toLocaleString('en-IN')} ${med.unit} (batch ${s.batch}) expire on ${s.expiry.toLocaleDateString('en-IN')}. Consider transferring to a high-demand PHC.`,
            link: 'medicines.html?phc=' + phc.id });
        }
      });
      const occ = phc.bedsOccupied / phc.bedsTotal;
      if (occ >= 0.85) {
        push({ id: `bed_${phc.id}`, type: 'bed', severity: occ >= 1 ? 'critical' : 'warning', phc, district: dName,
          title: occ >= 1 ? 'All beds occupied' : 'Bed capacity nearly full',
          message: `${phc.bedsOccupied} of ${phc.bedsTotal} beds occupied (${Math.round(occ * 100)}%). Plan referrals to nearby PHCs/CHCs.`,
          link: 'phc.html?id=' + phc.id });
      }
      const att = phc.staffPresent / phc.staffTotal;
      if (att < 0.8) {
        push({ id: `staff_${phc.id}`, type: 'staff', severity: att < 0.7 ? 'critical' : 'warning', phc, district: dName,
          title: 'Staff shortage',
          message: `Only ${phc.staffPresent} of ${phc.staffTotal} staff present today (${Math.round(att * 100)}%).`,
          link: 'phc.html?id=' + phc.id });
      }
      const surge = surgeRatio(phc);
      if (surge >= 0.35) {
        push({ id: `emg_${phc.id}`, type: 'emergency', severity: 'critical', phc, district: dName,
          title: 'Possible outbreak — patient surge',
          message: `Footfall is ${Math.round(surge * 100)}% above the 4-week baseline over the last 3 days. Run an emergency simulation.`,
          link: 'simulation.html' });
      }
    });
    const sev = { critical: 0, warning: 1 };
    const typeOrder = { emergency: 0, stock: 1, bed: 2, staff: 3, expiry: 4 };
    return list.sort((a, b) => sev[a.severity] - sev[b.severity] || typeOrder[a.type] - typeOrder[b.type]);
  }

  function clearCache() { riskCache.clear(); fcCache.clear(); }

  return {
    LEAD_TIME_DAYS, PATIENTS_PER_STAFF, clearCache, sum, avg, haversineKm,
    stockStatus, phcRisk, resilienceIndex, surgeRatio,
    forecast, phcForecast, simulate, redistribution, alerts,
  };
})();
