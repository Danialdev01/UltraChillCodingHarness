# Deploying UCCH on Dokploy (Dockerfile build type)

This is the step-by-step for putting UCCH on a Dokploy server at
**https://ucch.danialirfan.dev**. It deploys three services inside one Dokploy
project:

| Service | Dokploy type | What it is |
| --- | --- | --- |
| `ucch-db` | Database → PostgreSQL | the event log and everything else |
| `ucch-server` | Application, **Dockerfile** build | Fastify API, WebSocket, terminals, live-preview proxy |
| `ucch-web` | Application, **Dockerfile** build | the Next.js UI |

Plus one hand-placed Traefik file for the live-preview wildcard, which
Dokploy's UI cannot express.

Follow the steps in order: the web app's build needs the server's name, and
the server needs the database's.

---

## 0. Before you start

You need:

- A VPS with Dokploy installed (`curl -sSL https://dokploy.com/install.sh | sh`)
  and reachable on ports 80 and 443. 2 vCPU / 4 GB is comfortable; the server
  image is ~800 MB and the web build wants ~2 GB of RAM while compiling.
- The domain `danialirfan.dev` on Cloudflare (for the DNS-01 wildcard
  certificate — any Traefik-supported DNS provider works, the token step
  changes accordingly).
- This repository pushed to GitHub, with Dokploy's GitHub integration
  connected (Settings → Git → GitHub) or a deploy key for a private repo.
- Local sanity check, optional but worth five minutes:

  ```bash
  docker build -f apps/server/Dockerfile -t ucch-server .
  docker build -f apps/web/Dockerfile \
    --build-arg NEXT_PUBLIC_WS_ORIGIN=https://api.ucch.danialirfan.dev \
    --build-arg SERVER_ORIGIN=http://ucch-server:3001 -t ucch-web .
  ```

---

## 1. Prepare the VPS

SSH in as root. Two directories are bind-mounted into the server so that
project working trees and CLI logins outlive a redeploy:

```bash
mkdir -p /srv/ucch/workspaces /srv/ucch/creds
chmod 700 /srv/ucch/creds
chown -R 1000:1000 /srv/ucch
```

(The `ucch-projects` Docker network and `/srv/ucch/previews` from the README
belong to the container runtime, which is not enabled yet. Skip them.)

---

## 2. DNS (Cloudflare)

On the `danialirfan.dev` zone add three **A** records pointing at the VPS IP,
all with the proxy **off** (grey cloud):

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `ucch` | VPS IP | DNS only |
| A | `api.ucch` | VPS IP | DNS only |
| A | `*.ucch` | VPS IP | DNS only |

Grey cloud matters: Cloudflare's proxy breaks WebSockets on the API host and
puts a second TLS layer in front of Traefik's.

Check propagation before continuing:

```bash
dig +short ucch.danialirfan.dev api.ucch.danialirfan.dev anything.ucch.danialirfan.dev
# all three lines: the VPS IP
```

---

## 3. Wildcard certificate (DNS-01)

`p8001-{hash}.ucch.danialirfan.dev` needs a `*.ucch.danialirfan.dev`
certificate, and Let's Encrypt only issues wildcards through a **DNS-01**
challenge. Dokploy's default resolver is HTTP-01, so add a second one.

1. In Cloudflare: **My Profile → API Tokens → Create Token → Edit zone DNS**,
   scoped to `danialirfan.dev` only. Copy the token.

2. In Dokploy: **Settings → Web Server → Traefik → Environment Variables**, add

   ```
   CF_DNS_API_TOKEN=<the token>
   ```

3. **Settings → Web Server → Traefik → File System**, open `traefik.yml` and
   add a resolver next to the existing one (keep the existing one; Dokploy's
   own domains use it):

   ```yaml
   certificatesResolvers:
     letsencrypt:
       acme:
         email: danialirfan@danialirfan.dev
         storage: /etc/dokploy/traefik/dynamic/acme.json
         httpChallenge:
           entryPoint: web
     letsencrypt-dns:
       acme:
         email: danialirfan@danialirfan.dev
         storage: /etc/dokploy/traefik/dynamic/acme-dns.json
         dnsChallenge:
           provider: cloudflare
           resolvers:
             - "1.1.1.1:53"
             - "8.8.8.8:53"
   ```

   If your `traefik.yml` already names the HTTP-01 resolver differently,
   leave it; only the `letsencrypt-dns` block is new.

