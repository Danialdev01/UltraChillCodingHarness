# RAM, performance, and multi-VPS solutions

Status: design; application changes and benchmarks are pending. Reviewed 2026-11-09.

## 1. Findings and evidence

The production Dockerfile and docker-compose.yml run API, Next.js, PostgreSQL, optional MariaDB, terminals, agents, and project tools together. Disk-heavy installed tools do not consume their full installed size in RAM; running Chromium, converters, compilers, and project servers does.

The current config permits five CLI turns, six OMP turns, and 32 native turns through separate limits. These are count limits, not one shared memory budget. Nested subagents and OMP memory bridges also need accounting. Do not multiply historical per-process estimates into a capacity guarantee.

Existing controls include turn scheduling, terminal caps and idle expiry, history-cache eviction, stream coalescing, document-job concurrency, child priorities, metrics, resource sampling, and a watchdog. Extend these rather than introducing duplicate schedulers. Relevant implementation is under apps/server/src (config, turn-scheduler, bridge-leases, resource-sampler, eventstore, terminals, watchdog), packages/agent, and deploy/s6.

The existing documentation/solutions.md reports historical API RSS falling from 352 MB to 268 MB. This is neither total application memory nor a measurement of the current revision. Referenced raw documentation/perf results are absent. The inspected workspace exposes no running application process; host-wide free-memory output cannot establish the deployed VPS baseline. Existing uncommitted application changes must be preserved and included in benchmark provenance.

## 2. Measurement protocol

### Baseline and comparison status

| Measurement | Current baseline | Optimized | Required evidence |
| --- | --- | --- | --- |
| Container peak and sustained memory | Not measured | Not measured | cgroup samples |
| API heap, external memory, RSS | Not measured | Not measured | metrics and process samples |
| Agent process-tree memory | Not measured | Not measured | process attribution |
| Completed turns/minute and failures | Not measured | Not measured | workload results |
| Queue wait and execution p50/p95/p99 | Not measured | Not measured | scheduler timestamps |
| HTTP, WS, terminal p95/p99 | Not measured | Not measured | client observations |
| Browser memory and responsiveness | Not measured | Not measured | Playwright/browser traces |
| Swap activity, pressure, OOM events | Not measured | Not measured | host/cgroup counters |

Use the production image, isolated load-test database and synthetic users. Never seed production. Reuse scripts/load/README.md, up.sh, run.mjs, profile.sh, summarise.mjs and the Playwright stream test. Inspect scripts before running: setup can replace load containers. The existing seed guard requires LOADTEST_ALLOW_SEED=1 and a database name ending in _load.

For each experiment save optimization/benchmarks/<run-id>/ with metadata.json, raw workload JSON, metrics samples, process samples, browser results where applicable, and summary.md. Do not commit cookies, keys, environment secrets, or private project data. Metadata records commit, dirty-patch hash, image digest, Node/provider versions, CPU/RAM limits, host hardware, swap, database configuration, fixtures, dataset size, concurrency and network RTT.

Warm up five minutes; run three ten-minute repetitions per normal scenario. Run a separate two-hour soak. Keep datasets, generator placement, limits and fixtures identical between baseline and candidate. Run the generator outside the measured CPU/memory budget. Report median and range across repetitions, peak memory, errors, completions and unfinished turns. Distinguish queue time, provider time and execution time. Artificial RSS fixtures test scheduling; they do not prove real provider memory usage. Obtain a separate representative real-provider sample with its workload and cost recorded.

Scenario matrix: cold boot; warmed idle; 1/2/5/10/20/50 users; existing mixed 50-user workload; individual and mixed CLI/OMP/native bursts; nested subagents and memory bridges; development servers plus agents; builds and converters; repeated open/cancel/disconnect/close; two-hour soak; single-node versus two workers; worker failure under load. Stop increasing load on OOM or sustained pressure and record the supported capacity.

Sample cgroup memory.current, memory.peak, memory.stat, memory.events and effective memory.max; host MemAvailable, swap-in/out and pressure stall information; service/process-tree memory and CPU; API heap/external buffers, event-loop delay; database pool wait; queue depth/wait; HTTP and WS latency; terminal echo; UI long tasks and frame-to-paint. Existing resource-sampler estimates private resident pages; use PSS when available and label its absence. Summed process RSS double-counts shared pages and is not container usage. Collect at five-second intervals for normal tests and one second for burst attribution; measure collector overhead.

