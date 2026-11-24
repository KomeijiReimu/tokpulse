import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../installer/tokpulse.mjs", import.meta.url));
const { messages } = await import(new URL("../installer/messages.mjs", import.meta.url).href);
const packageName = "@komeijireimu/tokpulse";

async function fixture(t: TestContext, { xdg = true, native = true, warmupStatus = 0 } = {}) {
  const temp = process.env.TMPDIR || join(homedir(), ".cache");
  await fs.mkdir(temp, { recursive: true });
  const root = await fs.mkdtemp(join(temp, "tokpulse-installer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configHome = join(root, xdg ? "xdg" : ".config");
  const config = join(configHome, "opencode");
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(calls, "");
  if (native) await fs.writeFile(join(bin, "opencode"), `#!/bin/sh
printf '%s\\n' "$@" >> "$TOKPULSE_CALLS"
if [ "$1" = models ]; then
  printf 'models stdout\\n'
  printf 'models stderr\\n' >&2
  exit "$TOKPULSE_WARMUP_STATUS"
fi
printf 'native stdout\\n'
printf 'native stderr\\n' >&2
exit "\${TOKPULSE_NATIVE_STATUS:-0}"
`, { mode: 0o755 });
  const env = {
    HOME: root, XDG_CONFIG_HOME: xdg ? configHome : undefined, PATH: bin,
    TOKPULSE_CALLS: calls, TOKPULSE_WARMUP_STATUS: String(warmupStatus),
  };
  return {
    config,
    root,
    env,
    run: (args: string[], status = 0) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, TOKPULSE_NATIVE_STATUS: String(status) },
    }),
    calls: () => fs.readFile(calls, "utf8"),
  };
}

test("no arguments and --help show help without reading config or calling OpenCode", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.config, "opencode.jsonc"), '{"broken":');
  for (const args of [[], ["--help"]]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${messages.help}\n`);
    assert.equal(result.stderr, "");
  }
  assert.equal(await f.calls(), "");
});

test("setup delegates an unconfigured global plugin to native add at latest", async (t) => {
  const f = await fixture(t);
  const config = join(f.config, "opencode.json");
  const unrelated = JSON.stringify({ plugins: [`!${packageName}`, `-${packageName}@latest`, `${packageName}-extra`] });
  await fs.writeFile(config, unrelated);
  const result = f.run(["setup"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "native stdout\n");
  assert.equal(result.stderr, `${messages.setupProgress}\nnative stderr\n`);
  assert.equal(await f.calls(), `plugin\nadd\n${packageName}@latest\n`);
  assert.equal(await fs.readFile(config, "utf8"), unrelated);
});

test("TTY progress clears before native output; TERM=dumb uses a stable line", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const runtime = "bun";
  const { spawn } = await import(runtime);
  for (const term of ["xterm", "dumb"]) {
    const chunks: Uint8Array[] = [];
    const child = spawn([process.execPath, cli, "setup"], {
      cwd: f.root,
      env: { ...f.env, TERM: term },
      terminal: { data(_terminal: unknown, data: Uint8Array) { chunks.push(Uint8Array.from(data)); } },
    });
    try {
      assert.equal(await child.exited, 0);
    } finally {
      child.terminal.close();
    }
    const output = Buffer.concat(chunks).toString().replace(/\r+\n/g, "\n");
    if (term === "xterm") {
      assert.ok(output.startsWith(`\r| ${messages.setupProgress}`), JSON.stringify(output));
      assert.ok(output.includes("\r\x1b[2Knative stdout\nnative stderr\n"), JSON.stringify(output));
    } else {
      assert.ok(output.startsWith(`${messages.setupProgress}\n`), JSON.stringify(output));
      assert.doesNotMatch(output, /\x1b/);
      assert.match(output, /native stdout/);
      assert.match(output, /native stderr/);
    }
  }
});

test("setup and the install alias preserve existing JSON and JSONC options and pins", async (t) => {
  const f = await fixture(t, { xdg: false });
  const json = join(f.config, "opencode.json");
  const jsonc = join(f.config, "opencode.jsonc");
  const bare = JSON.stringify({ plugins: [packageName] });
  const pinned = `{
  // Keep this exact version and its custom options.
  "plugins": [{"package": "${packageName}@0.1.1", "options": {"enabled": false}},],
}\n`;
  await fs.writeFile(jsonc, pinned);
  const result = f.run(["setup"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${messages.alreadyConfigured}\n`);
  await fs.writeFile(json, bare);
  const repeated = f.run(["install"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, `${messages.alreadyConfigured}\n`);
  assert.equal(await f.calls(), "");
  assert.equal(await fs.readFile(json, "utf8"), bare);
  assert.equal(await fs.readFile(jsonc, "utf8"), pinned);
});

