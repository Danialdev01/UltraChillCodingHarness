# Fixing "Could not sign in. Please try again." on the Dokploy deployment

## Step 1: point each Dokploy app at its Dockerfile

On each application, General tab:

| App | Build Type | Dockerfile Path | Docker Context Path |
| --- | --- | --- | --- |
| ucch-server | Dockerfile | `apps/server/Dockerfile` | `.` |
| ucch-web | Dockerfile | `apps/web/Dockerfile` | `.` |

Type the `.` literally. An empty Docker Context Path makes Dokploy use the
Dockerfile's own directory as the context, and the build fails with
`COPY apps/server ./apps/server: "/apps/server": not found`.

## Step 2: keep the DNS wildcard proxy-free

The zone's `*.danialirfan.dev` A record (`217.216.74.159`) already resolves
`ucch`, `api.ucch` and every `p{port}-{hash}.ucch` name. It must stay
**DNS only** (grey cloud). Do not add a separate `ucch.danialirfan.dev`
record: that would stop the wildcard covering `api.ucch` and `*.ucch`.

Verify:

```bash
dig +short ucch.danialirfan.dev api.ucch.danialirfan.dev
# both lines: 217.216.74.159
```

## Step 3: set the domains on each app

Domains tab:

| App | Host | Container Port | HTTPS | Certificate |
| --- | --- | --- | --- | --- |
| ucch-server | `api.ucch.danialirfan.dev` | `3001` | on | Let's Encrypt |
| ucch-web | `ucch.danialirfan.dev` | `3000` | on | Let's Encrypt |

## Step 4: set the server environment

On ucch-server, Environment tab, Environment Variables. Use a **Postgres**
URL and encode `@` in the username as `%40`:

```
DATABASE_URL=postgresql://user%40example.com:password@host:5432/ucch
ROOT_DOMAIN=ucch.danialirfan.dev
PUBLIC_SCHEME=https
DEFAULT_USER_EMAIL=danialirfan@danialirfan.dev
DEFAULT_USER_PASSWORD=danialdev
```

Keep the rest of `.env.example` as is. Deploy the server.

## Step 5: note the server's App Name

On ucch-server, General tab, copy the App Name (for example
`ucch-server-k0le5z`).

## Step 6: set the web build arguments

On ucch-web, Environment tab, **Build Time Arguments** (not Environment
Variables):

```
NEXT_PUBLIC_WS_ORIGIN=https://api.ucch.danialirfan.dev
SERVER_ORIGIN=http://<server App Name>:3001
```

Under Environment Variables add only:

```
NODE_ENV=production
```

## Step 7: rebuild the web app

Press Deploy on ucch-web. A restart is not enough; both values are compiled
in at `next build`.

## Step 8: verify

```bash
curl -o /dev/null -w '%{http_code}\n' https://ucch.danialirfan.dev/login      # 200
curl -o /dev/null -w '%{http_code}\n' https://ucch.danialirfan.dev/api/me     # 401
curl -o /dev/null -w '%{http_code}\n' https://api.ucch.danialirfan.dev/api/me # 401
```

If `/api/me` returns `500`, the web container's logs show
`Failed to proxy http://<host>:3001` with the hostname it was built with;
repeat steps 5 to 7. If it returns `404`, Traefik has no router for the
host; repeat step 3 and redeploy that app.

Then sign in at `https://ucch.danialirfan.dev/login` with the default
account.
