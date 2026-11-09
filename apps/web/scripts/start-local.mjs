#!/usr/bin/env node
/**
 * Run the production build on this computer only.
 *
 *   pnpm build && pnpm start:local
 *
 * - Serves on 127.0.0.1 (loopback), so other devices on the network cannot
 *   reach it. Set PORT to use a port other than 3000.
 * - Loads the repository-root .env, as `pnpm dev` does. Existing shell
 *   exports take precedence.
 * - Runs Next.js's standalone server, the same way the Docker image does
 *   (`next start` does not support the standalone output this app builds).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const envFile = join(repoRoot, ".env");
const standalone = join(webRoot, ".next/standalone");
const server = join(standalone, "apps/web/server.js");

if (!existsSync(envFile)) {
  console.error(`Missing ${envFile}. Create it with: cp .env.example .env (see README "Quick Start").`);
  process.exit(1);
}
if (!existsSync(server)) {
  console.error("No production build found. Run `pnpm build` first.");
  process.exit(1);
}

// The standalone output omits static assets and public files; copy them in
// exactly as apps/web/Dockerfile does. Safe to repeat on every start.
cpSync(join(webRoot, ".next/static"), join(standalone, "apps/web/.next/static"), { recursive: true });
if (existsSync(join(webRoot, "public"))) {
  cpSync(join(webRoot, "public"), join(standalone, "apps/web/public"), { recursive: true });
}

const port = process.env.PORT || "3000";
console.log(`OpenVPM (production build) on http://localhost:${port} (this computer only). Stop with Ctrl+C.`);
const child = spawn(process.execPath, [`--env-file=${envFile}`, server], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: port },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
