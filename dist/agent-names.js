const MAX_AGENT_NAME_LENGTH = 256;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Trimmed exact agent field. Rejects non-strings, control characters, compaction, and overlong names. */
export function normalizeAgentName(value) {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_AGENT_NAME_LENGTH) return undefined;
  if (CONTROL_CHARACTER.test(name) || name === "compaction") return undefined;
  return name;
}

/** Dedupe and stable lexicographic order. Non-arrays are empty; nothing is truncated. */
export function normalizeAgentNames(value) {
  if (!Array.isArray(value)) return [];
  const names = new Set();
  for (const entry of value) {
    const name = normalizeAgentName(entry);
    if (name) names.add(name);
  }
  return [...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
