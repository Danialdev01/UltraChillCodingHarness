import { z } from "zod";

/**
 * The task pipeline's verdict when OMP verifies (solution §6.4, §9.4,
 * OM7.9): the JSON block the `task` worker ends its answer with. Parsed
 * loosely -- a finding without a line, or with a `path` for its file, is
 * still a finding -- and strictly where it matters: `passed` is a boolean.
 */
export const VerifierFinding = z.object({
  file: z.string().trim().min(1).max(1_000),
  line: z.number().int().nonnegative().nullable().catch(null).default(null),
  note: z.string().trim().min(1).max(4_000),
});
export type VerifierFinding = z.infer<typeof VerifierFinding>;

export const VerifierVerdict = z.object({
  passed: z.boolean(),
  reason: z.string().trim().max(4_000).catch("").default(""),
  findings: z.array(z.unknown()).max(200).catch([]).default([]),
});
