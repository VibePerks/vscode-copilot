import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// defaultAPIBase targets the prod backend; override with $VIBEPERKS_API.
export const DEFAULT_API_BASE = "https://api.vibeperks.ai"

// PluginConfig is the resolved local configuration the plugin runs on.
export interface PluginConfig {
  apiBase: string
  deviceToken: string
  optOut: boolean
}

// ConfigEnv is the subset of process.env the config layer reads. It is passed in
// explicitly so the loader stays pure and testable.
export interface ConfigEnv {
  VIBEPERKS_HOME?: string
  VIBEPERKS_API?: string
  VIBEPERKS_DEVICE_TOKEN?: string
}

// FileConfig is the on-disk shape shared with the other adapters' config.json, so a
// single `login` (from any VibePerks CLI) configures every adapter on the machine,
// VS Code included.
interface FileConfig {
  api_base?: string
  device_token?: string
  opt_out?: boolean
}

function configDir(env: ConfigEnv): string {
  if (env.VIBEPERKS_HOME) return env.VIBEPERKS_HOME
  return join(homedir(), ".vibeperks")
}

// readFileConfig reads ~/.vibeperks/config.json. A missing file is the normal "not
// yet configured" state and yields an empty config; any other read error or
// malformed JSON propagates (the extension entry boundary swallows it).
function readFileConfig(env: ConfigEnv): FileConfig {
  let raw: string
  try {
    raw = readFileSync(join(configDir(env), "config.json"), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw e
  }
  return JSON.parse(raw) as FileConfig
}

// loadConfig resolves the effective config from env overrides + the shared config
// file. Env wins over the file; the file wins over the built-in default base.
export function loadConfig(env: ConfigEnv): PluginConfig {
  const file = readFileConfig(env)
  const apiBase = (env.VIBEPERKS_API || file.api_base || DEFAULT_API_BASE).replace(/\/+$/, "")
  const deviceToken = env.VIBEPERKS_DEVICE_TOKEN || file.device_token || ""
  return { apiBase, deviceToken, optOut: file.opt_out === true }
}

// writeConfigPatch merges a partial config into the shared ~/.vibeperks/config.json,
// preserving fields other adapters wrote. The file is created 0600 if absent. This
// is how the VS Code commands (sign in/out, opt in/out) update the shared config so
// the change applies to every adapter on the machine.
export function writeConfigPatch(env: ConfigEnv, patch: FileConfig): void {
  const dir = configDir(env)
  const merged: FileConfig = { ...readFileConfig(env), ...patch }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
}

// saveDeviceToken records a device token in the shared config (sign in).
export function saveDeviceToken(env: ConfigEnv, token: string): void {
  writeConfigPatch(env, { device_token: token })
}

// clearDeviceToken removes the device token from the shared config (sign out).
export function clearDeviceToken(env: ConfigEnv): void {
  writeConfigPatch(env, { device_token: "" })
}

// setOptOut toggles the shared opt_out flag (opt out / opt in).
export function setOptOut(env: ConfigEnv, value: boolean): void {
  writeConfigPatch(env, { opt_out: value })
}
