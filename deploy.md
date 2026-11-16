# Deploy UCCH on Dokploy

UCCH runs as **one container** built from the [`Dockerfile`](Dockerfile): the app, the UI and its database, on port `3000`, with everything saved in `/data`.

Replace `ucch.example.com` with your domain throughout.

## What you need

- An **x86_64 (amd64)** VPS with at least 2 vCPU / 4 GB RAM (8 GB recommended). ARM won't work.
- Dokploy installed on it: `curl -sSL https://dokploy.com/install.sh | sh`
- Ports **80** and **443** open.
- A DNS **A record** for `ucch.example.com` pointing at the VPS. On Cloudflare, set it to **DNS only** (grey cloud).

## 1. Create the application

1. In Dokploy: **Projects → Create Project** (e.g. `ucch`).
2. Open it: **Create Service → Application** (e.g. `ucch`).

## 2. Connect the code

In the application's **General** tab:

1. **Provider**: GitHub → this repository, branch **`main`**. Save.
2. **Build Type**: **Dockerfile**
   - Docker File: `Dockerfile`
   - Docker Context Path: `.`
   - Docker Build Stage: leave empty
3. Save.

## 3. Set the environment

In the **Environment** tab, paste [`.env.example`](.env.example) and change:

```env
ROOT_DOMAIN=ucch.example.com
DEFAULT_USER_EMAIL=you@example.com
DEFAULT_USER_PASSWORD=choose-a-password
```

Leave `SECRET_KEY`, `POSTGRES_PASSWORD` and `DEV_DB_PASSWORD` empty; they're generated on first start. Save.

## 4. Add the domain

**Domains → Add Domain**:

- Host: `ucch.example.com`
- Container Port: **`3000`**
- HTTPS: **on**, Certificate: **Let's Encrypt**

## 5. Add the volume (required)

**Advanced → Volumes → Add Volume**:

- Type: **Volume Mount**
- Volume Name: **`ucch-data`**
- Mount Path: **`/data`**

Without it the container refuses to start (`/data is not a mounted volume`).

## 6. Set the update order (required)

**Advanced → Swarm Settings → Update Config**, paste this, and save:

```json
{
  "Parallelism": 1,
  "Order": "stop-first"
}
```

Without it, new deploys fail and the old version keeps running.

## 7. Deploy

Click **Deploy**. The first build takes about 10 minutes.

Then check it:

```bash
curl -s https://ucch.example.com/health
# {"status":"ok",...,"build":"2026…",...,"db":"ok","web":"ok"}
```

`build` changes on every deploy. If it doesn't, your new version isn't live (recheck step 6).

## 8. Sign in

Open `https://ucch.example.com` and sign in with `DEFAULT_USER_EMAIL` and `DEFAULT_USER_PASSWORD`.

## 9. Auto deploy (optional)

**General → Auto Deploy: on**, so every push to `main` redeploys.

---

## Backups

In the application's **Schedules**, add a daily command:

```bash
ucch-backup
```

It saves to `/data/backups/`. Restore with `ucch-restore /data/backups/<timestamp>`.

## Don't

- Remove or rename the `ucch-data` volume, or run `docker volume prune` on the VPS. That deletes all your data.
- Change `SECRET_KEY` after the first start. Saved API keys stop working.
- Use `start-first` as the update order.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `/data is not a mounted volume` | Add the volume (step 5), then deploy. |
| New version doesn't show after deploy | `build` in `/health` didn't change. Set stop-first (step 6) and deploy again. |
| `502 Bad Gateway` | Wait 2 minutes after deploy. Check the domain's port is `3000`. |
| Certificate doesn't issue | DNS isn't pointing at the VPS yet, or Cloudflare's proxy (orange cloud) is on. |
| Build runs out of memory | Use a VPS with 4 GB+ RAM, or add swap. |
| `NEXT_PUBLIC_*` change has no effect | Put it under **Environment → Build-time Arguments** and redeploy. |

More detail (previews, GitHub sign-in, tuning): [README.md, "Deploying on Dokploy"](README.md#deploying-on-dokploy).

> **Security:** anyone who can sign in gets a shell in the container. Only give accounts to people you trust with the server.
