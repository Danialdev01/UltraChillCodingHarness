/**
 * Version arithmetic for runtimes: which installed version a selection
 * means, which download it would want, and whether a version meets a
 * project's own constraint (composer.json's `require.php`).
 *
 * Plain `major.minor.patch` only. The runtimes offered are releases, never
 * pre-releases, so there is no ordering of `-RC1` against `-beta2` to get
 * right here.
 */

export type Version = readonly [number, number, number];

const FULL = /^(\d+)\.(\d+)\.(\d+)$/;

/** `8.4.12` as numbers; null for anything that is not exactly that shape. */
export function parseVersion(text: string): Version | null {
  const match = FULL.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Valid versions, newest first, each once. */
export function newestFirst(versions: Iterable<string>): string[] {
  return [...new Set([...versions].filter((v) => parseVersion(v)))].sort((a, b) => compareVersions(b, a));
}

/** `8.4` for `8.4.12`. */
export function lineOf(version: string): string {
  const v = parseVersion(version);
  return v ? `${v[0]}.${v[1]}` : version;
}

/** Every `x.y` line in a list, newest first. */
export function linesOf(versions: Iterable<string>): string[] {
  return [...new Set(newestFirst(versions).map(lineOf))];
}

/** Whether a version is one a selection accepts at all. `system` accepts none. */
export function matchesSelection(selection: string, version: string): boolean {
  if (selection === "system") return false;
  if (selection === "latest") return parseVersion(version) !== null;
  if (parseVersion(selection)) return selection === version;
  return lineOf(version) === selection;
}

/**
 * The version a selection picks from a list: the newest it accepts. Used
 * against what is installed (what the project runs) and against what is
 * downloadable (what it would run after an update).
 */
export function pickVersion(selection: string, versions: Iterable<string>): string | null {
  return newestFirst(versions).find((v) => matchesSelection(selection, v)) ?? null;
}

// --- composer constraints ----------------------------------------------------

type Bound = { op: ">=" | ">" | "<=" | "<" | "=" | "!="; v: Version };

function partial(text: string): number[] | null {
  const clean = text.replace(/^v/i, "").replace(/(@|-)(dev|stable|beta|alpha|rc)\w*$/i, "");
  if (!/^\d+(\.\d+){0,2}$/.test(clean)) return null;
  return clean.split(".").map(Number);
}

function pad(parts: number[]): Version {
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** The first version after every one a partial names: `8.1` -> `8.2.0`. */
function after(parts: number[]): Version {
  const bumped = [...parts];
  bumped[bumped.length - 1] = (bumped[bumped.length - 1] ?? 0) + 1;
  return pad(bumped);
}

function cmp(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** One term of a constraint as bounds; null when it is not understood. */
function term(raw: string): Bound[] | null {
  const text = raw.trim();
  if (text === "*" || text === "") return [];

  const op = /^(>=|<=|!=|>|<|==|=|\^|~)?(.*)$/.exec(text);
  if (!op) return null;
  const operator = op[1] ?? "";
  const rest = op[2] ?? "";

  // `8.*`, `8.1.*`, `8.1.x`.
  const wildcard = /^(.*?)\.[*xX]$/.exec(rest);
  if (wildcard && operator === "") {
    const parts = partial(wildcard[1] ?? "");
    return parts ? [{ op: ">=", v: pad(parts) }, { op: "<", v: after(parts) }] : null;
  }

  const parts = partial(rest);
  if (!parts) return null;
  const v = pad(parts);
  switch (operator) {
    case ">=":
    case ">":
    case "<=":
    case "<":
    case "!=":
      return [{ op: operator, v }];
    case "=":
    case "==":
      return [{ op: "=", v }];
    case "^": {
      // The leftmost non-zero part stays; `^8.1` is >=8.1.0 <9.0.0.
      const i = parts[0] !== 0 || parts.length === 1 ? 0 : parts[1] !== 0 || parts.length === 2 ? 1 : 2;
      return [{ op: ">=", v }, { op: "<", v: after(parts.slice(0, i + 1)) }];
    }
    case "~": {
      // `~8.1` is >=8.1 <9.0; `~8.1.2` is >=8.1.2 <8.2.0; `~8` is >=8 <9.
      const keep = parts.length === 1 ? 1 : parts.length - 1;
      return [{ op: ">=", v }, { op: "<", v: after(parts.slice(0, keep)) }];
    }
    default:
      // A bare partial (`8.1`) reads as that whole line: what someone writing
      // it for PHP means. A full one is exact.
      return parts.length === 3 ? [{ op: "=", v }] : [{ op: ">=", v }, { op: "<", v: after(parts) }];
  }
}

function meets(v: Version, bound: Bound): boolean {
  const c = cmp(v, bound.v);
  switch (bound.op) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
  }
}

/**
 * Whether `version` meets a composer-style constraint: `^8.1`,
 * `>=8.1 <8.4`, `^8.2 || ^8.3`, `8.1.*`, `8.1 - 8.3`. Null when the
 * constraint uses something this does not read, so a caller can say
 * "unknown" rather than a wrong yes or no.
 */
export function satisfiesConstraint(constraint: string, version: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  let anyUnknown = false;
  for (const alternative of constraint.split(/\s*\|\|?\s*/)) {
    const bounds = group(alternative);
    if (bounds === null) {
      anyUnknown = true;
      continue;
    }
    if (bounds.every((b) => meets(v, b))) return true;
  }
  return anyUnknown ? null : false;
}

/** One `||` alternative: terms joined by spaces or commas, or a hyphen range. */
function group(text: string): Bound[] | null {
  const trimmed = text.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    const low = partial(hyphen[1] ?? "");
    const high = partial(hyphen[2] ?? "");
    if (!low || !high) return null;
    const upper: Bound = high.length === 3 ? { op: "<=", v: pad(high) } : { op: "<", v: after(high) };
    return [{ op: ">=", v: pad(low) }, upper];
  }
  // `>= 8.1` with a space is one term, not two.
  const normal = trimmed.replace(/(>=|<=|!=|==|>|<|=|\^|~)\s+/g, "$1");
  const bounds: Bound[] = [];
  for (const part of normal.split(/\s*,\s*|\s+/)) {
    const parsed = term(part);
    if (parsed === null) return null;
    bounds.push(...parsed);
  }
  return bounds;
}
