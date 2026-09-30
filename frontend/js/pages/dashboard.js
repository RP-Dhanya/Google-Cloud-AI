/* B. National / District dashboard */
App.ready(() => {
  const s = Auth.session();
  const isAdmin = s && s.role === 'admin';
  const session = Layout.init({
    title: isAdmin ? 'National Overview' : 'District Overview',
    subtitle: 'Live status of medicines, beds, patients and staff across the PHC network',
  });
  if (!session) return;

  const content = UI.$('#content');
  let district = isAdmin ? (UI.param('district') || '') : session.districtId;
  const scope = () => (district ? DB.phcsInDistrict(district) : DB.phcs);

  function render() {
    const phcs = scope();
    const stocks = phcs.flatMap((p) => DB.stocksFor(p.id));
    const risks = phcs.map((p) => ({ p, r: Engine.phcRisk(p) }));
    const sum = Engine.sum;

    const units = sum(stocks.map((x) => x.qty));
    const bedsT = sum(phcs.map((p) => p.bedsTotal)), bedsO = sum(phcs.map((p) => p.bedsOccupied));
    const footToday = sum(phcs.map((p) => p.footfall.at(-1)));
    const footYest = sum(phcs.map((p) => p.footfall.at(-2)));
    const footChg = footYest ? footToday / footYest - 1 : 0;
    const staffP = sum(phcs.map((p) => p.staffPresent)), staffT = sum(phcs.map((p) => p.staffTotal));
    const high = risks.filter((x) => x.r.level === 'critical').length;
    const moderate = risks.filter((x) => x.r.level === 'warning').length;
    const outs = stocks.filter((x) => x.qty <= 0).length;
    const critMeds = stocks.filter((x) => Engine.stockStatus(x).level === 'critical').length;
    const ri = Engine.resilienceIndex(phcs);
    const riLevel = ri >= 75 ? 'normal' : ri >= 60 ? 'warning' : 'critical';
    const scopeName = district ? `${DB.getDistrict(district).name} district` : 'the national network';

    content.innerHTML = `
      ${isAdmin ? `
      <div class="toolbar">
        <label class="small muted" for="districtSel">District</label>
        <select id="districtSel">
          <option value="">All districts (national)</option>
          ${DB.districts.map((d) => `<option value="${d.id}" ${d.id === district ? 'selected' : ''}>${UI.esc(d.name)}, ${UI.esc(d.state)}</option>`).join('')}
        </select>
      </div>` : ''}

      <section class="card hero">
        <div>
          <div class="small muted" style="font-weight:600;text-transform:uppercase;letter-spacing:.04em">Resilience Index</div>
          <div class="hero-score" style="color:var(--${riLevel === 'normal' ? 'ok' : riLevel === 'warning' ? 'warn' : 'crit'})">${ri}<span class="muted" style="font-size:18px">/100</span></div>
        </div>
        <div class="grow">
          <h3 style="font-size:16px">${high ? `${high} PHC${high > 1 ? 's' : ''} in ${UI.esc(scopeName)} need attention now` : `${UI.esc(scopeName[0].toUpperCase() + scopeName.slice(1))} is stable`}</h3>
          <p class="muted" style="margin:4px 0 10px">The index combines medicine cover, bed occupancy, staff attendance and patient surges across ${phcs.length} PHCs. 100 means fully resilient.</p>
          <div class="toolbar">
            ${UI.pill('critical', `${high} high risk`)} ${UI.pill('warning', `${moderate} moderate`)} ${UI.pill('normal', `${phcs.length - high - moderate} low risk`)}
            <span class="spacer"></span>
            <a class="btn btn-outline btn-sm" href="simulation.html">Run emergency simulation</a>
            <a class="btn btn-primary btn-sm" href="redistribution.html">View redistribution plan</a>
          </div>
        </div>
      </section>

      <section class="kpis">
        ${UI.kpi({ label: 'Total PHCs', value: phcs.length, sub: `${new Set(phcs.map((p) => p.districtId)).size} district(s)`, icon: '🏥' })}
        ${UI.kpi({ label: 'Medicines in stock', value: UI.fmt(units), sub: `${DB.medicines.length} essential medicines tracked`, icon: '💊' })}
        ${UI.kpi({ label: 'Beds available', value: `${bedsT - bedsO}<span class="muted" style="font-size:15px"> / ${bedsT}</span>`, sub: `${UI.pct(bedsO / bedsT)} occupied`, tone: bedsO / bedsT > 0.85 ? 'warning' : 'ok', icon: '🛏️' })}
        ${UI.kpi({ label: 'Patient footfall today', value: UI.fmt(footToday), sub: `${footChg >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(footChg * 100))}% vs yesterday`, tone: 'accent', icon: '👥' })}
        ${UI.kpi({ label: 'Staff attendance', value: UI.pct(staffP / staffT), sub: `${staffP} of ${staffT} present`, tone: staffP / staffT < 0.8 ? 'warning' : 'ok', icon: '🩺' })}
        ${UI.kpi({ label: 'PHCs at risk', value: high, sub: `+${moderate} moderate`, tone: high ? 'critical' : 'ok', icon: '⚠️' })}
        ${UI.kpi({ label: 'Current stock-outs', value: outs, sub: `${critMeds} medicine lines critical`, tone: outs ? 'critical' : 'ok', icon: '📦' })}
      </section>

      <div class="grid g-2-1">
        <section class="card">
          <div class="card-head">
            <div><h2>Patient footfall</h2><p>Last 30 days and 7-day AI forecast</p></div>
            <div class="legend"><span><i style="background:var(--c-line)"></i>Actual</span><span style="color:var(--c-forecast)"><i class="dash"></i>Forecast</span><span><i class="box" style="background:var(--c-forecast)"></i>80% range</span></div>
          </div>
          <div id="footChart"></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>PHC network map</h2><p>Coloured by risk. Click a PHC for details.</p></div></div>
          <div id="mapChart"></div>
        </section>
      </div>

      <div class="grid g-2">
        <section class="card">
          <div class="card-head"><div><h2>Highest-risk PHCs</h2><p>Explainable score: what is driving the risk</p></div><a href="phc.html" class="small">All PHCs →</a></div>
          <div class="list" id="riskList"></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Critical alerts</h2><p>Unacknowledged, most urgent first</p></div><a href="alerts.html" class="small">All alerts →</a></div>
          <div class="list" id="alertList"></div>
        </section>
      </div>

      <section class="card">
        <div class="card-head"><div><h2>${district ? 'PHC summary' : 'District summary'}</h2><p>${district ? 'Every PHC in this district' : 'Compare districts at a glance'}</p></div></div>
        <div class="table-wrap" id="summaryTable"></div>
      </section>`;

    if (isAdmin) UI.$('#districtSel').onchange = (e) => {
      district = e.target.value;
      history.replaceState(null, '', district ? `?district=${district}` : location.pathname);
      render();
    };

    // Footfall chart
    const n = DB.HISTORY_DAYS;
    const total = Array.from({ length: n }, (_, i) => sum(phcs.map((p) => p.footfall[i])));
    const fc = Engine.forecast(total, 7);
    const hist = total.slice(-30);
    const labels = DB.historyDates.slice(-30).concat(fc.map((_, k) => DB.dayOffset(k + 1)));
    const pad = Array(29).fill(null);
    Charts.line(UI.$('#footChart'), {
      labels, height: 270, marker: 29, markerLabel: 'Today',
      series: [
        { name: 'Actual', data: hist.concat(Array(7).fill(null)), color: 'var(--c-line)' },
        { name: 'Forecast', data: pad.concat([hist.at(-1)], fc.map((f) => f.mean)), color: 'var(--c-forecast)', dash: true },
      ],
      band: { lo: pad.concat([hist.at(-1)], fc.map((f) => f.lo)), hi: pad.concat([hist.at(-1)], fc.map((f) => f.hi)), color: 'var(--c-forecast)' },
    });

    Charts.map(UI.$('#mapChart'), risks.map(({ p, r }) => ({
      lat: p.lat, lon: p.lon, level: r.level, group: DB.getDistrict(p.districtId).name,
      label: `${p.name}: risk ${r.score}/100`, href: `phc.html?id=${p.id}`,
    })));

    // Risk list
    const top = risks.slice().sort((a, b) => b.r.score - a.r.score).slice(0, 5);
    UI.$('#riskList').innerHTML = top.map(({ p, r }) => `
      <div class="list-item">
        <div class="score-badge score-${r.level}">${r.score}</div>
        <div class="grow">
          <div class="list-title"><a href="phc.html?id=${p.id}">${UI.esc(p.name)}</a> <span class="muted small">· ${UI.esc(DB.getDistrict(p.districtId).name)}</span></div>
          <div class="list-sub">${r.reasons.slice(0, 2).map((x) => UI.esc(x.text)).join(' · ') || 'No major issues'}</div>
        </div>
        ${UI.pill(r.level, r.label)}
      </div>`).join('');

    const al = Engine.alerts(phcs).filter((a) => a.severity === 'critical' && !a.acked).slice(0, 5);
    const AICON = { stock: '💊', bed: '🛏️', staff: '🩺', emergency: '🚨', expiry: '⏳' };
    UI.$('#alertList').innerHTML = al.length ? al.map((a) => `
      <div class="list-item">
        <div class="alert-ico critical" style="width:36px;height:36px">${AICON[a.type]}</div>
        <div class="grow"><div class="list-title">${UI.esc(a.title)}</div><div class="list-sub">${UI.esc(a.phc.name)} · ${UI.esc(a.district)}</div></div>
      </div>`).join('') : '<div class="empty">No critical alerts 🎉</div>';

    // Summary table
    if (district) {
      UI.$('#summaryTable').innerHTML = `<table><thead><tr><th>PHC</th><th class="r">Patients today</th><th class="r">Beds free</th><th class="r">Staff present</th><th class="r">Critical meds</th><th>Risk</th></tr></thead><tbody>
        ${risks.map(({ p, r }) => `<tr class="row-${r.level}">
          <td><a href="phc.html?id=${p.id}">${UI.esc(p.name)}</a></td>
          <td class="r num">${p.footfall.at(-1)}</td>
          <td class="r num">${p.bedsTotal - p.bedsOccupied} / ${p.bedsTotal}</td>
          <td class="r num">${p.staffPresent} / ${p.staffTotal}</td>
          <td class="r num">${r.out + r.crit}</td>
          <td>${UI.pill(r.level, `${r.label} · ${r.score}`)}</td></tr>`).join('')}
      </tbody></table>`;
    } else {
      UI.$('#summaryTable').innerHTML = `<table><thead><tr><th>District</th><th class="r">PHCs</th><th class="r">Patients today</th><th>Bed occupancy</th><th>Staff attendance</th><th class="r">Stock-outs</th><th class="r">High-risk PHCs</th><th class="r">Resilience</th></tr></thead><tbody>
        ${DB.districts.map((d) => {
          const ps = DB.phcsInDistrict(d.id);
          const occ = sum(ps.map((p) => p.bedsOccupied)) / sum(ps.map((p) => p.bedsTotal));
          const att = sum(ps.map((p) => p.staffPresent)) / sum(ps.map((p) => p.staffTotal));
          const so = ps.flatMap((p) => DB.stocksFor(p.id)).filter((x) => x.qty <= 0).length;
          const hr = ps.filter((p) => Engine.phcRisk(p).level === 'critical').length;
          const res = Engine.resilienceIndex(ps);
          const lv = res >= 75 ? 'normal' : res >= 60 ? 'warning' : 'critical';
          return `<tr>
            <td><a href="?district=${d.id}" data-d="${d.id}" class="dlink"><b>${UI.esc(d.name)}</b></a> <span class="muted small">${UI.esc(d.state)}</span></td>
            <td class="r num">${ps.length}</td>
            <td class="r num">${UI.fmt(sum(ps.map((p) => p.footfall.at(-1))))}</td>
            <td><div style="display:flex;gap:8px;align-items:center">${UI.meter(occ, occ > 0.9 ? 'critical' : occ > 0.8 ? 'warning' : 'normal')}<span class="num small">${UI.pct(occ)}</span></div></td>
            <td><div style="display:flex;gap:8px;align-items:center">${UI.meter(att, att < 0.7 ? 'critical' : att < 0.8 ? 'warning' : 'normal')}<span class="num small">${UI.pct(att)}</span></div></td>
            <td class="r num">${so}</td>
            <td class="r num">${hr}</td>
            <td class="r">${UI.pill(lv, res)}</td></tr>`;
        }).join('')}
      </tbody></table>`;
      UI.$$('.dlink').forEach((a) => a.onclick = (e) => {
        e.preventDefault(); district = a.dataset.d;
        history.replaceState(null, '', location.pathname + `?district=${district}`); render(); scrollTo(0, 0);
      });
    }
  }
  render();
});
