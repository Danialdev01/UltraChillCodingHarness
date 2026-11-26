import { randomUUID } from "node:crypto";
import { z } from "zod";
import { councilSize, pickModels, type CouncilDirective, type DomainEvent } from "@ucch/protocol";
import {
  appendTo,
  clip,
  fencedJson,
  pickedModel,
  quoted,
  RunningDeliberations,
  type DeliberationDeps,
  type DeliberationParent,
} from "./deliberations.js";
import type { ManagedAgent, RunOutcome } from "./subagents.js";
import { exchangesOf, recentExchanges } from "./thread-transcript.js";

export const COUNCIL_TIMEOUT_MS = 30 * 60_000;
const CONTEXT_CHARS = 8_000;
const QUESTION_CHARS = 20_000;

const POSITION_BLOCK =
  '```ucch-position\n{"recommendation":"what to do, in one or two sentences","confidence":0.0,"reasons":["..."],"risks":["..."]}\n```';

export const COUNCIL_OPENING_BRIEF = [
  "You sit on a council of independent agents asked the question below. Think it through on your own; nobody has seen the others' answers yet. You are read-only: read and search this folder where it helps, change nothing.",
  "Take a position. Say what would change your mind, and be honest about confidence (0 to 1).",
  "End with exactly one fenced block, and nothing after it:",
  POSITION_BLOCK,
].join("\n");

export const COUNCIL_ROUND_BRIEF = [
  "Here is where the other members stand. Critique their reasoning on its merits: name what is wrong or missing, then concede or hold your position. Change it only for a better argument, not to agree.",
  "If you now recommend the same as another member, repeat their recommendation word for word. End with exactly one fenced block, and nothing after it, with `changed` true only when your recommendation is different from your last:",
  POSITION_BLOCK.replace('"risks":["..."]', '"risks":["..."],"changed":false'),
].join("\n");

export const COUNCIL_MODERATOR_BRIEF = [
  "The person asked a council of agents the question in this message; their final positions are below. You are the moderator. Answer the person yourself: say what the council recommends and how far it agrees, give the strongest dissent its fair due, and then your own view. Weigh the arguments, not the head count, and check claims about the code before relying on them.",
].join("\n");

export interface CouncilOptions {
  maxCostUsd: number;
  timeoutMs?: number;
}

export interface Position {
  recommendation: string;
  confidence: number;
  reasons: string[];
  risks: string[];
  changed: boolean;
}

const texts = z
  .array(z.unknown())
  .catch([])
  .transform((list) => list.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, 10).map((item) => item.slice(0, 1_000)));

/** A member's answer as its position; one that gave no block is taken at its words. */
export function parsePosition(text: string): Position | null {
  const parsed = z
    .object({
      recommendation: z.string().trim().min(1),
      confidence: z.coerce.number().min(0).max(1).catch(0.5),
      reasons: texts,
      risks: texts,
      changed: z.boolean().catch(false),
    })
    .safeParse(fencedJson(text, "ucch-position"));
  if (parsed.success) return { ...parsed.data, recommendation: parsed.data.recommendation.slice(0, 4_000) };
  const words = text.trim();
  return words ? { recommendation: words.slice(0, 1_500), confidence: 0.5, reasons: [], risks: [], changed: false } : null;
}

/** Two recommendations that say the same, as far as their openings tell. */
export function sameRecommendation(a: string, b: string): boolean {
  const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
  return key(a) === key(b);
}

export interface Conclusion {
  consensus: "unanimous" | "majority" | "split";
  recommendation: string;
  dissent: { seat: string; position: string }[];
}

/** The final positions, grouped: the largest group's is the council's, ties going to the surer. */
export function conclude(positions: ReadonlyMap<string, Position>): Conclusion {
  const groups: { recommendation: string; seats: string[]; confidence: number }[] = [];
  for (const [seat, position] of [...positions].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const group = groups.find((g) => sameRecommendation(g.recommendation, position.recommendation));
    if (group) {
      group.seats.push(seat);
      group.confidence += position.confidence;
    } else groups.push({ recommendation: position.recommendation, seats: [seat], confidence: position.confidence });
  }
  groups.sort((a, b) => b.seats.length - a.seats.length || b.confidence - a.confidence);
  const lead = groups[0]!;
  return {
    consensus: groups.length === 1 ? "unanimous" : lead.seats.length > positions.size / 2 ? "majority" : "split",
    recommendation: lead.recommendation,
    dissent: groups.slice(1).flatMap((g) => g.seats.map((seat) => ({ seat, position: positions.get(seat)!.recommendation }))),
  };
}

export function contextOf(history: readonly { event: DomainEvent }[], question: string): string | null {
  const exchanges = exchangesOf(history);
  // The question itself is the last, not yet answered.
  if (exchanges.at(-1)?.prompt === question) exchanges.pop();
  const recent = recentExchanges(exchanges, 6, CONTEXT_CHARS);
  if (recent.length === 0) return null;
  return recent.map(({ prompt, reply }) => `Person: ${prompt}\n\nAgent: ${reply}`).join("\n\n");
}