4. **Restart Traefik** (button on the same page) so it reads the new static
   configuration and the environment variable.

---

## 4. Create the project and the database

1. **Projects → Create Project**: name `ucch`.

2. Inside it, **Create Service → Database → PostgreSQL**:

   | Field | Value |
   | --- | --- |
   | Name | `ucch-db` |
   | Database Name | `ucch` |
   | Username | `ucch` |
   | Password | generate a long one |
   | Docker Image | `postgres:16` (the default is fine) |

3. **Deploy** it. When it is running, open the database's **General** tab and
   copy the **Internal Connection URL**. It looks like

   ```
   postgres://ucch:<password>@ucch-db-a1b2c3:5432/ucch
   ```

   The host part is the database's App Name on `dokploy-network`; that is
   how the server reaches it. Do not enable external ports.

---

## 5. Create the server application

**Create Service → Application**, name `ucch-server`.

### 5.1 Source (General tab)

| Field | Value |
| --- | --- |
| Provider | GitHub (or Git with the repo URL) |
| Repository | this repository |
| Branch | `main` |
| Build Type | **Dockerfile** |
| Dockerfile Path | `apps/server/Dockerfile` |
| Docker Context Path | `.` |
| Docker Build Stage | *(empty)* |

The context must be the repository root: the Dockerfile copies `packages/*`
and the root `pnpm-lock.yaml`.

### 5.2 Environment tab

Open `.env.example` in this repository, paste the **entire file** into the
Environment Variables editor, and fill in the lines marked `>>> CUSTOMIZE`:

| Variable | Set it to |
| --- | --- |
| `DATABASE_URL` | the Internal Connection URL from step 4 |
| `SECRET_KEY` | output of `openssl rand -hex 32` (exactly 64 hex characters) |
| `DEFAULT_USER_PASSWORD` | a real password — this is your first login |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | optional; see §9 |

Everything else in the file is already correct for `ucch.danialirfan.dev`.
Two lines deserve a look before you save:

- `AGENT_ALLOW_HOST_SHELL=true` — required. The terminal, the agents' `bash`
  and the live preview's dev servers all run *inside this container*. It also
  means anyone who can sign in has a shell in the container: this deployment
  is for you and people you trust.
- `ANTHROPIC_API_KEY=` — deliberately blank. Users add their own OpenRouter
  keys in Settings, and a server-side Anthropic key would stop the `claude`
  CLI provider from using subscription billing.

### 5.3 Advanced tab → Mounts

Add two **Bind Mounts**:

| Host path | Container path |
| --- | --- |
| `/srv/ucch/workspaces` | `/srv/ucch/workspaces` |
| `/srv/ucch/creds` | `/srv/ucch/creds` |

Do **not** mount `/var/run/docker.sock`. Nothing uses it yet, and without it
a shell in the container is not root on the host.

### 5.4 Domains tab

**Add Domain**:

| Field | Value |
| --- | --- |
| Host | `api.ucch.danialirfan.dev` |
| Path | `/` |
| Container Port | `3001` |
| HTTPS | on |
| Certificate | Let's Encrypt |

### 5.5 Deploy

Press **Deploy**. The first build is the slow one — apt, PHP 8.2, typst and
the pnpm install — about five minutes cold; later builds reuse the layers
and take under a minute unless the lockfile changed.

The image declares a health check against `/health`, and the server applies
database migrations on boot, so there is no separate migration step. Wait
until the deployment log ends with `ucch server ready` and the service shows
healthy, then:

```bash
curl https://api.ucch.danialirfan.dev/health
# {"status":"ok","version":"0.1.0","connections":0}
```

### 5.6 Note the App Name

On the **General** tab Dokploy shows an **App Name** such as
`ucch-server-x1y2z3`. Copy it. It is the container's DNS name on
`dokploy-network`, and the next two steps need it.

---

## 6. Create the web application

**Create Service → Application**, name `ucch-web`.

### 6.1 Source (General tab)

| Field | Value |
| --- | --- |
| Repository / Branch | same as the server |
| Build Type | **Dockerfile** |
| Dockerfile Path | `apps/web/Dockerfile` |
| Docker Context Path | `.` |

### 6.2 Environment tab — two different boxes

This is the step people get wrong. The web build takes two values that are
**compiled into the build**, so they go under **Build Time Arguments**, not
Environment Variables:

