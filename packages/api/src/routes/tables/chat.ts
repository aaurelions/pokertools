// Chat body hygiene. Stored text is escaped so it is HTML-inert on render, and
// page sizes are clamped to a bounded server range.

export const CHAT_MAX_BODY_LENGTH = 2000;
const CHAT_MAX_PAGE_SIZE = 200;
const CHAT_DEFAULT_PAGE_SIZE = 50;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeChatBody(body: string): string {
  // Escape per code point and stop on a whole-unit boundary so truncation can
  // never leave a dangling partial entity ("&am") or a lone surrogate.
  let out = "";
  for (const character of body) {
    const unit = HTML_ESCAPES[character] ?? character;
    if (out.length + unit.length > CHAT_MAX_BODY_LENGTH) break;
    out += unit;
  }
  return out;
}

export function clampChatLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CHAT_DEFAULT_PAGE_SIZE;
  return Math.min(CHAT_MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}
