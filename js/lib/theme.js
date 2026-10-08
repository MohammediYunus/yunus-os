// YUNUS OS — theme controller.
// Contract: initTheme(btn) cycles auto → dark → light, applies data-theme on <html>
// (attribute removed for auto), persists to localStorage 'yos-demo-theme', dispatches
// window CustomEvent('yos:theme') on every change — including OS preference flips
// while in auto mode.

const KEY = 'yos-demo-theme';
const MODES = ['auto', 'dark', 'light'];
const LABELS = { auto: '◐ auto', dark: '● dark', light: '○ light' };

let mode = 'dark';
const mqLight = window.matchMedia('(prefers-color-scheme: light)');

/** Resolved theme actually rendering right now ('dark' | 'light'). */
export function effectiveTheme() {
  return mode === 'auto' ? (mqLight.matches ? 'light' : 'dark') : mode;
}

function apply(btn) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  if (btn) btn.textContent = LABELS[mode];
  window.dispatchEvent(
    new CustomEvent('yos:theme', { detail: { mode, theme: effectiveTheme() } })
  );
}

export function initTheme(btn) {
  try {
    const saved = localStorage.getItem(KEY);
    if (MODES.includes(saved)) mode = saved;
  } catch {
    /* storage unavailable (private mode) — stay on dark */
  }
  apply(btn);

  if (btn) {
    btn.addEventListener('click', () => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      try {
        localStorage.setItem(KEY, mode);
      } catch {
        /* non-fatal */
      }
      apply(btn);
    });
  }

  // In auto mode the rendered theme follows the OS — rebroadcast so listeners
  // (e.g. the canvas force graph) can re-read their colors.
  mqLight.addEventListener('change', () => {
    if (mode === 'auto') apply(btn);
  });
}
