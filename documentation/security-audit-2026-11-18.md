# Application audit and remediation plan

Audit date: 2026-11-18. Scope: the current working tree, including existing uncommitted and untracked changes. Application fixes have not been applied.

The application has verified security defects and failing checks. It cannot currently be described as error-free or vulnerability-free. Prioritize public secret disclosure, internal-network access through URL fetching, session revocation, and affected runtime dependencies.

## Validation and limits

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed across the workspace |
| `pnpm exec vitest run`, outside the restricted sandbox | 235 test files passed, 6 failed; 3,184 tests passed, 22 failed, 2 skipped |
| `pnpm audit --prod --json` | Exit 1; 102 advisory records; metadata reports 121 vulnerability occurrences: 3 critical, 44 high, 56 moderate, 18 low |
| Harmless local security reproductions | Public `.env` filter bypass, loopback URL-fetch bypass, and ticket redemption after session revocation reproduced |

The initial sandboxed test run produced subprocess/socket permission errors and is excluded from the assessment. The unrestricted run is the evidence used here. Local Node was v25.9.0; CI and the production image target Node 22, so repeat the release checks on that version.

This was a source review, dependency scan, automated test run, and selected local reproduction exercise. It was not a deployed penetration test. Production reverse-proxy configuration, running database permissions, OS/container package advisories, browser end-to-end behavior, production builds, and backup restoration were not verified. Passing checks cannot prove the absence of all vulnerabilities.

Evidence is saved under [audit-evidence/2026-11-18](audit-evidence/2026-11-18/). Registry findings describe affected dependencies; they do not establish 121 exploitable application paths. Some production-declared packages contain development tooling.

## Findings

### F1 — High: unauthenticated public file reads bypass the secret filter

Locations: `apps/server/src/public-routes.ts`, public `/file` handler; `apps/server/src/files.ts:344`, `isSecretPath()`; `WorkspaceFiles.resolve()`.

The public route tests the original path's last segment before the file layer normalizes it. `.env/.` passes `isSecretPath()` because its final segment is `.`, then resolves to `.env`. For an enabled public project, a visitor who knows the share slug can retrieve a file explicitly intended to be private.

Verified with Fastify injection and a temporary project containing only a dummy `.env`:

```text
GET /api/public/audit-abcdef/file?path=.env      -> 404
GET /api/public/audit-abcdef/file?path=.env%2F. -> 200, AUDIT_DUMMY_SECRET=example
```

Fix plan: normalize paths once before both authorization and filesystem access; reject invalid paths; apply the secret policy to the normalized path. Audit other consumers, including static preview reads. Extend the policy to prevent access through an innocuously named symlink to a secret inside the project: the current symlink confinement only checks whether the target stays inside the workspace. Consider an explicit set of files eligible for public sharing rather than relying entirely on filename exclusions.

Acceptance: route tests deny `.env`, `.env/.`, equivalent paths using `..` and backslashes, nested secrets, and symlink aliases. Ordinary public source files still work. If real projects were publicly shared, review access logs and rotate potentially exposed credentials after containment; this audit did not establish that exploitation occurred.

### F2 — High: URL fetching can reach private addresses

Locations: `packages/agent/src/tools/web.ts:187`, `isBlocked()` and `isBlockedV6()`; `apps/server/src/link-fetch.ts`; native `web_fetch` around line 90.

IPv4-mapped IPv6 filtering handles dotted addresses but misses their hexadecimal form. Node's URL parser converts `http://[::ffff:127.0.0.1]/` to hostname `::ffff:7f00:1`, which the filter permits. The link attachment endpoint uses this shared filter. A local HTTP server bound to `127.0.0.1` was successfully read through `fetchLink()` using the mapped address. The mapped form of `169.254.169.254` also passes the predicate, although no metadata service was contacted.

Separately, native `web_fetch` resolves a hostname during validation and then calls ordinary `fetch()`, which resolves it again. DNS rebinding between those operations can bypass the check. This second issue is established by the code path; no external rebinding attack was run. The new link fetcher's guarded connection lookup already addresses that race, but shares the broken IP classifier.

