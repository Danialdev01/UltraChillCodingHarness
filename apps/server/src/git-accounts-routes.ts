import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { GIT_PROVIDERS, GIT_PROVIDER_LABELS, type GitAccount, type GitProvider } from "@ucch/protocol";
import { BaseUrlError, normalizeBaseUrl } from "./git-base-url.js";
import type { GitAuthSource } from "./git-auth.js";
import {
  DEFAULT_BASE_URL,
  DuplicateAccountName,
  GITHUB_URL,
  checkTokenFormat,
  type GitAccountMeta,
  type GitAccountStore,
  type TokenCheck,
} from "./git-accounts.js";
import { GIT_HOSTS, GitHostError, type FetchLike, type GitRepo } from "./git-hosts/index.js";

/**
 * Connected git accounts (Settings -> Providers -> Git Provider), and what the
 * new-project dialog asks of them.
 *
 *   GET    /api/account/git-accounts          metadata only, never a token
 *   POST   /api/account/git-accounts          { provider, name, baseUrl?, token }
 *   PATCH  /api/account/git-accounts/:id      { name? } or { token? }
 *   DELETE /api/account/git-accounts/:id
 *   PUT    /api/settings/github               older, kept for scripts
 *
 *   GET    /api/git/accounts                  which are reachable, and as whom
 *   GET    /api/git/repos                     every account's, in one list
 *   GET    /api/git/accounts/:id/owners
 *   GET    /api/git/accounts/:id/branches?repo=
 *   POST   /api/git/accounts/:id/repos
 *
 * Every id is looked up among the caller's own accounts. A server's address
 * cannot be changed once saved: the token was given for that one.
 */

