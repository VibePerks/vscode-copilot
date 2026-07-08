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
import { type Meta, onActive, onIdle } from "./engine"
import { adMarkdown, adUrl } from "./sanitize"
import { AD_BACKGROUND_COLOR_ID, LEARN_MORE_COMMAND, SIGN_IN_COMMAND, StatusBar } from "./statusbar"
import { type AdState, type Kv, clearState, loadState, mementoKv } from "./store"
import type { Ad } from "./types"

// CLI is the canonical adapter id reported on every impression for this surface.
// The backend's impression `cli` field is free-form, so it stands apart from the
// CLI adapters (claude-code/codex/opencode/terminal) and the webview adapters
// (vscode-claude-code/vscode-codex).
const CLI = "copilot-chat"

// Where the muted/sign-in state sends the user to link a device.
const INSTALL_URL = "https://vibeperks.ai/install"

// A burst of editor activity is treated as "the agent is working" (the precise
// Copilot chat lifecycle is not exposed). After this much quiet, the burst is
// considered over and the impression is recorded.
const ACTIVITY_DEBOUNCE_MS = 1500

// Module-scoped runtime wiring, set up in activate().
let output: vscode.OutputChannel
let statusBar: StatusBar
let kv: Kv
let config: PluginConfig
let client: VibePerksClient
let meta: Meta
let currentAd: Ad | null = null
let active = false
let idleTimer: ReturnType<typeof setTimeout> | undefined

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
  else if (state.ad) statusBar.showAd(state.ad)
  else statusBar.showMuted()
}

// markActive runs the serve/rotate path once per activity burst (the engine itself
// dwell-gates serving by rotate_seconds), then arms the idle recorder.
function markActive(): Promise<void> {
  return guard("active", async () => {
    if (!configured()) {
      statusBar.showMuted()
      return
    }
    if (!active) {
      active = true
      const state = await onActive(kv, client, config, meta, Date.now())
      render(state)
    }
    scheduleIdle()
  })
}

function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void guard("idle", async () => {
      active = false
      if (configured()) await onIdle(kv, client, config, meta, Date.now())
    })
  }, ACTIVITY_DEBOUNCE_MS)
}

async function commandSignIn(): Promise<void> {
  // If a device token is already saved (shared ~/.vibeperks/config.json), don't force
  // a fresh login - reuse it. reload() picks up any token written to the shared config
  // after the extension activated, so a stale in-memory client can't keep reporting the
  // token as rejected. The user can retry with that token or replace it outright.
  reload()
  if (config.deviceToken !== "") {
    const choice = await vscode.window.showInformationMessage(
      "VibePerks: a device token is already configured on this machine.",
      "Retry with current token",
      "Replace token",
    )
    if (choice === "Retry with current token") {
      // Drop the sticky needsLogin flag and re-serve with the freshly reloaded client
      // so a previously-rejected (or externally fixed) token gets a clean attempt.
      await clearState(kv)
      currentAd = null
      active = false
      await markActive()
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
  const url = (currentAd && adUrl(currentAd.domain)) || INSTALL_URL
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
  // The chat participant (@vibeperks) is a first-class "agent working" signal and
  // shows the current sponsor line. It is optional: if the Chat API is unavailable
  // in the host, the status bar + activity heuristic still work.
  try {
    const participant = vscode.chat.createChatParticipant(
      "vibeperks.ads",
      async (_request, _ctx, stream) => {
        await guard("chat", async () => {
          await markActive()
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

    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(() => {
        void markActive()
      }),
    )

    // Initial paint from cache: muted when unconfigured/opted out, otherwise the
    // last cached ad if one survived from a previous session.
    if (configured()) {
      void guard("boot", async () => {
        const state = await loadState(kv)
        render(state)
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
  if (idleTimer) clearTimeout(idleTimer)
  return guard("deactivate", async () => {
    if (configured()) await onIdle(kv, client, config, meta, Date.now())
  })
}

function cryptoRandomId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}
