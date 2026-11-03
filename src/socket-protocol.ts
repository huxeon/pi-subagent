/** Communication IDs are connection-local counters, never business IDs. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RequestFrame = { type: "request"; id: number; method: string; params: JsonValue };
export type CancelFrame = { type: "cancel"; id: number };
export type ResponseFrame =
  | { type: "response"; id: number; ok: true; result: JsonValue }
  | { type: "response"; id: number; ok: false; error: { code: string; message: string } };
export type Frame = RequestFrame | CancelFrame | ResponseFrame;
export const MAX_FRAME_BYTES = 1024 * 1024; // Excludes the final LF; includes UTF-8 bytes, not characters.

export class SocketTransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SocketTransportError";
    this.code = code;
  }
}

function invalid(message: string): never { throw new SocketTransportError("PROTOCOL_ERROR", message); }

export function parseFrame(bytes: Buffer): Frame {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return invalid("Invalid UTF-8 or JSON frame"); }
  if (!value || typeof value !== "object") return invalid("Expected a frame object");
  const f = value as Record<string, unknown>;
  if (!Number.isSafeInteger(f.id) || (f.id as number) <= 0) return invalid("Invalid request number");
  if (f.type === "cancel") return value as CancelFrame;
  if (f.type === "request" && typeof f.method === "string" && f.method.length > 0 &&
      f.method.length <= 128 && Object.hasOwn(f, "params")) return value as RequestFrame;
  if (f.type === "response") {
    if (f.ok === true && Object.hasOwn(f, "result")) return value as ResponseFrame;
    if (f.ok === false && f.error && typeof f.error === "object") {
      const e = f.error as Record<string, unknown>;
      if (typeof e.code === "string" && typeof e.message === "string") return value as ResponseFrame;
    }
  }
  return invalid("Invalid frame shape");
}

export function encodeFrame(frame: Frame, maxBytes = MAX_FRAME_BYTES): Buffer {
  const text = JSON.stringify(frame);
  // Also validate runtime values (undefined results, cyclic objects, etc. are not a wire format).
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > maxBytes) throw new SocketTransportError("FRAME_TOO_LARGE", "Socket frame exceeds byte limit");
  parseFrame(bytes);
  return Buffer.concat([bytes, Buffer.from("\n")]);
}

/** A bounded partial frame; handles split UTF-8 and multiple frames per chunk. */
export class FrameDecoder {
  private partial: Buffer = Buffer.alloc(0);
  private readonly maxBytes: number;
  constructor(maxBytes = MAX_FRAME_BYTES) { this.maxBytes = maxBytes; }
  push(chunk: Buffer, receive: (frame: Frame) => void): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      if (this.partial.length + segment.length > this.maxBytes) {
        throw new SocketTransportError("FRAME_TOO_LARGE", "Socket frame exceeds byte limit");
      }
      this.partial = this.partial.length ? Buffer.concat([this.partial, segment]) : segment;
      if (newline < 0) return;
      const bytes = this.partial;
      this.partial = Buffer.alloc(0);
      receive(parseFrame(bytes));
      start = newline + 1;
    }
  }
  clear(): void { this.partial = Buffer.alloc(0); }
}