```
NEXT_PUBLIC_WS_ORIGIN=https://api.ucch.danialirfan.dev
SERVER_ORIGIN=http://ucch-server-x1y2z3:3001
```

with `ucch-server-x1y2z3` replaced by the App Name from step 5.6. The first
is inlined into the browser bundle (the WebSocket connects straight to the
API host); the second is baked into Next's rewrite table so `/api/*` on the
root domain is proxied to the server *inside* the Docker network. Putting
either under Environment Variables does nothing.

Under **Environment Variables** add only:

```
NODE_ENV=production
```

### 6.3 Domains tab

| Field | Value |
| --- | --- |
| Host | `ucch.danialirfan.dev` |
| Path | `/` |
| Container Port | `3000` |
| HTTPS | on |
| Certificate | Let's Encrypt |

### 6.4 Deploy

Press **Deploy** (`next build` takes two to three minutes). Then:

```bash
curl -o /dev/null -w '%{http_code}\n' https://ucch.danialirfan.dev/login
# 200

curl -o /dev/null -w '%{http_code}\n' https://ucch.danialirfan.dev/api/me
# 401  -- the rewrite reached the server and it asked for a session.
#        A 500 means SERVER_ORIGIN was wrong (or missing) at build time:
#        fix the build argument and redeploy the web app.
```

---

## 7. The live-preview wildcard route

Dokploy's Domains tab only generates `Host()` rules. The live preview serves
`p{port}-{hash}.ucch.danialirfan.dev`, which needs a `HostRegexp` router
pointing at the server — one small Traefik file.

1. Open [`deploy/dokploy/ucch-preview.yml`](deploy/dokploy/ucch-preview.yml)
   and replace its placeholders:

   | Placeholder | Value |
   | --- | --- |
   | `UCCH_ROOT_DOMAIN_ESCAPED` | `ucch\.danialirfan\.dev` (dots escaped — it is inside a regex) |
   | `UCCH_ROOT_DOMAIN` (twice) | `ucch.danialirfan.dev` |
   | `UCCH_SERVER_APP` | the server's App Name, e.g. `ucch-server-x1y2z3` |

   The finished file:

   ```yaml
   http:
     routers:
       ucch-preview:
         rule: "HostRegexp(`^p[0-9]+-[a-z0-9]{12}\\.ucch\\.danialirfan\\.dev$`)"
         entryPoints:
           - websecure
         service: ucch-preview
         tls:
           certResolver: letsencrypt-dns
           domains:
             - main: "ucch.danialirfan.dev"
               sans:
                 - "*.ucch.danialirfan.dev"
     services:
       ucch-preview:
         loadBalancer:
           passHostHeader: true
           servers:
             - url: "http://ucch-server-x1y2z3:3001"
   ```

2. In Dokploy: **Settings → Web Server → Traefik → File System**, create a
   new file in the `dynamic/` folder named `ucch-preview.yml` and paste it.
   Traefik watches that directory: no restart needed, and Dokploy leaves
   files it did not generate alone across redeploys.

3. Give Let's Encrypt a minute, then confirm the wildcard was issued — this
   is the one thing that fails silently:

   ```bash
   curl -vI https://anything.ucch.danialirfan.dev 2>&1 | grep -i 'subject:\|issuer:'
   # subject: CN=ucch.danialirfan.dev      (or *.ucch.danialirfan.dev)
   # issuer:  ... Let's Encrypt ...
   ```

   A `TRAEFIK DEFAULT CERT` here means the DNS-01 resolver did not work:
   check the Traefik logs (**Web Server → Traefik → Logs**) for `cloudflare`
   or `acme` errors — almost always a token without DNS-edit rights on the
   zone.

4. And that the router reaches the server's preview proxy rather than
   Traefik's own 404:

   ```bash
   curl -o /dev/null -w '%{http_code}\n' https://p8001-abcdefghijkl.ucch.danialirfan.dev/
   # 404 with an HTML "No preview here" page from the server.
   # Traefik's own 404 is plain text "404 page not found" -- that means the
   # rule did not match (check the escaping) or the file is not loaded.
   ```

---

## 8. First sign-in and a smoke test

1. Open https://ucch.danialirfan.dev and sign in with `DEFAULT_USER_EMAIL` /
   `DEFAULT_USER_PASSWORD`. The user is created on the server's first boot
   only; changing the variables later does not reset the password.
