# Fix: preview URL shows "Secure Connection Failed"

## The problem

You run `php artisan serve` in the terminal, set the preview port to `8000`, and open the preview URL:

```
https://p8000-31aw92xy99pa.ucch.danialirfan.dev
```

Firefox shows:

> Secure Connection Failed. Cannot communicate securely with peer: no common encryption algorithm(s).
> Error code: `SSL_ERROR_NO_CYPHER_OVERLAP`

Laravel and the port are fine. UCCH reaches `php artisan serve` on `127.0.0.1:8000` without any change. The browser fails before the request ever gets to the server.

## Why it happens, in simple terms

Every HTTPS address needs a **certificate**: an ID card that proves to the browser that the site is really who it says it is. A preview address has two "dots" before your domain:

```
p8000-31aw92xy99pa . ucch . danialirfan.dev
└──── level 2 ────┘  └ 1 ┘
```

There are two separate things to set up, and both must be in place:

1. **Cloudflare must not stand in front of preview addresses.** When the cloud next to a DNS record is orange ("Proxied"), the browser talks to Cloudflare, not to your server. Cloudflare's free certificate covers only **one** level (`*.danialirfan.dev`), so for a two-level name like `p8000-….ucch.danialirfan.dev` it has no certificate to show. It refuses the connection, and that refusal is the `SSL_ERROR_NO_CYPHER_OVERLAP` error.
2. **Your server needs its own certificate for `*.ucch.danialirfan.dev`.** Once Cloudflare steps aside, the browser talks straight to Traefik (the web server Dokploy runs on your VPS). Traefik has to hold a certificate for all the preview addresses. Let's Encrypt gives this kind of "wildcard" certificate for free, but only if it can prove you own the domain by writing a DNS record. Traefik does that with a Cloudflare API token.

## Where you are now (checked 2026-11-22)

| Step | Status |
|---|---|
| `*.ucch` DNS record set to DNS only (grey cloud) | **Done.** Cloudflare's nameservers already answer `217.216.74.159`, your VPS. |
| Your computer sees the new DNS answer | **Not yet everywhere.** Some resolvers still return the old Cloudflare addresses (`172.67.200.228`, `104.21.44.149`) for up to 5 minutes, sometimes longer in the browser. That is why you still see the same error. |
| Traefik has a certificate for `*.ucch.danialirfan.dev` | **Missing.** Your VPS currently answers with `TRAEFIK DEFAULT CERT`, a self-signed placeholder. |

So after the DNS cache clears, the error will change to a different one, like "Warning: Potential Security Risk Ahead" (`SEC_ERROR_UNKNOWN_ISSUER` or `SSL_ERROR_BAD_CERT_DOMAIN`). That is expected: it means step 1 worked and step 2 is next.

## How to fix it, step by step

### Step 1: Check the DNS record (already done)

In Cloudflare → your domain `danialirfan.dev` → **DNS → Records**, you should have:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `ucch` | `217.216.74.159` | your choice (works either way, see note below) |
| A | `*.ucch` | `217.216.74.159` | **DNS only** (grey cloud) |

The `*.ucch` row is the one that matters for previews. It must be grey.

### Step 2: Create a Cloudflare API token

This lets Traefik prove to Let's Encrypt that you own the domain.

1. Open Cloudflare → click your profile icon (top right) → **My Profile** → **API Tokens**.
2. Click **Create Token**.
3. Next to **Edit zone DNS**, click **Use template**.
4. Under **Zone Resources**, choose **Include → Specific zone → `danialirfan.dev`**.
5. Click **Continue to summary** → **Create Token**.
6. Copy the token now. Cloudflare shows it only once.

### Step 3: Give the token to Traefik

1. Open Dokploy → **Settings** → **Web Server** → **Traefik** → **Environment**.
2. Add a new line:

   ```
   CF_DNS_API_TOKEN=<the token you copied>
   ```

3. Save.

### Step 4: Tell Traefik how to get the wildcard certificate

1. Same place in Dokploy: **Traefik → File System** → open **`traefik.yml`**.
2. Find the section `certificatesResolvers:`. It already has a resolver called `letsencrypt`. Add a second one, `letsencrypt-dns`, under it, with the same indentation:

   ```yaml
   certificatesResolvers:
     letsencrypt:
       # ... leave the existing one as it is ...
     letsencrypt-dns:
       acme:
         email: <your email>
         storage: /etc/dokploy/traefik/dynamic/acme-dns.json
         dnsChallenge:
           provider: cloudflare
   ```

   Do not add a second `certificatesResolvers:` line. YAML is sensitive to spaces, so use spaces, not tabs.
