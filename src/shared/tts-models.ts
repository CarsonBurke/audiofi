export type TtsModelId = 'kokoro' | 'chatterbox-turbo';

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
    description: 'Fast local voice, 82M params. Validated in the extension.',
  },
  {
    id: 'chatterbox-turbo',
    label: 'Chatterbox ONNX',
    playable: false,
    description: 'Large expressive local prototype using the official browser-demo adapter.',
    prototypeNote:
      'Uses onnx-community/chatterbox-ONNX with its default prompt voice, but first-load UX and live offscreen playback are not product-ready yet.',
    warningNote:
      'Chatterbox is disabled until startup latency, memory, download size, cancellation, and cache behavior are validated in MV3.',
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
