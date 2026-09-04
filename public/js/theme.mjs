// App-wide light/dark theme. The base look follows the device (prefers-color-scheme); a toggle
// lets the viewer pin light or dark, remembered per device in localStorage. The chosen theme is
// reflected as data-theme="light|dark" on <html>; absent means "follow the system".
const KEY = 'bff-theme';
const root = document.documentElement;

const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const effective = () => stored() || (systemDark() ? 'dark' : 'light');
const apply = (theme) => { if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme; };

const SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

const buttons = [...document.querySelectorAll('[data-theme-toggle]')];

function paint(btn) {
  const isDark = effective() === 'dark';
  // The button shows where it will take you: a sun while dark, a moon while light.
  btn.innerHTML = isDark ? SUN : MOON;
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function toggle() {
  const next = effective() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  apply(next);
  buttons.forEach(paint);
}

apply(stored());
buttons.forEach((b) => { b.addEventListener('click', toggle); paint(b); });

// While the viewer has made no explicit choice, track the device flipping light/dark.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!stored()) buttons.forEach(paint); });
