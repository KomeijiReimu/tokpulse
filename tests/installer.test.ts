import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/tokpulse.mjs", import.meta.url));
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
  return {
    config,
    run: (args: string[], status = 0) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: root, XDG_CONFIG_HOME: xdg ? configHome : undefined, PATH: bin,
        TOKPULSE_CALLS: calls, TOKPULSE_NATIVE_STATUS: String(status), TOKPULSE_WARMUP_STATUS: String(warmupStatus),
      },
    }),
    calls: () => fs.readFile(calls, "utf8"),
  };
}

test("default install delegates an unconfigured global plugin to native add at latest", async (t) => {
  const f = await fixture(t);
  const config = join(f.config, "opencode.json");
  const unrelated = JSON.stringify({ plugins: [`!${packageName}`, `-${packageName}@latest`, `${packageName}-extra`] });
  await fs.writeFile(config, unrelated);
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.calls(), `plugin\nadd\n${packageName}@latest\n`);
  assert.equal(await fs.readFile(config, "utf8"), unrelated);
});

test("install is idempotent across JSON and JSONC and preserves options and pins", async (t) => {
  const f = await fixture(t, { xdg: false });
  const json = join(f.config, "opencode.json");
  const jsonc = join(f.config, "opencode.jsonc");
  const bare = JSON.stringify({ plugins: [packageName] });
  const pinned = `{
  // Keep this exact version and its custom options.
  "plugins": [{"package": "${packageName}@0.1.1", "options": {"enabled": false}},],
}\n`;
  await fs.writeFile(jsonc, pinned);
  const result = f.run(["install"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already configured/);
  await fs.writeFile(json, bare);
  const repeated = f.run(["install"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already configured/);
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
  assert.equal(result.stderr, "models stderr\nnative stderr\n");
  assert.equal(await fs.readFile(config, "utf8"), source);
});

test("a failed OpenCode warmup forwards the error and blocks update", async (t) => {
  const f = await fixture(t, { warmupStatus: 29 });
  await fs.writeFile(join(f.config, "opencode.json"), JSON.stringify({ plugins: [`${packageName}@latest`] }));
  const result = f.run(["update"]);
  assert.equal(result.status, 29);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "models stderr\n");
  assert.equal(await f.calls(), "models\n");
});

test("update never falls back to updating all plugins when absent or ambiguous", async (t) => {
  const f = await fixture(t);
  const missing = f.run(["update"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not configured globally/);
  await fs.writeFile(join(f.config, "opencode.json"), JSON.stringify({ plugins: [packageName, `${packageName}@0.1.1`] }));
  const ambiguous = f.run(["update"]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /Multiple Token Pulse targets/);
  assert.equal(await f.calls(), "");
});

test("native stderr, stdout, and nonzero exit codes are forwarded", async (t) => {
  const f = await fixture(t);
  const result = f.run(["install"], 23);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "native stdout\n");
  assert.equal(result.stderr, "native stderr\n");
});

test("help, invalid arguments, and missing OpenCode have clear diagnostics", async (t) => {
  const f = await fixture(t, { native: false });
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: tokpulse \[install\|update\]/);
  for (const args of [["remove"], ["update", "other-plugin"]]) {
    const unknown = f.run(args);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Usage: tokpulse/);
  }
  const missing = f.run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /OpenCode was not found on PATH/);
});

test("invalid config stops install without printing config contents", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.config, "opencode.jsonc"), '{"secret": "never-print-this", invalid}');
  const result = f.run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not parse global opencode\.jsonc/);
  assert.doesNotMatch(result.stderr, /never-print-this/);
  assert.equal(await f.calls(), "");
});
