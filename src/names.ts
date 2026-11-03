export const MAX_NAME_BYTES = 126;

/** Exact Unicode identity: no trimming, case folding or Unicode normalization. */
export function validateName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
      Buffer.from(name, "utf8").toString("utf8") !== name ||
      Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
    throw new Error(`Invalid name: expected nonblank Unicode without controls, at most ${MAX_NAME_BYTES} UTF-8 bytes`);
  }
  return name;
}

export function encodeName(name: string): string {
  return `n-${Buffer.from(validateName(name), "utf8").toString("hex")}`;
}

/** Only canonical extension directory components are accepted by discovery. */
export function decodeName(component: string): string | undefined {
  if (!/^n-(?:[0-9a-f]{2})+$/u.test(component)) return undefined;
  const name = Buffer.from(component.slice(2), "hex").toString("utf8");
  try {
    return encodeName(name) === component ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Uses the existing Pi session ID, not the session label or a generated ID. */
export function encodeParentSession(sessionId: string): string {
  return `p-${encodeName(sessionId).slice(2)}`;
}
