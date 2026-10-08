// YUNUS OS — shared UI helpers. Widgets build ALL DOM through these (no raw innerHTML with data).

/** h('div', {class:'x', onclick:fn, href:...}, child1, child2 | [children]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (['hidden', 'disabled', 'checked', 'required', 'multiple', 'selected'].includes(k)) { if (v) el.setAttribute(k, ''); continue; }
    if ((k === 'href' || k === 'src') && !safeURL(v)) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function safeURL(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value, window.location.href); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

export function relTime(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

export function ageHours(hrs) {
  if (hrs == null) return '—';
  if (hrs < 1) return `${Math.round(hrs * 60)}m`;
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}

export const statusDot = (kind) => h('span', { class: `dot ${kind || ''}` });

const countAnimations = new WeakMap();
/** animated count-up for hero numbers; respects reduced motion */
export function tickUp(el, target, { ms = 500, fmt = fmtInt } = {}) {
  const animation = {}; countAnimations.set(el, animation);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !Number.isFinite(target)) { el.textContent = fmt(target); return; }
  const t0 = performance.now();
  const step = (t) => {
    if (countAnimations.get(el) !== animation) return;
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** inline SVG sparkline; values: number[], w/h in px; endDot marks the latest value */
export function sparkline(values, { w = 96, h = 22, stroke = 'var(--orange)', fill = true, endDot = false, domain = null } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.style.display = 'block';
  const vs = (values || []).map(Number).filter(Number.isFinite);
  if (vs.length < 2) return svg;
  const min = domain?.[0] ?? Math.min(...vs), max = domain?.[1] ?? Math.max(...vs), span = max - min || 1;
  const pts = vs.map((v, i) => [
    (i / (vs.length - 1)) * (w - 2) + 1,
    h - 2 - ((v - min) / span) * (h - 5),
  ]);
  const d = 'M' + pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' L');
  if (fill) {
    const area = document.createElementNS(svg.namespaceURI, 'path');
    area.setAttribute('d', `${d} L${w - 1},${h - 1} L1,${h - 1} Z`);
    area.setAttribute('fill', 'currentColor');
    area.setAttribute('opacity', '0.08');
    area.style.color = stroke.startsWith('var') ? '' : stroke;
    if (stroke.startsWith('var')) area.style.color = `var(${stroke.slice(4, -1)})`;
    svg.append(area);
  }
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', stroke);
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  if (endDot) {
    const [cx, cy] = pts[pts.length - 1];
    const c = document.createElementNS(svg.namespaceURI, 'circle');
    c.setAttribute('cx', cx.toFixed(1));
    c.setAttribute('cy', cy.toFixed(1));
    c.setAttribute('r', '2');
    c.setAttribute('fill', stroke);
    svg.append(c);
  }
  return svg;
}

/** standard row for list widgets: left content + right meta, optional href */
export function listRow({ href, left, right, cls = '' }) {
  const inner = [
    h('div', { class: 'lr-left' }, left),
    right != null ? h('div', { class: 'lr-right num' }, right) : null,
  ];
  href = safeURL(href);
  const row = href
    ? h('a', { class: `lr rowlink ${cls}`, href, target: '_blank', rel: 'noreferrer' }, inner)
    : h('div', { class: `lr ${cls}` }, inner);
  return row;
}

export const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
