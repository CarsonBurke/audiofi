// Volume scale (linear 0–1) and speaker glyph, shared by the panel and widget.

import { ICONS } from '../panel/icons';

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const VOLUME_STEP = 0.05;

export const volumeToFraction = (v: number): number => v;
export const volumeToValue = (f: number): number => f;
export const formatVolume = (v: number): string => `${Math.round(v * 100)}%`;

/** Speaker icon matching the current level (muted / low / high). */
export const volumeIcon = (v: number): string =>
  v <= 0 ? ICONS.volumeMute : v < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh;

export const clampVolume = (v: number): number => Math.min(Math.max(v, VOLUME_MIN), VOLUME_MAX);
