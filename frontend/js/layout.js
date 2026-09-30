/* =========================================================================
   layout.js — Shared UI helpers + sidebar/topbar shell for every page.
   ========================================================================= */
const UI = {
  fmt: (n) => Math.round(Number(n)).toLocaleString('en-IN'),
  fmt1: (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 }),
  pct: (x) => `${Math.round(x * 100)}%`,
  date: (d) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
  shortDate: (d) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
  esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  param: (k) => new URLSearchParams(location.search).get(k),
  $: (sel, root = document) => root.querySelector(sel),
  $$: (sel, root = document) => [...root.querySelectorAll(sel)],

  STATUS_ICON: { normal: '🟢', warning: '🟡', critical: '🔴' },
  pill(level, text) { return `<span class="pill pill-${level}"><i class="dot"></i>${UI.esc(text)}</span>`; },
  statusPill(level, text) { return `<span class="pill pill-${level}">${UI.STATUS_ICON[level]} ${UI.esc(text)}</span>`; },
  priorityPill(p) { const lv = { HIGH: 'critical', MEDIUM: 'warning', LOW: 'info' }[p]; return `<span class="pill pill-${lv}">${p}</span>`; },

  kpi({ label, value, sub = '', tone = '', icon = '' }) {
    return `<div class="kpi ${tone ? 'kpi-' + tone : ''}">
      <div class="kpi-label">${icon ? `<span class="kpi-icon">${icon}</span>` : ''}${UI.esc(label)}</div>
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;
  },

  meter(frac, level) {
    const w = Math.max(2, Math.min(100, frac * 100));
    return `<div class="meter"><span class="meter-${level}" style="width:${w}%"></span></div>`;
  },

  toast(msg, tone = 'ok') {
    let host = UI.$('#toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = `toast toast-${tone}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
  },

  // Fill a <select> with the PHCs the user may see, grouped by district
  phcOptions(select, selectedId, { includeAll = false } = {}) {
    const list = Auth.scopePHCs();
    const groups = {};
    list.forEach((p) => (groups[p.districtId] = groups[p.districtId] || []).push(p));
    let html = includeAll ? `<option value="">All PHCs in scope (${list.length})</option>` : '';
    Object.entries(groups).forEach(([dId, ps]) => {
      html += `<optgroup label="${UI.esc(DB.getDistrict(dId).name)}">` +
        ps.map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${UI.esc(p.name)}</option>`).join('') +
        '</optgroup>';
    });
    select.innerHTML = html;
    if (list.length === 1) select.disabled = true;
  },

  downloadCsv(filename, rows) {
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
  },
};

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  phc: '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M12 9v6M9 12h6"/>',
  pill: '<path d="M10.5 20.5a4.95 4.95 0 0 1-7-7l10-10a4.95 4.95 0 0 1 7 7z"/><path d="m8.5 8.5 7 7"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  swap: '<path d="M7 7h13l-4-4"/><path d="M17 17H4l4 4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
};
const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const Theme = {
  init() {
    let t = null;
    try { t = localStorage.getItem('phc_theme'); } catch (e) { /* ignore */ }
    if (t) document.documentElement.dataset.theme = t;
  },
  toggle() {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('phc_theme', next); } catch (e) { /* ignore */ }
    document.dispatchEvent(new Event('themechange'));
  },
};
Theme.init();

const Layout = {
  NAV: [
    { href: 'dashboard.html', label: 'Overview', icon: 'dashboard' },
    { href: 'phc.html', label: 'PHC Dashboard', icon: 'phc' },
    { href: 'medicines.html', label: 'Medicine Monitoring', icon: 'pill' },
    { href: 'prediction.html', label: 'AI Prediction', icon: 'trend' },
    { href: 'simulation.html', label: 'Emergency Simulation', icon: 'zap' },
    { href: 'redistribution.html', label: 'Redistribution', icon: 'swap' },
    { href: 'alerts.html', label: 'Alerts', icon: 'bell' },
  ],

  init({ title, subtitle = '' }) {
    const s = Auth.guard();
    if (!s) return null;
    const page = location.pathname.split('/').pop();
    const alertCount = Engine.alerts(Auth.scopePHCs()).filter((a) => !a.acked && a.severity === 'critical').length;

    UI.$('#sidebar').innerHTML = `
      <div class="brand">
        <div class="brand-mark">${icon('phc')}</div>
        <div><div class="brand-name">PulseGrid</div><div class="brand-tag">Federated PHC Resilience</div></div>
      </div>
      <nav class="nav">
        ${Layout.NAV.filter((n) => Auth.can(n.href)).map((n) => `
          <a href="${n.href}" class="nav-item ${n.href === page ? 'active' : ''}">
            ${icon(n.icon)}<span>${n.label}</span>
            ${n.href === 'alerts.html' && alertCount ? `<b class="nav-badge">${alertCount}</b>` : ''}
          </a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="user-card">
          <div class="avatar">${UI.esc(s.name.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</div>
          <div class="user-meta"><div class="user-name">${UI.esc(s.name)}</div><div class="user-role">${Auth.ROLE_LABEL[s.role]}</div></div>
        </div>
        <button class="btn btn-ghost btn-block side-btn" id="resetBtn" title="Clear approved transfers and acknowledged alerts">${icon('reset')} Reset demo data</button>
        <button class="btn btn-ghost btn-block side-btn" id="logoutBtn">${icon('logout')} Sign out</button>
      </div>`;

    UI.$('#topbar').innerHTML = `
      <button class="icon-btn only-mobile" id="menuBtn" aria-label="Menu">${icon('menu')}</button>
      <div class="topbar-title">
        <h1>${UI.esc(title)}</h1>
        ${subtitle ? `<p>${UI.esc(subtitle)}</p>` : ''}
      </div>
      <div class="topbar-actions">
        <span class="mode-chip ${Api.enabled ? 'live' : ''}" title="${Api.enabled ? 'Connected to the PulseGrid backend: data from the SQL database' : 'Backend not connected: using built-in demo data'}"><i></i>${Api.enabled ? 'Live' : 'Demo data'}</span>
        <span class="scope-chip" title="Your data scope">${UI.esc(Auth.scopeLabel())}</span>
        <span class="date-chip">${UI.date(DB.TODAY)}</span>
        <a href="alerts.html" class="icon-btn" aria-label="Alerts">${icon('bell')}${alertCount ? `<b class="bell-badge">${alertCount}</b>` : ''}</a>
        <button class="icon-btn" id="themeBtn" aria-label="Toggle theme">${icon('moon')}</button>
      </div>`;

    UI.$('#logoutBtn').onclick = Auth.logout;
    UI.$('#themeBtn').onclick = Theme.toggle;
    const resetBtn = UI.$('#resetBtn');
    if (Api.enabled && s.role !== 'admin') resetBtn.remove();
    else resetBtn.onclick = async () => {
      if (Api.enabled) {
        if (!confirm('Re-seed the database? ALL data in the SQL database will be replaced with fresh demo data.')) return;
        resetBtn.disabled = true;
        try { await Api.reseed(); location.reload(); } catch (e) { UI.toast(e.message, 'warn'); resetBtn.disabled = false; }
      } else if (confirm('Reset demo data? Approved transfers and acknowledged alerts will be cleared.')) {
        DB.resetState(); location.reload();
      }
    };
    UI.$('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
    UI.$('#scrim')?.addEventListener('click', () => document.body.classList.remove('nav-open'));
    document.title = `${title} · PulseGrid`;
    return s;
  },
};
