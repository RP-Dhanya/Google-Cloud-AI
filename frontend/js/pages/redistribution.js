/* G. Cross-district redistribution */
App.ready(() => {
  const session = Layout.init({ title: 'Redistribution', subtitle: 'AI-recommended transfers that move surplus stock to PHCs that are about to run out' });
  if (!session) return;

  const content = UI.$('#content');
  let scenario = null;
  if (UI.param('scenario')) { try { scenario = JSON.parse(localStorage.getItem('phc_scenario')); } catch (e) { scenario = null; } }
  let horizon = scenario ? scenario.horizon : ([7, 14, 30].includes(+UI.param('h')) ? +UI.param('h') : 14);
  let priority = '';
  let district = '';
  const multiplier = scenario ? (1 + scenario.patient / 100) * (1 + scenario.medicine / 100) : 1;

  // Does a transfer concern the current user?
  function inScope(t) {
    if (session.role === 'admin') return !district || t.fromPhc.districtId === district || t.toPhc.districtId === district;
    if (session.role === 'district') return t.fromPhc.districtId === session.districtId || t.toPhc.districtId === session.districtId;
    return t.from === session.phcId || t.to === session.phcId;
  }

  // Live mode: the plan is computed by the backend over the whole national network
  let cache = { key: null, plan: [] };
  async function loadPlan() {
    const key = `${horizon}|${district}`;
    if (cache.key === key) return cache.plan;
    let plan;
    if (Api.enabled) {
      plan = await Api.redistribution({ horizon, scenario, district });
    } else {
      const decided = new Set(DB.transfers().map((t) => t.id));
      plan = Engine.redistribution({ horizon, multiplier }).filter((t) => !decided.has(t.id));
    }
    cache = { key, plan: plan.filter(inScope) };
    return cache.plan;
  }

  async function render() {
    if (cache.key !== `${horizon}|${district}`) content.innerHTML = '<div class="card loading">Computing redistribution plan…</div>';
    let plan;
    try { plan = await loadPlan(); }
    catch (e) { content.innerHTML = `<div class="banner banner-critical">Could not load the plan: ${UI.esc(e.message)}</div>`; return; }
    const shown = plan.filter((t) => !priority || t.priority === priority);
    const count = (p) => plan.filter((t) => t.priority === p).length;
    const units = Engine.sum(plan.map((t) => t.qty));
    const protectedPhcs = new Set(plan.map((t) => t.to)).size;
    const cross = plan.filter((t) => t.crossDistrict).length;
    const expirySaved = Engine.sum(plan.filter((t) => t.nearExpiry).map((t) => t.qty));

    content.innerHTML = `
      ${scenario ? `<div class="banner banner-warning">🧪 <div style="flex:1">Planning for a simulated scenario: <b>+${scenario.patient}% patients</b>, <b>+${scenario.medicine}% medicine demand</b>, ${scenario.horizon}-day horizon.</div><a class="btn btn-outline btn-sm" href="redistribution.html">Back to current conditions</a></div>` : ''}
      <div class="toolbar">
        <div class="seg" id="hSeg">${[7, 14, 30].map((h) => `<button data-h="${h}" class="${h === horizon ? 'active' : ''}">${h}-day horizon</button>`).join('')}</div>
        ${session.role === 'admin' ? `<select id="distSel" aria-label="District"><option value="">All districts</option>${DB.districts.map((d) => `<option value="${d.id}" ${d.id === district ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('')}</select>` : ''}
        <span class="spacer"></span>
        <div class="chips" id="prioChips">
          ${[['', 'All', plan.length], ['HIGH', 'High', count('HIGH')], ['MEDIUM', 'Medium', count('MEDIUM')], ['LOW', 'Low', count('LOW')]]
            .map(([k, l, c]) => `<button class="chip ${priority === k ? 'active' : ''}" data-k="${k}">${l}<span class="count">${c}</span></button>`).join('')}
        </div>
      </div>

      <section class="kpis">
        ${UI.kpi({ label: 'Transfers recommended', value: plan.length, sub: `${count('HIGH')} high priority`, tone: count('HIGH') ? 'critical' : 'ok', icon: '🔁' })}
        ${UI.kpi({ label: 'Units to move', value: UI.fmt(units), sub: 'across all medicines', icon: '📦' })}
        ${UI.kpi({ label: 'PHCs protected', value: protectedPhcs, sub: 'stock-outs prevented', tone: 'ok', icon: '🛡️' })}
        ${UI.kpi({ label: 'Cross-district', value: cross, sub: `${plan.length - cross} within the same district`, tone: 'accent', icon: '🗺️' })}
        ${UI.kpi({ label: 'Near-expiry units reused', value: UI.fmt(expirySaved), sub: 'would otherwise expire unused', tone: 'ok', icon: '♻️' })}
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Recommended transfers</h2><p>Most urgent receivers first. The nearest donor is chosen, and every donor keeps its own ${horizon}-day demand plus safety stock.</p></div>
          <button class="btn btn-outline btn-sm" id="csvBtn">⬇ Export plan</button></div>
        <div id="transferList">
          ${shown.length ? shown.slice(0, 80).map((t) => {
            const can = Api.enabled ? t.canApprove : Auth.canApprove(t.fromPhc, t.toPhc);
            return `<div class="transfer">
              <div>
                <div class="route">
                  <span>${UI.esc(t.fromPhc.name)} <small>${UI.esc(DB.getDistrict(t.fromPhc.districtId).name)}</small></span>
                  <span class="arrow">→</span>
                  <span>${UI.esc(t.toPhc.name)} <small>${UI.esc(DB.getDistrict(t.toPhc.districtId).name)}</small></span>
                  ${UI.priorityPill(t.priority)}
                  ${t.crossDistrict ? UI.pill('neutral', 'Cross-district') : ''}
                  ${t.nearExpiry ? UI.pill('ok', '♻️ Near-expiry stock') : ''}
                </div>
                <div class="transfer-meta">
                  <span><b>Medicine</b>${UI.esc(t.med.name)}</span>
                  <span><b>Quantity</b>${UI.fmt(t.qty)} ${t.med.unit}</span>
                  <span><b>Reason</b>${t.shortReason}</span>
                  <span><b>Distance</b>${UI.fmt(t.km)} km · ~${t.etaHours < 1 ? '<1' : Math.round(t.etaHours)} h</span>
                </div>
                <div class="transfer-reason">${UI.esc(t.reason)}</div>
              </div>
              <div class="transfer-actions">
                ${can ? `<button class="btn btn-primary btn-sm" data-act="approved" data-id="${t.id}">✓ Approve</button>
                         <button class="btn btn-outline btn-sm" data-act="rejected" data-id="${t.id}">Reject</button>`
                      : '<span class="small muted">Awaiting district approval</span>'}
              </div>
            </div>`;
          }).join('') + (shown.length > 80 ? `<p class="small muted">Showing 80 of ${shown.length}. Filter by priority or district to see the rest.</p>` : '')
          : '<div class="empty">No transfers needed. Every PHC has enough stock for this horizon. 🎉</div>'}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Decision log</h2><p>Approved transfers are applied to stock immediately</p></div></div>
        <div class="table-wrap" id="logTable"></div>
      </section>`;

    UI.$$('#hSeg button').forEach((b) => b.onclick = () => { horizon = +b.dataset.h; render(); });
    UI.$$('#prioChips .chip').forEach((b) => b.onclick = () => { priority = b.dataset.k; render(); });
    if (UI.$('#distSel')) UI.$('#distSel').onchange = (e) => { district = e.target.value; render(); };
    UI.$$('[data-act]').forEach((b) => b.onclick = async () => {
      const t = plan.find((x) => x.id === b.dataset.id);
      const status = b.dataset.act;
      if (Api.enabled) {
        UI.$$('[data-act]').forEach((x) => (x.disabled = true));
        try { await Api.decide(t, status, horizon, scenario); }
        catch (e) { UI.toast(e.message, 'warn'); UI.$$('[data-act]').forEach((x) => (x.disabled = false)); return; }
      } else DB.setTransfer({ id: t.id, medId: t.medId, from: t.from, to: t.to, qty: t.qty, priority: t.priority, km: Math.round(t.km), reason: t.shortReason, status: b.dataset.act, by: session.name });
      Engine.clearCache();
      cache.key = null;
      UI.toast(b.dataset.act === 'approved' ? `Approved: ${UI.fmt(t.qty)} ${t.med.unit} of ${t.med.name} to ${t.toPhc.name}` : 'Transfer rejected', b.dataset.act === 'approved' ? 'ok' : 'warn');
      render();
    });
    UI.$('#csvBtn').onclick = () => UI.downloadCsv(`redistribution-plan-${horizon}d.csv`, [
      ['Priority', 'From PHC', 'From district', 'To PHC', 'To district', 'Medicine', 'Quantity', 'Unit', 'Distance km', 'Reason'],
      ...shown.map((t) => [t.priority, t.fromPhc.name, DB.getDistrict(t.fromPhc.districtId).name, t.toPhc.name, DB.getDistrict(t.toPhc.districtId).name, t.med.name, t.qty, t.med.unit, Math.round(t.km), t.reason]),
    ]);

    const log = DB.transfers().sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    UI.$('#logTable').innerHTML = log.length ? `<table><thead><tr><th>When</th><th>Route</th><th>Medicine</th><th class="r">Qty</th><th>Priority</th><th>Decision</th><th>By</th></tr></thead><tbody>
      ${log.map((t) => `<tr><td class="small">${new Date(t.decidedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
        <td>${UI.esc(t.fromName || DB.getPHC(t.from).name)} → ${UI.esc(t.toName || DB.getPHC(t.to).name)}</td><td>${UI.esc(t.medName || DB.getMedicine(t.medId).name)}</td>
        <td class="r num">${UI.fmt(t.qty)}</td><td>${UI.priorityPill(t.priority)}</td>
        <td>${t.status === 'approved' ? UI.pill('normal', 'Approved · dispatched') : UI.pill('neutral', 'Rejected')}</td><td class="small muted">${UI.esc(t.by || '')}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No decisions yet. Approve a transfer above to move stock.</div>';
  }
  render();
});
