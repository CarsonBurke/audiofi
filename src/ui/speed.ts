// Shared playback-speed scale for the side panel and the in-page widget.
//
// Speed runs on a log (exponential) scale so each octave gets equal slider
// travel: 0.5× | 1× | 2× | 4× sit at 0, ⅓, ⅔, 1. That puts the common 1–2× band
// squarely in the middle and keeps fine control where people actually listen.

import type { SliderNotch } from './slider';

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 4;
export const SPEED_STEP = 0.05;

const OCTAVES = Math.log2(SPEED_MAX / SPEED_MIN); // = 3

export const speedToFraction = (v: number): number => Math.log2(v / SPEED_MIN) / OCTAVES;
export const speedToValue = (f: number): number => SPEED_MIN * 2 ** (f * OCTAVES);

export const SPEED_NOTCHES: SliderNotch[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 1.5 },
  { value: 2, label: '2×' },
  { value: 3 },
  { value: 4, label: '4×' },
];

/** Compact label, e.g. 1 → "1×", 1.5 → "1.5×", 1.85 → "1.85×". */
export const formatSpeed = (v: number): string => `${v.toFixed(2).replace(/\.?0+$/, '')}×`;

/** Clamp an arbitrary stored speed into the supported range. */
export const clampSpeed = (v: number): number => Math.min(Math.max(v, SPEED_MIN), SPEED_MAX);
