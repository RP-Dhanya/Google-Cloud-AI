/* E. AI prediction */
App.ready(() => {
  const session = Layout.init({ title: 'AI Demand Prediction', subtitle: 'Patient and medicine demand forecasts, expected stock-out dates and risk' });
  if (!session) return;

  const content = UI.$('#content');
  const scope = Auth.scopePHCs();
  // Default to the highest-risk PHC so the most urgent forecast is shown first
  let phcId = scope.some((p) => p.id === UI.param('phc')) ? UI.param('phc')
    : scope.slice().sort((a, b) => Engine.phcRisk(b).score - Engine.phcRisk(a).score)[0].id;
  let horizon = [7, 14, 30].includes(+UI.param('h')) ? +UI.param('h') : 14;

  content.innerHTML = `
    <div class="toolbar">
      <select id="phcSel" aria-label="PHC"></select>
      <div class="seg" id="hSeg">${[7, 14, 30].map((h) => `<button data-h="${h}">${h}-day</button>`).join('')}</div>
      <span class="spacer"></span>
      <span class="small muted">Model: damped Holt trend + weekly seasonality · 80% confidence band · ${Api.enabled ? 'computed on the server' : 'computed in the browser'}</span>
    </div>
    <div id="predBody" style="display:flex;flex-direction:column;gap:20px"></div>
    ${scope.length > 1 ? `
    <section class="card">
      <div class="card-head"><div><h2>Early warnings across your PHCs</h2><p id="ewSub"></p></div><a class="small" href="redistribution.html">Open redistribution →</a></div>
      <div class="table-wrap scroll-y" style="max-height:380px" id="ewTable"></div>
    </section>` : ''}
    <section class="card" id="fedCard"></section>`;

  UI.phcOptions(UI.$('#phcSel'), phcId);
  UI.$('#phcSel').onchange = (e) => { phcId = e.target.value; sync(); };
  UI.$$('#hSeg button').forEach((b) => b.onclick = () => { horizon = +b.dataset.h; sync(); });

  function sync() {
    history.replaceState(null, '', location.pathname + `?phc=${phcId}&h=${horizon}`);
    UI.$$('#hSeg button').forEach((b) => b.classList.toggle('active', +b.dataset.h === horizon));
    renderPHC();
    if (scope.length > 1) renderEarlyWarnings();
  }

  function riskLevel(r) { return r >= 70 ? 'critical' : r >= 35 ? 'warning' : 'normal'; }

  let reqId = 0;
  async function renderPHC() {
    const my = ++reqId;
    let fc;
    if (Api.enabled) {
      // Live mode: the forecast comes from the backend AI pipeline
      UI.$('#predBody').innerHTML = '<div class="card loading">Running forecast on the server…</div>';
      try { fc = await Api.predictions(phcId, horizon); }
      catch (e) { UI.$('#predBody').innerHTML = `<div class="banner banner-critical">Could not load predictions: ${UI.esc(e.message)}</div>`; return; }
      if (my !== reqId) return;   // a newer request has started
    } else {
      fc = Engine.phcForecast(phcId, horizon);
    }
    if (!fc.meds.length) {
      UI.$('#predBody').innerHTML = '<div class="card empty">No medicines are registered at this PHC yet. Add stock with /api/update_stock.</div>';
      return;
    }
    const phc = fc.phc;
    const patTotal = Engine.sum(fc.patients.map((p) => p.mean));
    const medTotal = Engine.sum(fc.meds.map((m) => m.total));
    const byDay = fc.meds.slice().sort((a, b) => a.stockOutDay - b.stockOutDay);
    const first = byDay[0];
    const worst = fc.meds.slice().sort((a, b) => b.risk - a.risk)[0];
    const atRisk = fc.meds.filter((m) => m.risk >= 50).length;

    UI.$('#predBody').innerHTML = `
      <section class="kpis">
        ${UI.kpi({ label: `Predicted patients (${horizon}d)`, value: UI.fmt(patTotal), sub: `≈ ${UI.fmt(patTotal / horizon)} per day`, tone: 'accent', icon: '👥' })}
        ${UI.kpi({ label: `Predicted medicine demand`, value: UI.fmt(medTotal), sub: `units across ${fc.meds.length} medicines`, icon: '💊' })}
        ${UI.kpi({ label: 'Earliest stock-out', value: first.stockOutDay <= horizon ? UI.shortDate(first.stockOutDate) : 'None', sub: first.stockOutDay <= horizon ? `${UI.esc(first.med.name)} · in ${first.stockOutDay.toFixed(1)} days` : `No stock-out expected within ${horizon} days`, tone: first.stockOutDay <= 3 ? 'critical' : first.stockOutDay <= horizon ? 'warning' : 'ok', icon: '📅' })}
        ${UI.kpi({ label: 'Highest stock-out risk', value: `${worst.risk}%`, sub: `${UI.esc(worst.med.name)} · ${atRisk} medicine(s) ≥ 50%`, tone: riskLevel(worst.risk) === 'normal' ? 'ok' : riskLevel(worst.risk), icon: '⚠️' })}
        ${UI.kpi({ label: 'Model accuracy', value: `${Math.max(0, 100 - fc.mape).toFixed(1)}%`, sub: `back-tested error (MAPE) ${fc.mape.toFixed(1)}%`, tone: 'ok', icon: '🎯' })}
      </section>

      <section class="card">
        <div class="card-head">
          <div><h2>Predicted patient demand · ${UI.esc(phc.name)}</h2><p>Last 30 days of actuals and the next ${horizon} days forecast</p></div>
          <div class="legend"><span><i style="background:var(--c-line)"></i>Actual</span><span style="color:var(--c-forecast)"><i class="dash"></i>Forecast</span><span><i class="box" style="background:var(--c-forecast)"></i>80% range</span></div>
        </div>
        <div id="fcChart"></div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Predicted medicine demand & stock-out risk</h2><p>Risk is the probability that demand over the next ${horizon} days exceeds current stock.</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Medicine</th><th class="r">Current stock</th><th class="r">Predicted demand (${horizon}d)</th><th class="r">Avg / day</th><th>Expected stock-out</th><th style="min-width:160px">Risk</th><th></th></tr></thead>
          <tbody>${byDay.map((m) => {
            const lv = riskLevel(m.risk);
            const soText = m.stock.qty <= 0 ? '<b style="color:var(--crit)">Out of stock now</b>'
              : m.stockOutDay <= horizon ? `<b>${UI.date(m.stockOutDate)}</b><div class="muted small">in ${m.stockOutDay.toFixed(1)} days</div>`
              : m.stockOutDay < 365 ? `${UI.date(m.stockOutDate)}<div class="muted small">beyond horizon</div>` : '<span class="muted">Not expected</span>';
            return `<tr class="row-${lv}">
              <td><b>${UI.esc(m.med.name)}</b><div class="muted small">${m.med.unit}</div></td>
              <td class="r num">${UI.fmt(m.stock.qty)}</td>
              <td class="r num"><b>${UI.fmt(m.total)}</b>${m.shortfall > 0 ? `<div class="small" style="color:var(--crit)">short by ${UI.fmt(m.shortfall)}</div>` : ''}</td>
              <td class="r num">${UI.fmt(m.total / horizon)}</td>
              <td>${soText}</td>
              <td><div style="display:flex;gap:8px;align-items:center">${UI.meter(m.risk / 100, lv)}<b class="num small" style="width:38px;text-align:right">${m.risk}%</b></div></td>
              <td>${m.risk >= 50 ? `<a class="btn btn-outline btn-sm" href="redistribution.html?h=${horizon}">Plan transfer</a>` : ''}</td>
            </tr>`;
          }).join('')}</tbody></table></div>
      </section>`;

    const hist = phc.footfall.slice(-30);
    const pad = Array(29).fill(null);
    Charts.line(UI.$('#fcChart'), {
      labels: DB.historyDates.slice(-30).concat(fc.patients.map((_, k) => DB.dayOffset(k + 1))),
      height: 280, marker: 29, markerLabel: 'Today',
      series: [
        { name: 'Actual', data: hist.concat(Array(horizon).fill(null)), color: 'var(--c-line)' },
        { name: 'Forecast', data: pad.concat([hist.at(-1)], fc.patients.map((p) => p.mean)), color: 'var(--c-forecast)', dash: true },
      ],
      band: { lo: pad.concat([hist.at(-1)], fc.patients.map((p) => p.lo)), hi: pad.concat([hist.at(-1)], fc.patients.map((p) => p.hi)), color: 'var(--c-forecast)' },
    });
  }

  async function renderEarlyWarnings() {
    const h = horizon;
    let rows;
    try {
      rows = Api.enabled ? await Api.earlyWarnings(h, 60)
        : scope.flatMap((p) => Engine.phcForecast(p.id, h).meds.map((m) => ({ p, m }))).filter((x) => x.m.risk >= 60);
    } catch (e) { UI.$('#ewTable').innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
    if (h !== horizon) return;
    rows.sort((a, b) => a.m.stockOutDay - b.m.stockOutDay);
    UI.$('#ewSub').textContent = `${rows.length} medicine lines with ≥ 60% risk of stock-out in the next ${horizon} days`;
    UI.$('#ewTable').innerHTML = `<table><thead><tr><th>PHC</th><th>Medicine</th><th class="r">Stock</th><th class="r">Demand (${horizon}d)</th><th>Stock-out</th><th class="r">Risk</th></tr></thead><tbody>
      ${rows.length ? rows.map(({ p, m }) => `<tr class="row-${riskLevel(m.risk)}">
        <td><a href="?phc=${p.id}&h=${horizon}">${UI.esc(p.name)}</a><div class="muted small">${UI.esc(DB.getDistrict(p.districtId).name)}</div></td>
        <td>${UI.esc(m.med.name)}</td>
        <td class="r num">${UI.fmt(m.stock.qty)}</td>
        <td class="r num">${UI.fmt(m.total)}</td>
        <td>${m.stock.qty <= 0 ? '<b style="color:var(--crit)">Now</b>' : `${UI.shortDate(m.stockOutDate)} <span class="muted small">(${m.stockOutDay.toFixed(1)}d)</span>`}</td>
        <td class="r">${UI.pill(riskLevel(m.risk), `${m.risk}%`)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No high-risk medicines in this horizon.</td></tr>'}
    </tbody></table>`;
  }

  /* ---------- Federated learning across BRICS (simulated for the prototype) ---------- */
  const localMape = Engine.avg(DB.phcs.map((p) => Engine.phcForecast(p.id, 7).mape));
  const NODES = [
    { flag: '🇮🇳', name: 'India', net: `${DB.phcs.length} PHCs (this node)`, local: localMape, self: true },
    { flag: '🇧🇷', name: 'Brazil', net: 'UBS primary care units', local: 13.4 },
    { flag: '🇷🇺', name: 'Russia', net: 'Feldsher-midwife posts', local: 11.8 },
    { flag: '🇨🇳', name: 'China', net: 'Township health centres', local: 9.9 },
    { flag: '🇿🇦', name: 'South Africa', net: 'Primary care clinics', local: 14.6 },
    { flag: '🇪🇬', name: 'Egypt', net: 'Primary health units', local: 15.2 },
    { flag: '🇪🇹', name: 'Ethiopia', net: 'Health posts', local: 17.9 },
    { flag: '🇮🇩', name: 'Indonesia', net: 'Puskesmas', local: 12.7 },
  ];
  let round = 12;
  const fedMape = (r) => 6.4 + 9 * Math.exp(-r / 4.5);
  const localAvg = Engine.avg(NODES.map((n) => n.local));

  function renderFed(syncing = false) {
    const g = fedMape(round);
    UI.$('#fedCard').innerHTML = `
      <div class="card-head">
        <div><h2>🌐 BRICS federated forecasting model</h2>
          <p>Each country trains on its own PHC data and shares only encrypted model updates. No patient records leave the country. <span class="pill pill-neutral">Simulated in prototype</span></p></div>
        <button class="btn btn-primary btn-sm" id="fedBtn" ${syncing ? 'disabled' : ''}>${syncing ? 'Aggregating…' : '▶ Run federated round'}</button>
      </div>
      <div class="grid g-1-2">
        <div>
          <div class="kpis" style="grid-template-columns:1fr 1fr">
            ${UI.kpi({ label: 'Global round', value: round, sub: 'FedAvg aggregation', tone: 'accent' })}
            ${UI.kpi({ label: 'Federated error', value: `${g.toFixed(1)}%`, sub: `vs ${localAvg.toFixed(1)}% local-only`, tone: 'ok' })}
          </div>
          <div class="small muted" style="margin:14px 0 6px">Privacy: secure aggregation + differential privacy (ε = 1.0)</div>
          <div class="progress"><span id="fedProg" style="width:${syncing ? 0 : 100}%"></span></div>
          <div style="margin-top:14px" id="fedChart"></div>
          <div class="legend" style="margin-top:6px"><span><i style="background:var(--muted)"></i>Local-only avg</span><span style="color:var(--c-forecast)"><i style="background:var(--c-forecast)"></i>Federated</span></div>
        </div>
        <div>
          ${NODES.map((n) => `<div class="fed-node">
            <div><span class="fed-status ${syncing ? 'syncing' : ''}"></span>${n.flag} <b>${n.name}</b> <span class="muted small">· ${n.net}</span></div>
            <span class="small muted num">local ${n.local.toFixed(1)}%</span>
            <span class="pill pill-normal num">→ ${Math.min(n.local, g + (n.local - localAvg) * 0.15).toFixed(1)}%</span>
          </div>`).join('')}
        </div>
      </div>`;
    const rounds = Array.from({ length: round + 1 }, (_, i) => i);
    Charts.line(UI.$('#fedChart'), {
      labels: rounds.map((r) => `R${r}`), height: 170, aria: 'Forecast error by federated round',
      series: [
        { name: 'Local-only error %', data: rounds.map(() => localAvg), color: 'var(--muted)', dash: true },
        { name: 'Federated error %', data: rounds.map(fedMape), color: 'var(--c-forecast)' },
      ],
    });
    UI.$('#fedBtn').onclick = runRound;
  }

  function runRound() {
    renderFed(true);
    let p = 0;
    const tick = setInterval(() => {
      p += 20;
      const bar = UI.$('#fedProg'); if (bar) bar.style.width = `${p}%`;
      if (p >= 100) {
        clearInterval(tick); round++; renderFed(false);
        UI.toast(`Round ${round} complete: ${NODES.length} countries aggregated, error ${fedMape(round).toFixed(1)}%`);
      }
    }, 280);
  }

  sync();
  renderFed();
});
