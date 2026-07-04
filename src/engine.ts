import { VibePerksClient } from "./client"
import type { PluginConfig } from "./config"
import { RejectedError } from "./errors"
import {
  type AdState,
  type Kv,
  clearState,
  enqueue,
  loadQueue,
  loadState,
  saveQueue,
  saveState,
} from "./store"
import type { Ad, Impression } from "./types"

// Meta is the per-session adapter metadata attached to every impression.
export interface Meta {
  cli: string
  cliVersion: string
  pluginVersion: string
  sessionId: string
}

const DEFAULT_ROTATE_SECONDS = 20
const FLUSH_RETRY_DELAY_MS = 200

const EMPTY_STATE: AdState = { ad: null, servedAt: 0, recorded: false }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function rotateMs(ad: Ad | null): number {
  const seconds = ad && ad.rotate_seconds > 0 ? ad.rotate_seconds : DEFAULT_ROTATE_SECONDS
  return seconds * 1000
}

// recordCurrent enqueues an impression for the currently displayed ad exactly
// once. It is a no-op when there is no ad or it was already recorded. The house
// ad (served when there is no paid inventory) has no impression token and is
// display-only, so it is never reported. All times are epoch-ms integers.
async function recordCurrent(kv: Kv, s: AdState, meta: Meta, now: number): Promise<AdState> {
  if (!s.ad || !s.ad.impression_token || s.recorded) return s
  const displayedMs = Math.max(0, now - s.servedAt)
  const imp: Impression = {
    impression_token: s.ad.impression_token,
    displayed_ms: displayedMs,
    session_id: meta.sessionId || undefined,
    session_duration_ms: displayedMs || undefined,
    plugin_version: meta.pluginVersion || undefined,
    cli: meta.cli || undefined,
    cli_version: meta.cliVersion || undefined,
  }
  await enqueue(kv, imp)
  return { ...s, recorded: true }
}

// postWithRetry attempts a single impression post with at most one bounded retry,
// and only for transient failures. Permanent outcomes (success, RejectedError,
// UnauthorizedError) return/throw immediately without retrying.
async function postWithRetry(client: VibePerksClient, imp: Impression): Promise<void> {
  try {
    await client.postImpression(imp)
  } catch (e) {
    if (e instanceof RejectedError) throw e
    if (e instanceof Error && e.name === "UnauthorizedError") throw e
    await delay(FLUSH_RETRY_DELAY_MS)
    await client.postImpression(imp)
  }
}

// flush posts every buffered impression. Delivered and permanently rejected
// impressions are dropped; transient failures are kept for the next flush. The
// first transient error (if any) propagates after the buffer is rewritten so the
// boundary can log it.
export async function flush(kv: Kv, client: VibePerksClient): Promise<void> {
  const queue = await loadQueue(kv)
  if (queue.length === 0) return
  const remaining: Impression[] = []
  let firstErr: unknown = null
  for (const imp of queue) {
    try {
      await postWithRetry(client, imp)
    } catch (e) {
      if (e instanceof RejectedError) continue
      remaining.push(imp)
      if (firstErr === null) firstErr = e
    }
  }
  await saveQueue(kv, remaining)
  if (firstErr) throw firstErr
}

// onActive is the agent-working / rotation worker. It records the current ad's
// impression and serves the next ad when there is no ad or rotate_seconds has
// elapsed, then flushes the buffer. The resulting AdState is returned so the caller
// renders the status bar from it. Opt-out clears the cached ad, does no network I/O,
// and returns the empty state.
export async function onActive(
  kv: Kv,
  client: VibePerksClient,
  cfg: PluginConfig,
  meta: Meta,
  now: number,
): Promise<AdState> {
  if (cfg.optOut) {
    await clearState(kv)
    return { ...EMPTY_STATE }
  }
  let s = await loadState(kv)
  const due = !s.ad || now - s.servedAt >= rotateMs(s.ad)
  if (!due) {
    await flush(kv, client)
    return s
  }
  s = await recordCurrent(kv, s, meta, now)
  let ad: Ad | null
  try {
    ad = await client.serve()
  } catch (e) {
    // A rejected device token is terminal: clear the cached ad and flag the slot so
    // the status bar shows a sign-in notice. This is a handled outcome, not an error
    // to surface, so the caller renders the returned state.
    if (e instanceof Error && e.name === "UnauthorizedError") {
      const reason = (e as { reason?: string }).reason ?? ""
      const needsLogin: AdState = {
        ad: null,
        servedAt: 0,
        recorded: false,
        needsLogin: true,
        needsLoginReason: reason,
      }
      await saveState(kv, needsLogin)
      await flush(kv, client)
      return needsLogin
    }
    // Keep the buffered impression and the recorded flag; surface the serve error
    // (the extension entry boundary swallows it so VS Code is unaffected).
    await saveState(kv, s)
    await flush(kv, client)
    throw e
  }
  const next: AdState = ad
    ? { ad, servedAt: now, recorded: false }
    : { ad: null, servedAt: 0, recorded: false }
  await saveState(kv, next)
  await flush(kv, client)
  return next
}

// onIdle is the agent-stopped worker: it records the current ad's impression (if
// not yet recorded) and flushes the buffer. Opt-out is a no-op.
export async function onIdle(
  kv: Kv,
  client: VibePerksClient,
  cfg: PluginConfig,
  meta: Meta,
  now: number,
): Promise<void> {
  if (cfg.optOut) return
  let s = await loadState(kv)
  s = await recordCurrent(kv, s, meta, now)
  await saveState(kv, s)
  await flush(kv, client)
}
