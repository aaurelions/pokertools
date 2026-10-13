import { describe, expect, it } from "vitest";
import { CHAT_MAX_BODY_LENGTH, sanitizeChatBody } from "../../src/routes/tables/chat.js";

describe("sanitizeChatBody", () => {
  it("escapes markup", () => {
    expect(sanitizeChatBody(`<b>"a"&'b'</b>`)).toBe(
      "&lt;b&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/b&gt;"
    );
  });

  it("never cuts an HTML entity in half when truncating", () => {
    const out = sanitizeChatBody("a".repeat(CHAT_MAX_BODY_LENGTH - 1) + "<");
    expect(out.length).toBeLessThanOrEqual(CHAT_MAX_BODY_LENGTH);
    expect(out).toBe("a".repeat(CHAT_MAX_BODY_LENGTH - 1));
    expect(out).not.toMatch(/&[a-z#0-9]*$/);
  });

  it("never splits a surrogate pair when truncating", () => {
    const out = sanitizeChatBody("a".repeat(CHAT_MAX_BODY_LENGTH - 1) + "😀");
    expect(out).toBe("a".repeat(CHAT_MAX_BODY_LENGTH - 1));
  });
});