Comparison formulas: memory improvement = (baseline peak - candidate peak) / baseline peak; throughput improvement = (candidate completed/minute - baseline completed/minute) / baseline completed/minute. Compare equivalent completed work, not a smaller active workload hidden by longer queues. For multi-VPS tests report both primary memory and aggregate node resources.

Proposed gates, not achieved results: zero OOM kills or lost durable events; no growing orphan count; sustained memory below 80% and peaks below 90% of configured capacity; at least 20% lower peak at matched throughput OR 25% higher throughput at equal memory; no unexplained interactive p95 regression over 10%; retained memory plateaus after lifecycle cycles. Report failures honestly and revise supported capacity rather than hiding them.

## 3. Local optimization design

### Shared admission and bounded queues (P1)

Retain account/provider fairness and count limits, adding atomic node-wide memory reservations before process startup. Effective capacity is the lower applicable host/cgroup allowance minus operating-system, API/web/database baseline, safety reserve and outstanding execution reservations. Avoid double-counting measured running memory and reservations: reserve only the estimated growth not represented in the latest sample, with conservative handling of stale samples. Reject new starts when telemetry is stale; active jobs continue under hard limits.

Measure p95 process-tree peaks per workload class and use those estimates for CLI, OMP, native, bridge, document and build reservations. Unknown classes use a conservative configured estimate. Add configurable memory safety reserve, queue capacity and queue timeout; expose queue reasons. Resume admission below a lower pressure threshold to avoid oscillation. Release reservations exactly once on exit, cancellation or failed spawn. Count tenant limits across workers at the primary.

Nested-agent admission must not deadlock: reserve a bounded parent-plus-child envelope or reject/queue child requests with a finite deadline and explicit failure. Never permit an unbounded child fan-out or let every parent hold capacity indefinitely awaiting children. Test concurrent admissions and reservation recovery.

### Process isolation and lifecycle (P1)

Audit every spawn path, including terminals, shell tools, converters, bridge children, project commands and detached servers. Track process trees and resource ownership; graceful cancellation escalates to termination after a configured deadline. Reap descendants on cancellation, project deletion, worker drain and shutdown. Preserve intentionally persistent development servers through explicit managed records and stop controls; terminal inactivity alone must not silently kill hosting.

Use execution containers/cgroups with memory, CPU, PID and wall-time limits. Do not grant project processes the Docker socket; use a narrow privileged launcher if needed. Node heap limits cover only V8 heap, not all native buffers or child processes. OOM scores select victims but do not prevent memory exhaustion. Start with conservative opt-in resource profiles and document their measured capacity. Roll back through the feature flag without removing existing caps.

### Retention, I/O and UI (P2)

Profile before editing: history-cache event count can hide very large events; add measured byte budgets alongside count limits. Inspect replay allocation, WS slow-client buffers, upload buffering, provider probe caches, file-watcher lifetime, collaboration-document eviction, and metrics label cardinality. Use bounded queues, TTL/LRU eviction, paginated reads, streamed files and disk spooling where justified. Preserve event ordering and reconnect replay; disconnect slow clients explicitly instead of retaining unlimited buffers.

Tune PostgreSQL buffers, work_mem and connection pools against concurrent queries and project database use. A query can allocate work_mem multiple times. Avoid arbitrary pool increases; reserve connections for interactive routes and migrations. MariaDB remains off when unused. Profile slow queries and indexes before changing them.

Measure browser transcript retention, rendering, subscriptions and query invalidation with long histories and streaming. Preserve existing stream batching and memoization. Prefer targeted fixes to additional global polling. Verify browser gains separately from VPS memory.

### Heavy work and deployment (P2)

Separate converter/build admission from interactive turns and account for their children. Prefer prebuilt production images so Dokploy does not compile the application beside active agents. Provide optional external database and dedicated build-worker profiles after measurements justify them. Smaller images improve deployment/storage but do not by themselves prove runtime RAM savings.