3. Save.

### Step 5: Send preview addresses to UCCH

Traefik now needs a rule that says "any `p<port>-<hash>.ucch.danialirfan.dev` goes to the UCCH container, using the wildcard certificate".

1. Find your UCCH application's **service name**: Dokploy → your UCCH application → **General** tab. It looks like `ucch-abc123`.
2. **Option A, if your Dokploy accepts wildcard domains:** in the application → **Domains** → **Add Domain**: host `*.ucch.danialirfan.dev`, container port `3000`, HTTPS on, certificate provider **custom** with resolver name `letsencrypt-dns`. If it rejects the `*`, use option B.
3. **Option B, a file:** Dokploy → **Traefik → File System** → folder **`dynamic/`** → create a file named `ucch-previews.yml` with this content (replace `<service name>` with the name from step 1):

   ```yaml
   http:
     routers:
       ucch-previews:
         rule: HostRegexp(`^p[0-9]+-[a-z0-9]{12}\.ucch\.danialirfan\.dev$`)
         entryPoints: [websecure]
         service: ucch-previews
         tls:
           certResolver: letsencrypt-dns
           domains:
             - main: ucch.danialirfan.dev
               sans: ["*.ucch.danialirfan.dev"]
     services:
       ucch-previews:
         loadBalancer:
           servers:
             - url: http://<service name>:3000
   ```

4. Save.

### Step 6: Restart Traefik

Dokploy → **Settings → Web Server → Traefik → Restart** (or **Reload**). Wait about a minute while Let's Encrypt issues the certificate.

### Step 7: Check that it worked

From any computer, run:

```bash
curl -vI https://anything.ucch.danialirfan.dev 2>&1 | grep -i issuer
```

- **Shows `Let's Encrypt`** (for example `issuer: C=US; O=Let's Encrypt; CN=R11`): the certificate is ready. Open the preview URL again.
- **Shows `TRAEFIK DEFAULT CERT`**: the certificate wasn't issued. Look at Traefik's logs (Dokploy → **Traefik → Logs**) for `acme` or `cloudflare`. The usual causes are a wrong or missing `CF_DNS_API_TOKEN`, a token that isn't limited to the right zone, or a YAML indentation mistake in step 4.
- **Fails with `SSL_ERROR_NO_CYPHER_OVERLAP` or `handshake failure`**: your computer still uses the old Cloudflare answer. See below.

### Step 8: If the browser still shows the old error

The DNS change is live, but your computer or browser may remember the old answer for a few minutes.

1. Check what your computer sees:

   ```bash
   dig +short p8000-31aw92xy99pa.ucch.danialirfan.dev
   ```

   It should print `217.216.74.159`. If it prints `172.67.…` or `104.21.…`, it's still the old answer.
2. Wait 5 minutes, or clear the cache:
   - Linux (systemd): `resolvectl flush-caches`
   - Firefox: open `about:networking#dns` → **Clear DNS Cache**, then restart Firefox.
   - Chrome: open `chrome://net-internals/#dns` → **Clear host cache**.
3. Open the preview URL again.

## Quick summary

| You see | Meaning | Fix |
|---|---|---|
| `SSL_ERROR_NO_CYPHER_OVERLAP` | Cloudflare is still in front of the preview address | Set `*.ucch` to DNS only (grey), then clear the DNS cache (step 8) |
| "Potential Security Risk", `TRAEFIK DEFAULT CERT` | Cloudflare is out of the way, but there's no wildcard certificate yet | Steps 2 to 7 |
| The Laravel page loads | Done | — |
| `502` or "nothing is listening" after the certificate works | `php artisan serve` stopped, or the preview port isn't `8000` | Restart it in the terminal and check the port |

**Note on the `ucch` record (not the `*.ucch` one).** It is currently proxied (orange). That works, because `ucch.danialirfan.dev` is only one level deep, so Cloudflare's certificate covers it. [`deploy.md`](../deploy.md) recommends DNS only for it too, so that Let's Encrypt can renew the main site's certificate directly. If the main site's certificate ever fails to renew, set that record to grey as well.
