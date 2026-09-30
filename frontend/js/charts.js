/* =========================================================================
   charts.js — Tiny dependency-free SVG chart helpers.
   Colours come from CSS variables so light/dark themes work automatically.
   ========================================================================= */
const Charts = (() => {
  const registry = new Map(); // el -> redraw fn (for resize / theme change)
  const NS = 'http://www.w3.org/2000/svg';

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  const fmtAxis = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(2)}k` : `${+v.toFixed(1)}`);

  function register(el, fn) { registry.set(el, fn); fn(); }
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => registry.forEach((fn, el) => el.isConnected && fn()), 150); });
  document.addEventListener('themechange', () => registry.forEach((fn, el) => el.isConnected && fn()));

  /* Line chart with optional forecast band.
     opts: { labels: [Date|string], series: [{ name, data: [num|null], color, dash }],
             band: { lo: [], hi: [], color }, height, marker: index, markerLabel } */
  function line(el, opts) {
    register(el, () => {
      const W = el.clientWidth || 600, H = opts.height || 260;
      const pad = { l: 42, r: 14, t: 14, b: 28 };
      const n = opts.labels.length;
      const all = opts.series.flatMap((s) => s.data).concat(opts.band ? opts.band.hi : []).filter((v) => v != null);
      const yMax = niceMax(Math.max(...all) * 1.08);
      const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
      const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);

      let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart-svg" role="img" aria-label="${opts.aria || 'Line chart'}">`;
      for (let k = 0; k <= 4; k++) {
        const v = (yMax * k) / 4, yy = y(v);
        svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" class="grid"/>`;
        svg += `<text x="${pad.l - 8}" y="${yy + 4}" class="axis" text-anchor="end">${fmtAxis(v)}</text>`;
      }
      const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - pad.l) / 70))));
      opts.labels.forEach((lb, i) => {
        if ((i % step === 0 && n - 1 - i >= step * 0.6) || i === n - 1) {
          const txt = lb instanceof Date ? UI.shortDate(lb) : lb;
          svg += `<text x="${x(i)}" y="${H - 8}" class="axis" text-anchor="middle">${txt}</text>`;
        }
      });
      if (opts.marker != null) {
        svg += `<line x1="${x(opts.marker)}" x2="${x(opts.marker)}" y1="${pad.t}" y2="${H - pad.b}" class="marker"/>`;
        if (opts.markerLabel) svg += `<text x="${x(opts.marker) + 6}" y="${pad.t + 10}" class="axis marker-label">${opts.markerLabel}</text>`;
      }
      if (opts.band) {
        const idx = opts.band.lo.map((v, i) => (v == null ? null : i)).filter((i) => i != null);
        const top = idx.map((i) => `${x(i)},${y(opts.band.hi[i])}`).join(' ');
        const bot = idx.slice().reverse().map((i) => `${x(i)},${y(opts.band.lo[i])}`).join(' ');
        svg += `<polygon points="${top} ${bot}" style="fill:${opts.band.color};opacity:.16"/>`;
      }
      opts.series.forEach((s) => {
        let d = '', pen = false;
        s.data.forEach((v, i) => {
          if (v == null) { pen = false; return; }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
        });
        svg += `<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="2.25" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
      });
      svg += `<line class="hover-line" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" style="display:none"/>`;
      svg += `<rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent" class="hover-zone"/>`;
      svg += '</svg>';
      el.classList.add('chart');
      el.innerHTML = svg + '<div class="chart-tip" style="display:none"></div>';

      const zone = el.querySelector('.hover-zone'), hl = el.querySelector('.hover-line'), tip = el.querySelector('.chart-tip');
      zone.addEventListener('mousemove', (e) => {
        const rect = el.querySelector('svg').getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
        hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.style.display = '';
        const lb = opts.labels[i];
        let html = `<b>${lb instanceof Date ? UI.date(lb) : lb}</b>`;
        opts.series.forEach((s) => { if (s.data[i] != null) html += `<div><i style="background:${s.color}"></i>${s.name}: ${UI.fmt(s.data[i])}</div>`; });
        if (opts.band && opts.band.lo[i] != null) html += `<div class="muted">Range: ${UI.fmt(opts.band.lo[i])} – ${UI.fmt(opts.band.hi[i])}</div>`;
        tip.innerHTML = html; tip.style.display = '';
        const left = (x(i) / W) * rect.width;
        tip.style.left = `${Math.min(left + 12, rect.width - tip.offsetWidth - 4)}px`;
        tip.style.top = '8px';
      });
      zone.addEventListener('mouseleave', () => { hl.style.display = 'none'; tip.style.display = 'none'; });
    });
  }

  /* Vertical columns. opts: { labels, values, max, color: fn(v,i)|string, height, suffix } */
  function columns(el, opts) {
    register(el, () => {
      const W = el.clientWidth || 400, H = opts.height || 180;
      const pad = { l: 34, r: 8, t: 10, b: 26 };
      const n = opts.values.length;
      const yMax = opts.max || niceMax(Math.max(...opts.values) * 1.1);
      const bw = (W - pad.l - pad.r) / n;
      const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
      let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart-svg">`;
      for (let k = 0; k <= 2; k++) {
        const v = (yMax * k) / 2;
        svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${fmtAxis(v)}${opts.suffix || ''}</text>`;
      }
      opts.values.forEach((v, i) => {
        const c = typeof opts.color === 'function' ? opts.color(v, i) : opts.color;
        const lb = opts.labels[i];
        svg += `<rect x="${pad.l + i * bw + bw * 0.18}" y="${y(v)}" width="${bw * 0.64}" height="${Math.max(0, H - pad.b - y(v))}" rx="3" style="fill:${c}"><title>${lb instanceof Date ? UI.date(lb) : lb}: ${UI.fmt1(v)}${opts.suffix || ''}</title></rect>`;
        if (n <= 16 || i % 2 === 0) svg += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${lb instanceof Date ? lb.getDate() : lb}</text>`;
      });
      el.classList.add('chart');
      el.innerHTML = svg + '</svg>';
    });
  }

  /* Horizontal bars (HTML). items: [{ label, value, display, level }] */
  function hbars(el, items, { max } = {}) {
    const m = max || Math.max(...items.map((i) => i.value), 1);
    el.innerHTML = `<div class="hbars">${items.map((it) => `
      <div class="hbar-row">
        <div class="hbar-label" title="${UI.esc(it.label)}">${UI.esc(it.label)}</div>
        <div class="hbar-track"><span class="hbar-fill hbar-${it.level || 'info'}" style="width:${Math.max(1.5, (it.value / m) * 100)}%"></span></div>
        <div class="hbar-val">${it.display ?? UI.fmt(it.value)}</div>
      </div>`).join('')}</div>`;
  }

  /* Donut / gauge. opts: { value, total, level, center, caption } */
  function donut(el, { value, total, level = 'info', center, caption }) {
    const R = 52, C = 2 * Math.PI * R, f = total ? Math.min(1, value / total) : 0;
    el.innerHTML = `<div class="donut">
      <svg viewBox="0 0 140 140" width="140" height="140">
        <circle cx="70" cy="70" r="${R}" class="donut-track"/>
        <circle cx="70" cy="70" r="${R}" class="donut-fill donut-${level}" stroke-dasharray="${C * f} ${C}" transform="rotate(-90 70 70)"/>
        <text x="70" y="68" text-anchor="middle" class="donut-center">${center}</text>
        <text x="70" y="88" text-anchor="middle" class="axis">${caption || ''}</text>
      </svg></div>`;
  }

  /* Network map: PHCs plotted by lat/lon, coloured by risk level. */
  function map(el, points) {
    register(el, () => {
      const W = el.clientWidth || 500, H = Math.max(280, Math.min(420, W * 0.8));
      const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
      const b = { minLat: Math.min(...lats) - 1.2, maxLat: Math.max(...lats) + 1.2, minLon: Math.min(...lons) - 1.5, maxLon: Math.max(...lons) + 1.5 };
      const sx = (W - 20) / (b.maxLon - b.minLon), sy = (H - 20) / (b.maxLat - b.minLat), s = Math.min(sx, sy);
      const ox = (W - s * (b.maxLon - b.minLon)) / 2, oy = (H - s * (b.maxLat - b.minLat)) / 2;
      const px = (lon) => ox + (lon - b.minLon) * s, py = (lat) => oy + (b.maxLat - lat) * s;
      let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart-svg map-svg">`;
      for (let lat = Math.ceil(b.minLat / 5) * 5; lat <= b.maxLat; lat += 5) svg += `<line x1="0" x2="${W}" y1="${py(lat)}" y2="${py(lat)}" class="grid"/><text x="4" y="${py(lat) - 3}" class="axis">${lat}°N</text>`;
      for (let lon = Math.ceil(b.minLon / 5) * 5; lon <= b.maxLon; lon += 5) svg += `<line y1="0" y2="${H}" x1="${px(lon)}" x2="${px(lon)}" class="grid"/><text y="${H - 4}" x="${px(lon) + 3}" class="axis">${lon}°E</text>`;
      const groups = {};
      points.forEach((p) => (groups[p.group] = groups[p.group] || []).push(p));
      Object.entries(groups).forEach(([g, ps]) => {
        const cx = Engine.avg(ps.map((p) => px(p.lon))), cy = Engine.avg(ps.map((p) => py(p.lat)));
        svg += `<circle cx="${cx}" cy="${cy}" r="${26}" class="map-halo"/><text x="${cx}" y="${cy - 30}" text-anchor="middle" class="map-label">${UI.esc(g)}</text>`;
      });
      const order = { normal: 0, warning: 1, critical: 2 };
      points.slice().sort((a, b2) => order[a.level] - order[b2.level]).forEach((p) => {
        svg += `<a href="${p.href}"><circle cx="${px(p.lon)}" cy="${py(p.lat)}" r="${p.level === 'critical' ? 7 : 5.5}" class="map-dot map-${p.level}"><title>${UI.esc(p.label)}</title></circle></a>`;
      });
      el.classList.add('chart');
      el.innerHTML = svg + '</svg>';
    });
  }

  return { line, columns, hbars, donut, map };
})();
