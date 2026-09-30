/* D. Medicine monitoring */
App.ready(() => {
  const session = Layout.init({ title: 'Medicine Monitoring', subtitle: 'Stock levels, consumption and expiry for every medicine in every PHC' });
  if (!session) return;

  const content = UI.$('#content');
  const scope = Auth.scopePHCs();
  const single = scope.length === 1;
  const state = {
    phc: single ? scope[0].id : (scope.some((p) => p.id === UI.param('phc')) ? UI.param('phc') : ''),
    status: UI.param('status') || '',
    q: '',
    expiring: false,
    sort: 'cover', dir: 1,
  };

  content.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <select id="phcSel" aria-label="PHC"></select>
        <input type="search" id="search" placeholder="Search medicine…" style="min-width:200px">
        <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="expiring"> Expiring within 30 days</label>
        <span class="spacer"></span>
        <button class="btn btn-outline btn-sm" id="csvBtn">⬇ Export CSV</button>
      </div>
      <div class="chips" id="statusChips" style="margin-top:14px"></div>
    </section>
    <section class="card">
      <div class="table-wrap scroll-y" id="tableWrap"></div>
      <p class="small muted" style="margin:12px 0 0">Status rules: 🔴 <b>Critical</b> means out of stock, under 5 days of cover, or below half the minimum. 🟡 <b>Warning</b> means below the minimum required quantity (10 days of cover). 🟢 <b>Normal</b> means everything else.</p>
    </section>`;

  UI.phcOptions(UI.$('#phcSel'), state.phc, { includeAll: true });
  UI.$('#phcSel').onchange = (e) => { state.phc = e.target.value; render(); };
  UI.$('#search').oninput = (e) => { state.q = e.target.value.toLowerCase(); render(); };
  UI.$('#expiring').onchange = (e) => { state.expiring = e.target.checked; render(); };

  const COLS = [
    { key: 'name', label: 'Medicine' },
    { key: 'phc', label: 'PHC', multiOnly: true },
    { key: 'qty', label: 'Current qty', r: true },
    { key: 'min', label: 'Min required', r: true },
    { key: 'cons', label: 'Daily use', r: true },
    { key: 'cover', label: 'Days of cover' },
    { key: 'expiry', label: 'Expiry date' },
    { key: 'level', label: 'Status' },
  ];

  function rows() {
    const phcs = state.phc ? [DB.getPHC(state.phc)] : scope;
    return phcs.flatMap((p) => DB.stocksFor(p.id).map((s) => {
      const m = DB.getMedicine(s.medId), st = Engine.stockStatus(s);
      return { s, m, st, p, name: m.name, phc: p.name, qty: s.qty, min: s.minQty, cons: s.dailyCons, cover: st.cover, expiry: s.expiry.getTime(), level: { critical: 0, warning: 1, normal: 2 }[st.level] };
    }));
  }

  let current = [];
  function render() {
    const all = rows().filter((x) => (!state.q || x.name.toLowerCase().includes(state.q)) && (!state.expiring || x.st.daysToExpiry <= 30));
    const counts = { critical: 0, warning: 0, normal: 0 };
    all.forEach((x) => counts[x.st.level]++);
    UI.$('#statusChips').innerHTML = [['', 'All', all.length], ['critical', '🔴 Critical', counts.critical], ['warning', '🟡 Warning', counts.warning], ['normal', '🟢 Normal', counts.normal]]
      .map(([k, l, c]) => `<button class="chip ${state.status === k ? 'active' : ''}" data-k="${k}">${l}<span class="count">${c}</span></button>`).join('');
    UI.$$('#statusChips .chip').forEach((b) => b.onclick = () => { state.status = b.dataset.k; render(); });

    current = all.filter((x) => !state.status || x.st.level === state.status)
      .sort((a, b) => (a[state.sort] > b[state.sort] ? 1 : a[state.sort] < b[state.sort] ? -1 : 0) * state.dir);
    const cols = COLS.filter((c) => !(c.multiOnly && state.phc));

    UI.$('#tableWrap').innerHTML = `<table>
      <thead><tr>${cols.map((c) => `<th class="sortable ${c.r ? 'r' : ''}" data-k="${c.key}">${c.label}${state.sort === c.key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${current.length ? current.map(({ s, m, st, p }) => `
        <tr class="row-${st.level}">
          <td><b>${UI.esc(m.name)}</b><div class="muted small">${m.category} · batch ${s.batch}</div></td>
          ${state.phc ? '' : `<td><a href="phc.html?id=${p.id}">${UI.esc(p.name)}</a><div class="muted small">${UI.esc(DB.getDistrict(p.districtId).name)}</div></td>`}
          <td class="r num"><b>${UI.fmt(s.qty)}</b> <span class="muted small">${m.unit}</span></td>
          <td class="r num">${UI.fmt(s.minQty)}</td>
          <td class="r num">${UI.fmt(s.dailyCons)}</td>
          <td><div style="display:flex;gap:8px;align-items:center">${UI.meter(Math.min(1, st.cover / 30), st.level)}<span class="num small">${st.cover.toFixed(1)}d</span></div></td>
          <td class="num">${UI.date(s.expiry)}${st.daysToExpiry <= 30 ? `<div>${UI.pill(st.daysToExpiry <= 10 ? 'critical' : 'warning', `expires in ${st.daysToExpiry}d`)}</div>` : ''}</td>
          <td>${UI.statusPill(st.level, st.label)}</td>
        </tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">No medicines match these filters.</td></tr>`}
      </tbody></table>`;
    UI.$$('th.sortable').forEach((th) => th.onclick = () => {
      const k = th.dataset.k;
      state.dir = state.sort === k ? -state.dir : 1; state.sort = k; render();
    });
  }

  UI.$('#csvBtn').onclick = () => UI.downloadCsv(`medicine-stock-${DB.TODAY.toISOString().slice(0, 10)}.csv`, [
    ['Medicine', 'PHC', 'District', 'Current qty', 'Unit', 'Min required', 'Daily consumption', 'Days of cover', 'Expiry date', 'Status'],
    ...current.map(({ s, m, st, p }) => [m.name, p.name, DB.getDistrict(p.districtId).name, s.qty, m.unit, s.minQty, s.dailyCons, st.cover.toFixed(1), s.expiry.toISOString().slice(0, 10), st.label]),
  ]);

  render();
});
