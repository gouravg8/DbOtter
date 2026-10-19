/**
 * End-to-end tests: the real UI in Chromium, talking to the real Rust backend through the
 * dev bridge, against a real Postgres (see README, "Tests").
 *
 *   DBOTTER_TEST_PORT=55432 pnpm test:e2e
 *
 * PLAYWRIGHT_CHROMIUM_PATH can point at an existing Chromium instead of a downloaded one.
 */
import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const chromium = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const dataDir = path.join(os.tmpdir(), "dbotter-e2e");

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // the bridge's saved connections are shared state
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1360, height: 820 },
    launchOptions: chromium ? { executablePath: chromium } : {},
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm bridge 1430 ${dataDir}`,
      url: "http://127.0.0.1:1430/api",
      reuseExistingServer: true,
      timeout: 600_000,
    },
    {
      command: "pnpm dev:browser --port 1420 --strictPort",
      url: "http://localhost:1420",
      reuseExistingServer: true,
    },
  ],
});
