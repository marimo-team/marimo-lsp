import * as NodeCrypto from "node:crypto";

export const DISCOVERY_API_PATH = "/api/marimo/v1";
export const DISCOVERY_OPERATIONS = [
  "catalog.watch",
  "notebook.open",
  "session.execute",
] as const;

/** RFC 9562 UUIDv5, used for opaque IDs stable within one publisher lifetime. */
export function uuidV5(namespace: string, value: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  if (namespaceBytes.byteLength !== 16) {
    throw new Error("UUIDv5 namespace must be a UUID");
  }
  const bytes = NodeCrypto.createHash("sha1")
    .update(namespaceBytes)
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
