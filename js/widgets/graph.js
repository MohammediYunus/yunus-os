// YUNUS OS — THE GRAPH: a 3D constellation of the selected codebase.
// Slow earth-like spin, drag to rotate, wheel zoom, hover/click to explore
// relations (obsidian-style). Canvas 2D with perspective projection, no libs.
import { h, fmtInt, tickUp } from '../lib/ui.js';

const SPIN = (Math.PI * 2) / 90_000;  // 1 revolution / 90s (rad per ms)
const FOV = 2.6;                      // perspective strength
const ZOOM_MIN = 0.5, ZOOM_MAX = 3;

/* ---------- trackball rotation (3x3 matrix — infinite tumble, no gimbal) ---------- */
const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
function mul3(A, B) {
  const M = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    M[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  return M;
}
// Gram-Schmidt re-orthonormalization — keeps float drift from ever skewing the globe
function ortho3(M) {
  let [ax, ay, az] = [M[0], M[3], M[6]];
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  let [bx, by, bz] = [M[1], M[4], M[7]];
  const d = ax * bx + ay * by + az * bz;
  bx -= d * ax; by -= d * ay; bz -= d * az;
  const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return [ax, bx, cx, ay, by, cy, az, bz, cz];
}
const ROT0 = mul3(rotX(0.21), rotY(0.6)); // initial orientation (matches the old tilt + yaw)

const S = {
  nodes: [], links: [], byId: new Map(), neighbors: new Map(),
  stats: null, built: '', identity: '', sourceKey: '',
  rot: [...ROT0], spinVel: SPIN, dragging: false, lastPointer: null,
  inertia: 0, idleSince: 0, hoverId: null, pinnedId: null, orthoTick: 0,
  zoom: 1, panX: 0, panY: 0, tZoom: 1, tPanX: 0, tPanY: 0, userView: false,
  lastClickT: 0, lastClickX: 0, lastClickY: 0, lastHero: -1,
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1, raf: 0, lastT: 0,
  pal: null, reduced: false,
  els: {},
};

/* ---------- palette from tokens (re-derived on yos:theme) ---------- */
function derivePalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const light = (css.getPropertyValue('color-scheme') || '').includes('light');
  const ramp = light
    ? [v('--orange'), '#8a4a12', '#3d3a30', '#1c1b17', '#0f7fc4', '#55534b']
    : [v('--orange'), '#ffb020', '#ffd98a', '#c9a05a', '#56c8ff', '#9c8a6a'];
  S.pal = {
    light,
    fg: v('--fg'), dim: v('--dim'), faint: v('--faint'),
    orange: v('--orange'), line: v('--line'),
    ramp,
    linkAlpha: light ? 0.07 : 0.2,
    glow: !light,
  };
}

