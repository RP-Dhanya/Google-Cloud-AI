/* H. Alerts */
App.ready(() => {
  const session = Layout.init({ title: 'Alerts', subtitle: 'Early warnings for stock-outs, beds, staff and emergencies' });
  if (!session) return;

  const content = UI.$('#content');
  const TYPES = [
    { key: '', label: 'All' },
    { key: 'emergency', label: '🚨 Emergency' },
    { key: 'stock', label: '💊 Medicine stock-out' },
    { key: 'bed', label: '🛏️ Bed shortage' },
    { key: 'staff', label: '🩺 Staff shortage' },
    { key: 'expiry', label: '⏳ Expiry' },
  ];
  const ICON = { stock: '💊', bed: '🛏️', staff: '🩺', emergency: '🚨', expiry: '⏳' };
  const state = { type: UI.param('type') || '', severity: '', showAcked: false, q: '' };

  function render() {
    const all = Engine.alerts(Auth.scopePHCs());
    const open = all.filter((a) => !a.acked);
    const base = all.filter((a) => (state.showAcked || !a.acked) && (!state.severity || a.severity === state.severity)
      && (!state.q || `${a.title} ${a.phc.name} ${a.district}`.toLowerCase().includes(state.q)));
    const list = base.filter((a) => !state.type || a.type === state.type);
    const cnt = (t) => open.filter((a) => a.type === t).length;

    content.innerHTML = `
      <section class="kpis">
        ${UI.kpi({ label: 'Emergency warnings', value: cnt('emergency'), sub: 'patient surges detected', tone: cnt('emergency') ? 'critical' : 'ok', icon: '🚨' })}
        ${UI.kpi({ label: 'Stock-out warnings', value: cnt('stock'), sub: `${open.filter((a) => a.type === 'stock' && a.severity === 'critical').length} critical`, tone: cnt('stock') ? 'critical' : 'ok', icon: '💊' })}
        ${UI.kpi({ label: 'Bed shortage', value: cnt('bed'), sub: 'PHCs at ≥ 85% occupancy', tone: cnt('bed') ? 'warning' : 'ok', icon: '🛏️' })}
        ${UI.kpi({ label: 'Staff shortage', value: cnt('staff'), sub: 'PHCs below 80% attendance', tone: cnt('staff') ? 'warning' : 'ok', icon: '🩺' })}
      </section>
      <section class="card">
        <div class="toolbar">
          <div class="chips">${TYPES.map((t) => `<button class="chip ${state.type === t.key ? 'active' : ''}" data-type="${t.key}">${t.label}<span class="count">${t.key ? base.filter((a) => a.type === t.key).length : base.length}</span></button>`).join('')}</div>
          <span class="spacer"></span>
          <input type="search" id="q" placeholder="Search PHC or alert…" value="${UI.esc(state.q)}">
          <select id="sev" aria-label="Severity"><option value="">All severities</option><option value="critical" ${state.severity === 'critical' ? 'selected' : ''}>Critical only</option><option value="warning" ${state.severity === 'warning' ? 'selected' : ''}>Warning only</option></select>
          <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="acked" ${state.showAcked ? 'checked' : ''}> Show acknowledged</label>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>${list.length} alert${list.length === 1 ? '' : 's'}</h2><p>Most severe first</p></div>
          ${list.some((a) => !a.acked) ? '<button class="btn btn-outline btn-sm" id="ackAll">Acknowledge all shown</button>' : ''}</div>
        <div>${list.length ? list.slice(0, 150).map((a) => `
          <div class="alert-item ${a.acked ? 'acked' : ''}">
            <div class="alert-ico ${a.severity}">${ICON[a.type]}</div>
            <div style="min-width:0">
              <div class="toolbar" style="gap:8px"><b>${UI.esc(a.title)}</b>${UI.pill(a.severity, a.severity === 'critical' ? 'Critical' : 'Warning')}</div>
              <div class="small" style="margin-top:2px">${UI.esc(a.message)}</div>
              <div class="small muted" style="margin-top:4px"><a href="phc.html?id=${a.phc.id}">${UI.esc(a.phc.name)}</a> · ${UI.esc(a.district)}</div>
            </div>
            <div class="toolbar" style="gap:6px;flex-wrap:nowrap">
              <a class="btn btn-outline btn-sm" href="${a.link}">Act</a>
              ${a.acked ? '<span class="small muted">✓ Acknowledged</span>' : `<button class="btn btn-ok btn-sm" data-ack="${a.id}">Acknowledge</button>`}
            </div>
          </div>`).join('') : '<div class="empty">No alerts match these filters. 🎉</div>'}
          ${list.length > 150 ? `<p class="small muted">Showing 150 of ${list.length}.</p>` : ''}
        </div>
      </section>`;

    UI.$$('[data-type]').forEach((b) => b.onclick = () => { state.type = b.dataset.type; render(); });
    UI.$('#sev').onchange = (e) => { state.severity = e.target.value; render(); };
    UI.$('#acked').onchange = (e) => { state.showAcked = e.target.checked; render(); };
    UI.$('#q').onchange = (e) => { state.q = e.target.value.toLowerCase(); render(); };
    UI.$$('[data-ack]').forEach((b) => b.onclick = () => { DB.ack(b.dataset.ack); render(); });
    const ackAll = UI.$('#ackAll');
    if (ackAll) ackAll.onclick = () => { list.forEach((a) => !a.acked && DB.ack(a.id)); UI.toast(`${list.length} alerts acknowledged`); render(); };
  }
  render();
});
