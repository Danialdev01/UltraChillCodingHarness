# Optimization implementation checklist

Status: documentation completed; first opt-in shared-estimate admission layer implemented. Full runtime optimization, VPS measurements and remote workers remain pending.

Detailed design: [solutions.md](solutions.md). This checklist does not authorize production load tests, deployments, or external infrastructure changes.

## Delivery completed

- [x] Create optimization/todo.md and optimization/solutions.md.
- [x] Define reproducible measurement protocol and honest result status.
- [x] Specify whole-project multi-VPS placement and future build/emulator direction.

## Working rules

Preserve pre-existing uncommitted changes. Benchmark the actual working tree with its patch hash. Use isolated synthetic data; keep secrets out of artifacts. Implement milestones independently and update this checklist with evidence links, actual results and rollback notes. Assign an implementation owner when work starts.

## 0. Documentation and evidence

Dependencies: None. Design: [solutions §1](solutions.md#1-findings-and-evidence).

- [ ] Record architecture, controls and measurement gaps. **Done when:** Cross-check Dockerfile, config, scheduler and load harness; distinguish historical numbers from current measurements.
- [ ] Maintain baseline/results table. **Done when:** Use Not measured until raw run artifacts exist; never claim a runtime improvement from documentation.

## 1. Capture baseline

Dependencies: Milestone 0. Design: [solutions §2](solutions.md#2-measurement-protocol).

- [ ] Prepare isolated production-image load target. **Done when:** Verify synthetic database guard, resource limits, fixtures and generator separation.
- [ ] Capture provenance and telemetry. **Done when:** Save revision/patch hash, image digest and sanitized settings; reconcile cgroup totals with process attribution.
- [ ] Run workload matrix and soak. **Done when:** Three measured repetitions after warmup; document failures, supported capacity and two-hour retention behavior.

## 2. Local RAM improvements

Dependencies: Milestone 1. Design: [solutions §3](solutions.md#3-local-optimization-design).

- [ ] Implement shared memory admission. **Done when:** Test atomic reservations, mixed providers, stale telemetry, hysteresis, bounded queues and per-account fairness.
- [ ] Bound nested execution. **Done when:** Test parent/child capacity exhaustion, bridge fan-out, finite deadlines and cancellation without deadlock.
- [ ] Manage execution process trees. **Done when:** Test failed spawn, cancel, terminal disconnect, project deletion and shutdown; confirm no orphan growth.
- [ ] Add hard execution limits. **Done when:** Verify memory/CPU/PID limits and timeouts without privileged project access to the container runtime.
- [ ] Profile retained allocations and I/O. **Done when:** Fix measured cache, replay, upload, watcher and WS buffering issues; verify bounded memory and event ordering.
- [ ] Tune database and UI only where justified. **Done when:** Check pool contention, slow queries, browser long histories and subscription counts.
- [ ] Benchmark every substantive change. **Done when:** Meet documented gates or report the regression; retain rollback configuration and raw evidence.

## 3. Local execution interface

Dependencies: Milestone 2. Design: [solutions §4](solutions.md#4-multi-vps-backend-subsystem).

- [ ] Inventory project-local operations. **Done when:** Cover agents, files, Git, worktrees, terminal, watcher, runtime, upload, preview and project databases.
- [ ] Introduce local execution adapter. **Done when:** Existing single-node behavior passes parity and authorization tests before adding remote execution.

## 4. Worker installation and scheduling

Dependencies: Milestone 3. Design: [solutions §4](solutions.md#4-multi-vps-backend-subsystem).

- [ ] Add worker image and deployment templates. **Done when:** Backend only; persistent storage and resource limits; pinned image usable through Dokploy or Compose.
- [ ] Implement enrollment and scoped identity. **Done when:** Test single-use token expiry, revocation, rotation, version mismatch and workspace grants.
- [ ] Add durable jobs, reservations and fenced leases. **Done when:** Test duplicate dispatch, atomic capacity allocation, event deduplication, expiry and stale ownership rejection.
- [ ] Add infrastructure and placement UI. **Done when:** Show health/capacity/queue; Automatic and explicit VPS selection; verify cross-tenant isolation.

## 5. Complete remote project execution

Dependencies: Milestone 4. Design: [solutions §4](solutions.md#4-multi-vps-backend-subsystem).

- [ ] Proxy all project operations. **Done when:** Verify terminals reconnect, Git/watchers, runtime management, uploads and file edits on remote storage.
- [ ] Route hosted previews. **Done when:** Test HTTP, WS upgrades, authorization, port restrictions, slow clients and worker outages.
- [ ] Implement draining and project transfer. **Done when:** Preserve dirty files, worktrees, provider state and project databases; verify checksums, exclusive ownership and rollback.
- [ ] Deliver scoped secrets and redact logs. **Done when:** Verify the primary vault and application database credentials never reach workers unnecessarily.

## 6. Failure drills and distributed comparison

Dependencies: Milestone 5. Design: [solutions §2](solutions.md#2-measurement-protocol).

- [ ] Exercise worker failure and recovery. **Done when:** Test partitions, process crashes, primary restart, spool limits, lease loss and ambiguous side effects; no blind retry.
- [ ] Benchmark one primary and multiple workers. **Done when:** Match workload; report primary and aggregate memory, RTT, throughput and queue wait.
- [ ] Validate restore and staged rollout. **Done when:** Restore database/worker volumes; opt-in canary, drain and explicit transfer-back rollback before wider release.

## 7. Future builds and emulators

Dependencies: Milestone 6. Design: [solutions §4](solutions.md#4-multi-vps-backend-subsystem).

- [ ] Design snapshot-based build execution. **Done when:** Separate resource profiles, immutable input and verified artifact return; benchmark build interference.
- [ ] Design emulator capability. **Done when:** Require hardware/virtualization checks, lifecycle limits and remote interaction routing before enablement.

## Release evidence

- [ ] Attach baseline/candidate run identifiers and a comparison of memory, throughput, latency and errors.
- [ ] Separate achieved results from targets and mocked runs from real-provider samples.
- [ ] Record supported capacity, remaining bottlenecks and known compatibility limitations.
- [ ] Confirm zero lost durable events, no orphan growth and no OOM at declared capacity.
- [ ] Publish operator instructions for limits, alerts, worker enrollment, drain, backup, restore and rollback.

## Implemented increment

- [x] Add shared per-kind estimate budget across CLI, OMP and native turns.
- [x] Add opt-in queue capacity and finite wait timeout; Compose configuration passthrough.
- [x] Test mixed-provider reservations, duplicate release, impossible requests, queue cancellation and expiry.
- [x] Pass server typecheck and 44 focused tests (scheduler/config/bridge).
- [x] Supply synthetic scheduler benchmark; record its limited interpretation in solutions §5.
- [ ] Complete the broader admission-control milestone: live pressure, nested envelopes, telemetry and calibrated estimates.
