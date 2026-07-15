import { describe, expect, it } from "vitest"
import { VibePerksClient, type FetchFn } from "../src/client"
import type { PluginConfig } from "../src/config"
import { onActive, onIdle, type Meta } from "../src/engine"
import { loadQueue, loadState, type Kv } from "../src/store"
import type { Ad, Impression } from "../src/types"

const META: Meta = {
  cli: "copilot-chat",
  cliVersion: "1.90.0",
  pluginVersion: "0.1.0",
  sessionId: "s1",
}
const CFG: PluginConfig = { apiBase: "https://x", deviceToken: "tok", optOut: false }

function ad(over: Partial<Ad> = {}): Ad {
  return {
    ad_id: "a1",
    sentence: "Get paid while vibe coding - VibePerks.ai",
    domain: "VibePerks.ai",
    impression_token: "imp1",
    rotate_seconds: 20,
    ...over,
  }
}

function fakeKv(): Kv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    async get(k) {
      return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : undefined
    },
    async set(k, v) {
      store.set(k, JSON.parse(JSON.stringify(v)))
    },
  }
}

// harness wires a real VibePerksClient over a programmable fetch so the engine is
// tested against the actual client behaviour (status mapping, retry).
function harness() {
  const serveQueue: (Ad | null | "error" | "unauthorized")[] = []
  const impressionStatuses: number[] = []
  const delivered: Impression[] = []
  let serveCalls = 0
  let impressionAttempts = 0
  const fetch: FetchFn = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/v1/ads/serve")) {
      serveCalls++
      const next = serveQueue.shift()
      if (next === "error") throw new Error("network down")
      if (next === "unauthorized") return new Response(null, { status: 401 })
      if (next == null) return new Response(null, { status: 204 })
      return new Response(JSON.stringify(next), { status: 200 })
    }
    impressionAttempts++
    const body = JSON.parse(String(init?.body)) as Impression
    const status = impressionStatuses.shift() ?? 201
    if (status === 200 || status === 201) delivered.push(body)
    return new Response(JSON.stringify({}), { status })
  }
  const client = new VibePerksClient("https://x", "tok", fetch)
  return {
    client,
    serveQueue,
    impressionStatuses,
    delivered,
    get serveCalls() {
      return serveCalls
    },
    get impressionAttempts() {
      return impressionAttempts
    },
  }
}

async function seedState(kv: Kv, a: Ad | null, servedAt: number, recorded: boolean) {
  await kv.set("vibeperks:state", { ad: a, servedAt, recorded })
}

describe("engine happy path", () => {
  it("serves + caches an ad on active, returns it, then records on idle", async () => {
    const kv = fakeKv()
    const h = harness()
    h.serveQueue.push(ad())

    const state = await onActive(kv, h.client, CFG, META, 1000)
    expect(state.ad?.ad_id).toBe("a1")
    expect((await loadState(kv)).ad?.ad_id).toBe("a1")
    expect(h.serveCalls).toBe(1)
    expect(h.delivered).toHaveLength(0)

    await onIdle(kv, h.client, CFG, META, 5000)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({
      impression_token: "imp1",
      displayed_ms: 4000,
      session_id: "s1",
      cli: "copilot-chat",
      cli_version: "1.90.0",
    })
    expect(await loadQueue(kv)).toHaveLength(0)
    expect((await loadState(kv)).recorded).toBe(true)
  })

  it("returns the empty state when inventory is empty (204)", async () => {
    const kv = fakeKv()
    const h = harness()
    h.serveQueue.push(null)
    const state = await onActive(kv, h.client, CFG, META, 1000)
    expect(state.ad).toBeNull()
  })
})

describe("engine opt-out", () => {
  it("clears the cached ad on active and does no network I/O", async () => {
    const kv = fakeKv()
    const h = harness()
    await seedState(kv, ad(), 1000, false)

    const state = await onActive(kv, h.client, { ...CFG, optOut: true }, META, 2000)
    expect(state.ad).toBeNull()
    expect((await loadState(kv)).ad).toBeNull()
    expect(h.serveCalls).toBe(0)

    await onIdle(kv, h.client, { ...CFG, optOut: true }, META, 3000)
    expect(h.delivered).toHaveLength(0)
  })
})

describe("engine rotation / dwell", () => {
  it("does not re-serve within the rotate window", async () => {
    const kv = fakeKv()
    const h = harness()
    h.serveQueue.push(ad({ ad_id: "a1" }), ad({ ad_id: "a2", impression_token: "imp2" }))

    await onActive(kv, h.client, CFG, META, 1000)
    const state = await onActive(kv, h.client, CFG, META, 6000) // 5s < 20s window
    expect(h.serveCalls).toBe(1)
    expect(state.ad?.ad_id).toBe("a1")
  })

  it("re-serves after the window and records the prior ad's impression", async () => {
    const kv = fakeKv()
    const h = harness()
    h.serveQueue.push(ad({ ad_id: "a1" }), ad({ ad_id: "a2", impression_token: "imp2" }))

    await onActive(kv, h.client, CFG, META, 1000)
    const state = await onActive(kv, h.client, CFG, META, 22000) // 21s >= 20s window
    expect(h.serveCalls).toBe(2)
    expect(state.ad?.ad_id).toBe("a2")
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ impression_token: "imp1", displayed_ms: 21000 })
  })
})

