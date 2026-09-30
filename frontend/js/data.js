/* =========================================================================
   data.js — Demo data layer (mock database)
   Every collection here maps 1:1 to a future SQL table:
     districts, phcs, medicines, stock, footfall_daily, staff_daily, transfers
   When the Python backend is ready, replace these functions with fetch()
   calls to the API — the rest of the frontend stays unchanged.
   ========================================================================= */
const DB = (() => {
  // Seeded RNG so every page sees the same "database"
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260930);
  const r = (min, max) => min + rnd() * (max - min);
  const ri = (min, max) => Math.floor(r(min, max + 1));

  let TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  let HISTORY_DAYS = 60;
  const DAY_MS = 86400000;
  const dayOffset = (n) => new Date(TODAY.getTime() + n * DAY_MS);
  let historyDates = Array.from({ length: HISTORY_DAYS }, (_, i) => dayOffset(i - (HISTORY_DAYS - 1)));

  const districts = [
    { id: 'PUN', name: 'Pune', state: 'Maharashtra', lat: 18.52, lon: 73.86, phcs: ['Hadapsar', 'Khed', 'Baramati', 'Junnar', 'Maval'] },
    { id: 'JAI', name: 'Jaipur', state: 'Rajasthan', lat: 26.91, lon: 75.79, phcs: ['Sanganer', 'Chomu', 'Amber', 'Bassi', 'Phagi'] },
    { id: 'PAT', name: 'Patna', state: 'Bihar', lat: 25.59, lon: 85.14, phcs: ['Danapur', 'Phulwari', 'Masaurhi', 'Bihta', 'Fatuha'] },
    { id: 'ERN', name: 'Ernakulam', state: 'Kerala', lat: 9.98, lon: 76.28, phcs: ['Aluva', 'Kothamangalam', 'Perumbavoor', 'Piravom', 'Angamaly'] },
    { id: 'KAM', name: 'Kamrup', state: 'Assam', lat: 26.14, lon: 91.74, phcs: ['Hajo', 'Rangia', 'Boko', 'Chaygaon', 'Palasbari'] },
    { id: 'LKO', name: 'Lucknow', state: 'Uttar Pradesh', lat: 26.85, lon: 80.95, phcs: ['Malihabad', 'Mohanlalganj', 'Bakshi Ka Talab', 'Sarojini Nagar', 'Gosainganj'] },
  ];

  // rate = average units dispensed per patient visit
  const medicines = [
    { id: 'M01', name: 'Paracetamol 500mg', unit: 'tabs', rate: 2.2, category: 'Analgesic' },
    { id: 'M02', name: 'Amoxicillin 250mg', unit: 'caps', rate: 0.9, category: 'Antibiotic' },
    { id: 'M03', name: 'ORS Sachets', unit: 'sachets', rate: 0.5, category: 'Rehydration' },
    { id: 'M04', name: 'Metformin 500mg', unit: 'tabs', rate: 0.8, category: 'Diabetes' },
    { id: 'M05', name: 'Amlodipine 5mg', unit: 'tabs', rate: 0.5, category: 'Hypertension' },
    { id: 'M06', name: 'Iron-Folic Acid', unit: 'tabs', rate: 0.6, category: 'Supplement' },
    { id: 'M07', name: 'Zinc 20mg', unit: 'tabs', rate: 0.3, category: 'Supplement' },
    { id: 'M08', name: 'Cetirizine 10mg', unit: 'tabs', rate: 0.4, category: 'Antihistamine' },
    { id: 'M09', name: 'Albendazole 400mg', unit: 'tabs', rate: 0.15, category: 'Anthelmintic' },
    { id: 'M10', name: 'Salbutamol Inhaler', unit: 'units', rate: 0.03, category: 'Respiratory' },
    { id: 'M11', name: 'Insulin (Regular)', unit: 'vials', rate: 0.02, category: 'Diabetes' },
    { id: 'M12', name: 'Artemether-Lumefantrine', unit: 'tabs', rate: 0.25, category: 'Antimalarial' },
  ];

  // PHCs currently experiencing an outbreak-like surge in footfall
  const SURGE = { 'PAT-01': 0.7, 'KAM-01': 0.55, 'JAI-02': 0.45 };
  const DOW = [0.8, 1.18, 1.08, 1.02, 1.0, 1.06, 0.78]; // Sun..Sat visit pattern

  const phcs = [];
  const stock = [];
  districts.forEach((d) => {
    d.phcs.forEach((name, k) => {
      const id = `${d.id}-0${k + 1}`;
      const base = ri(60, 170);
      const drift = r(-0.08, 0.12);
      const surge = SURGE[id] || 0;
      const footfall = historyDates.map((date, i) => {
        let v = base * DOW[date.getDay()] * (1 + (drift * i) / HISTORY_DAYS) * (1 + (rnd() - 0.5) * 0.16);
        const start = HISTORY_DAYS - 12;
        if (surge && i >= start) v *= 1 + surge * ((i - start + 1) / 12);
        return Math.round(v);
      });

      const bedsTotal = ri(6, 20);
      const occRate = surge ? r(0.92, 1.0) : r(0.3, 0.95);
      const staffTotal = Math.round(base / 11) + ri(3, 6); // staffing roughly follows patient load
      const attBase = rnd() < 0.15 ? r(0.55, 0.72) : r(0.78, 0.98);
      const staff = historyDates.map(() => Math.min(staffTotal, Math.round(staffTotal * (attBase + (rnd() - 0.5) * 0.12))));

      const phc = {
        id, name: `PHC ${name}`, districtId: d.id,
        lat: d.lat + r(-0.35, 0.35), lon: d.lon + r(-0.35, 0.35),
        bedsTotal, bedsOccupied: Math.round(bedsTotal * occRate),
        staffTotal, staffPresent: staff[staff.length - 1], staffHistory: staff,
        footfall,
      };
      phcs.push(phc);

      const recent = footfall.slice(-7).reduce((a, b) => a + b, 0) / 7;
      medicines.forEach((m) => {
        const dailyCons = Math.max(1, Math.round(recent * m.rate * r(0.7, 1.3)));
        const u = rnd();
        const cover = u < 0.025 ? 0 : u < 0.075 ? r(0.5, 5) : u < 0.17 ? r(5, 10) : r(15, 90);
        const perPatient = dailyCons / recent;
        stock.push({
          phcId: id, medId: m.id,
          qty: Math.round(dailyCons * cover),
          minQty: Math.ceil(dailyCons * 10),
          dailyCons,
          expiry: dayOffset(rnd() < 0.08 ? ri(5, 30) : ri(31, 540)),
          batch: `B${ri(1000, 9999)}`,
          consumption: footfall.map((f) => Math.round(f * perPatient * r(0.85, 1.15))),
        });
      });
    });
  });

  // ---- Persistent state (approved transfers, acknowledged alerts) ----
  const STORE_KEY = 'phc_state_v1';
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { transfers: {}, acks: {} }; }
    catch (e) { return { transfers: {}, acks: {} }; }
  }
  const state = loadState();
  function saveState() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }

  let stockIndex = new Map(stock.map((s) => [`${s.phcId}|${s.medId}`, s]));
  const getStock = (phcId, medId) => stockIndex.get(`${phcId}|${medId}`);

  // Replay approved transfers on top of the base data so stock reflects decisions
  function applyTransferToStock(t) {
    const from = getStock(t.from, t.medId), to = getStock(t.to, t.medId);
    if (!from || !to) return;
    const q = Math.min(t.qty, from.qty);
    from.qty -= q; to.qty += q;
  }
  Object.values(state.transfers).filter((t) => t.status === 'approved').forEach(applyTransferToStock);

  let phcIndex, medIndex, distIndex;
  function reindex() {
    stockIndex = new Map(stock.map((s) => [`${s.phcId}|${s.medId}`, s]));
    phcIndex = new Map(phcs.map((p) => [p.id, p]));
    medIndex = new Map(medicines.map((m) => [m.id, m]));
    distIndex = new Map(districts.map((d) => [d.id, d]));
  }
  reindex();

  const replace = (arr, items) => { arr.length = 0; arr.push(...items); };
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

  // Replace the demo data with a snapshot from the backend (GET /api/get_phc_data?include_history=true)
  function hydrate(snap) {
    TODAY = parseDate(snap.as_of);
    historyDates = snap.dates.map(parseDate);
    HISTORY_DAYS = historyDates.length;
    replace(districts, snap.districts.map((d) => ({ id: d.id, name: d.name, state: d.state, lat: d.lat, lon: d.lon })));
    replace(medicines, snap.medicines.map((m) => ({ id: m.id, name: m.name, unit: m.unit, rate: m.rate, category: m.category })));
    replace(phcs, snap.phcs.map((p) => ({
      id: p.id, name: p.name, districtId: p.district_id, lat: p.lat, lon: p.lon,
      bedsTotal: p.beds_total, bedsOccupied: p.beds_occupied, staffTotal: p.staff_total,
      staffPresent: p.staff_present, staffHistory: p.staff_history, footfall: p.footfall,
    })));
    replace(stock, snap.phcs.flatMap((p) => p.medicines.map((m) => ({
      phcId: p.id, medId: m.med_id, qty: m.qty, minQty: m.min_qty, dailyCons: m.daily_consumption,
      expiry: m.expiry_date ? parseDate(m.expiry_date) : new Date(TODAY.getFullYear() + 5, 0, 1), // none recorded
      batch: m.batch || '-',
      consumption: m.consumption,
    }))));
    reindex();
  }

  return {
    get TODAY() { return TODAY; },
    get HISTORY_DAYS() { return HISTORY_DAYS; },
    get historyDates() { return historyDates; },
    dayOffset, hydrate,
    districts, phcs, medicines, stock,
    getPHC: (id) => phcIndex.get(id),
    getMedicine: (id) => medIndex.get(id),
    getDistrict: (id) => distIndex.get(id),
    getStock,
    stocksFor: (phcId) => stock.filter((s) => s.phcId === phcId),
    phcsInDistrict: (dId) => phcs.filter((p) => p.districtId === dId),

    // In API mode the server is the source of truth for decisions and alerts
    serverTransfers: null,
    serverAlerts: null,
    transfers() { return this.serverTransfers || Object.values(state.transfers); },
    setTransfer(t) {
      state.transfers[t.id] = { ...t, decidedAt: new Date().toISOString() };
      if (t.status === 'approved') applyTransferToStock(t);
      saveState();
    },
    isAcked: (id) => !!state.acks[id],
    ack(id) { state.acks[id] = new Date().toISOString(); saveState(); },
    resetState() { localStorage.removeItem(STORE_KEY); },
  };
})();
