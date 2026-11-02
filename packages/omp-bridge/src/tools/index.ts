import { ompCodemod, ompRename, ompSymbols } from "./code.js";
import { ompDebug } from "./debug.js";
import { ompHandoffBrief } from "./handoff.js";
import { ompRecall, ompRetain } from "./memory.js";
import { ompReview } from "./review.js";
import { ompTask } from "./task.js";
import type { BridgeTool } from "./tool.js";

/** Every OMP tool the bridge offers (solution §10.2), in the table's order. */
export const BRIDGE_TOOLS: readonly BridgeTool<any>[] = [
  ompTask,
  ompReview,
  ompSymbols,
  ompRename,
  ompCodemod,
  ompDebug,
  ompRecall,
  ompRetain,
  ompHandoffBrief,
];