export type CouncilOutcome =
  /** The held turn goes ahead, with this ahead of its message. */
  | { kind: "brief"; text: string }
  | { kind: "cancelled" };

interface Member {
  seat: string;
  agent: ManagedAgent;
}

/**
 * `@council`: several agents answer a question apart, then argue it out, and
 * the session's own agent -- whose turn is held back meanwhile -- writes the
 * answer from where they ended up. Members see each other as letters only,
 * so no argument wins on its model's name.
 */
export class CouncilRunner {
  readonly running = new RunningDeliberations();
  constructor(
    private readonly deps: DeliberationDeps,
    private readonly options: CouncilOptions,
  ) {}

  async run(input: { parent: DeliberationParent; turnId: string; directive: CouncilDirective; question: string; signal: AbortSignal }): Promise<CouncilOutcome> {
    const { parent, directive, question } = input;
    const deliberationId = randomUUID();
    const ids = { threadId: parent.threadId, deliberationId };
    const append = appendTo(this.deps.store, parent);
    const controller = this.running.open(deliberationId, parent.threadId);
    const onParent = () => controller.abort("parent");
    if (input.signal.aborted) onParent();
    input.signal.addEventListener("abort", onParent, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), this.options.timeoutMs ?? COUNCIL_TIMEOUT_MS);
    timer.unref?.();
    let members: Member[] = [];
    const everyone: ManagedAgent[] = [];
    const models = new Map<string, string>();
    const latest = new Map<string, Position>();
    let costUsd = 0;
    let opened = false;
    const stopped = () => controller.signal.aborted && controller.signal.reason !== "timeout";
    try {
      const [settings, available, catalogue, history] = await Promise.all([
        this.deps.settings(parent.projectId),
        this.deps.harnesses(parent.subject),
        this.deps.catalogue().catch(() => []),
        this.deps.store.threadHistory(parent.threadId),
      ]);
      const rounds = directive.rounds ?? settings.councilRounds;
      const picks = pickModels({
        role: "council",
        author: parent.author,
        count: councilSize(directive, settings.councilSize),
        explicit: directive.models,
        available,
        catalogue,
      });
      const seated: Extract<DomainEvent, { type: "agent.council_started" }>["members"] = [];
      const refused: string[] = [];
      for (const pick of picks) {
        const agent = await this.deps.runner.startManaged({
          parentThreadId: parent.threadId,
          subject: parent.subject,
          turnId: input.turnId,
          deliberationId,
          description: "Council member",
          model: pickedModel(pick, parent.author),
          author: parent.author,
          signal: controller.signal,
        });
        if ("error" in agent) {
          refused.push(agent.error);
          continue;
        }
        const seat = String.fromCharCode("A".charCodeAt(0) + seated.length);
        everyone.push(agent);
        members.push({ seat, agent });
        models.set(seat, agent.model ?? agent.provider);
        seated.push({
          seat,
          subagentId: agent.subagentId,
          childThreadId: agent.childThreadId,
          childHash: agent.childHash,
          model: agent.model,
          provider: agent.provider,
          reason: pick.reason,
        });
      }
      opened = true;
      await append([{ type: "agent.council_started", ...ids, turnId: input.turnId, members: seated, rounds, question }]);
      let partial = refused.length > 0;

      const context = contextOf(history, question);
      const task = [
        COUNCIL_OPENING_BRIEF,
        quoted("question", clip(question, QUESTION_CHARS)),
        ...(context ? [quoted("context", context)] : []),
      ].join("\n\n");

      /** One turn of every member, together; those that fail leave. */
      const ask = async (round: number, message: (member: Member) => string) => {
        const before = new Map(latest);
        const outcomes = await Promise.all(
          members.map(async (member): Promise<[Member, RunOutcome]> => {
            const outcome = await member.agent.turn(message(member));
            const position = outcome.kind === "done" ? parsePosition(outcome.text) : null;
            if (outcome.kind === "done") costUsd += outcome.costUsd;
            if (position) {
              const last = before.get(member.seat);
              const changed = last !== undefined && (position.changed || !sameRecommendation(last.recommendation, position.recommendation)) && last.recommendation !== position.recommendation;
              latest.set(member.seat, { ...position, changed });
              await append([{ type: "agent.council_position", ...ids, round, seat: member.seat, ...position, changed }]);
              return [member, outcome];
            }
            return [member, outcome.kind === "done" ? { kind: "failed", error: "it gave no answer" } : outcome];
          }),
        );
        if (controller.signal.aborted) return;
        for (const [member, outcome] of outcomes) {
          if (outcome.kind === "done") continue;
          partial = true;
          members = members.filter((other) => other !== member);
          // One that answered before keeps its last word; it only stops arguing.
          await append([{ type: "agent.council_dropped", ...ids, seat: member.seat, error: outcome.error.slice(0, 2_000) }]);
          await member.agent.end().catch(this.deps.onError);
        }
      };

      await ask(0, () => task);
      let roundsRun = 0;
      let stop: "budget" | "timeout" | undefined;
      const settled = () => {
        const positions = [...latest.values()];
        return positions.every((p) => p.confidence >= 0.8 && sameRecommendation(p.recommendation, positions[0]!.recommendation));
      };
      for (let round = 1; round <= rounds && members.length >= 2 && !controller.signal.aborted && !settled(); round++) {
        if (costUsd > this.options.maxCostUsd) {
          stop = "budget";
          break;
        }
        const before = new Map(latest);
        await ask(round, (member) => {
          const others = [...before]
            .filter(([seat]) => seat !== member.seat)
            .map(([seat, p]) =>
              [`Member ${seat} (confidence ${p.confidence}): ${p.recommendation}`, ...p.reasons.map((r) => `  - because: ${r}`), ...p.risks.map((r) => `  - risk: ${r}`)].join("\n"),
            );
          return `${COUNCIL_ROUND_BRIEF}\n\n${quoted("positions", clip(others.join("\n\n"), 40_000))}`;
        });
        if (controller.signal.aborted) break;
        roundsRun = round;
        if (members.every((member) => !latest.get(member.seat)?.changed)) break;
      }
      if (stopped()) return await this.#cancelled(append, ids, controller);
      if (controller.signal.aborted) stop = "timeout";

      if (latest.size < 2) {
        const why = stop === "timeout" ? "it ran out of time" : refused[0] ?? "too few members answered";
        await append([{ type: "agent.council_failed", ...ids, error: `The council could not meet: ${why}`.slice(0, 2_000), partial: latest.size > 0 }]);
        return { kind: "brief", text: unmet(why, latest, directive) };
      }
      const conclusion = conclude(latest);
      await append([
        {
          type: "agent.council_concluded",
          ...ids,
          ...conclusion,
          roundsRun,
          costUsd,
          ...(partial ? { partial: true } : {}),
          ...(stop ? { stopped: stop } : {}),
        },
      ]);
      return { kind: "brief", text: moderatorBrief(latest, models, conclusion, directive) };
    } catch (error) {
      if (stopped()) return await this.#cancelled(append, ids, controller, opened);
      this.deps.onError(error);
      const why = error instanceof Error ? error.message : String(error);
      if (opened) await append([{ type: "agent.council_failed", ...ids, error: `The council could not meet: ${why}`.slice(0, 2_000), partial: latest.size > 0 }]);
      return { kind: "brief", text: unmet(why, latest, directive) };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onParent);
      this.running.close(deliberationId);
      for (const agent of everyone) {
        if (controller.signal.aborted) agent.stop();
        await agent.end().catch(this.deps.onError);
      }
    }
  }

  async #cancelled(append: (events: DomainEvent[]) => Promise<unknown>, ids: { threadId: string; deliberationId: string }, controller: AbortController, opened = true): Promise<CouncilOutcome> {
    if (opened) await append([{ type: "agent.deliberation_cancelled", ...ids, by: controller.signal.reason }]);
    return { kind: "cancelled" };
  }
}

