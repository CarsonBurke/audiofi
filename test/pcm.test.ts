import { describe, it, expect } from 'vitest';
import { encodePcm, decodePcm } from '../src/shared/pcm';

describe('pcm codec', () => {
  it('round-trips float32 samples exactly', () => {
    const pcm = new Float32Array([0, 1, -1, 0.5, -0.25, 0.123456, -0.987654]);
    const restored = decodePcm(encodePcm(pcm));
    expect(restored.length).toBe(pcm.length);
    expect(Array.from(restored)).toEqual(Array.from(pcm));
  });

  it('handles an empty buffer', () => {
    expect(decodePcm(encodePcm(new Float32Array(0))).length).toBe(0);
  });

  it('round-trips a buffer larger than the 32K encode window', () => {
    const pcm = new Float32Array(100_000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 0.01);
    const restored = decodePcm(encodePcm(pcm));
    expect(restored.length).toBe(pcm.length);
    expect(restored[0]).toBe(pcm[0]);
    expect(restored[99_999]).toBe(pcm[99_999]);
    expect(restored[50_000]).toBe(pcm[50_000]);
  });

  it('preserves values when the source is a view with a non-zero byteOffset', () => {
    const backing = new Float32Array([9, 9, 1, 2, 3, 4]);
    const view = backing.subarray(2); // byteOffset = 8
    const restored = decodePcm(encodePcm(view));
    expect(Array.from(restored)).toEqual([1, 2, 3, 4]);
  });
});
