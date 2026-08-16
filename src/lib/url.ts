/** A same-origin relative path, or null. Every post-sign-in redirect passes
 *  through here so a `next=` can only ever send someone deeper into this site,
 *  never off it: one leading slash, not "//" or "/\" (protocol-relative), no
 *  control characters, and nothing longer than a real path. Anything else
 *  falls back to the standing-based landing. Kept here, on its own, because it
 *  is the open-redirect guard and it is worth being able to test in isolation.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  if (/[\x00-\x1f]/.test(raw)) return null;
  return raw;
}
