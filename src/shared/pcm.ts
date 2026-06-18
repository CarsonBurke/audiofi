// PCM wire codec.
//
// Chrome extension messaging (`chrome.runtime.sendMessage` /
// `chrome.tabs.sendMessage`) serialises payloads as JSON, NOT via structured
// clone — so a `Float32Array` does not survive the hop: it arrives as a plain,
// lengthless object and is unusable as audio. We therefore ship PCM as a base64
// string of its raw little-endian float32 bytes and rebuild the `Float32Array`
// on the receiving side. Base64 keeps each chunk ~2.5× smaller than a JSON
// number array and parses far faster.

// 32K-sample windows keep String.fromCharCode's argument list well under the
// engine's spread/apply limit while still amortising the call overhead.
const WINDOW = 0x8000;

/** Encode mono float32 PCM to a base64 string for cross-context messaging. */
export function encodePcm(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += WINDOW) {
    binary += String.fromCharCode(...bytes.subarray(i, i + WINDOW));
  }
  return btoa(binary);
}

/** Rebuild a float32 PCM buffer from {@link encodePcm}'s base64 string. */
export function decodePcm(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Clamp to a whole number of float32s: the Float32Array(buffer) overload
  // throws on a byteLength that isn't a multiple of 4, so a truncated/corrupt
  // payload would otherwise crash the message handler instead of degrading.
  const floats = Math.floor(bytes.byteLength / 4);
  return new Float32Array(bytes.buffer, 0, floats);
}
