// Values flow directly from the ignored local file to Wrangler stdin, never stdout.
import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
loadEnvFile(".env");
const names = [
  "AHAB_JWT_SECRET",
  "OPENROUTER_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];
const secrets = Object.fromEntries(
  names
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
if (!secrets.AHAB_JWT_SECRET)
  throw new Error("Generate a signing secret first.");
const child = spawn(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "secret", "bulk"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_LOG_PATH: "/dev/null" },
  },
);
child.stdin.end(JSON.stringify(secrets));
// Suppress all provider output; only names and exit status are safe to report.
child.stdout.resume();
child.stderr.resume();
child.on("error", () => {
  console.error("Could not start secret publishing.");
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (code === 0)
    console.log(`Published secret names: ${Object.keys(secrets).join(", ")}`);
  else console.error("Secret publishing failed; check Cloudflare login.");
  process.exitCode = code || 0;
});
