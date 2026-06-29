export type TtsModelId = 'kokoro' | 'mms-eng' | 'kitten-nano' | 'chatterbox-turbo';

export interface TtsModelOption {
  id: TtsModelId;
  label: string;
  playable: boolean;
  description: string;
  prototypeNote?: string;
  warningNote?: string;
}

export const DEFAULT_TTS_MODEL: TtsModelId = 'kokoro';

export const TTS_MODELS: TtsModelOption[] = [
  {
    id: 'kokoro',
    label: 'Kokoro',
    playable: true,
    description: 'Fast local voice, 82M params.',
  },
  {
    id: 'mms-eng',
    label: 'MMS English',
    playable: true,
    description: 'Tiny stock Transformers.js v4 VITS model.',
    warningNote:
      'Experimental v4 path. Single 16 kHz English voice and CC-BY-NC-4.0 upstream license; not a production default.',
  },
  {
    id: 'kitten-nano',
    label: 'KittenTTS Nano',
    playable: false,
    description: 'Small 15M StyleTTS2 candidate, about 57 MB.',
    prototypeNote: 'Smallest WebGPU/WASM candidate found; needs an engine adapter and quality testing.',
  },
  {
    id: 'chatterbox-turbo',
    label: 'Chatterbox Turbo',
    playable: false,
    description: 'Expressive voice-cloning/control candidate, about 539 MB.',
    prototypeNote: 'Best advanced control candidate; too large for default browser playback.',
  },
];

export function isKnownTtsModel(value: unknown): value is TtsModelId {
  return TTS_MODELS.some((model) => model.id === value);
}

export function isPlayableTtsModel(value: TtsModelId): boolean {
  return TTS_MODELS.some((model) => model.id === value && model.playable);
}

export function ttsModelLabel(value: TtsModelId): string {
  return TTS_MODELS.find((model) => model.id === value)?.label ?? value;
}

export function ttsModelPrototypeNote(value: TtsModelId): string {
  return TTS_MODELS.find((model) => model.id === value)?.prototypeNote ?? 'Prototype model path.';
}

export function ttsModelWarningNote(value: TtsModelId): string | undefined {
  return TTS_MODELS.find((model) => model.id === value)?.warningNote;
}

export function resolvePlayableTtsModel(value: unknown): TtsModelId {
  return isKnownTtsModel(value) && isPlayableTtsModel(value) ? value : DEFAULT_TTS_MODEL;
}
