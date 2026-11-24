export const messages = {
  help: `Usage: tokpulse-cli <command>

Commands:
  setup        Install Token Pulse globally in OpenCode at @latest.
  update       Update the global plugin, keeping its version range or pin.
  -h, --help   Show this help.

Run with Bun:
  bun x @komeijireimu/tokpulse-cli@latest setup
  bun x @komeijireimu/tokpulse-cli@latest update`,
  invalidArguments: "Unsupported arguments.",
  configRead: (filename) => `Could not read global ${filename}. Check that the file is readable and try again.`,
  configParse: (filename) => `Could not parse global ${filename}. Fix the syntax and try again.`,
  configShape: (filename) => `Invalid global ${filename}: use a configuration object and make "plugins" an array if present.`,
  alreadyConfigured: "Token Pulse is already configured in OpenCode's global config.",
  missingConfigured: "Token Pulse is not configured globally. Run the setup command first.",
  multipleConfigured: "Multiple Token Pulse targets are configured globally. Keep one global entry before updating.",
  openCodeMissing: "OpenCode was not found on PATH. Install the OpenCode CLI or add it to PATH, then try again.",
  setupProgress: "Installing Token Pulse through OpenCode...",
  warmupProgress: "Loading OpenCode's configured plugins...",
  updateProgress: "Updating Token Pulse through OpenCode...",
  nativeLaunchFailed: "Could not start the OpenCode CLI.",
  setupFailed: "Token Pulse installation failed.",
  warmupFailed: "OpenCode failed to prepare for the update.",
  updateFailed: "Token Pulse update failed.",
};
