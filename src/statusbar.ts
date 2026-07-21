import { renderLine } from "./sanitize"
import type { Ad } from "./types"

// Command ids the status bar item points at. Kept here so extension.ts and the
// status bar agree on a single source of truth.
export const LEARN_MORE_COMMAND = "vibeperks.learnMore"
export const SIGN_IN_COMMAND = "vibeperks.signIn"

// Theme color id used to tint the served ad line so it stands out from the rest
// of the status bar. VS Code only honors `statusBarItem.warningBackground` and
// `statusBarItem.errorBackground` as status-bar background colors; warning (a
// muted amber) reads as "notice", not "error", which fits a sponsor line.
export const AD_BACKGROUND_COLOR_ID = "statusBarItem.warningBackground"

// The status bar line is bounded so a long served sentence can never dominate the
// bar. The sentence is already control-byte sanitized upstream (renderLine).
const MAX_TEXT = 120

// StatusBarTarget is the structural subset of vscode.StatusBarItem this module
// drives. Declaring it here (instead of importing `vscode`) keeps the render logic
// unit-testable without the extension host. The tooltip type stays wide enough to
// accept vscode's `string | MarkdownString` (this module only ever writes strings).
export interface StatusBarTarget {
  text: string
  tooltip: string | { value: string } | undefined
  command: string | { command: string } | undefined
  // Structural stand-in for vscode.StatusBarItem.backgroundColor (a ThemeColor).
  // Typed as unknown here so this module stays free of a `vscode` import and
  // testable; extension.ts passes a real ThemeColor.
  backgroundColor: unknown
  show(): void
  hide(): void
}

// clip bounds a rendered line to max characters, appending an ellipsis marker when
// it must truncate so the line never silently misleads.
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 3) return s.slice(0, max)
  return s.slice(0, max - 3) + "..."
}

// adText builds the bounded status bar text for a served ad. The megaphone
// codicon makes it read as an ad, never a fake status.
export function adText(ad: Ad): string {
  return clip(`$(megaphone) ${renderLine(ad)}`, MAX_TEXT)
}

// StatusBar wraps one status bar item and renders the three states the surface can
// be in: a served sponsor line, the muted unconfigured placeholder, or hidden.
export class StatusBar {
  private readonly item: StatusBarTarget
  private readonly highlight: unknown

  // `highlight` is the ThemeColor applied to the served ad line so it stands out
  // (created by extension.ts). Left undefined in tests, which is a no-op tint.
  constructor(item: StatusBarTarget, highlight?: unknown) {
    this.item = item
    this.highlight = highlight
  }

  // showAd renders a served sponsor line; clicking it runs the learn-more command.
  // The line is tinted so it reads as a distinct sponsor slot, not plain status.
  showAd(ad: Ad): void {
    this.item.text = adText(ad)
    this.item.tooltip = `VibePerks - ${ad.domain}. Click to learn more.`
    this.item.command = LEARN_MORE_COMMAND
    this.item.backgroundColor = this.highlight
    this.item.show()
  }

  // showMuted renders the unconfigured placeholder; clicking it runs sign-in. No
  // network call is ever made in this state.
  showMuted(): void {
    this.item.text = "$(megaphone) vibeperks"
    this.item.tooltip = "VibePerks - sign in to start earning while you code."
    this.item.command = SIGN_IN_COMMAND
    this.item.backgroundColor = undefined
    this.item.show()
  }

  // showPaused renders the earning-cap notice: the publisher hit their hourly/daily
  // limit, so serving is paused until it resets. Plain (untinted) so it reads as an
  // informational pause, not a paid ad. `tryAgainAt` (ISO-8601 UTC) drives the
  // tooltip's reset time; the client clock is used only for the local display.
  showPaused(tryAgainAt?: string): void {
    this.item.text = "$(megaphone) VibePerks: limit reached"
    const resetAt = tryAgainAt ? new Date(tryAgainAt) : undefined
    const when =
      resetAt && !Number.isNaN(resetAt.getTime())
        ? ` More ads at ${resetAt.toLocaleTimeString()}.`
        : ""
    this.item.tooltip = `VibePerks - you have reached your earning limit for now.${when}`
    this.item.command = LEARN_MORE_COMMAND
    this.item.backgroundColor = undefined
    this.item.show()
  }

  // showNeedsLogin renders the sign-in notice shown when the device token was
  // rejected. `reason` (e.g. "device token invalid or revoked", "account suspended")
  // is surfaced so the user knows why earning stopped; clicking it runs sign-in.
  showNeedsLogin(reason = ""): void {
    const why = reason ? `: ${reason}` : ""
    this.item.text = `$(megaphone) VibePerks: sign-in required${why}`
    this.item.tooltip = `Your VibePerks device token was rejected${
      reason ? ` (${reason})` : ""
    }. Run \`vibeperks login\` (or click to sign in).`
    this.item.command = SIGN_IN_COMMAND
    this.item.backgroundColor = undefined
    this.item.show()
  }

  hide(): void {
    this.item.hide()
  }
}
