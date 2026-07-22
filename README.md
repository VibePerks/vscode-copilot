# VibePerks for GitHub Copilot Chat (VS Code)

A VS Code extension that shows one quiet **VibePerks** sponsor line in the editor
**status bar** while you work with GitHub Copilot Chat, earning you credit. It uses
the same backend contract and the same shared device login as every other VibePerks
adapter, so one `login` configures them all.

> This is a peer of the other adapters (`plugin/claude-code`, `plugin/codex`,
> `plugin/opencode`, `plugin/terminal`, and the Claude/Codex webview adapter in
> `plugin/vscode`). It is the **Copilot Chat** surface and is the only one that
> renders in the VS Code status bar.

## Install

Sideload the packaged extension:

```sh
curl -L https://vibeperks.ai/vsix-copilot -o vibeperks-copilot-chat.vsix && code --install-extension vibeperks-copilot-chat.vsix
```

(`/vsix-copilot` redirects to the current package; a Marketplace / Open VSX
listing may also be available.) Then run **VibePerks: Sign in** from the command
palette, or set the shared device token (`export VIBEPERKS_DEVICE_TOKEN=<token>`).

## Uninstall

1. (Optional) Run **VibePerks: Sign out** from the Command Palette to clear your
   device token from the shared config.
2. Remove the extension: `code --uninstall-extension vibeperks.vibeperks-copilot-chat`
   (or use the Extensions view).

To pause without uninstalling, run **VibePerks: Opt out** - it then fetches nothing,
reports nothing, and shows nothing. Your token/cache live in `~/.vibeperks/`; delete
that folder to remove them too.

## What it does

- Renders `<sentence ending in a domain>` in the status bar from a local
  cache (instant, offline-safe). Hover shows the sponsor; click opens it.
- Serves an ad from `GET /v1/ads/serve` (device token in `X-Device-Token`) when the
  editor becomes active, dwell-gated by `rotate_seconds`, and reports the impression
  to `POST /v1/impressions` when activity stops.
- Registers a `@vibeperks` chat participant that shows the current sponsor line (a
  first-class "agent working" signal). The status bar still works if the Chat API is
  unavailable.
- Reads the shared `~/.vibeperks/config.json` and honors `$VIBEPERKS_HOME` /
  `$VIBEPERKS_API` / `$VIBEPERKS_DEVICE_TOKEN`.

## When ads refresh

The sponsor line refreshes on its own gentle schedule, and never when you're idle:

- **As you work** - a short burst of typing signals "the agent is working" and pulls
  the next sponsor (no more than once per rotation window).
- **When you `@vibeperks` in Copilot Chat** - that mention refreshes and shows the
  current sponsor line.
- **On a rotation timer** - while you're active, the line rotates every ~20 seconds
  (the server sets the interval) and the previous view is recorded.

When nothing is happening, nothing is fetched - the status bar just keeps showing the
last cached line, offline-safe.

## Privacy: what leaves / never leaves your machine

| Leaves the machine (backend contract only) | Never leaves the machine |
| --- | --- |
| Device token (`X-Device-Token`) | Your code, prompts, files, or paths |
| `impression_token`, `displayed_ms`, `session_id`, `session_duration_ms` | Editor content or document text |
| `cli` (`copilot-chat`), `cli_version` (VS Code version), `plugin_version` | Anything about what you typed |

The served ad copy is treated as untrusted: every control byte is stripped before it
touches the status bar, and the learn-more link only ever opens an `http(s)` URL.

## Commands

- **VibePerks: Sign in** - opens the install page and accepts a pasted device token.
- **VibePerks: Sign out** - clears the device token from the shared config.
- **VibePerks: Opt out / Opt in** - toggles `opt_out`; opted out fetches, reports, and
  shows nothing.
- **VibePerks: Learn more about the current sponsor** - opens the sponsor domain.
- **VibePerks: Open menu** - a quick pick of the above.

## Safety model

A **single fail-silent boundary** wraps every host callback (commands, the activity
listener, the rotation timer, the chat participant, activate/deactivate). A client or
network error is logged to the "VibePerks" output channel and swallowed there - VS
Code is never broken or slowed. No swallowing happens any deeper. Every network call
has a hard timeout; the one bounded retry lives only in the impression flush.

## Under the hood: the "thinking" signal (for developers / auditors)

VS Code exposes **no public event** for GitHub Copilot's own chat request lifecycle.
The impression model here is therefore **activity / dwell-based**, not a precise
per-Copilot-request hook:

1. The `@vibeperks` chat participant is a guaranteed active signal (but only fires on
   explicit `@vibeperks` mentions).
2. A debounced burst of editor activity (`onDidChangeTextDocument`) approximates "the
   agent is working" for the common case.
3. While active, the displayed ad rotates every `rotate_seconds`, recording the prior
   impression on each rotation.

This is the one place the VS Code surface is weaker than the CLI adapters' per-turn
model, and it changes what an "impression" means for billing. It is documented here
rather than hidden.

## Development

```sh
npm install
npm run format:check   # prettier
npm run typecheck      # tsc --noEmit
npm test               # vitest (unit + mocked contract + privacy)
npm run build          # esbuild bundle -> dist/extension.js
npm run package        # vsce package -> vibeperks-copilot-chat.vsix
```

`src/extension.ts` is the vscode-only fail-silent boundary; it is exercised by the
live VS Code host, not unit tests (excluded from coverage), exactly like the opencode
adapter's `tui.tsx`.

## License

PolyForm Shield 1.0.0 - see [LICENSE](LICENSE).
