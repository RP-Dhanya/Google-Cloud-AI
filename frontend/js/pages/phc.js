/* C. PHC dashboard */
App.ready(() => {
  const session = Layout.init({ title: 'PHC Dashboard', subtitle: 'Stock, beds, patients and staff for a single Primary Health Centre' });
  if (!session) return;

  const content = UI.$('#content');
  const allowed = Auth.scopePHCs();
  let phcId = allowed.some((p) => p.id === UI.param('id')) ? UI.param('id') : allowed[0].id;

  function render() {
    const phc = DB.getPHC(phcId);
    const d = DB.getDistrict(phc.districtId);
    const r = Engine.phcRisk(phc);
    const stocks = DB.stocksFor(phc.id).map((s) => ({ s, st: Engine.stockStatus(s), m: DB.getMedicine(s.medId) }));
    const bedsFree = phc.bedsTotal - phc.bedsOccupied;
    const occ = phc.bedsOccupied / phc.bedsTotal;
    const absent = phc.staffTotal - phc.staffPresent;
    const today = phc.footfall.at(-1), avg7 = Engine.avg(phc.footfall.slice(-8, -1));

    content.innerHTML = `
      <div class="toolbar">
        <label class="small muted" for="phcSel">PHC</label>
        <select id="phcSel"></select>
        <span class="spacer"></span>
        <a class="btn btn-outline btn-sm" href="medicines.html?phc=${phc.id}">All medicines</a>
        <a class="btn btn-primary btn-sm" href="prediction.html?phc=${phc.id}">AI forecast for this PHC</a>
      </div>

      <section class="card hero">
        <div class="score-badge score-${r.level}" style="width:72px;height:72px;font-size:26px;border-radius:16px">${r.score}</div>
        <div class="grow">
          <div class="toolbar" style="gap:8px"><h2 style="font-size:20px">${UI.esc(phc.name)}</h2>${UI.statusPill(r.level, r.label)}</div>
          <p class="muted" style="margin:2px 0 0">${UI.esc(d.name)} district, ${UI.esc(d.state)} · PHC ID ${phc.id}</p>
        </div>
        <div style="flex:1;min-width:280px">
          <div class="small muted" style="font-weight:600">Why this risk level</div>
          <div class="reason-list">
            ${r.parts.map((p) => `<div class="reason"><b>${p.key}</b>${UI.meter(p.v, p.v > 0.6 ? 'critical' : p.v > 0.25 ? 'warning' : 'normal')}<span class="num small">${p.points}/${p.weight}</span></div>`).join('')}
          </div>
        </div>
      </section>

      <section class="kpis">
        ${UI.kpi({ label: 'Patients today', value: today, sub: `${today >= avg7 ? '▲' : '▼'} ${Math.abs(Math.round((today / avg7 - 1) * 100))}% vs 7-day average`, tone: 'accent', icon: '👥' })}
        ${UI.kpi({ label: 'Beds available', value: `${bedsFree}<span class="muted" style="font-size:15px"> / ${phc.bedsTotal}</span>`, sub: `${phc.bedsOccupied} occupied`, tone: occ >= 1 ? 'critical' : occ > 0.85 ? 'warning' : 'ok', icon: '🛏️' })}
        ${UI.kpi({ label: 'Staff present', value: phc.staffPresent, sub: `${absent} absent of ${phc.staffTotal}`, tone: r.att < 0.7 ? 'critical' : r.att < 0.8 ? 'warning' : 'ok', icon: '🩺' })}
        ${UI.kpi({ label: 'Critical medicines', value: r.out + r.crit, sub: `${r.out} out of stock · ${r.warn} low`, tone: r.out + r.crit ? 'critical' : 'ok', icon: '💊' })}
      </section>

      <div class="grid g-2-1">
        <section class="card">
          <div class="card-head"><div><h2>Daily patient count</h2><p>Last 30 days</p></div></div>
          <div id="patientChart"></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Beds</h2><p>Available vs occupied</p></div></div>
          <div id="bedDonut"></div>
          <div class="toolbar" style="justify-content:center;margin-top:8px">${UI.pill('info', `${phc.bedsOccupied} occupied`)} ${UI.pill('normal', `${bedsFree} available`)}</div>
        </section>
      </div>

      <div class="grid g-2">
        <section class="card">
          <div class="card-head"><div><h2>Staff attendance</h2><p>Present each day, last 14 days (of ${phc.staffTotal})</p></div>
            <div class="legend"><span><i style="background:var(--ok);height:10px"></i>≥ 80%</span><span><i style="background:var(--warn);height:10px"></i>70–80%</span><span><i style="background:var(--crit);height:10px"></i>&lt; 70%</span></div></div>
          <div id="staffChart"></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Medicine consumption</h2><p>Average daily units, last 7 days</p></div></div>
          <div id="consChart"></div>
        </section>
      </div>

      <section class="card">
        <div class="card-head"><div><h2>Medicine stock</h2><p>Sorted by urgency</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Medicine</th><th class="r">Current qty</th><th class="r">Min required</th><th class="r">Daily use</th><th>Days of cover</th><th>Expiry</th><th>Status</th></tr></thead>
          <tbody>
          ${stocks.sort((a, b) => a.st.cover - b.st.cover).map(({ s, st, m }) => `
            <tr class="row-${st.level}">
              <td><b>${UI.esc(m.name)}</b><div class="muted small">${m.category}</div></td>
              <td class="r num">${UI.fmt(s.qty)} <span class="muted small">${m.unit}</span></td>
              <td class="r num">${UI.fmt(s.minQty)}</td>
              <td class="r num">${UI.fmt(s.dailyCons)}</td>
              <td><div style="display:flex;gap:8px;align-items:center">${UI.meter(Math.min(1, st.cover / 30), st.level)}<span class="num small">${st.cover === Infinity ? '∞' : st.cover.toFixed(1)}d</span></div></td>
              <td class="num">${UI.date(s.expiry)}${st.daysToExpiry <= 30 ? ` ${UI.pill('warning', `${st.daysToExpiry}d`)}` : ''}</td>
              <td>${UI.statusPill(st.level, st.label)}</td>
            </tr>`).join('')}
          </tbody></table></div>
      </section>`;

    UI.phcOptions(UI.$('#phcSel'), phcId);
    UI.$('#phcSel').onchange = (e) => { phcId = e.target.value; history.replaceState(null, '', location.pathname + `?id=${phcId}`); render(); };

    Charts.line(UI.$('#patientChart'), {
      labels: DB.historyDates.slice(-30), height: 240,
      series: [{ name: 'Patients', data: phc.footfall.slice(-30), color: 'var(--c-line)' }],
    });
    Charts.donut(UI.$('#bedDonut'), { value: phc.bedsOccupied, total: phc.bedsTotal, level: occ >= 1 ? 'critical' : occ > 0.85 ? 'warning' : 'info', center: UI.pct(occ), caption: 'occupied' });
    Charts.columns(UI.$('#staffChart'), {
      labels: DB.historyDates.slice(-14), values: phc.staffHistory.slice(-14), max: phc.staffTotal, height: 200,
      color: (v) => (v / phc.staffTotal < 0.7 ? 'var(--crit)' : v / phc.staffTotal < 0.8 ? 'var(--warn)' : 'var(--ok)'),
    });
    Charts.hbars(UI.$('#consChart'), stocks
      .map(({ s, m, st }) => ({ label: m.name, value: Engine.avg(s.consumption.slice(-7)), display: `${UI.fmt(Engine.avg(s.consumption.slice(-7)))}`, level: st.level === 'normal' ? 'info' : st.level }))
      .sort((a, b) => b.value - a.value).slice(0, 8));
  }
  render();
});
