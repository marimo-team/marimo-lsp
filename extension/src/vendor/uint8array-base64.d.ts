/**
 * TC39 Uint8Array Base64 proposal (Stage 4).
 * TypeScript doesn't ship these types yet, so we vendor them.
 * @see https://github.com/tc39/proposal-arraybuffer-base64
 */

interface Uint8ArrayConstructor {
  fromBase64(base64: string): Uint8Array;
  fromHex(hex: string): Uint8Array;
}

interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
  toBase64(): string;
  toHex(): string;
  setFromBase64(base64: string): { read: number; written: number };
  setFromHex(hex: string): { read: number; written: number };
}
