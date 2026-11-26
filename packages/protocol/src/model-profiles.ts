import { SAME_MODEL } from "./agent-directives.js";
import { modelTokens, type CatalogueModel, type RoutingHarness } from "./model-routing.js";

/**
 * What the server knows about models when it has to choose one for a
 * reviewer or a council seat: whose they are, how strong, and what at.
 * Hand-kept, by family, so a new version of a known family needs no edit.
 */
export interface ModelProfile {
  /** "opus", "gpt", "gemini-pro", ... */
  family: string;
  /** "anthropic", "openai", "google", "xai", "deepseek", or an id's own prefix. */
  vendor: string;
  /** 1 is the frontier. */
  tier: 1 | 2 | 3;
  strengths: readonly ModelStrength[];
}
export type ModelStrength = "code" | "review" | "reasoning" | "long-context" | "fast";

const FRONTIER: readonly ModelStrength[] = ["code", "review", "reasoning"];

const FAMILIES: readonly (readonly [RegExp, ModelProfile])[] = [
  [/\bopus\b/, { family: "opus", vendor: "anthropic", tier: 1, strengths: FRONTIER }],
  [/\bsonnet\b/, { family: "sonnet", vendor: "anthropic", tier: 2, strengths: FRONTIER }],
  // Billed on usage credits outside the subscription: never the automatic choice ahead of the others.
  [/\bfable\b/, { family: "fable", vendor: "anthropic", tier: 2, strengths: ["reasoning"] }],
  [/\bhaiku\b/, { family: "haiku", vendor: "anthropic", tier: 3, strengths: ["fast"] }],
  [/\b(?:gpt|codex)\b.*\b(?:mini|nano|audio|image|realtime|search|chat|oss|instant|safeguard)\b/, { family: "gpt-small", vendor: "openai", tier: 3, strengths: ["fast"] }],
  [/\bgpt\b.*\bpro\b/, { family: "gpt-pro", vendor: "openai", tier: 2, strengths: ["reasoning"] }],
  [/\bgpt [34]\b/, { family: "gpt-old", vendor: "openai", tier: 3, strengths: [] }],
  [/\bgpt\b.*\bcodex\b/, { family: "gpt-codex", vendor: "openai", tier: 1, strengths: ["code", "review"] }],
  [/\bgpt\b/, { family: "gpt", vendor: "openai", tier: 1, strengths: FRONTIER }],
  [/^o \d\b.*\bmini\b/, { family: "o-mini", vendor: "openai", tier: 3, strengths: ["fast"] }],
  [/^o \d\b/, { family: "o", vendor: "openai", tier: 2, strengths: ["reasoning"] }],
  [/\bgemini\b.*\b(?:image|audio|tts|lite|live|embedding)\b/, { family: "gemini-small", vendor: "google", tier: 3, strengths: ["fast"] }],
  [/\bgemini\b.*\bpro\b/, { family: "gemini-pro", vendor: "google", tier: 1, strengths: [...FRONTIER, "long-context"] }],
  [/\bgemini\b.*\bflash\b/, { family: "gemini-flash", vendor: "google", tier: 2, strengths: ["fast", "long-context"] }],
  [/\bgrok\b.*\b(?:mini|fast|image|vision)\b/, { family: "grok-small", vendor: "xai", tier: 3, strengths: ["fast"] }],
  [/\bgrok\b/, { family: "grok", vendor: "xai", tier: 1, strengths: ["code", "reasoning"] }],
  [/\bdeepseek\b.*\b(?:distill|ocr|lite)\b/, { family: "deepseek-small", vendor: "deepseek", tier: 3, strengths: [] }],
  [/\bdeepseek\b/, { family: "deepseek", vendor: "deepseek", tier: 2, strengths: ["code", "reasoning"] }],
  [/\bkimi\b/, { family: "kimi", vendor: "moonshotai", tier: 2, strengths: ["code"] }],
  [/\bglm\b(?!.*\b(?:air|flash|v)\b)/, { family: "glm", vendor: "z-ai", tier: 2, strengths: ["code"] }],
  [/\bqwen\b.*\bmax\b/, { family: "qwen-max", vendor: "qwen", tier: 2, strengths: ["code"] }],
];