Each change ships independently with a flag or reversible configuration, a matched benchmark, regression tests for affected behavior, and rollback instructions. Avoid changing heap, database, scheduler and UI settings in one untraceable experiment.

## 4. Multi-VPS backend subsystem

### Ownership and topology

Primary VPS on Dokploy owns authentication, authorization, application PostgreSQL, durable events, scheduling and browser connections. A backend-only worker image excludes Next.js and the application database. Workers own persistent project checkouts, worktrees, provider sessions, terminals, project servers and local runtime tools. Project databases used by hosted projects stay with the project where required; they are distinct from the primary application database.

First release places an entire project on one node. All sessions and subagents use that node. The primary proxies file, Git, runtime, upload, terminal, preview and watcher operations over the worker connection; audit all current local filesystem assumptions before release. Keep the existing local execution path behind the same interface. Never horizontally replicate the all-in-one image against one PostgreSQL data directory.

### Installation workflow

Administrator opens Infrastructure, creates a worker name and short-lived single-use enrollment token, then copies a version-pinned Dokploy/Compose deployment template. Template specifies primary HTTPS URL, enrollment token, persistent worker volume, CPU/RAM/PID limits and restart policy. Worker enrolls using outbound TLS, exchanges the token for a revocable worker identity, and deletes the bootstrap token. Do not store SSH credentials in the application.

Primary checks protocol compatibility, clock skew, writable storage, tool versions, capabilities and capacity before enabling scheduling. Administrator grants workspace access. Project creation offers Automatic or an authorized specific VPS. Infrastructure shows last heartbeat, memory headroom, reservations, disk, queue, assigned projects, version, errors and draining/offline status. Only infrastructure administrators enroll or revoke nodes; project placement also requires workspace permissions.

### Interfaces and persistent records

Add versioned execution APIs rather than exposing arbitrary unauthenticated shell endpoints. Minimum records: execution_nodes; workspace_node_grants; project_placements with generation; execution_jobs with idempotency key and state; resource_reservations; execution_leases with fencing token and expiry. Store durable dispatch/outbox state transactionally with job creation. Do not persist raw credentials in these records.

Execution interface covers start/cancel/status, event acknowledgments, file and Git operations, terminals, watchers, runtimes, previews and artifacts. Worker messages carry protocol version, node/project/job IDs, placement generation, fencing token and sequence number where relevant. Primary validates user authorization before forwarding and worker validates scoped grants. Version mismatch makes the node unschedulable; no silent incompatible dispatch.

### Placement and resource scheduling

Filter nodes by workspace authorization, health, protocol/tool compatibility, capabilities, disk, CPU and memory reservations. Rank eligible nodes by reserved-memory/capacity ratio, queue depth, then stable node ID. Acquire reservation and placement transactionally so concurrent schedulers cannot oversubscribe. Automatic chooses only on initial placement or explicit reassignment; do not shuffle running projects. Specific-node jobs wait visibly for that node rather than silently moving elsewhere. Bound queue size and wait time.

Heartbeat every five seconds; mark unavailable after 20 seconds; execution lease lasts 30 seconds. Worker must stop execution before an unrenewed lease expires, using a local monotonic deadline and conservative skew allowance. Fence all primary-accepted events and operations by current placement generation. Lease expiry alone cannot prove an unreachable machine is physically stopped: never activate a replacement owner until shutdown is confirmed or the old node is externally fenced.

### Delivery, disconnect and recovery

Use at-least-once dispatch with idempotent job creation/start handling and sequence-numbered events. Acknowledgments follow durable primary persistence. Spool unacknowledged events locally with byte/disk limits; pause or fail cleanly before exceeding the limit. Deduplicate replay at the primary. Never promise exactly-once external side effects.

On connection loss stop new dispatch, display disconnected state and obey lease expiry. Reconcile job identity and last accepted event on reconnect. Mark ambiguous external execution as requiring reconciliation rather than blindly retrying. Drain blocks new placement and starts; allow active work to finish or explicitly cancel. Revocation closes connections and disallows renewal. Rotate worker credentials without enrolling duplicate identities.

### Project transfer and hosting

