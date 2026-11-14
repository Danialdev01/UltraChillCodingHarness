# Deploying UCCH on Dokploy (Dockerfile build)

A step-by-step for running UCCH as a Dokploy **Application** that Dokploy builds itself from the repository's [`Dockerfile`](Dockerfile). The result is one container that holds the API, the UI and PostgreSQL, on one port (`3000`) and one volume (`/data`).

For the background behind each setting, and for the prebuilt-image route via GHCR, see [README.md, &#34;Deploying on Dokploy&#34;](README.md#deploying-on-dokploy).

Throughout, `ucch.example.com` stands for your domain.

---

## 1. Prepare the server

1. Get an **x86_64 (amd64)** VPS. **ARM won't work**: the image downloads amd64 builds of pandoc, typst and s6-overlay, and the build stops early on any other architecture.

   - Minimum: 2 vCPU / 4 GB RAM (the build compiles Next.js). Recommended: 8 GB, which is what the defaults are tuned for.
2. Install Dokploy on it:

   ```bash
   curl -sSL https://dokploy.com/install.sh | sh
   ```
3. Open ports **80** and **443** (and Dokploy's own panel port, `3000`, until you've given the panel a domain).
4. Open the Dokploy panel at `http://<vps-ip>:3000` and create the admin account.

## 2. Point DNS at the server

At your DNS provider:

| Type | Name                   | Value                                              |
| ---- | ---------------------- | -------------------------------------------------- |
| A    | `ucch.example.com`   | the VPS's IP                                       |
| A    | `*.ucch.example.com` | the VPS's IP (only for live previews, see step 11) |

On Cloudflare, set both records to **DNS only** (grey cloud), or Let's Encrypt can't issue the certificate.

Check that it resolves before you continue:

```bash
dig +short ucch.example.com
```

## 3. Give Dokploy access to the repository

Under **Settings → Git** in Dokploy, connect GitHub (the GitHub App), or plan to use the **Git** provider with the repository's URL (add an SSH key under **Settings → SSH Keys** for a private repository).

## 4. Create the project and application

1. **Projects → Create Project**, name it `ucch`.
2. Open it, then **Create Service → Application**, name it `ucch`.

## 5. Configure the build

In the application's **General** tab:

1. **Provider**: GitHub (or Git) → this repository, branch **`main`**. Save.
2. **Build Type**: **Dockerfile**.
   - **Docker File**: `Dockerfile`
   - **Docker Context Path**: `.`
   - **Docker Build Stage**: leave empty (or `app`). `app` is the last stage, so it's the default.
3. Save.

**Optional build-time arguments** (under **Environment → Build-time Arguments**, *not* the runtime environment). These are compiled into the image, so changing one needs a rebuild, not just a restart:

```env
NEXT_PUBLIC_TLDRAW_LICENSE_KEY=   # removes the "made with tldraw" badge on whiteboards
BUILD_ID=                         # any build name, e.g. a commit sha: open tabs offer to reload when it changes
NEXT_PUBLIC_PWA=1                 # builds the service worker
```

## 6. Set the environment

In the **Environment** tab:

1. Paste the whole of [`.env.example`](.env.example).
2. Set **`ROOT_DOMAIN=ucch.example.com`**. This is the only required value. Keep `PUBLIC_SCHEME=https`.
3. Recommended: set `DEFAULT_USER_EMAIL` and `DEFAULT_USER_PASSWORD` for your first sign-in. If you leave the password blank, one is generated (see step 9).
4. On a 2–4 GB VPS, lower PostgreSQL's memory:

   ```env
   PG_SHARED_BUFFERS=256MB
   PG_EFFECTIVE_CACHE_SIZE=768MB
   ```
5. Leave `SECRET_KEY`, `POSTGRES_PASSWORD` and `DEV_DB_PASSWORD` **blank** on a fresh install. They're generated on the first boot and kept in `/data/secrets`. Set them only when you're moving an existing install over.
6. Save.

## 7. Add the domain, volume and update order

1. **Domains → Add Domain**
   - **Host**: `ucch.example.com`
   - **Container Port**: **`3000`**
   - **HTTPS**: on, **Certificate**: Let's Encrypt
2. **Advanced → Volumes → Add Volume**
   - Type **Volume Mount**, **Mount Path**: **`/data`** (any volume name, e.g. `ucch-data`).
   - Everything stateful lives here: databases, project files, CLI logins, secrets, backups. Without it, every redeploy starts from nothing.
   - **Required.** Use a *Volume Mount* (a named Docker volume), not a bind mount into the repository checkout, which Dokploy re-clones. Without a mount at `/data` the container refuses to start and logs `/data is not a mounted volume`. (`ALLOW_EPHEMERAL_DATA=true` overrides this, for throwaway test runs only.)
3. **Advanced → Swarm Settings → Update Config**: set **`Order` to `stop-first`**.
   > **Don't skip this one.** The default `start-first` briefly runs the old and new containers side by side, which means two PostgreSQL servers on one data directory, and that corrupts it.
   >
4. Recommended, **Advanced → Resources** (for an 8 GB VPS): memory limit **7168 MB**, memory reservation **4096 MB**, no CPU limit.

## 8. Deploy

1. Click **Deploy** and follow the **Deployments** tab's log.
2. The first build takes **about 10 minutes**. Later builds reuse BuildKit's cache and are much faster.
3. Once the container starts, the health check allows it up to 2 minutes to come up. Database migrations run automatically on every start.

Check it:

```bash
curl -s https://ucch.example.com/health
# {"status":"ok",...,"db":"ok","web":"ok"}

curl -o /dev/null -w '%{http_code}\n' https://ucch.example.com/api/me
# 401  (the server answered; you just aren't signed in)
```

## 9. Sign in

1. Open `https://ucch.example.com`.
2. Sign in with `DEFAULT_USER_EMAIL` (default `admin@<ROOT_DOMAIN>`) and `DEFAULT_USER_PASSWORD`.
3. If you left the password blank, read the generated one in the application's **Terminal** tab in Dokploy (or with `docker exec <container> …` on the VPS):

   ```bash
   cat /data/secrets/default_user_password
   ```
4. Add your OpenRouter key under **Settings → Providers**.

The first account is created on the first boot only, so changing these variables later won't reset it.

## 10. Turn on automatic deploys

Under the application's **General** tab, turn on **Auto Deploy**, so every push to `main` rebuilds and redeploys. Alternatively, copy the webhook from **Deployments → Webhook** into the GitHub repository's webhooks.

## 11. Optional extras

- **GitHub sign-in**: create a GitHub OAuth App with the callback `https://ucch.example.com/api/auth/github/callback`, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_ALLOWED_USERS` and/or `GITHUB_ALLOWED_ORGS`, and redeploy. With no allowed users or orgs, GitHub sign-in only admits accounts that already exist.
- **MySQL for your projects**: `ENABLE_MYSQL=true` (about 150 MB of RAM).
- **Research crawler**: run `unclecode/crawl4ai` as its own Dokploy service and set `CRAWL4AI_URL` / `CRAWL4AI_API_TOKEN`.
- **Alerts**: `ALERT_WEBHOOK_URL` (e.g. an ntfy topic).
- **Live previews** (`https://p{port}-{hash}.ucch.example.com`): these need the `*.ucch.example.com` record from step 2 and a wildcard certificate through a DNS challenge in Traefik. Follow [README.md, &#34;Live previews&#34;](README.md#live-previews-optional-one-time). Everything else works without them.

## 12. Backups

1. In Dokploy, open **Schedules** on the application and add a daily job that runs:

   ```bash
   ucch-backup
   ```

   It writes a consistent dump of the databases plus `secret_key` to `/data/backups/<timestamp>/` and keeps the newest 7 (`BACKUP_KEEP`).
2. Copy `/data/backups` and `/data/workspaces` off the server regularly. Don't copy `/data/creds` off it, because it holds users' CLI logins.
3. To restore: `ucch-restore /data/backups/<timestamp>`.

> **Keep `secret_key` safe.** Without it, stored API keys and database connections can't be decrypted.

---

## Updating and rolling back

- **Update**: push to `main` (with Auto Deploy on) or press **Deploy**. On shutdown the server gets up to 60 seconds to finish in-flight work.
- **Roll back**: revert the commit on `main` and deploy again, or point the application at an older branch or tag.
- **Logs**: the application's **Logs** tab. Every line is prefixed with its service (`server`, `web`, `postgres`, …).

## Troubleshooting

| Symptom                                                    | Cause / fix                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Build fails with "UCCH's image is x86_64 only"             | The VPS is ARM. Use an amd64 server, or build with CI on GitHub and pull the image (see the README's prebuilt-image alternative). |
| Build gets killed partway through / runs out of memory     | Too little RAM for the Next.js build. Add swap, or move to a 4 GB+ VPS.                                                           |
| `502 Bad Gateway` right after a deploy                   | The container is still starting (allow up to 2 minutes). Otherwise check that the domain's **Container Port** is `3000`.  |
| Certificate never issues                                   | DNS doesn't point at the VPS yet, the Cloudflare proxy is on (orange cloud), or ports 80/443 are closed.                          |
| Data is gone after a redeploy                              | No named volume at `/data`. Add it (step 7.2). Older images created an anonymous volume per container; to recover, on the VPS find the newest with `docker volume ls` and `docker run --rm -v <id>:/d alpine ls /d`, then copy it into the new volume: `docker run --rm -v <id>:/from -v ucch-data:/to alpine cp -a /from/. /to/` (with the app stopped). |
| Deploy fails: `/data is not a mounted volume`              | Same cause, caught at startup. Add the volume (step 7.2) and redeploy.                                                            |
| Logs show `NEW EMPTY DATA VOLUME` on an existing install   | The container got a different or empty volume. Check the mount in **Advanced → Volumes**.                                         |
| PostgreSQL errors about the data directory after an update | The update order is `start-first`. Set it to `stop-first` (step 7.3) and restore from a backup if needed.                     |
| Stored API keys stop working                               | `SECRET_KEY` changed. Restore the original from `/data/secrets/secret_key` or a backup.                                       |
| Changing a `NEXT_PUBLIC_*` value has no effect           | It's a build-time argument. Set it under Build-time Arguments and redeploy, which rebuilds.                                       |

## Security note

Anyone who can sign in gets a shell inside the container (`AGENT_ALLOW_HOST_SHELL=true`) and can read other users' workspaces. **Give accounts only to people you trust with the server itself.** The Docker socket is deliberately not mounted.