const PREFIX_VENDOR: Record<string, string> = { "x-ai": "xai" };

/** `claude-opus-5-5`, `opus`, `openai/gpt-5.1`, ... as its profile. */
export function modelProfile(id: string): ModelProfile {
  const [prefix, name] = id.includes("/") ? [id.slice(0, id.indexOf("/")).toLowerCase(), id.slice(id.indexOf("/") + 1)] : [null, id];
  const spelled = modelTokens(name.replace(/:.*$/, "")).join(" ");
  for (const [pattern, profile] of FAMILIES) if (pattern.test(spelled)) return profile;
  return { family: spelled || id, vendor: prefix ? PREFIX_VENDOR[prefix] ?? prefix : "other", tier: 3, strengths: [] };
}

export interface PickHarness extends RoutingHarness {
  /** What it is known to offer; `models` only when the CLI itself listed them. */
  knownModels?: readonly CatalogueModel[];
}

export interface PickInput {
  role: "reviewer" | "council";
  /** The model whose work it is, and what it runs on; null: that harness's default. */
  author: { provider: string; model: string | null };
  count: number;
  /** As the person named them; they take the first seats. */
  explicit: readonly string[];
  available: readonly PickHarness[];
  catalogue: readonly CatalogueModel[];
  /** `auto`, `same`, or a model. Reviewers only. */
  preference?: string;
}

export interface ModelPick {
  /** Null: the session's own harness and model. */
  model: string | null;
  reason: string;
}

export const PICK_REASONS = {
  asked: "you asked for it",
  same: "the session's own model",
  onlySame: "the session's own model: nothing else is available",
  setting: "the project's reviewer",
  otherVendor: "different vendor from the author",
  otherFamily: "different model from the author's, same vendor",
  seat: "best available from its vendor",
} as const;

interface Candidate {
  id: string;
  profile: ModelProfile;
  /** Runs on a subscription the person already pays for. */
  cli: boolean;
}

