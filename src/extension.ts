import * as vscode from "vscode"

import { VibePerksClient } from "./client"
import {
  type ConfigEnv,
  type PluginConfig,
  clearDeviceToken,
  loadConfig,
  saveDeviceToken,
  setOptOut,
} from "./config"
import { type Meta, onBlur, onFocus, onTick, rotationIntervalMs } from "./engine"
import { adMarkdown, clickUrl } from "./sanitize"
import { AD_BACKGROUND_COLOR_ID, LEARN_MORE_COMMAND, SIGN_IN_COMMAND, StatusBar } from "./statusbar"
import { type AdState, type Kv, clearState, loadState, mementoKv } from "./store"
import type { Ad } from "./types"

// CLI is the canonical adapter id reported on every impression for this surface.
const CLI = "copilot-chat"

// Where the muted/sign-in state sends the user to link a device.
const INSTALL_URL = "https://vibeperks.ai/install"

// Module-scoped runtime wiring, set up in activate().
let output: vscode.OutputChannel
let statusBar: StatusBar
let kv: Kv
let config: PluginConfig
let client: VibePerksClient
let meta: Meta
let currentAd: Ad | null = null
let rotationTimer: ReturnType<typeof setInterval> | undefined
let capWakeTimer: ReturnType<typeof setTimeout> | undefined

function env(): ConfigEnv {
  return process.env as ConfigEnv
}

function log(message: string): void {
  output.appendLine(`[vibeperks] ${message}`)
}

// guard is the single fail-silent boundary: every host callback runs through it so
// a client/network error can never break or slow VS Code. Errors are logged and
// swallowed here and nowhere deeper.
function guard(label: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .catch((e) => log(`${label}: ${e instanceof Error ? e.message : String(e)}`))
}

function configured(): boolean {
  return config.deviceToken !== "" && !config.optOut
}

function reload(): void {
  config = loadConfig(env())
  client = new VibePerksClient(config.apiBase, config.deviceToken)
}

function render(state: AdState): void {
  currentAd = state.ad
  if (!configured()) {
    statusBar.showMuted()
    return
  }
  if (state.needsLogin) statusBar.showNeedsLogin(state.needsLoginReason)
  else if (state.tryAgainAt && Date.parse(state.tryAgainAt) > Date.now())
    statusBar.showCapped(state.tryAgainAt, state.lang)
  else if (state.ad) statusBar.showAd(state.ad)
  else statusBar.showMuted()
}

// clearTimers stops the rotation timer and any pending cap-wake timeout.
function clearTimers(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer)
    rotationTimer = undefined
  }
  if (capWakeTimer) {
    clearTimeout(capWakeTimer)
    capWakeTimer = undefined
  }
}

// startRotationTimer arms the rotation interval. The interval is derived from the
// last served ad's hourly_cap (3600 / cap seconds). While the timer runs, each
// tick records the current ad and serves a new one.
function startRotationTimer(): void {
  clearTimers()
  // Read the cached state to determine the current rotation interval. If there is
  // no cached ad (fresh start), default to 300s (12/hour).
  void guard("start-timer", async () => {
    const s = await loadState(kv)
    const interval = rotationIntervalMs(s)
    rotationTimer = setInterval(() => {
      void guard("tick", async () => {
        if (!configured()) return
        const state = await onTick(kv, client, config, meta, Date.now())
        render(state)
        // If the tick resulted in an earning cap, clear the rotation timer and
        // schedule a wake-up at try_again_at.
        if (state.tryAgainAt) {
          clearTimers()
          scheduleCapWake(state.tryAgainAt)
        }
      })
    }, interval)
  })
}

// scheduleCapWake sets a one-shot timeout to resume serving when the earning cap
// resets at `tryAgainAt` (ISO-8601 UTC).
function scheduleCapWake(tryAgainAt: string): void {
  const resetMs = Date.parse(tryAgainAt)
  if (Number.isNaN(resetMs)) return
  const delay = Math.max(0, resetMs - Date.now())
  capWakeTimer = setTimeout(() => {
    void guard("cap-wake", async () => {
      if (!configured()) return
      const state = await onFocus(kv, client, config, meta, Date.now())
      render(state)
      if (!state.tryAgainAt) startRotationTimer()
    })
  }, delay)
}

// onWindowFocused runs the serve/rotate path when the window gains focus. If no ad
// is cached or the rotation interval has elapsed (e.g. user was away), a new ad is
// served immediately and the rotation timer starts. If still within the interval,
// the timer keeps running from where it left off.
function onWindowFocused(): void {
  void guard("focus", async () => {
    if (!configured()) {
      statusBar.showMuted()
      return
    }
    const state = await onFocus(kv, client, config, meta, Date.now())
    render(state)
    if (!state.tryAgainAt) startRotationTimer()
  })
}

// onWindowBlurred stops rotation while the user is away and records the current
// ad's impression.
function onWindowBlurred(): void {
  clearTimers()
  void guard("blur", async () => {
    if (configured()) await onBlur(kv, client, config, meta, Date.now())
  })
}