test("update warms OpenCode once before passing the exact configured target", async (t) => {
  const f = await fixture(t);
  const target = `${packageName}@>=0.1.1 <1`;
  const config = join(f.config, "opencode.jsonc");
  const source = JSON.stringify({ plugins: [{ package: target, options: { keybind: false } }] });
  await fs.writeFile(config, source);
  await fs.writeFile(join(f.config, "opencode.json"), JSON.stringify({ plugins: [target] }));
  const result = f.run(["update"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.calls(), `models\nplugin\nupdate\n${target}\n`);
  assert.equal(result.stdout, "native stdout\n");
  assert.equal(result.stderr, `${messages.warmupProgress}\nmodels stderr\n${messages.updateProgress}\nnative stderr\n`);
  assert.equal(await fs.readFile(config, "utf8"), source);
});

test("a failed OpenCode warmup forwards the error and blocks update", async (t) => {
  const f = await fixture(t, { warmupStatus: 29 });
  await fs.writeFile(join(f.config, "opencode.json"), JSON.stringify({ plugins: [`${packageName}@latest`] }));
  const result = f.run(["update"]);
  assert.equal(result.status, 29);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${messages.warmupProgress}\nmodels stderr\n${messages.warmupFailed}\n`);
  assert.equal(await f.calls(), "models\n");
});

test("update never falls back to updating all plugins when absent or ambiguous", async (t) => {
  const f = await fixture(t);
  const missing = f.run(["update"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, `${messages.missingConfigured}\n`);
  await fs.writeFile(join(f.config, "opencode.json"), JSON.stringify({ plugins: [packageName, `${packageName}@0.1.1`] }));
  const ambiguous = f.run(["update"]);
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.stderr, `${messages.multipleConfigured}\n`);
  assert.equal(await f.calls(), "");
});

test("the install alias forwards native output and exit code on failure", async (t) => {
  const f = await fixture(t);
  const result = f.run(["install"], 23);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "native stdout\n");
  assert.equal(result.stderr, `${messages.setupProgress}\nnative stderr\n${messages.setupFailed}\n`);
  assert.equal(await f.calls(), `plugin\nadd\n${packageName}@latest\n`);
});

test("a failed targeted update forwards native output and exit code", async (t) => {
  const f = await fixture(t);
  const target = `${packageName}@latest`;
  await fs.writeFile(join(f.config, "opencode.json"), JSON.stringify({ plugins: [target] }));
  const result = f.run(["update"], 23);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "native stdout\n");
  assert.equal(result.stderr, `${messages.warmupProgress}\nmodels stderr\n${messages.updateProgress}\nnative stderr\n${messages.updateFailed}\n`);
  assert.equal(await f.calls(), `models\nplugin\nupdate\n${target}\n`);
});

test("invalid arguments and missing OpenCode have clear diagnostics", async (t) => {
  const f = await fixture(t, { native: false });
  for (const args of [["remove"], ["update", "other-plugin"]]) {
    const unknown = f.run(args);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, `${messages.invalidArguments}\n\n${messages.help}\n`);
  }
  const missing = f.run(["setup"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, `${messages.openCodeMissing}\n`);
});

test("invalid config stops install without printing config contents", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.config, "opencode.jsonc"), '{"secret": "never-print-this", invalid}');
  const result = f.run(["setup"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `${messages.configParse("opencode.jsonc")}\n`);
  assert.doesNotMatch(result.stderr, /never-print-this/);
  assert.equal(await f.calls(), "");
});