/** Best first; total and fixed, so the same choices always give the same pick. */
function compare(a: Candidate, b: Candidate, want: readonly ModelStrength[]): number {
  const fit = (c: Candidate) => want.filter((s) => c.profile.strengths.includes(s)).length;
  return (
    a.profile.tier - b.profile.tier ||
    Number(b.cli) - Number(a.cli) ||
    fit(b) - fit(a) ||
    // Versions say nothing across vendors.
    rankOf(a.profile.vendor) - rankOf(b.profile.vendor) ||
    (a.profile.vendor < b.profile.vendor ? -1 : a.profile.vendor > b.profile.vendor ? 1 : 0) ||
    compareVersions(b.id, a.id) ||
    a.id.length - b.id.length ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const VENDORS = ["anthropic", "openai", "google", "xai", "deepseek"];
function rankOf(vendor: string): number {
  const at = VENDORS.indexOf(vendor);
  return at === -1 ? VENDORS.length : at;
}

function versionOf(id: string): number[] {
  // A date or a size in the name is not a version.
  return modelTokens(id.slice(id.indexOf("/") + 1)).filter((t) => /^\d{1,2}$/.test(t)).map(Number);
}
function compareVersions(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The models the server may choose for someone who named none. */
function candidates(input: PickInput, want: readonly ModelStrength[]): Candidate[] {
  const usable = input.available.filter((h) => h.usable && (h.usedPercent ?? 0) <= 90);
  const out: Candidate[] = [];
  const covered = new Set<string>();
  for (const harness of usable) {
    if (harness.provider !== "claude" && harness.provider !== "codex") continue;
    covered.add(harness.provider === "claude" ? "anthropic" : "openai");
    for (const model of harness.models ?? harness.knownModels ?? []) {
      out.push({ id: model.id, profile: modelProfile(model.id), cli: true });
    }
  }
  if (usable.some((h) => h.provider === "omp")) {
    for (const model of input.catalogue) {
      if (model.id.includes(":")) continue;
      const profile = modelProfile(model.id);
      // A vendor's own CLI runs its models; OpenRouter is billed apart.
      if (profile.tier === 3 || covered.has(profile.vendor)) continue;
      out.push({ id: model.id, profile, cli: false });
    }
  }
  return out.sort((a, b) => compare(a, b, want));
}

function authorProfile(author: PickInput["author"]): { vendor: string; family: string | null } {
  if (author.model) return modelProfile(author.model);
  return { vendor: author.provider === "claude" ? "anthropic" : author.provider === "codex" ? "openai" : "other", family: null };
}

/** Who reviews, or sits on the council. */
export function pickModels(input: PickInput): ModelPick[] {
  const asked: ModelPick[] = input.explicit.map((model) =>
    model === SAME_MODEL ? { model: null, reason: PICK_REASONS.same } : { model, reason: PICK_REASONS.asked },
  );
  const picks = asked.slice(0, Math.max(input.count, asked.length));
  if (picks.length >= input.count) return picks;
  return input.role === "reviewer" ? pickReviewers(input, picks) : pickCouncil(input, picks);
}

function pickReviewers(input: PickInput, picks: ModelPick[]): ModelPick[] {
  const preference = input.preference ?? "auto";
  if (picks.length === 0 && preference === SAME_MODEL) picks.push({ model: null, reason: PICK_REASONS.same });
  else if (picks.length === 0 && preference !== "auto") picks.push({ model: preference, reason: PICK_REASONS.setting });

  const author = authorProfile(input.author);
  const all = candidates(input, ["review", "code"]);
  const capable = all.filter((c) => c.profile.tier < 3 && (c.profile.strengths.includes("review") || c.profile.strengths.includes("code")));
  while (picks.length < input.count) {
    const taken = new Set(picks.map((pick) => pick.model));
    const vendors = new Set(picks.map((pick) => (pick.model ? modelProfile(pick.model).vendor : author.vendor)));
    const free = capable.filter((c) => !taken.has(c.id));
    const other = free.filter((c) => c.profile.vendor !== author.vendor);
    const pick = other.find((c) => !vendors.has(c.profile.vendor)) ?? other[0];
    if (pick) {
      picks.push({ model: pick.id, reason: PICK_REASONS.otherVendor });
      continue;
    }
    const family = author.family === null ? undefined : free.find((c) => c.profile.vendor === author.vendor && c.profile.family !== author.family);
    if (family) {
      picks.push({ model: family.id, reason: PICK_REASONS.otherFamily });
      continue;
    }
    picks.push({ model: null, reason: PICK_REASONS.onlySame });
  }
  return picks;
}

function pickCouncil(input: PickInput, picks: ModelPick[]): ModelPick[] {
  const author = authorProfile(input.author);
  if (picks.length === 0) picks.push({ model: null, reason: PICK_REASONS.same });
  const all = candidates(input, ["reasoning", "code"]).filter((c) => c.profile.tier < 3);
  const used = new Set(picks.map((pick) => pick.model ?? input.author.model));
  const seats = new Map<string, number>();
  const seat = (vendor: string) => seats.set(vendor, (seats.get(vendor) ?? 0) + 1);
  for (const pick of picks) seat(pick.model ? modelProfile(pick.model).vendor : author.vendor);
  while (picks.length < input.count) {
    const free = all.filter((c) => !used.has(c.id));
    // Best first already: the fewest-seated vendor's strongest model.
    const next = free.reduce<Candidate | null>(
      (best, c) => (best === null || (seats.get(c.profile.vendor) ?? 0) < (seats.get(best.profile.vendor) ?? 0) ? c : best),
      null,
    );
    if (!next) {
      picks.push({ model: null, reason: PICK_REASONS.onlySame });
      continue;
    }
    used.add(next.id);
    seat(next.profile.vendor);
    picks.push({ model: next.id, reason: PICK_REASONS.seat });
  }
  return picks;
}