export interface GitAccountAuditEntry {
  userId: string;
  action: "git_account.created" | "git_account.renamed" | "git_account.token_replaced" | "git_account.removed";
  accountId: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface GitAccountRouteDeps {
  principal(request: FastifyRequest): Promise<{ userId: string } | null>;
  accounts: GitAccountStore;
  encryptionAvailable: boolean;
  check(provider: GitProvider, baseUrl: string, token: string): Promise<TokenCheck>;
  /** The caller's accounts as credentials, the GitHub sign-in's last when it stands in for one. */
  sources(userId: string): Promise<(GitAuthSource & { name: string })[]>;
  learnLogin(id: string, login: string): void;
  fetch: FetchLike;
  audit(entry: GitAccountAuditEntry): Promise<void>;
  changed(userId: string): void;
  onError(error: unknown): void;
}

export const MAX_NAME_LENGTH = 40;
export const MAX_GIT_ACCOUNTS = 20;

const Name = z
  .string()
  .trim()
  .min(1, "Give the account a name.")
  .max(MAX_NAME_LENGTH, `Keep the name to ${MAX_NAME_LENGTH} characters.`);
const Token = z.string().trim().min(1, "Paste a token.").max(1000, "That token is too long.");
const CreateBody = z.object({
  provider: z.enum(GIT_PROVIDERS),
  name: Name,
  baseUrl: z.string().trim().max(300).optional(),
  token: Token,
});
const PatchBody = z
  .object({ name: Name.optional(), token: Token.optional() })
  .refine((b) => (b.name === undefined) !== (b.token === undefined), "Send a name or a token.");
const LegacyBody = z.object({ apiKey: z.string().trim().min(1).max(400).nullable() });
const CreateRepoBody = z.object({
  owner: z.string().trim().min(1).max(255),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((v) => v !== "." && v !== ".."),
  private: z.boolean().default(true),
  description: z.string().max(350).optional(),
  autoInit: z.boolean().default(true),
});
const isUuid = (id: string) => z.string().uuid().safeParse(id).success;

const NO_SECRET_KEY = "SECRET_KEY is not configured on the server, so tokens cannot be stored.";
const LEGACY_NAME = "GitHub";

export function registerGitAccountRoutes(app: FastifyInstance, deps: GitAccountRouteDeps): void {
  const who = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] ?? "").slice(0, 300) || null,
  });

  const record = (
    request: FastifyRequest,
    userId: string,
    action: GitAccountAuditEntry["action"],
    meta: GitAccountMeta,
    summary: string,
  ) =>
    deps
      .audit({
        userId,
        action,
        accountId: meta.id,
        summary,
        details: { provider: meta.provider, name: meta.name, baseUrl: meta.baseUrl, ...who(request) },
      })
      .then(() => deps.changed(userId));

  const label = (meta: GitAccountMeta) => `${GIT_PROVIDER_LABELS[meta.provider]} account "${meta.name}"`;

  // -- Settings ---------------------------------------------------------------

  app.get("/api/account/git-accounts", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const [accounts, sources] = await Promise.all([
      deps.accounts.list(principal.userId),
      deps.sources(principal.userId),
    ]);
    return {
      accounts,
      encryptionAvailable: deps.encryptionAvailable,
      // A sign-in token is in use only where no account was saved.
      githubFromLogin: sources.some((s) => !isUuid(s.id)),
    };
  });

  app.post("/api/account/git-accounts", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid account." });
    const { provider, name, token } = parsed.data;

    let baseUrl: string;
    try {
      // GitHub is github.com alone, whatever was sent.
      const given = provider === "github" ? null : parsed.data.baseUrl || null;
      const raw = given ?? DEFAULT_BASE_URL[provider];
      if (!raw) return reply.code(400).send({ error: "Enter the server URL." });
      baseUrl = normalizeBaseUrl(raw);
    } catch (error) {
      if (error instanceof BaseUrlError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const formatError = checkTokenFormat(provider, token);
    if (formatError) return reply.code(400).send({ error: formatError });

    const existing = await deps.accounts.list(principal.userId);
    if (existing.length >= MAX_GIT_ACCOUNTS) {
      return reply.code(409).send({ error: `You can keep up to ${MAX_GIT_ACCOUNTS} git accounts. Remove one first.` });
    }
    if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      return reply.code(409).send({ error: new DuplicateAccountName(name).message });
    }

    const check = await deps.check(provider, baseUrl, token);
    if (!check.ok) return reply.code(422).send({ error: check.error });
    try {
      const account = await deps.accounts.create(principal.userId, {
        provider,
        name,
        baseUrl,
        token,
        login: check.login,
        scopes: check.scopes,
      });
      await record(request, principal.userId, "git_account.created", account, `Connected the ${label(account)}`);
      return { account };
    } catch (error) {
      if (error instanceof DuplicateAccountName) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/account/git-accounts/:id", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const parsed = PatchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid account." });
    const existing = await deps.accounts.list(principal.userId);
    const before = existing.find((a) => a.id === request.params.id);
    if (!before) return reply.code(404).send({ error: "No such git account." });

    const { name, token } = parsed.data;
    if (token !== undefined) {
      if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
      const formatError = checkTokenFormat(before.provider, token);
      if (formatError) return reply.code(400).send({ error: formatError });
      const check = await deps.check(before.provider, before.baseUrl, token);
      if (!check.ok) return reply.code(422).send({ error: check.error });
      const account = await deps.accounts.replaceToken(principal.userId, before.id, token, check.login, check.scopes);
      if (!account) return reply.code(404).send({ error: "No such git account." });
      await record(request, principal.userId, "git_account.token_replaced", account, `Replaced the token of the ${label(account)}`);
      return { account };
    }

    if (existing.some((a) => a.id !== before.id && a.name.toLowerCase() === name!.toLowerCase())) {
      return reply.code(409).send({ error: new DuplicateAccountName(name!).message });
    }
    try {
      const account = await deps.accounts.rename(principal.userId, before.id, name!);
      if (!account) return reply.code(404).send({ error: "No such git account." });
      await record(request, principal.userId, "git_account.renamed", account, `Renamed the ${label(before)} to "${account.name}"`);
      return { account };
    } catch (error) {
      if (error instanceof DuplicateAccountName) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/account/git-accounts/:id", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const before = (await deps.accounts.list(principal.userId)).find((a) => a.id === request.params.id);
    if (!before || !(await deps.accounts.remove(principal.userId, before.id))) {
      return reply.code(404).send({ error: "No such git account." });
    }
    await record(request, principal.userId, "git_account.removed", before, `Removed the ${label(before)}`);
    return { ok: true };
  });

  /**
   * The route scripts stored a GitHub token through before there were
   * accounts: it is the account named "GitHub". No live check, as before.
   */
  app.put("/api/settings/github", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const parsed = LegacyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "an api key or null is required" });
    const token = parsed.data.apiKey;
    const existing = await deps.accounts.list(principal.userId);
    const before = existing.find((a) => a.provider === "github" && a.name === LEGACY_NAME);
    if (token === null) {
      if (before && (await deps.accounts.remove(principal.userId, before.id))) {
        await record(request, principal.userId, "git_account.removed", before, `Removed the ${label(before)}`);
      }
      return { github: { configured: false, hint: null } };
    }
    if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
    if (!/^[\x21-\x7e]+$/.test(token)) return reply.code(400).send({ error: "an api key or null is required" });
    if (before) {
      const account = await deps.accounts.replaceToken(principal.userId, before.id, token, null, null);
      if (account) await record(request, principal.userId, "git_account.token_replaced", account, `Replaced the token of the ${label(account)}`);
    } else {
      if (existing.length >= MAX_GIT_ACCOUNTS || existing.some((a) => a.name.toLowerCase() === LEGACY_NAME.toLowerCase())) {
        return reply.code(409).send({ error: "That account can't be added. Use Settings → Providers." });
      }
      const account = await deps.accounts.create(principal.userId, {
        provider: "github",
        name: LEGACY_NAME,
        baseUrl: GITHUB_URL,
        token,
        login: null,
        scopes: null,
      });
      await record(request, principal.userId, "git_account.created", account, `Connected the ${label(account)}`);
    }
    return { github: { configured: true, hint: token.slice(-4) } };
  });

  // -- The new-project dialog -------------------------------------------------

  type Source = GitAuthSource & { name: string };

  function connect(source: Source) {
    const token = source.token();
    if (!token) throw new GitHostError("The saved token can't be read. Replace it in Settings → Providers.", 409);
    return { host: GIT_HOSTS[source.provider], ctx: { baseUrl: source.baseUrl, token, fetch: deps.fetch } };
  }

  async function login(source: Source): Promise<string> {
    const { host, ctx } = connect(source);
    const me = await host.identify(ctx);
    if (!source.login && isUuid(source.id)) deps.learnLogin(source.id, me.login);
    return me.login;
  }

  const messageOf = (error: unknown, source: Source): string => {
    if (error instanceof GitHostError) return error.message;
    deps.onError(error);
    return `${GIT_PROVIDER_LABELS[source.provider]} could not be reached.`;
  };

  /** Runs one call against one of the caller's accounts, with its failure as the reply. */
  async function withAccount(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    work: (connection: ReturnType<typeof connect>) => Promise<unknown>,
  ) {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const source = (await deps.sources(principal.userId)).find((s) => s.id === request.params.id);
    if (!source) return reply.code(404).send({ error: "No such git account." });
    try {
      return await work(connect(source));
    } catch (error) {
      // A host's 401 is about its token. Passed on as it is, it would read as
      // the harness's own session having ended.
      const status = error instanceof GitHostError ? (error.status === 401 ? 422 : error.status) : 502;
      return reply.code(status).send({ error: messageOf(error, source) });
    }
  }

  app.get("/api/git/accounts", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const accounts = await Promise.all(
      (await deps.sources(principal.userId)).map(async (source): Promise<GitAccount> => {
        const me = await login(source).catch(() => null);
        return {
          id: source.id,
          provider: source.provider,
          name: source.name,
          baseUrl: source.baseUrl,
          connected: me !== null,
          login: me,
        };
      }),
    );
    return { accounts };
  });

  app.get("/api/git/repos", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const sources = await deps.sources(principal.userId);
    const accounts: { id: string; provider: GitProvider; name: string; login: string }[] = [];
    const repos: (GitRepo & { provider: GitProvider; accountId: string; accountName: string })[] = [];
    const errors: { accountId: string; provider: GitProvider; name: string; error: string }[] = [];
    await Promise.all(
      sources.map(async (source) => {
        const { id, provider, name } = source;
        try {
          const { host, ctx } = connect(source);
          const [me, list] = await Promise.all([login(source), host.listRepos(ctx)]);
          accounts.push({ id, provider, name, login: me });
          for (const repo of list) repos.push({ ...repo, provider, accountId: id, accountName: name });
        } catch (error) {
          errors.push({ accountId: id, provider, name, error: messageOf(error, source) });
        }
      }),
    );
    // Accounts answer in any order; the list is by activity whichever they came from.
    const order = (id: string) => sources.findIndex((s) => s.id === id);
    accounts.sort((a, b) => order(a.id) - order(b.id));
    errors.sort((a, b) => order(a.accountId) - order(b.accountId));
    const at = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
    repos.sort((a, b) => at(b.pushedAt) - at(a.pushedAt));
    return { accounts, repos, errors };
  });

  app.get<{ Params: { id: string } }>("/api/git/accounts/:id/owners", (request, reply) =>
    withAccount(request, reply, async ({ host, ctx }) => ({ owners: await host.listOwners(ctx) })),
  );

  app.get<{ Params: { id: string }; Querystring: { repo?: string } }>("/api/git/accounts/:id/branches", (request, reply) =>
    withAccount(request, reply, async ({ host, ctx }) => {
      const repo = request.query.repo?.trim();
      if (!repo || repo.length > 500) throw new GitHostError("a repository is required", 400);
      return host.listBranches(ctx, repo);
    }),
  );

  app.post<{ Params: { id: string } }>("/api/git/accounts/:id/repos", (request, reply) =>
    withAccount(request, reply, async ({ host, ctx }) => {
      const parsed = CreateRepoBody.safeParse(request.body);
      if (!parsed.success) {
        throw new GitHostError("an owner and a repository name (letters, digits, . - _) are required", 400);
      }
      return { repo: await host.createRepo(ctx, parsed.data) };
    }),
  );
}
