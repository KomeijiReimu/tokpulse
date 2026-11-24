#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { messages } from "./messages.mjs";

const packageName = "@komeijireimu/tokpulse";

function fail(message, status = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(status);
}

const [command, ...extra] = process.argv.slice(2);
if (extra.length === 0 && (command === undefined || ["-h", "--help", "help"].includes(command))) {
  console.log(messages.help);
  process.exit(0);
}
const setup = command === "setup" || command === "install";
if (extra.length !== 0 || (!setup && command !== "update")) fail(`${messages.invalidArguments}\n\n${messages.help}`, 2);

const configDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
const specs = new Set();
for (const filename of ["opencode.json", "opencode.jsonc"]) {
  let source;
  try {
    source = await readFile(join(configDirectory, filename), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    fail(messages.configRead(filename));
  }
  let config;
  try {
    config = Bun.JSONC.parse(source);
  } catch {
    fail(messages.configParse(filename));
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
      || ("plugins" in config && !Array.isArray(config.plugins))) {
    fail(messages.configShape(filename));
  }
  for (const entry of config.plugins ?? []) {
    const spec = typeof entry === "string" ? entry : entry?.package;
    if (typeof spec === "string" && (spec === packageName || spec.startsWith(`${packageName}@`))) specs.add(spec);
  }
}

if (setup && specs.size > 0) {
  console.log(messages.alreadyConfigured);
  process.exit(0);
}
if (command === "update") {
  if (specs.size === 0) fail(messages.missingConfigured);
  if (specs.size > 1) fail(messages.multipleConfigured);
}

const opencode = Bun.which("opencode");
if (!opencode) fail(messages.openCodeMissing);

async function runStage(args, progress, failure, ignoreStdout = false) {
  const animate = process.stderr.isTTY && process.env.TERM !== "dumb";
  let timer, child, result, interrupted;
  const stopSpinner = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    process.stderr.write("\r\x1b[2K");
  };
  const interrupt = (signal, status) => {
    interrupted = status;
    stopSpinner();
    child?.kill(signal);
  };
  const onInterrupt = () => interrupt("SIGINT", 130);
  const onTerminate = () => interrupt("SIGTERM", 143);

  try {
    if (animate) {
      const frames = ["|", "/", "-", "\\"];
      let frame = 0;
      const draw = () => process.stderr.write(`\r${frames[frame++ % frames.length]} ${progress}`);
      draw();
      timer = setInterval(draw, 80);
    } else {
      process.stderr.write(`${progress}\n`);
    }
    child = Bun.spawn([opencode, ...args], {
      stdin: "inherit",
      stdout: ignoreStdout ? "ignore" : animate ? "pipe" : "inherit",
      stderr: animate ? "pipe" : "inherit",
    });
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    result = await Promise.all([
      child.exited,
      animate && !ignoreStdout ? Bun.readableStreamToBytes(child.stdout) : undefined,
      animate ? Bun.readableStreamToBytes(child.stderr) : undefined,
    ]);
  } finally {
    stopSpinner();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  const [status, stdout, stderr] = result;
  if (stdout?.length) process.stdout.write(stdout);
  if (stderr?.length) process.stderr.write(stderr);
  if (interrupted) return interrupted;
  if (status !== 0) process.stderr.write(`${failure}\n`);
  return status;
}

try {
  if (setup) {
    process.exitCode = await runStage(["plugin", "add", `${packageName}@latest`], messages.setupProgress, messages.setupFailed);
  } else {
    // On a cold start, OpenCode can query configured plugins before they finish loading.
    const status = await runStage(["models"], messages.warmupProgress, messages.warmupFailed, true);
    const [configured] = specs;
    process.exitCode = status || await runStage(["plugin", "update", configured], messages.updateProgress, messages.updateFailed);
  }
} catch {
  process.stderr.write(`${messages.nativeLaunchFailed}\n`);
  process.exitCode = 1;
}
