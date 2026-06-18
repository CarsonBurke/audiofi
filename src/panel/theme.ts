// Theme controller (SPEC §10: respect system theme). Three preferences —
// 'system' follows the OS light/dark setting live, 'light'/'dark' pin it. The
// choice persists in chrome.storage.local; 'dark' is applied by toggling a
// `.dark` class on <html>, which Tailwind's custom dark variant keys off.

import { ICONS } from './icons';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY_THEME = 'settings.theme';
const ORDER: ThemePref[] = ['system', 'light', 'dark'];

const media = window.matchMedia('(prefers-color-scheme: dark)');
let current: ThemePref = 'system';

function systemIsDark(): boolean {
  return media.matches;
}

function apply(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && systemIsDark());
  document.documentElement.classList.toggle('dark', dark);
}

/** Load the saved preference and start tracking the OS theme when in 'system'. */
export async function initTheme(): Promise<ThemePref> {
  const stored = await chrome.storage.local.get(KEY_THEME);
  current = isPref(stored[KEY_THEME]) ? stored[KEY_THEME] : 'system';
  apply(current);
  media.addEventListener('change', () => {
    if (current === 'system') apply(current);
  });
  return current;
}

/** Advance system → light → dark → system, persist, apply, and return the new pref. */
export async function cycleTheme(): Promise<ThemePref> {
  current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  apply(current);
  await chrome.storage.local.set({ [KEY_THEME]: current });
  return current;
}

/** SVG markup for the toggle, reflecting the current preference. */
export function themeIcon(pref: ThemePref): string {
  return pref === 'system' ? ICONS.monitor : pref === 'light' ? ICONS.sun : ICONS.moon;
}

function isPref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}