Reassignment is explicit maintenance: block new writes, stop agents/terminals/servers, confirm exclusive ownership, snapshot repository plus dirty/untracked files, worktrees, attachments and provider session state, transfer over authenticated streaming transport, verify manifests/checksums and permissions, then atomically switch placement generation. Include required project database backups and secrets via scoped encrypted delivery. Exclude reproducible dependency caches only when restoration is tested. If a provider session cannot resume elsewhere, disclose and block transfer until the user chooses a fresh session.

Keep the old snapshot until destination health and restart checks pass. Failure before ownership switch leaves the original authoritative; failure after switch requires fenced reverse transfer, never concurrent writes. Disk preflight includes staging and rollback copies.

Route previews through the primary using authorized project/port mappings; tunnel HTTP and WebSocket upgrades with backpressure and disconnect limits. Do not expose arbitrary worker ports publicly. Retain existing preview authentication and origin checks. Local project paths never become browser-accessible URLs.

### Security, rollout and future capabilities

Deliver only project/turn-scoped secrets to workers, redact logs, encrypt transport and stored credentials, rotate/revoke identities, and audit infrastructure changes. Workers are trusted execution hosts for their granted projects; a compromised worker can access secrets delivered to it. Do not copy the primary credential vault or database credentials to every worker.

Rollout: local interface parity; one opt-in worker with disposable projects; remote operations completeness; failure drills; limited workspace rollout; broader enablement after benchmarks. Back up primary database and worker volumes independently and test coordinated restore. Rollback disables new remote placements, drains workers and explicitly transfers projects back; never switch remote files to stale local paths.

Reserve capability identifiers agent, hosting, build and emulator. V1 implements agent and hosting together. Future build jobs use source snapshots and artifact storage; emulator workers require separate hardware/virtualization checks and streaming/session limits. Separate agent and hosting machines and live filesystem synchronization are deferred.

## 5. Implementation progress: shared admission

Implemented opt-in shared estimate reservations in TurnScheduler, with config and Compose passthrough. Existing count limits still apply. AGENT_MEMORY_BUDGET_MB enables the budget; AGENT_CLI_MEMORY_MB and AGENT_OMP_MEMORY_MB default to 512; AGENT_NATIVE_MEMORY_MB defaults to 128. These estimates require calibration. Budget excludes API, web, databases, document jobs and unmanaged project processes; this is not a hard memory cap or live-pressure controller. Choose the budget only after subtracting those workloads and safety reserve from effective memory capacity.

With a budget enabled, queue defaults are 256 waiting requests and a five-minute wait timeout. AGENT_MAX_WAITING and AGENT_WAIT_TIMEOUT_MS override these, and can also be used independently. Impossible estimates reject immediately. Reservations cover running turns until their release callback and cannot be released twice. Bridge calls use the same budget and retain their shorter lease deadline. Nested work can still exhaust the budget; finite waits prevent indefinite waiting but envelope reservations remain future work. Queue positions remain per provider kind, not a prediction of memory wait duration.

Rollback: unset AGENT_MEMORY_BUDGET_MB and independent queue overrides, then redeploy; running state is not migrated. No database migration is needed. Existing applications retain count-only behavior by default.

Verification: 16 scheduler tests, 20 config tests, eight bridge tests passed; server TypeScript check passed. Bridge tests needed permission to open temporary Unix sockets outside the sandbox.

Run `pnpm exec tsx optimization/benchmark-scheduler.ts` to reproduce the synthetic admission experiment. One local Node v25.9.0 run completed 60 jobs in each case: count-only scheduling admitted a peak estimated 8192 MB in 92 ms; a 2048 MB budget admitted 2048 MB in 248 ms. These are estimated simultaneous working sets and artificial 20 ms jobs, NOT measured agent RSS, throughput or production latency. The longer completion time demonstrates the queueing tradeoff. Actual VPS baseline and candidate RAM remain unmeasured.

Outstanding milestones include live-pressure sampling and hysteresis, hard execution limits, process lifecycle auditing, full workload benchmarks, local execution adapter, backend worker image, enrollment, durable placement/leases, remote operations, hosting routing and failure recovery. No multi-VPS feature is available yet.
