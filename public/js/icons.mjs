// Inline SVG icons used across the app in place of emoji. Line style, stroke = currentColor,
// so they take on the surrounding text colour and work in light and dark. icon(name) returns
// an SVG string; unknown names fall back to a neutral dot so nothing renders as a broken glyph.
const P = (inner) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  printer: P('<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/>'),
  hourglass: P('<path d="M6 3h12M6 21h12M8 3c0 4 8 5 8 9s-8 5-8 9M16 3c0 4-8 5-8 9"/>'),
  eye: P('<path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  success: P('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  frown: P('<circle cx="12" cy="12" r="9"/><path d="M8 15.5s1.4-2 4-2 4 2 4 2"/><path d="M9 9h.01M15 9h.01"/>'),
  skip: P('<path d="M5 5v14l8-7z"/><path d="M19 5v14"/>'),
  ban: P('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  receipt: P('<path d="M6 2h12v20l-2.5-1.6L13 22l-2.5-1.6L8 22l-2-1.6z"/><path d="M9 8h6M9 12h6"/>'),
  offline: P('<path d="M2 2l20 20"/><path d="M16.7 11.1A6 6 0 0 0 12 9M8.5 16.5a5 5 0 0 1 6-1"/><path d="M5 12.9a10 10 0 0 1 4-2.6M19 12.9a10 10 0 0 0-2-1.7"/><path d="M12 20h.01"/>'),
  error: P('<path d="M7.9 3h8.2L21 7.9v8.2L16.1 21H7.9L3 16.1V7.9z"/><path d="M12 8v4M12 16h.01"/>'),
  ticket: P('<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4z"/><path d="M13 6v2M13 11v2M13 16v2"/>'),
  key: P('<circle cx="7.5" cy="15.5" r="4"/><path d="M10.3 12.7L20 3M16 7l2.5 2.5M14 9l2 2"/>'),
  wifi: P('<path d="M5 12.6a10 10 0 0 1 14 0"/><path d="M8.5 16.1a5 5 0 0 1 7 0"/><path d="M2 9a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>'),
  alert: P('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  lock: P('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  wrench: P('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.5-3.5a6 6 0 0 1-7.9 7.9l-6.5 6.5a2.1 2.1 0 0 1-3-3l6.5-6.5a6 6 0 0 1 7.9-7.9z"/>'),
  fullscreen: P('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  sparkle: P('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>'),
  refresh: P('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v5h-5"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
};

export function icon(name) {
  return ICONS[name] || P('<circle cx="12" cy="12" r="2.5"/>');
}
