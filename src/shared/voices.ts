// Curated Kokoro voice catalog (SPEC §4, §10). Hard-coded so the panel's voice
// picker renders instantly, before the model loads. The offscreen engine treats
// these ids as authoritative; Kokoro ships more, but this is a quality-graded
// English subset (American + British) suitable for v1.

import type { VoiceOption } from './types';

export const DEFAULT_VOICE = 'af_heart';

export const VOICES: VoiceOption[] = [
  { id: 'af_heart', label: 'Heart (US, female)', lang: 'en-us' },
  { id: 'af_bella', label: 'Bella (US, female)', lang: 'en-us' },
  { id: 'af_nicole', label: 'Nicole (US, female)', lang: 'en-us' },
  { id: 'am_michael', label: 'Michael (US, male)', lang: 'en-us' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)', lang: 'en-us' },
  { id: 'am_puck', label: 'Puck (US, male)', lang: 'en-us' },
  { id: 'bf_emma', label: 'Emma (UK, female)', lang: 'en-gb' },
  { id: 'bm_george', label: 'George (UK, male)', lang: 'en-gb' },
];

export function isKnownVoice(id: string): boolean {
  return VOICES.some((v) => v.id === id);
}
