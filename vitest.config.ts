import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // extension.ts is the vscode-only fail-silent boundary (imports the `vscode`
      // module, which is unavailable under vitest) - it is exercised by the live
      // VS Code host, not unit tests, exactly like the opencode adapter's tui.tsx.
      exclude: ["src/extension.ts"],
      reporter: ["text-summary"],
    },
  },
})