async function commandSignIn(): Promise<void> {
  reload()
  if (config.deviceToken !== "") {
    const choice = await vscode.window.showInformationMessage(
      "VibePerks: a device token is already configured on this machine.",
      "Retry with current token",
      "Replace token",
    )
    if (choice === "Retry with current token") {
      await clearState(kv)
      currentAd = null
      onWindowFocused()
      return
    }
    if (choice !== "Replace token") return
  }
  await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL))
  const token = await vscode.window.showInputBox({
    title: "VibePerks sign in",
    prompt: "Paste your device token from the VibePerks dashboard",
    password: true,
    ignoreFocusOut: true,
  })
  if (!token) return
  saveDeviceToken(env(), token.trim())
  reload()
  render({ ad: currentAd, servedAt: 0, recorded: true })
  void vscode.window.showInformationMessage(
    "VibePerks: signed in. Reload the window (or restart VS Code) for the change to take full effect.",
  )
}

async function commandSignOut(): Promise<void> {
  clearDeviceToken(env())
  reload()
  await clearState(kv)
  currentAd = null
  statusBar.showMuted()
  void vscode.window.showInformationMessage("VibePerks: signed out.")
}

async function commandOptOut(): Promise<void> {
  setOptOut(env(), true)
  reload()
  await clearState(kv)
  currentAd = null
  statusBar.hide()
  void vscode.window.showInformationMessage("VibePerks: sponsor unit off.")
}

function commandOptIn(): void {
  setOptOut(env(), false)
  reload()
  render({ ad: currentAd, servedAt: 0, recorded: true })
  void vscode.window.showInformationMessage("VibePerks: sponsor unit on.")
}

async function commandLearnMore(): Promise<void> {
  const url = (currentAd && clickUrl(currentAd)) || INSTALL_URL
  await vscode.env.openExternal(vscode.Uri.parse(url))
}

async function commandMenu(): Promise<void> {
  const items: vscode.QuickPickItem[] = configured()
    ? [
        { label: "Learn more about the current sponsor" },
        { label: "Opt out of the sponsor unit" },
        { label: "Sign out" },
      ]
    : [{ label: "Sign in" }, { label: "Opt in to the sponsor unit" }]
  const pick = await vscode.window.showQuickPick(items, { title: "VibePerks" })
  switch (pick?.label) {
    case "Learn more about the current sponsor":
      return commandLearnMore()
    case "Opt out of the sponsor unit":
      return commandOptOut()
    case "Sign out":
      return commandSignOut()
    case "Sign in":
      return commandSignIn()
    case "Opt in to the sponsor unit":
      return commandOptIn()
    default:
      return
  }
}

function registerChatParticipant(context: vscode.ExtensionContext): void {
  // The chat participant (@vibeperks) shows the current sponsor line. It is
  // optional: if the Chat API is unavailable in the host, the status bar still
  // works. The participant triggers an immediate serve if the rotation interval
  // has elapsed (same as a focus event) so explicit @vibeperks mentions are
  // guaranteed to show a fresh ad when due.
  try {
    const participant = vscode.chat.createChatParticipant(
      "vibeperks.ads",
      async (_request, _ctx, stream) => {
        await guard("chat", async () => {
          onWindowFocused()
          if (currentAd) stream.markdown(adMarkdown(currentAd))
          else stream.markdown("VibePerks has no sponsor to show right now.")
        })
      },
    )
    context.subscriptions.push(participant)
  } catch (e) {
    log(`chat participant unavailable: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    output = vscode.window.createOutputChannel("VibePerks")
    context.subscriptions.push(output)

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    context.subscriptions.push(item)
    statusBar = new StatusBar(item, new vscode.ThemeColor(AD_BACKGROUND_COLOR_ID))

    kv = mementoKv(context.globalState)
    config = loadConfig(env())
    client = new VibePerksClient(config.apiBase, config.deviceToken)
    meta = {
      cli: CLI,
      cliVersion: vscode.version,
      pluginVersion: String(context.extension.packageJSON.version ?? ""),
      sessionId: cryptoRandomId(),
    }

    const register = (id: string, fn: () => Promise<void> | void): void => {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, () => guard(`command:${id}`, fn)),
      )
    }
    register(SIGN_IN_COMMAND, commandSignIn)
    register("vibeperks.signOut", commandSignOut)
    register("vibeperks.optOut", commandOptOut)
    register("vibeperks.optIn", commandOptIn)
    register(LEARN_MORE_COMMAND, commandLearnMore)
    register("vibeperks.menu", commandMenu)

    registerChatParticipant(context)

    // Window focus drives the rotation timer: ads only rotate while the user is
    // actively looking at the editor (focused). When the window loses focus the
    // timer is cleared and the current ad's impression is recorded.
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) onWindowFocused()
        else onWindowBlurred()
      }),
    )

    // Initial paint from cache: muted when unconfigured/opted out, otherwise the
    // last cached ad if one survived from a previous session. If the window is
    // already focused at startup, begin rotation immediately.
    if (configured()) {
      void guard("boot", async () => {
        const state = await loadState(kv)
        render(state)
        if (vscode.window.state.focused) onWindowFocused()
      })
    } else {
      statusBar.showMuted()
    }
  } catch (e) {
    // Never let activation throw into the host.
    try {
      log(`activate: ${e instanceof Error ? e.message : String(e)}`)
    } catch {
      // output channel itself failed - nothing more we can safely do.
    }
  }
}

export function deactivate(): Promise<void> {
  clearTimers()
  return guard("deactivate", async () => {
    if (configured()) await onBlur(kv, client, config, meta, Date.now())
  })
}

function cryptoRandomId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}
