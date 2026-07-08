import { describe, expect, it } from "vitest"
import { adMarkdown, adUrl, renderLine, sanitize } from "../src/sanitize"
import type { Ad } from "../src/types"

function ad(over: Partial<Ad> = {}): Ad {
  return {
    ad_id: "a1",
    sentence: "Fast APIs for every chain - alchemy.com",
    domain: "alchemy.com",
    impression_token: "t1",
    rotate_seconds: 20,
    ...over,
  }
}

describe("sanitize", () => {
  it("strips C0 control bytes and DEL", () => {
    expect(sanitize("a\u0000b\u001bc\u007fd\te")).toBe("abcde")
  })

  it("strips newlines and trims surrounding whitespace", () => {
    expect(sanitize("  hello\nworld  ")).toBe("helloworld")
  })

  it("leaves clean text unchanged", () => {
    expect(sanitize("clean text")).toBe("clean text")
  })

  it("preserves legitimate unicode (accents)", () => {
    expect(sanitize("APIs rápidas")).toBe("APIs rápidas")
  })
})

describe("renderLine", () => {
  it("returns the sentence when it already ends in the domain", () => {
    expect(renderLine(ad())).toBe("Fast APIs for every chain - alchemy.com")
  })

  it("appends the domain defensively when missing from the sentence", () => {
    expect(renderLine(ad({ sentence: "Fast APIs for every chain", domain: "alchemy.com" }))).toBe(
      "alchemy.com - Fast APIs for every chain",
    )
  })

  it("returns just the sentence when the domain is empty", () => {
    expect(renderLine(ad({ sentence: "Just a sentence", domain: "" }))).toBe("Just a sentence")
  })

  it("sanitizes control bytes injected into the sentence or domain", () => {
    expect(renderLine(ad({ sentence: "evil\u001b[31m", domain: "x.com" }))).toBe("x.com - evil[31m")
  })
})

describe("adUrl", () => {
  it("adds an https scheme to a bare domain", () => {
    expect(adUrl("alchemy.com")).toBe("https://alchemy.com/")
  })

  it("keeps an explicit http(s) scheme", () => {
    expect(adUrl("http://example.com/path")).toBe("http://example.com/path")
    expect(adUrl("https://example.com")).toBe("https://example.com/")
  })

  it("rejects non-web schemes (no javascript:/file:)", () => {
    expect(adUrl("javascript:alert(1)")).toBeNull()
    expect(adUrl("file:///etc/passwd")).toBeNull()
  })

  it("returns null for an empty or control-only domain", () => {
    expect(adUrl("")).toBeNull()
    expect(adUrl("\u0000\u001b")).toBeNull()
  })
})

describe("adMarkdown", () => {
  it("links the domain first (underlined + clickable), then bolds the sentence", () => {
    expect(adMarkdown(ad())).toBe(
      "**Sponsored:** [alchemy.com](https://alchemy.com/) **Fast APIs for every chain**",
    )
  })

  it("prepends a linked domain when it is absent from the sentence", () => {
    expect(adMarkdown(ad({ sentence: "Fast APIs for builders", domain: "alchemy.com" }))).toBe(
      "**Sponsored:** [alchemy.com](https://alchemy.com/) **Fast APIs for builders**",
    )
  })

  it("shows an unsafe domain as plain text, never a link", () => {
    expect(adMarkdown(ad({ sentence: "Total pwn", domain: "javascript:alert(1)" }))).toBe(
      "**Sponsored:** javascript:alert(1) **Total pwn**",
    )
  })

  it("omits the domain when empty", () => {
    expect(adMarkdown(ad({ sentence: "Just a sentence", domain: "" }))).toBe(
      "**Sponsored:** **Just a sentence**",
    )
  })
})