Fix plan: use a well-tested IP parser/CIDR policy that normalizes all mapped IPv6 forms, and share a single transport that validates the actual address used to connect. Revalidate every redirect, retain byte/time limits, and enforce an egress policy blocking internal services as a second layer. Follow the [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Acceptance: both native web fetching and link attachments reject mapped loopback, mapped private/metadata addresses, mixed DNS answers, redirects to internal addresses, and a controlled DNS-rebinding fixture. Public HTTPS fetches continue to work.

### F3 — High: revoking sessions leaves alternative authenticated channels alive

Locations: `apps/server/src/auth.ts`, `revokeSession()`, `redeemTicket()`, `changePassword()`; `apps/server/src/index.ts:1429`, password route; `apps/server/src/ws.ts:175`, upgrade and connection lifetime.

`revokeSession()` deletes the database row and cache entry, but leaves outstanding WebSocket tickets intact. Redemption returns the captured principal without checking the backing session. A ticket for the same hashed session ID was still redeemable after revocation in a local service-level reproduction using a mock database.

Password changes delete other sessions but the password route never closes their existing sockets. The gateway retains its principal for the connection lifetime and does not recheck session validity. Already-open connections can therefore continue operating after the password change, and naturally expired sessions can retain live sockets. Logout closes current sockets for its session, but an outstanding ticket can establish another one during its remaining five-minute lifetime.

Fix plan: centralize revocation so it removes outstanding tickets, invalidates session cache entries, and closes all associated sockets. Password changes should return revoked session IDs or emit a revocation signal while preserving the current session. Recheck the backing session when consuming a ticket, and enforce expiry during the socket lifetime. Make password updates and durable session deletion transactional. See [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Acceptance: tests cover logout with a pre-issued ticket, password changes with two connected devices, session expiry during a connection, and the permitted current session. Revoked channels must stop commands, terminal input, and event delivery.

### F4 — Medium: preview access survives membership removal and logout

Locations: `apps/server/src/preview.ts:206`, cookie validation; `apps/server/src/index.ts:891`, preview gateway construction.

Preview cookies last 12 hours and include a user claim when minted, but verification checks only project, port, signature, and expiration. It neither uses the user claim nor consults current membership or the login session. A removed member holding a preview cookie can continue accessing the preview until expiry while the project keeps the same port. Logout and password changes do not invalidate it. This finding is based on source inspection, not a deployed multi-account test.

Fix plan: bind grants to a live session or revocable grant record and check membership during HTTP and WebSocket authorization. Invalidate cached authorization and close existing preview sockets when access changes. Maintain a short, bounded cache if necessary.

Acceptance: removing a member or revoking their login denies subsequent preview requests and upgrades, and terminates their existing preview sockets. Remaining members retain access.

### F5 — High when accounts or repositories are not fully trusted: processes share the API's execution identity

Locations: `apps/server/src/terminals.ts`; `packages/agent/src/executors/host.ts`; `deploy/s6/scripts/init-dirs`; `docker-compose.yml`; `Dockerfile`.

Terminals, project servers, and agent commands run as the same OS user as the API and share the workspace/credential filesystem. Production Compose enables host shell execution and defaults Codex to full access. A working directory and environment filtering do not prevent arbitrary commands from accessing other paths available to that user. A malicious project script or a compromised agent process can therefore cross project/account filesystem boundaries and potentially inspect same-user process state. The README acknowledges a trusted-user operating model; this is a documented architectural limitation with security consequences, not evidence of a Docker-host escape.

Fix plan: keep admission restricted to trusted operators while implementing per-project execution containers or equivalent OS isolation. Run the API outside those workers; mount only the required project tree; broker narrowly scoped credentials; separate internal database and control-plane network access; set process/memory limits. Apply the same boundary to terminals, CLI agents, dev servers, git hooks, and document conversion.

Acceptance: a command in project A cannot read or modify project B, API credentials, other users' CLI credentials, or the API's process state, and cannot contact control-plane services. Validate this with two separate accounts and malicious repository fixtures before admitting untrusted users.

### F6 — Urgent dependency remediation: affected runtime packages are locked

The production dependency scan reports the following notable packages. Treat the full saved JSON as the inventory and distinguish reachable runtime code from tooling before assigning exploitability.

| Package | Locked version | Required action |
| --- | --- | --- |
| Next.js | 15.5.25 | Upgrade to at least 15.5.28 on the current release line, or a supported newer patched release |
| sharp, reached through Next.js | 0.35.4 | Resolve at least 0.35.5 and verify the rebuilt image |
| DOMPurify, reached through Mermaid | 3.4.15 | Resolve at least 3.4.17; review advisory-specific options and Mermaid integration |
| Drizzle ORM | 0.38.4 | Upgrade to at least 0.45.2; validate query behavior and migration tooling compatibility |
| undici, direct web dependency | 7.24.4 | Upgrade to a compatible release resolving all saved advisories, including transitive copies |
| proxy-addr, through shadcn's Express/MCP dependencies | 2.0.7 | Resolve at least 2.0.8, or remove unnecessary production tooling dependencies |

The [Next.js advisory](https://github.com/advisories/GHSA-2464-fhr4-w9xw) describes possible unauthenticated code execution through image optimization on glibc Linux and gives the patched Next.js/sharp versions above. The repository uses a Debian-based production image and locks an affected sharp version, making this an urgent release check. An image-optimization exploit was not attempted; deployed reachability and exact native libraries remain to be verified.

The [Drizzle advisory](https://github.com/advisories/GHSA-gpj5-g38j-94v9) requires untrusted input to reach identifier or alias construction. The inspected `project-stats.ts` identifier is internally supplied; this audit did not prove an application SQL injection through Drizzle. Similarly, DOMPurify and proxy-addr advisory severities do not prove the necessary vulnerable configuration is exercised here. Proxy-addr is under development tooling declared as a production dependency, rather than the Fastify trust-proxy implementation.

Fix plan: upgrade direct dependencies in small compatible groups, regenerate the lockfile, move CLI-only packages such as shadcn out of production dependencies where appropriate, and upgrade or replace parents of vulnerable transitive dependencies. Avoid indiscriminate major-version overrides. Review unresolved advisories individually; the current scan includes a picomatch advisory with no patched version advertised. Add recurring registry scanning and deployed-image scanning to CI, with documented reachability-based exceptions.

Acceptance: clean frozen install, passing types/tests/production build, smoke tests for images and Mermaid, and a fresh audit with no unreviewed reachable high/critical findings. Verify resolved versions inside the final image, not just package manifests.

### F7 — Medium, deployment-dependent: forwarded client IP is trusted from every peer

Location: `apps/server/src/index.ts:947`, `trustProxy: true`; login rate limit around line 4903; Compose exposes port 3000.

Fastify accepts forwarded client addresses without restricting the upstream peer. If callers can reach the API directly, or the edge preserves an attacker-controlled forwarding chain, changing `X-Forwarded-For` can change the address used for per-IP rate limits. This weakens password-guessing and public-route throttling. Production edge behavior was not tested.

Fix plan: configure trusted proxy addresses/hops explicitly, ensure the edge overwrites forwarding headers, and restrict direct backend access in proxied deployments. With no proxy, disable proxy trust. Add account-based login throttling alongside IP limits.

Acceptance: repeated login attempts with changing spoofed forwarding headers from an untrusted peer still hit the same limit; legitimate proxy traffic records the correct client address.

### F8 — Medium: the current test suite is failing

The unrestricted run has six failing files. These are reproducible check failures, not all proven user-visible defects; several assertions appear inconsistent with intentional current behavior and require a product/contract decision.

| Test file | Failures | Observed discrepancy and fix plan |
| --- | --- | --- |
| `apps/server/src/agent.test.ts` | 3 | OMP context events report `thresholdTokens: 110000` instead of expected `null`. Confirm the intended 55% compaction threshold and align event contract/tests. |
| `apps/server/src/omp-overlay.test.ts` | 13 | Twelve snapshots omit `thresholdPercent: 55`; one assertion expects no threshold metadata. Review the threshold change, then deliberately update tests/snapshots or restore the intended configuration. |
| `apps/web/src/app/navigation.test.ts` | 1 | Session sidebar calls `router.refresh()` outside the permitted navigation pattern. Use targeted query invalidation or document and test why a shell refresh is required. |
| `apps/web/src/lib/quotas.test.ts` | 1 | `quotaTone(74)` returns `full`, while the test expects `normal`. Quota display shares context-meter thresholds; define quota-specific thresholds if subscription usage needs different semantics. |
| `apps/web/src/lib/slash-commands.test.ts` | 1 | Expected command matching includes `handoff`; the current list does not. Align the exposed command set and tests with supported provider behavior. |
| `apps/web/src/lib/ui-color-lint.test.ts` | 3 | Palette/hex/opacity violations in dialogs and the Claude icon. Use semantic tokens and accessible disabled states; explicitly allow intentional brand artwork where appropriate. |

Acceptance: all six files and the complete suite pass on Node 22; snapshot updates receive a semantic review. Do not weaken security assertions or bulk-update snapshots solely to obtain a green run.

## Implementation order

1. **Contain disclosure and internal-network access:** implement F1 and F2 with regression tests. Disable public source-file sharing and link fetching at the deployment edge if an immediate patch cannot be shipped. Inventory potentially exposed secrets only for affected projects.
2. **Patch urgent runtime dependencies:** address F6, beginning with Next.js/sharp, rebuild the image, and verify the resolved artifact. Do this alongside the first fixes rather than waiting for the larger isolation work.
3. **Make revocation complete:** implement F3 and F4 together across HTTP, WebSocket, collaboration ticket consumption, and previews. Add two-device/two-account integration coverage.
4. **Restore reliable release checks:** resolve F8, constrain proxy trust under F7, run types, the full suite, production build, and browser/container smoke tests on Node 22.
5. **Deliver execution isolation:** implement F5 before expanding beyond mutually trusted operators and repositories. Add repeatable cross-project isolation tests and OS-image/dependency scanning.

Each implementation should be a separate reviewable change with its tests. The release gate is passing checks, successful targeted security regressions, reviewed dependency exposure, and validation of the actual deployed routing/isolation configuration. These are completion criteria, not a claim that future vulnerabilities cannot exist.