2. **Settings → Providers**: add your OpenRouter key (agents bill to it).
3. **New project** → clone a repository, or start one empty.
4. Open the project, switch to the **terminal**, start a dev server:

   ```bash
   php artisan serve --port=8001          # Laravel
   npm run dev -- --port 8001 --host      # Vite / Next
   ```

5. Press the **globe** in the top bar, enter `8001`, **Save**. The dot turns
   green ("Listening on port 8001") and two URLs appear:

   - **Share** `https://ucch.danialirfan.dev/{hash}/preview` — open this one.
     It checks you own the project and forwards you to
   - **App origin** `https://p8001-{hash}.ucch.danialirfan.dev` — where the app
     actually runs. `…/preview/dashboard` lands on the app's `/dashboard`.

   Vite 6+ refuses unknown hostnames: add `server.allowedHosts: true` to the
   project's `vite.config` if the preview shows Vite's "Blocked request".

---

## 9. Optional: GitHub sign-in

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

   | Field | Value |
   | --- | --- |
   | Homepage URL | `https://ucch.danialirfan.dev` |
   | Authorization callback URL | `https://ucch.danialirfan.dev/api/auth/github/callback` |

   The callback is on the **root** domain, not `api.` — the web app proxies
   `/api/*` to the server, so the session cookie is set first-party. Pointing
   it at `api.` would set the cookie on a host the browser never sends it to.

2. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the server's
   Environment tab and **Redeploy** the server.

---

## 10. Day-to-day

**Updating.** Push to `main`, then **Deploy** on the server and on the web
app (or enable **Auto Deploy** on both — the GitHub integration adds the
webhook). Dokploy's rolling update starts the new container before stopping
the old one; the server runs migrations on boot, so a schema change is
applied by the new container while the old one drains.

**Order on a change to `packages/protocol`.** Deploy the server first, then
the web app: the web bundle compiles the protocol package in, and an old
web talking to a new server is the safer direction.

**If the server's App Name ever changes** (you deleted and recreated the
application): update `SERVER_ORIGIN` in the web app's build arguments and
redeploy the web app, and update `deploy/dokploy/ucch-preview.yml`.

**Backups.** Dokploy's database backups (S3) cover Postgres. Back up
`/srv/ucch/workspaces` however you back up the host. **Exclude
`/srv/ucch/creds`** — those are personal CLI logins.

**Logs.** Each application's **Logs** tab. The server logs one JSON line per
request; the preview proxy logs only errors.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Server build fails on `pnpm install --frozen-lockfile` | lockfile and `package.json` disagree | run `pnpm install` locally, commit `pnpm-lock.yaml` |
| Server exits at boot with `invalid configuration: SECRET_KEY` | not 64 hex chars | `openssl rand -hex 32` |
| Server exits with `DEV_AUTH_BYPASS must not be enabled in production` | `DEV_AUTH_BYPASS=true` pasted from a dev env | set it to `false` |
| Server exits with `no authentication method configured` | no default user and no GitHub app | set `DEFAULT_USER_EMAIL` + `DEFAULT_USER_PASSWORD` |
| Every `/api/*` call from the UI is 500 | `SERVER_ORIGIN` missing or wrong at web **build** time | set the Build Time Argument, redeploy web |
| Chat connects then drops, or "reconnecting" forever | `NEXT_PUBLIC_WS_ORIGIN` wrong, or Cloudflare proxy (orange cloud) on `api.` | fix the build arg / grey-cloud the record |
| Terminal says shell access is disabled | `AGENT_ALLOW_HOST_SHELL` not `true` | set it, redeploy server |
| Preview URL shows a browser certificate warning | wildcard not issued (HTTP-01 resolver, or bad Cloudflare token) | step 3 and step 7.3 |
| Preview URL shows plain-text `404 page not found` | Traefik did not match: regex escaping, wrong file location, or old App Name | step 7 |
| Preview page says "Nothing on port …" but the app is running | dev server bound to an address other than loopback, or to a different port | start it on `127.0.0.1`/`::1` (the default) with the port you saved |
| Preview page shows Vite "Blocked request. This host is not allowed" | Vite 6 host check | `server.allowedHosts: true` in `vite.config` |
| Projects vanished after a redeploy | workspaces bind mount missing | step 5.3 |