/* ---------- 3D layout: community clusters on a fibonacci sphere ---------- */
function buildLayout(graph) {
  const nodes = graph.nodes || [], links = graph.links || [];
  S.byId.clear(); S.neighbors.clear();

  const commSizes = new Map();
  for (const n of nodes) commSizes.set(n.community, (commSizes.get(n.community) || 0) + 1);
  const comms = [...commSizes.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const commIndex = new Map(comms.map((c, i) => [c, i]));

  // cluster centers on a unit fibonacci sphere
  const centers = new Map();
  const GA = Math.PI * (3 - Math.sqrt(5));
  comms.forEach((c, i) => {
    const y = comms.length === 1 ? 0 : 1 - (2 * (i + 0.5)) / comms.length;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    centers.set(c, [Math.cos(GA * i) * r, y, Math.sin(GA * i) * r]);
  });

  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree || 1));
  // deterministic per-node pseudo-random from id (layout stable across loads)
  const rand = (s, salt) => {
    // Avalanche the hash: sequential synthetic IDs otherwise collapse into streaks.
    let x = 0x811c9dc5 ^ salt;
    for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    x = (x ^ (x >>> 16)) >>> 0;
    return (x / 0xffffffff) * 2 - 1;
  };

  S.nodes = nodes.map((n) => {
    const [cx, cy, cz] = centers.get(n.community) || [0, 0, 1];
    const spread = 0.38 + 0.3 * Math.min(1, (commSizes.get(n.community) || 1) / 40);
    let x = cx + rand(n.id, 3) * spread;
    let y = cy + rand(n.id, 17) * spread;
    let z = cz + rand(n.id, 41) * spread;
    // hubs sink toward the core so the center glows
    const hub = Math.sqrt((n.degree || 1) / maxDeg);
    const shell = 1 - 0.35 * hub;
    const len = Math.hypot(x, y, z) || 1;
    x = (x / len) * shell; y = (y / len) * shell; z = (z / len) * shell;
    const node = {
      ...n, x, y, z,
      ci: commIndex.get(n.community) || 0,
      r: 1.1 + 3.1 * hub,
      hub: hub > 0.55,
      sx: 0, sy: 0, sr: 0, depth: 0,
    };
    S.byId.set(n.id, node);
    return node;
  });

  S.links = links
    .filter((l) => S.byId.has(l.source) && S.byId.has(l.target))
    .map((l) => ({ a: S.byId.get(l.source), b: S.byId.get(l.target), w: l.weight || 1 }));
  for (const l of S.links) {
    if (!S.neighbors.has(l.a.id)) S.neighbors.set(l.a.id, new Set());
    if (!S.neighbors.has(l.b.id)) S.neighbors.set(l.b.id, new Set());
    S.neighbors.get(l.a.id).add(l.b.id);
    S.neighbors.get(l.b.id).add(l.a.id);
  }
}

/* ---------- projection ---------- */
function project(n, cx, cy, rScale) {
  const M = S.rot;
  const x1 = M[0] * n.x + M[1] * n.y + M[2] * n.z;
  const y2 = M[3] * n.x + M[4] * n.y + M[5] * n.z;
  const z2 = M[6] * n.x + M[7] * n.y + M[8] * n.z;
  const d = FOV / (FOV - z2);            // z2 in [-1,1]; always > 0
  n.sx = cx + x1 * rScale * d * S.zoom + S.panX;
  n.sy = cy + y2 * rScale * d * S.zoom + S.panY;
  n.sr = Math.max(0.5, n.r * d * Math.sqrt(S.zoom));
  n.depth = (z2 + 1) / 2;                // 0 back … 1 front
}