describe("engine dedupe", () => {
  it("records one ad's impression only once across repeated idle hooks", async () => {
    const kv = fakeKv()
    const h = harness()
    h.serveQueue.push(ad())

    await onActive(kv, h.client, CFG, META, 1000)
    await onIdle(kv, h.client, CFG, META, 3000)
    await onIdle(kv, h.client, CFG, META, 4000)
    expect(h.delivered).toHaveLength(1)
  })
})

describe("engine serve failure", () => {
  it("propagates the serve error but still flushes the prior impression and keeps state safe", async () => {
    const kv = fakeKv()
    const h = harness()
    await seedState(kv, ad(), 1000, false) // a previously served, unrecorded ad
    h.serveQueue.push("error")

    await expect(onActive(kv, h.client, CFG, META, 22000)).rejects.toThrow(/network down/)
    expect(h.delivered).toHaveLength(1) // prior impression flushed despite serve failure
    expect(h.delivered[0].impression_token).toBe("imp1")
    const s = await loadState(kv)
    expect(s.ad?.ad_id).toBe("a1") // prior ad preserved
    expect(s.recorded).toBe(true)
  })
})

describe("engine unauthorized token", () => {
  it("flags needsLogin, clears the ad, and returns the state without throwing", async () => {
    const kv = fakeKv()
    const h = harness()
    await seedState(kv, ad(), 1000, false) // a previously served, unrecorded ad
    h.serveQueue.push("unauthorized")

    const state = await onActive(kv, h.client, CFG, META, 22000)
    expect(state.needsLogin).toBe(true)
    expect(state.needsLoginReason).toBe("device token invalid or revoked")
    expect(state.ad).toBeNull()
    const s = await loadState(kv)
    expect(s.needsLogin).toBe(true)
    expect(s.needsLoginReason).toBe("device token invalid or revoked")
    expect(s.ad).toBeNull()
    // the prior impression is still flushed
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].impression_token).toBe("imp1")
  })

  it("clears needsLogin once a serve succeeds again", async () => {
    const kv = fakeKv()
    const h = harness()
    await kv.set("vibeperks:state", { ad: null, servedAt: 0, recorded: false, needsLogin: true })
    h.serveQueue.push(ad({ ad_id: "a2", impression_token: "imp2" }))

    const state = await onActive(kv, h.client, CFG, META, 1000)
    expect(state.needsLogin).toBeFalsy()
    expect(state.ad?.ad_id).toBe("a2")
  })
})

describe("engine impression delivery", () => {
  it("delivers after exactly one bounded retry on a transient failure", async () => {
    const kv = fakeKv()
    const h = harness()
    await seedState(kv, ad(), 1000, false)
    h.impressionStatuses.push(503, 200)

    await onIdle(kv, h.client, CFG, META, 3000)
    expect(h.impressionAttempts).toBe(2)
    expect(h.delivered).toHaveLength(1)
    expect(await loadQueue(kv)).toHaveLength(0)
  })

  it("keeps the impression queued and propagates when both attempts fail", async () => {
    const kv = fakeKv()
    const h = harness()
    await seedState(kv, ad(), 1000, false)
    h.impressionStatuses.push(503, 503)

    await expect(onIdle(kv, h.client, CFG, META, 3000)).rejects.toThrow()
    expect(h.delivered).toHaveLength(0)
    expect(await loadQueue(kv)).toHaveLength(1)
  })

  it("drops a permanently rejected impression without retrying or throwing", async () => {
    const kv = fakeKv()
    const h = harness()
    await seedState(kv, ad(), 1000, false)
    h.impressionStatuses.push(422)

    await expect(onIdle(kv, h.client, CFG, META, 3000)).resolves.toBeUndefined()
    expect(h.impressionAttempts).toBe(1)
    expect(h.delivered).toHaveLength(0)
    expect(await loadQueue(kv)).toHaveLength(0)
  })
})

describe("engine privacy", () => {
  it("only ever sends backend-contract fields in an impression", async () => {
    const kv = fakeKv()
    const h = harness()
    h.serveQueue.push(ad())

    await onActive(kv, h.client, CFG, META, 1000)
    await onIdle(kv, h.client, CFG, META, 2000)

    const allowed = new Set([
      "impression_token",
      "displayed_ms",
      "session_id",
      "session_duration_ms",
      "plugin_version",
      "cli",
      "cli_version",
    ])
    for (const key of Object.keys(h.delivered[0])) expect(allowed.has(key)).toBe(true)
  })
})
