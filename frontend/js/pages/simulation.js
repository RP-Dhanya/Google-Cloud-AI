/* F. Emergency simulation (what-if stress test) */
App.ready(() => {
  const session = Layout.init({ title: 'Emergency Simulation', subtitle: 'Stress-test the PHC network against outbreaks, disasters and staff shortages' });
  if (!session) return;

  const content = UI.$('#content');
  const isAdmin = session.role === 'admin';
  const params = { patient: 40, medicine: 20, staff: 15, beds: 50, horizon: 14 };
  let district = isAdmin ? '' : session.districtId;

  const PRESETS = [
    { name: '🦟 Dengue outbreak', v: { patient: 45, medicine: 30, staff: 10, beds: 60 } },
    { name: '🌡️ Heatwave', v: { patient: 30, medicine: 25, staff: 5, beds: 35 } },
    { name: '🌊 Flood', v: { patient: 35, medicine: 40, staff: 30, beds: 50 } },
    { name: '🦠 Pandemic wave', v: { patient: 90, medicine: 50, staff: 30, beds: 120 } },
  ];
  const SLIDERS = [
    { key: 'patient', label: 'Patient increase', max: 200, icon: '👥' },
    { key: 'medicine', label: 'Medicine demand increase (per patient)', max: 200, icon: '💊' },
    { key: 'staff', label: 'Staff reduction', max: 90, icon: '🩺' },
    { key: 'beds', label: 'Bed demand increase', max: 200, icon: '🛏️' },
  ];

  content.innerHTML = `
    <div class="grid g-1-2">
      <section class="card">
        <div class="card-head"><div><h2>Scenario inputs</h2><p>Start from a preset or set your own values. Assumes no resupply arrives during the horizon.</p></div></div>
        <div class="preset-row">${PRESETS.map((p, i) => `<button class="chip" data-i="${i}">${p.name}</button>`).join('')}</div>
        <div style="display:flex;flex-direction:column;gap:16px;margin-top:18px">
          ${isAdmin ? `<div class="field"><label for="distSel">Scope</label><select id="distSel"><option value="">All districts (national)</option>${DB.districts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('')}</select></div>` : ''}
          ${SLIDERS.map((s) => `
            <div>
              <div class="slider-label"><span>${s.icon} ${s.label}</span></div>
              <div class="slider-field">
                <input type="range" min="0" max="${s.max}" step="5" id="r_${s.key}" aria-label="${s.label}">
                <div style="position:relative"><input type="number" min="0" max="${s.max}" id="n_${s.key}" style="width:100%;padding-right:24px"><span class="muted" style="position:absolute;right:10px;top:9px">%</span></div>
              </div>
            </div>`).join('')}
          <div class="field"><label>Horizon</label><div class="seg" id="hSeg"><button data-h="7">7 days</button><button data-h="14">14 days</button><button data-h="30">30 days</button></div></div>
          <button class="btn btn-primary" id="planBtn">🔁 Plan redistribution for this scenario</button>
        </div>
      </section>
      <div id="results" style="display:flex;flex-direction:column;gap:20px;min-width:0"></div>
    </div>`;

  function syncInputs() {
    SLIDERS.forEach((s) => { UI.$(`#r_${s.key}`).value = params[s.key]; UI.$(`#n_${s.key}`).value = params[s.key]; });
    UI.$$('#hSeg button').forEach((b) => b.classList.toggle('active', +b.dataset.h === params.horizon));
  }
  SLIDERS.forEach((s) => {
    const set = (v) => { params[s.key] = Math.max(0, Math.min(s.max, +v || 0)); syncInputs(); run(); };
    UI.$(`#r_${s.key}`).oninput = (e) => set(e.target.value);
    UI.$(`#n_${s.key}`).onchange = (e) => set(e.target.value);
  });
  UI.$$('.preset-row .chip').forEach((b) => b.onclick = () => {
    Object.assign(params, PRESETS[b.dataset.i].v);
    UI.$$('.preset-row .chip').forEach((x) => x.classList.toggle('active', x === b));
    syncInputs(); run();
  });
  UI.$$('#hSeg button').forEach((b) => b.onclick = () => { params.horizon = +b.dataset.h; syncInputs(); run(); });
  if (isAdmin) UI.$('#distSel').onchange = (e) => { district = e.target.value; run(); };
  UI.$('#planBtn').onclick = () => {
    localStorage.setItem('phc_scenario', JSON.stringify({ patient: params.patient, medicine: params.medicine, horizon: params.horizon }));
    location.href = 'redistribution.html?scenario=1';
  };

  // Live mode sends the scenario to the backend (debounced while sliders move)
  let timer, reqId = 0;
  function run() {
    clearTimeout(timer);
    timer = setTimeout(runNow, Api.enabled ? 250 : 0);
  }

  async function runNow() {
    const phcs = district ? DB.phcsInDistrict(district) : Auth.scopePHCs();
    const my = ++reqId;
    let res;
    if (Api.enabled) {
      try { res = await Api.simulate(params, district); }
      catch (e) { UI.$('#results').innerHTML = `<div class="banner banner-critical">Simulation failed: ${UI.esc(e.message)}</div>`; return; }
      if (my !== reqId) return;
    } else {
      res = Engine.simulate(params, phcs);
    }
    const shortageLines = Engine.sum(res.rows.map((r) => r.shortages.length));
    const affected = res.rows.filter((r) => r.level !== 'normal').sort((a, b) => (a.level === b.level ? b.shortages.length - a.shortages.length : a.level === 'critical' ? -1 : 1));

    UI.$('#results').innerHTML = `
      ${res.critical.length ? `<div class="banner banner-critical">🚨 <div><b>${res.critical.length} of ${phcs.length} PHCs would become critical</b> within ${params.horizon} days under this scenario.</div></div>`
        : `<div class="banner banner-info">✅ <div>No PHC becomes critical under this scenario within ${params.horizon} days.</div></div>`}
      <section class="kpis">
        ${UI.kpi({ label: 'PHCs critical', value: res.critical.length, sub: `+${res.warning.length} under strain`, tone: res.critical.length ? 'critical' : 'ok' })}
        ${UI.kpi({ label: 'Expected shortages', value: shortageLines, sub: 'medicine lines that run out', tone: shortageLines ? 'warning' : 'ok' })}
        ${UI.kpi({ label: 'Required beds', value: res.requiredBeds, sub: 'extra beds needed', tone: res.requiredBeds ? 'critical' : 'ok' })}
        ${UI.kpi({ label: 'Required staff', value: res.requiredStaff, sub: `at ${Engine.PATIENTS_PER_STAFF} patients per staff per day`, tone: res.requiredStaff ? 'warning' : 'ok' })}
      </section>

      <section class="card">
        <div class="card-head"><div><h2>PHCs that may become critical</h2><p>Sorted by severity</p></div></div>
        <div class="table-wrap scroll-y" style="max-height:420px"><table>
          <thead><tr><th>PHC</th><th class="r">Patients (${params.horizon}d)</th><th class="r">Beds needed</th><th class="r">Staff avail / needed</th><th>Issues</th><th>Status</th></tr></thead>
          <tbody>${affected.length ? affected.map((r) => `<tr class="row-${r.level}">
            <td><a href="phc.html?id=${r.phc.id}">${UI.esc(r.phc.name)}</a><div class="muted small">${UI.esc(DB.getDistrict(r.phc.districtId).name)}</div></td>
            <td class="r num">${UI.fmt(r.patients)}</td>
            <td class="r num">${r.bedsNeeded} / ${r.phc.bedsTotal}</td>
            <td class="r num">${r.staffAvail} / ${r.staffNeeded}</td>
            <td class="small" style="min-width:170px">${r.issues.join(', ') || '—'}</td>
            <td>${UI.statusPill(r.level, r.level === 'critical' ? 'Critical' : 'Strained')}</td>
          </tr>`).join('') : '<tr><td colspan="6" class="empty">All PHCs remain stable.</td></tr>'}</tbody>
        </table></div>
      </section>

      <div class="grid g-2">
        <section class="card">
          <div class="card-head"><div><h2>Required medicines</h2><p>Extra units needed across affected PHCs</p></div></div>
          <div id="medBars"></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Expected shortages</h2><p>Largest deficits by PHC and medicine</p></div></div>
          <div class="table-wrap scroll-y" style="max-height:340px"><table>
            <thead><tr><th>PHC</th><th>Medicine</th><th class="r">Stock</th><th class="r">Demand</th><th class="r">Deficit</th></tr></thead>
            <tbody>${res.rows.flatMap((r) => r.shortages.map((s) => ({ r, s }))).sort((a, b) => b.s.deficit / b.s.demand - a.s.deficit / a.s.demand).slice(0, 40)
              .map(({ r, s }) => `<tr><td>${UI.esc(r.phc.name)}</td><td>${UI.esc(s.med.name)}</td><td class="r num">${UI.fmt(s.stock)}</td><td class="r num">${UI.fmt(s.demand)}</td><td class="r num" style="color:var(--crit)"><b>${UI.fmt(s.deficit)}</b></td></tr>`).join('')
              || '<tr><td colspan="5" class="empty">No shortages expected.</td></tr>'}</tbody>
          </table></div>
        </section>
      </div>`;

    if (res.requiredMeds.length) {
      Charts.hbars(UI.$('#medBars'), res.requiredMeds.slice(0, 10).map((m) => ({
        label: m.med.name, value: m.phcs, display: `${UI.fmt(m.deficit)} ${m.med.unit}`, level: m.phcs >= phcs.length / 3 ? 'critical' : 'warning',
      })));
      UI.$('#medBars').insertAdjacentHTML('beforeend', '<p class="small muted" style="margin:10px 0 0">Bar length is the number of PHCs short of that medicine.</p>');
    } else UI.$('#medBars').innerHTML = '<div class="empty">No extra medicines needed.</div>';
  }

  syncInputs();
  run();
});
