import { describe, expect, it } from "vitest";

import { escapeHtml } from "../public/escape.js";

describe("escapeHtml", () => {
  it("escapes markup and attribute-breaking characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;"
    );
  });

  it("handles non-string values", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42.5)).toBe("42.5");
    expect(escapeHtml("SOL/USDC Bot")).toBe("SOL/USDC Bot");
  });
});
