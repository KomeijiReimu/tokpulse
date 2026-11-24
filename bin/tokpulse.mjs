#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const packageName = "@komeijireimu/tokpulse";
const usage = `Usage: tokpulse [install|update]

  install (default)  Add Token Pulse to the global OpenCode config with @latest.
  update             Ask OpenCode to update the configured target without changing its pin.
  -h, --help         Show this help.`;

function fail(message, status = 1) {
  console.error(`tokpulse: ${message}`);
  process.exit(status);
}

const [command = "install", ...extra] = process.argv.slice(2);
if (extra.length === 0 && ["-h", "--help", "help"].includes(command)) {
  console.log(usage);
  process.exit(0);
}
if (extra.length !== 0 || (command !== "install" && command !== "update")) fail(`Unsupported arguments.\n${usage}`, 2);

const configDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
const specs = new Set();
for (const filename of ["opencode.json", "opencode.jsonc"]) {
  let source;
  try {
    source = await readFile(join(configDirectory, filename), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    fail(`Could not read global ${filename}.`);
  }
  let config;
  try {
    config = Bun.JSONC.parse(source);
  } catch {
    fail(`Could not parse global ${filename}. Fix the configuration and try again.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
      || ("plugins" in config && !Array.isArray(config.plugins))) {
    fail(`Invalid global ${filename}: expected a configuration object with an optional plugins array.`);
  }
  for (const entry of config.plugins ?? []) {
    const spec = typeof entry === "string" ? entry : entry?.package;
    if (typeof spec === "string" && (spec === packageName || spec.startsWith(`${packageName}@`))) specs.add(spec);
  }
}

if (command === "install" && specs.size > 0) {
  console.log("Token Pulse is already configured in the global OpenCode config.");
  process.exit(0);
}
if (command === "update") {
  if (specs.size === 0) fail("Token Pulse is not configured globally. Run tokpulse install first.");
  if (specs.size > 1) fail("Multiple Token Pulse targets are configured globally. Keep one target before updating.");
}

const opencode = Bun.which("opencode");
if (!opencode) fail("OpenCode was not found on PATH. Install OpenCode and try again.");

const [configured] = specs;
const action = command === "install" ? ["add", `${packageName}@latest`] : ["update", configured];
try {
  const child = Bun.spawn([opencode, "plugin", ...action], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} catch {
  fail("Could not run the OpenCode plugin command.");
}
