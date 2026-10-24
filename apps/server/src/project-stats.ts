import { sql, type SQL } from "drizzle-orm";
import type { Transaction } from "@ucch/db";
import { LIMIT_STOP_REASONS } from "@ucch/protocol";

/**
 * The `project_stats` projection's two pieces of SQL that are not plain
 * counters: whether a turn failed, and the whole row computed from scratch.
 *
 * Kept with the projection's own statements (`applyProjection` in
 * engine.ts) in mind: those update the row relatively as turns start and
 * end; this recomputes it when that cannot work, because rows went away.
 */

/**
 * Whether the `turns` row named `turn` (an alias in the surrounding query)
 * failed: an error, or a stop reason that means it was cut short -- the
 * same rule as `stoppedShort` in the protocol, which the sidebar's red dot
 * has always used. Migration 0025's backfill spells out the same list.
 */
export function turnFailed(turn: string): SQL {
  const alias = sql.identifier(turn);
  const limits = sql.join(
    [...LIMIT_STOP_REASONS].map((reason) => sql`${reason}`),
    sql`, `,
  );
  return sql`(${alias}.error is not null or ${alias}.stop_reason in (${limits}) or ${alias}.stop_reason like 'error%')`;
}

/**
 * One project's row, summed again from its threads and turns: after a
 * thread is deleted, whose turns -- and their spend -- go with it. The same
 * query as the migration's backfill, for one project.
 */
export async function recomputeProjectStats(tx: Transaction, projectId: string): Promise<void> {
  await tx.execute(sql`
    insert into project_stats (project_id, thread_count, tokens, cost_usd, last_turn_id, last_turn_failed, updated_at)
    select
      p.id,
      (select count(*)::int from threads th where th.project_id = p.id),
      (
        select coalesce(sum(
          (tu.usage ->> 'inputTokens')::double precision
          + (tu.usage ->> 'outputTokens')::double precision
          + (tu.usage ->> 'cacheReadInputTokens')::double precision
          + (tu.usage ->> 'cacheCreationInputTokens')::double precision
        ), 0)
        from turns tu join threads th on th.id = tu.thread_id
        where th.project_id = p.id
      ),
      (
        select coalesce(sum(tu.cost_usd)::double precision, 0)
        from turns tu join threads th on th.id = tu.thread_id
        where th.project_id = p.id
      ),
      last.id,
      coalesce(${turnFailed("last")}, false),
      now()
    from projects p
    left join lateral (
      select tu.id, tu.error, tu.stop_reason
      from turns tu join threads th on th.id = tu.thread_id
      where th.project_id = p.id
      order by tu.created_at desc
      limit 1
    ) last on true
    where p.id = ${projectId}
    on conflict (project_id) do update set
      thread_count = excluded.thread_count,
      tokens = excluded.tokens,
      cost_usd = excluded.cost_usd,
      last_turn_id = excluded.last_turn_id,
      last_turn_failed = excluded.last_turn_failed,
      updated_at = excluded.updated_at
  `);
}
