import { describe, expect, it } from "vitest"
import {
  AD_BACKGROUND_COLOR_ID,
  LEARN_MORE_COMMAND,
  SIGN_IN_COMMAND,
  StatusBar,
  adText,
  clip,
  type StatusBarTarget,
} from "../src/statusbar"
import type { Ad } from "../src/types"

function ad(over: Partial<Ad> = {}): Ad {
  return {
    ad_id: "a1",
    sentence: "Get paid while vibe coding - VibePerks.ai",
    domain: "VibePerks.ai",
    impression_token: "t1",
    rotate_seconds: 20,
    ...over,
  }
}

function fakeItem(): StatusBarTarget & { shown: boolean } {
  return {
    text: "",
    tooltip: undefined,
    command: undefined,
    backgroundColor: undefined,
    shown: false,
    show() {
      this.shown = true
    },
    hide() {
      this.shown = false
    },
  }
}

describe("clip", () => {
  it("leaves short strings unchanged", () => {
    expect(clip("hello", 10)).toBe("hello")
  })

  it("truncates with an ellipsis marker", () => {
    expect(clip("abcdefghij", 8)).toBe("abcde...")
  })

  it("returns a raw slice when max is too small for an ellipsis", () => {
    expect(clip("abcdef", 2)).toBe("ab")
  })
})

describe("adText", () => {
  it("prefixes a megaphone line", () => {
    expect(adText(ad())).toBe("$(megaphone) Get paid while vibe coding - VibePerks.ai")
  })

  it("bounds an overlong sentence", () => {
    const long = "x".repeat(300)
    const text = adText(ad({ sentence: long, domain: "d.com" }))
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text.endsWith("...")).toBe(true)
  })
})

describe("StatusBar", () => {
  it("renders a served ad and points click at learn-more", () => {
    const item = fakeItem()
    new StatusBar(item).showAd(ad())
    expect(item.text).toContain("$(megaphone)")
    expect(item.command).toBe(LEARN_MORE_COMMAND)
    expect(item.tooltip).toContain("VibePerks.ai")
    expect(item.shown).toBe(true)
  })

  it("tints the served ad line with the highlight color so it stands out", () => {
    const item = fakeItem()
    const highlight = { id: AD_BACKGROUND_COLOR_ID }
    new StatusBar(item, highlight).showAd(ad())
    expect(item.backgroundColor).toBe(highlight)
  })

  it("clears the tint when falling back to the muted placeholder", () => {
    const item = fakeItem()
    const highlight = { id: AD_BACKGROUND_COLOR_ID }
    const bar = new StatusBar(item, highlight)
    bar.showAd(ad())
    bar.showMuted()
    expect(item.backgroundColor).toBeUndefined()
  })

  it("renders the muted placeholder and points click at sign-in", () => {
    const item = fakeItem()
    new StatusBar(item).showMuted()
    expect(item.text).toBe("$(megaphone) vibeperks")
    expect(item.command).toBe(SIGN_IN_COMMAND)
    expect(item.shown).toBe(true)
  })

  it("renders the needs-login notice and points click at sign-in", () => {
    const item = fakeItem()
    new StatusBar(item).showNeedsLogin()
    expect(item.text).toContain("sign-in required")
    expect(item.tooltip).toContain("vibeperks login")
    expect(item.command).toBe(SIGN_IN_COMMAND)
    expect(item.shown).toBe(true)
  })

  it("surfaces the rejection reason in the needs-login notice", () => {
    const item = fakeItem()
    new StatusBar(item).showNeedsLogin("account suspended")
    expect(item.text).toContain("account suspended")
    expect(item.tooltip).toContain("account suspended")
    expect(item.command).toBe(SIGN_IN_COMMAND)
  })

  it("clears the tint when showing the needs-login notice", () => {
    const item = fakeItem()
    const highlight = { id: AD_BACKGROUND_COLOR_ID }
    const bar = new StatusBar(item, highlight)
    bar.showAd(ad())
    bar.showNeedsLogin("account suspended")
    expect(item.backgroundColor).toBeUndefined()
  })

  it("hides the item", () => {
    const item = fakeItem()
    const bar = new StatusBar(item)
    bar.showMuted()
    bar.hide()
    expect(item.shown).toBe(false)
  })
})