/* ---------- render loop ---------- */
function render(now) {
  const { ctx, w, h, pal } = S;
  if (!ctx || !pal) { S.raf = requestAnimationFrame(render); return; }
  const dt = S.lastT ? Math.min(50, now - S.lastT) : 16;
  S.lastT = now;
  // watchdog: a degenerate camera can never strand the widget — snap home instead
  if (!Number.isFinite(S.rot[0] + S.rot[4] + S.rot[8] + S.zoom + S.panX + S.panY)) {
    S.rot = [...ROT0]; S.inertia = 0;
    S.zoom = S.tZoom = 1; S.panX = S.panY = S.tPanX = S.tPanY = 0;
  }

  // motion: spin unless interacting/focused/reduced — screen-space Y rotation,
  // so the earth-spin reads the same whatever way the user has tumbled the globe
  const wantSpin = !S.reduced && !S.dragging && !S.hoverId && !S.pinnedId;
  const target = wantSpin ? SPIN : 0;
  S.spinVel += (target - S.spinVel) * Math.min(1, dt / 600);
  const spinStep = S.reduced ? 0 : S.spinVel * dt + S.inertia * dt;
  if (spinStep) S.rot = mul3(rotY(spinStep), S.rot);
  S.inertia *= Math.pow(0.9982, dt);
  if (++S.orthoTick % 240 === 0) S.rot = ortho3(S.rot); // scrub float drift

  // smooth zoom/pan toward targets
  const k = S.reduced ? 1 : Math.min(1, dt / 140);
  S.zoom += (S.tZoom - S.zoom) * k;
  S.panX += (S.tPanX - S.panX) * k;
  S.panY += (S.tPanY - S.panY) * k;
  setZoomHUD();
  // deep zoom = exploring — fade the DOM overlays out of the way
  S.els.wrap?.classList.toggle('gx-zoomed', S.zoom > 1.5);

  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.47;
  const rScale = Math.min(w, h) * 0.42;

  for (const n of S.nodes) project(n, cx, cy, rScale);

  const focusId = S.pinnedId || S.hoverId;
  const focusSet = focusId ? S.neighbors.get(focusId) || new Set() : null;
  const isFocused = (n) => focusId && (n.id === focusId || focusSet.has(n.id));

  // links first — focus links are drawn as flowing orange bead-rays afterwards
  ctx.lineWidth = 1;
  const focusRays = [];
  for (const l of S.links) {
    if (focusId && (l.a.id === focusId || l.b.id === focusId)) { focusRays.push(l); continue; }
    const da = (l.a.depth + l.b.depth) / 2;
    let alpha = pal.linkAlpha * (0.25 + 0.75 * da) * Math.min(1, 0.5 + l.w * 0.25);
    if (focusId) alpha *= 0.12;
    const color = pal.light ? '28,27,23' : '233,215,180';
    ctx.strokeStyle = `rgba(${color},${alpha.toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(l.a.sx, l.a.sy); ctx.lineTo(l.b.sx, l.b.sy); ctx.stroke();
  }
  if (focusId && focusRays.length) {
    const focus = S.byId.get(focusId);
    const SPACING = 16;
    // uniform beads drifting slowly outward — identical sizes keep the loop seamless
    const flow = S.reduced ? 0 : (now * 0.0065) % SPACING;
    ctx.fillStyle = pal.light ? 'rgba(232,82,10,0.75)' : 'rgba(232,120,40,0.8)';
    const beadR = 0.9 * Math.sqrt(S.zoom);
    for (const l of focusRays) {
      const other = l.a.id === focusId ? l.b : l.a;
      const dx = other.sx - focus.sx, dy = other.sy - focus.sy;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const start = focus.sr + 6, end = d - other.sr - 4;
      for (let t = start + flow; t < end; t += SPACING) {
        ctx.beginPath();
        ctx.arc(focus.sx + ux * t, focus.sy + uy * t, beadR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // nodes back-to-front
  const sorted = [...S.nodes].sort((a, b) => a.depth - b.depth);
  ctx.globalCompositeOperation = pal.glow ? 'lighter' : 'source-over';
  for (const n of sorted) {
    let alpha = 0.28 + 0.72 * n.depth;
    if (focusId && !isFocused(n)) alpha *= 0.14;
    const col = n.id === focusId ? pal.orange : pal.ramp[Math.min(n.ci, pal.ramp.length - 1)];
    ctx.shadowBlur = pal.glow && (n.hub || isFocused(n)) ? 9 : 0;
    ctx.shadowColor = col;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(n.sx, n.sy, n.sr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'source-over';

  // focus labels (hovered/pinned + neighbors — obsidian-style relations).
  // Label as many neighbors as legibly fit: front/hub nodes first, greedy
  // collision skip so labels never overlap, edge-cull so they never clamp.
  if (focusId) {
    const focus = S.byId.get(focusId);
    const labelled = [focus, ...[...focusSet].map((id) => S.byId.get(id))]
      .filter(Boolean)
      .sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1
        : (b.depth + (b.degree || 0) / 200) - (a.depth + (a.degree || 0) / 200)));
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const n of labelled) {
      const main = n.id === focusId;
      const label = main ? n.label : (n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label);
      const tw = ctx.measureText(label).width;
      // cull labels that would clamp into the panel edges (never pile up at borders)
      const tx = n.sx + n.sr + 5;
      const ty = n.sy;
      if (tx < 6 || tx + tw > w - 6 || ty < 12 || ty > h - 12) continue;
      const box = { x: tx - 2, y: ty - 7, w: tw + 4, h: 14 };
      if (!main && placed.some((p) =>
        !(box.x > p.x + p.w || box.x + box.w < p.x || box.y > p.y + p.h || box.y + box.h < p.y))) continue;
      placed.push(box);
      ctx.globalAlpha = main ? 1 : 0.75;
      ctx.fillStyle = main ? pal.orange : pal.fg;
      if (!pal.light) { ctx.shadowColor = '#000'; ctx.shadowBlur = 4; }
      ctx.fillText(label, tx, ty);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  S.raf = requestAnimationFrame(render);
}

/* ---------- interaction helpers ---------- */
function nodeAt(mx, my) {
  let best = null, bestD = 1e9;
  for (const n of S.nodes) {
    const d = Math.hypot(n.sx - mx, n.sy - my);
    if (d < bestD && d < n.sr + 8) { best = n; bestD = d; }
  }
  return best;
}

function setZoomHUD() {
  const hud = S.els.hud;
  if (!hud) return;
  // visible whenever meaningfully zoomed — zoom only ever changes by user action,
  // so this can never be summoned by autonomous motion. Stays until reset lands.
  const show = Math.abs(S.tZoom - 1) > 0.02 || Math.abs(S.zoom - 1) > 0.02
    || Math.abs(S.tPanX) > 8 || Math.abs(S.tPanY) > 8;
  hud.style.display = show ? '' : 'none';
  if (show) {
    const pct = `${Math.round(S.zoom * 100)}%`;
    if (hud.firstChild.textContent !== pct) hud.firstChild.textContent = pct;
  }
}

function clearHover() {
  S.hoverId = null;
  if (S.els.tip) S.els.tip.style.display = 'none';
}

function resetView() {
  S.tZoom = 1; S.tPanX = 0; S.tPanY = 0; S.userView = false;
  S.rot = [...ROT0]; S.inertia = 0; // home orientation too — full "reset view"
  clearHover();
}

function showFocusPanel(node, { focusResult = false } = {}) {
  const { statsBlock, focusBlock } = S.els;
  const hadFocus = focusBlock.contains(document.activeElement);
  if (!node) {
    focusBlock.style.display = 'none';
    statsBlock.style.display = '';
    if (hadFocus) S.els.explore.focus();
    return;
  }
  const neigh = [...(S.neighbors.get(node.id) || [])]
    .map((id) => S.byId.get(id)).filter(Boolean)
    .sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 5);
  const nLinks = (S.neighbors.get(node.id) || new Set()).size;
  const heading = h('div', { class: 'gx-focus-name', role: 'heading', 'aria-level': '3', tabindex: '-1' }, node.label);
  focusBlock.replaceChildren(
    heading,
    h('div', { class: 'gx-focus-meta' },
      `${nLinks} ${nLinks === 1 ? 'link' : 'links'} shown · deg ${node.degree ?? '—'}`),
    h('div', { class: 'gx-focus-rel' }, 'related'),
    ...neigh.map((nb) => h('button', {
      class: 'gx-focus-nb',
      title: nb.label,
      onclick: (e) => { e.stopPropagation(); pin(nb.id, { focusResult: true }); },
    }, nb.label.length > 30 ? nb.label.slice(0, 29) + '…' : nb.label)),
  );
  focusBlock.style.display = '';
  statsBlock.style.display = 'none';
  if (focusResult || hadFocus) heading.focus();
}

function pin(id, options) {
  S.pinnedId = id;
  S.els.wrap?.classList.toggle('gx-pinned', !!id);
  showFocusPanel(id ? S.byId.get(id) : null, options);
}

/* ---------- events ---------- */
function wireEvents() {
  const cv = S.canvas, tip = S.els.tip;

  // controls: LEFT-drag pans the view · RIGHT-drag rotates the globe
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    S.lastPointer = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  });
  cv.addEventListener('pointermove', (e) => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (S.lastPointer && (e.buttons & (1 | 2))) {
      const dx = e.clientX - S.lastPointer.x, dy = e.clientY - S.lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) S.lastPointer.moved = true;
      if (S.lastPointer.moved) {
        S.dragging = true;
        if (e.buttons & 2) {
          // right button: trackball rotate — infinite tumble on both axes
          S.rot = mul3(rotX(dy * 0.004), mul3(rotY(dx * 0.005), S.rot));
          S.inertia = Math.max(-0.0025, Math.min(0.0025, dx * 0.00012));
        } else {
          // left button: pan the view
          S.tPanX += dx; S.panX += dx;
          S.tPanY += dy; S.panY += dy;
          S.userView = true;
          setZoomHUD();
        }
        S.lastPointer.x = e.clientX; S.lastPointer.y = e.clientY;
        cv.style.cursor = 'grabbing';
      }
      return;
    }
    const n = nodeAt(mx, my);
    S.hoverId = n ? n.id : null;
    cv.style.cursor = n ? 'pointer' : 'grab';
    if (n && !S.pinnedId) {
      tip.style.display = '';
      // quadrant-flip so the card never buries the hovered cluster
      tip.style.left = mx > rect.width * 0.58 ? `${Math.max(6, mx - 214)}px` : `${mx + 14}px`;
      tip.style.top = `${Math.max(6, my - 36)}px`;
      const comm = n.communityName && n.communityName.toLowerCase() !== n.label.toLowerCase()
        ? `${n.communityName} · ` : '';
      tip.replaceChildren(
        h('div', { class: 'gx-tip-name' }, n.label),
        h('div', { class: 'gx-tip-meta' },
          `${comm}deg ${n.degree ?? '—'} · ${n.fileType || 'code'}`),
      );
    } else tip.style.display = 'none';
  });
  cv.addEventListener('pointerup', (e) => {
    const wasDrag = S.lastPointer?.moved;
    S.lastPointer = null; S.dragging = false; S.idleSince = performance.now();
    cv.style.cursor = 'grab';
    if (wasDrag || e.button !== 0) return; // pin/reset are left-click gestures only
    // manual double-click detection — more reliable than the dblclick event
    // under pointer capture, and it must also clear pin/hover state.
    const nowT = performance.now();
    if (S.lastClickT && nowT - S.lastClickT < 350
      && Math.hypot(e.clientX - S.lastClickX, e.clientY - S.lastClickY) < 6) {
      S.lastClickT = 0;
      resetView();
      pin(null);
      return;
    }
    S.lastClickT = nowT; S.lastClickX = e.clientX; S.lastClickY = e.clientY;
    const rect = cv.getBoundingClientRect();
    const n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    pin(n ? n.id : null);
  });
  cv.addEventListener('pointerleave', () => {
    S.hoverId = null; tip.style.display = 'none'; S.idleSince = performance.now();
  });

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.0105 : 0.0022));
    const z0 = S.tZoom;
    S.tZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.tZoom * factor));
    const scale = S.tZoom / z0;
    // keep the world point under the cursor fixed
    const cx = rect.width / 2, cy = rect.height * 0.47;
    S.tPanX = (S.tPanX - (mx - cx)) * scale + (mx - cx);
    S.tPanY = (S.tPanY - (my - cy)) * scale + (my - cy);
    S.userView = true;
    setZoomHUD();
  }, { passive: false });

  cv.addEventListener('dblclick', (e) => { e.preventDefault(); resetView(); pin(null); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.pinnedId) pin(null); });

  window.addEventListener('yos:theme', () => { derivePalette(); clearHover(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(S.raf); S.raf = 0; S.lastT = 0; }
    else if (!S.raf) S.raf = requestAnimationFrame(render);
  });
}

/* ---------- widget module ---------- */
export default {
  id: 'graph',
  title: 'The Graph',

  mount(el) {
    el.classList.add('w-graph');
    const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    S.reduced = motionPreference.matches;
    if (S.reduced) S.spinVel = S.inertia = 0;
    motionPreference.addEventListener('change', event => {
      S.reduced = event.matches;
      if (S.reduced) S.spinVel = S.inertia = 0;
    });
    const wrap = h('div', { class: 'gx-wrap' });
    S.els.wrap = wrap;
    S.canvas = h('canvas', { class: 'gx-canvas', 'aria-label': 'Codebase graph. Drag to pan, right-drag to rotate, scroll to zoom. Use Explore a node below for keyboard access.' });
    S.els.tip = h('div', { class: 'gx-tip', style: { display: 'none' } });
    S.els.hud = h('div', { class: 'gx-hud', style: { display: 'none' } },
      h('span', { class: 'num' }, '100%'), h('span', { class: 'gx-hud-hint' }, 'dblclick reset'));
    S.els.hero = h('div', { class: 'gx-hero' },
      h('div', { class: 'gx-hero-num num' }, '—'),
      h('div', { class: 'gx-hero-label' }, 'nodes · synthetic codebase'));
    S.els.statsBlock = h('div', { class: 'gx-stats' });
    S.els.focusBlock = h('div', { class: 'gx-focus', style: { display: 'none' } });
    S.els.empty = h('p', { class: 'gx-empty', hidden: true }, 'No supported source files found. Connect a repository folder to build your graph.');
    wrap.append(S.els.empty, S.canvas, S.els.tip, S.els.hud, S.els.hero, S.els.statsBlock, S.els.focusBlock);
    let exploreIndex = 0;
    S.els.explore = h('button', { class: 'graph-reset', type: 'button', onclick: () => {
      const hubs = [...S.nodes].sort((a, b) => b.degree - a.degree);
      if (hubs.length) pin(hubs[exploreIndex++ % hubs.length].id, { focusResult: true });
    } }, 'Explore a node');
    el.append(wrap,
      h('div', { class: 'graph-help' },
        h('span', {}, 'Drag to pan · right-drag to rotate · scroll to zoom'),
        S.els.explore,
        h('button', { class: 'graph-reset', type: 'button', onclick: () => { resetView(); pin(null); } }, 'Reset view')));

    derivePalette();
    const size = () => {
      const r = wrap.getBoundingClientRect();
      if (!r.width) return;
      S.dpr = window.devicePixelRatio || 1;
      S.w = Math.round(r.width); S.h = Math.round(r.height);
      S.canvas.width = S.w * S.dpr; S.canvas.height = S.h * S.dpr;
      S.ctx = S.canvas.getContext('2d');
      S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      clearHover(); // projected positions changed — stale hover would mislead
    };
    new ResizeObserver(size).observe(wrap);
    size();
    wireEvents();
    S.raf = requestAnimationFrame(render);
  },

  update(data, ctx) {
    const g = data?.graph || { nodes: [], links: [], stats: { nodes: 0, links: 0, communities: 0 } };
    const sourceKey = `${data.mode || (data.demo ? 'demo' : 'live')}|${g.sourceId || g.workspaceId || ''}`;
    const identity = JSON.stringify([sourceKey, g.nodes || [], g.links || []]);
    const changed = identity !== S.identity;
    if (changed) {
      if (sourceKey !== S.sourceKey) resetView();
      S.identity = identity; S.sourceKey = sourceKey; buildLayout(g); clearHover(); pin(null);
    }
    S.els.empty.hidden = S.nodes.length > 0;
    S.els.hero.querySelector('.gx-hero-label').textContent = data.demo ? 'nodes · synthetic codebase' : 'nodes · selected workspace';
    S.canvas.setAttribute('aria-label', `${data.demo ? 'Synthetic' : 'Selected workspace'} codebase graph. Use Explore a node below for keyboard access.`);
    S.stats = g.stats || { nodes: S.nodes.length, links: S.links.length, communities: new Set(S.nodes.map(node => node.community)).size };
    S.built = (g.builtAtCommit || '').slice(0, 7);
    if (ctx?.aux) {
      ctx.aux.replaceChildren(
        h('span', { class: 'dot' }), h('span', {}, `${fmtInt(S.nodes.length)} shown`));
    }
    if (changed) clearHover();
    const heroNum = S.els.hero?.querySelector('.gx-hero-num');
    if (heroNum && S.stats && S.stats.nodes !== S.lastHero) {
      S.lastHero = S.stats.nodes;
      tickUp(heroNum, S.stats.nodes, { ms: 700 });
    }
    if (S.els.statsBlock && S.stats && !S.pinnedId) {
      S.els.statsBlock.replaceChildren(
        h('div', {}, h('b', { class: 'num' }, fmtInt(S.stats.links)), ' links'),
        h('div', {}, h('b', { class: 'num' }, fmtInt(S.stats.communities)), ' communities'),
        S.built ? h('div', {}, h('b', { class: 'num' }, S.built), ' built') : null,
      );
    }
  },
};