function afterwards(directive: CouncilDirective): string {
  return directive.implement
    ? "Then carry out the recommended approach, to the end, and verify it."
    : "Do not change files; answer only.";
}

export function moderatorBrief(
  positions: ReadonlyMap<string, Position>,
  models: ReadonlyMap<string, string>,
  conclusion: Conclusion,
  directive: CouncilDirective,
): string {
  const seats = [...positions].map(([seat, p]) =>
    [`Member ${seat} (${models.get(seat) ?? "unknown"}, confidence ${p.confidence}): ${p.recommendation}`, ...p.reasons.map((r) => `  - because: ${r}`), ...p.risks.map((r) => `  - risk: ${r}`)].join("\n"),
  );
  const agreement =
    conclusion.consensus === "unanimous" ? "The members agree." : conclusion.consensus === "majority" ? "Most members agree; dissent: " : "The members are split; apart from the leading position: ";
  const dissent = conclusion.dissent.length ? conclusion.dissent.map((d) => d.seat).join(", ") + "." : "";
  return [
    "<council>",
    COUNCIL_MODERATOR_BRIEF,
    `${agreement}${dissent} (Positions are matched by wording: say so if two differ only in words.) ${afterwards(directive)}`,
    quoted("positions", clip(seats.join("\n\n"), 40_000)),
    "</council>",
  ].join("\n");
}

function unmet(why: string, positions: ReadonlyMap<string, Position>, directive: CouncilDirective): string {
  const heard = [...positions].map(([seat, p]) => `Member ${seat}: ${p.recommendation}`).join("\n");
  return [
    "<council>",
    `The person asked for a council of agents on this message, but it could not meet (${why}). Tell them so, and answer the question yourself. ${afterwards(directive)}`,
    ...(heard ? [quoted("positions", clip(heard, 8_000))] : []),
    "</council>",
  ].join("\n");
}
