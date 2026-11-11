# Deploying Golden Arrow on Render

Golden Arrow has its **own Atlas cluster**, and a backend talks to **one** `MONGO_URI`. So this is a
**new pair of Render services**, not a change to the existing ones — `zarvia` and
`trade-erp-nexus-nodejs` keep serving Brivox, ABC and the demos exactly as they do now.

Both services deploy from the branch **`production/golden-arrow`** in their own repository. The
`render.yaml` on that branch in each repo already carries everything below.

```
  browser ──→ goldenarrow.onrender.com         (static site, the SPA)
                 │  /api/*  rewrite  ─────────→ api-golden-arrow-385b.onrender.com  (web service)
                 │                                        │
                 └─ /*      → index.html                  └──→ golden-arrow.kejvhzf.mongodb.net
```

The backend's host appears in no request a browser can see, and app and API are one origin — which is
why the cookie is `SameSite=Lax` rather than relying on a CORS check.

---

## 1. Backend — Web Service `api-golden-arrow-385b`

| Setting | Value |
| --- | --- |
| Repository | the backend repo, branch **`production/golden-arrow`** |
| Root directory | *(empty)* |
| Runtime | Node |
| Build | `npm ci` |
| Start | `npm start` |
| Health check | `/api/v1/health` |
| Plan | **Starter** — not Free. See the note below. |
| Region | **the same region as the Atlas cluster.** Cannot be changed later. |

### Environment variables

You asked to keep the existing values and change only the Mongo URL. That holds for all the secrets.
**Two others cannot stay as they are** — not as a preference, but because the app would be wrong:

| Variable | Value | Copy from the existing service? |
| --- | --- | --- |
| `MONGO_URI` | the `mongodb+srv://…@golden-arrow.kejvhzf.mongodb.net/ERP?retryWrites=true&w=majority` line from `.env.golden-arrow` | **NO — this is the one you change** |
| `PUBLIC_APP_URL` | `https://goldenarrow.onrender.com` | **NO — must be this client's own site** |
| `SYSTEM_MAIL_FROM_NAME` | `Golden Arrow Auto Garage` | NO — cosmetic, but it signs the client's mail |
| `NODE_ENV` | `production` | yes |
| `SESSION_COOKIE_SAMESITE` | `lax` | yes |
| `JWT_SECRET` | | yes — copy, or use the per-client one in `.env.golden-arrow` |
| `PLATFORM_JWT_SECRET` | must differ from `JWT_SECRET` | yes — same choice |
| `SECRET_BOX_KEY` | 64 hex | yes — same choice, **and it is still free to change: nothing in this client's database is encrypted yet (checked 8 Nov 2026)** |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | | yes |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `30d` | yes |
| `SYSTEM_MAIL_PROVIDER` + its key and from-address | | yes |
| `SUPPORT_CONTACT` | | yes |
| `CORS_ORIGINS` | `https://goldenarrow.onrender.com` | **NO — this client's own frontend** |

**Why `PUBLIC_APP_URL` cannot be copied.** It is the base of every password-reset link *and* every
customer document link, and it is never taken from the request's `Origin`. Left at
`https://zarvia.onrender.com`, a Golden Arrow user's "forgot my password" mail would send them to the
other installation, where the token means nothing — reset would simply not work, and the client's
people would be pointed at another client's address.

**`CORS_ORIGINS` is required, and the reasoning that said otherwise was wrong.** The `/api/*`
rewrite is a *proxy*: it forwards the browser's `Origin` header to the backend, so the backend
does see an Origin and does check it. "One origin in the browser" is not "no Origin at the
server". In production `utils/allowedOrigins.js` trusts only `https://zarvia.onrender.com` (the
localhost defaults are dropped there), so this client's own frontend must be named or every
browser call is refused **403 `CORS_ORIGIN_NOT_ALLOWED`** — sign-in and the developer console
included. The console does share the app's relative path (`platformApi.js` builds on
`API_BASE_URL`; there is no `VITE_PLATFORM_API_URL` any more), which is why it fails the same way.

**`TRUST_PROXY_HOPS` and `TRUST_CF_CONNECTING_IP` are deliberately not set.** Both default correctly
when `RENDER` is set, and the visitor's real address was measured to survive the rewrite. Verify it
after deploying (check 3 below) rather than assuming it. `SHARED_CLIENT_ADDRESS` must stay **off**.

**On copying `JWT_SECRET` / `PLATFORM_JWT_SECRET` / `SECRET_BOX_KEY`:** it works, and it is safe
against cross-installation sign-in, because a token is only accepted after the account id inside it is
found in *this* database. The cost is isolation — one leaked variable would then cover both clients.
Per-client values are already generated in `.env.golden-arrow` and cost nothing to use while no one
has signed in and nothing is encrypted. Your call; copying is not a mistake.

**On the plan:** `free` sleeps, and its first request after idle was measured at **32.6 s**. The
garage QA report's "5–20 s waits" were that, not a missing busy indicator. For a paying client use
**Starter**.

---

## 2. Frontend — Static Site `golden-arrow`

| Setting | Value |
| --- | --- |
| Repository | the frontend repo, branch **`production/golden-arrow`** |
| **Root directory** | **empty** — the Vite app is at the repository root |
| Build | `npm ci && npm run build` |
| **Publish directory** | **`dist`** |

### Environment variables

Exactly one, and `.env.production` already carries the same value, so a build with no dashboard
variables still behaves like the deployed site:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | `/api/v1` |

It is baked into the bundle **at build time**, so changing it needs a rebuild, not a restart.

### Rewrite rules — the order is the whole thing

Render ignores `public/_redirects` (that file is Netlify's), so these must be real dashboard rewrite
rules, in this order:

| # | Source | Destination | Type |
| --- | --- | --- | --- |
| 1 | `/api/*` | `https://api-golden-arrow-385b.onrender.com/api/*` | Rewrite |
| 2 | `/*` | `/index.html` | Rewrite |

**Rule 1 must be above rule 2.** Below it, `/*` answers every API call with `index.html` and the app
dies on a JSON parse error at the very first request. Without rule 2, `/` loads but every deep link
404s on refresh.

Point rule 1 at **this client's** backend. Aimed at the other service, people would sign in against
the wrong database.

### Header rules

A dashboard-made static site **ignores the `headers:` block in `render.yaml`** — measured 21 Oct 2026,
the live site answered only `nosniff` and Render's own HSTS. So add these by hand as header rules:

| Path | Header | Value |
| --- | --- | --- |
| `/*` | `X-Frame-Options` | `DENY` |
| `/*` | `X-Content-Type-Options` | `nosniff` |
| `/*` | `Referrer-Policy` | `no-referrer` |
| `/*` | `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| `/sw.js` | `Cache-Control` | `no-cache` |
| `/d/*` | `X-Robots-Tag` | `noindex, nofollow, noarchive` |

`X-Frame-Options` is the one that matters: an ERP that moves money should not be embeddable.
`/d/*` is the customer's document page, whose address carries a secret.

---

## 3. Order, and the checks that catch a wrong one

1. **Backend first**, with its variables. It will not start in production without `MONGO_URI` and a
   real `JWT_SECRET` — a weak key fails the deploy and Render keeps the previous version running.
2. `GET https://api-golden-arrow-385b.onrender.com/api/v1/health` → `{"ready": true}`.
   On a cold shared-tier cluster the first boot can exceed the 20 s gate; wait for `ready: true`
   before signing in.
3. Same URL again, and read **`yourAddress`**: it must be *your* address, must **not** change when you
   send `-H "X-Forwarded-For: 1.2.3.4"`, and must be the same across three calls. If it is a
   Cloudflare address or changes each time, every per-address limit is dead — stop and fix it before
   go-live.
4. **Frontend**, with `VITE_API_URL` and both rewrites.
5. `GET https://goldenarrow.onrender.com/api/v1/health` → the same JSON. If it returns HTML, rule 1
   is below rule 2.
6. **Sign in, then hard-reload a deep link** such as `/garage/board`. This is the check nothing in code
   can make: it proves the rewrite passes `Set-Cookie` back and `Cookie` forward. If the reload signs
   you out, `SESSION_COOKIE_SAMESITE=lax` is missing or the rewrite is dropping the cookie.
7. Open **Garage → Board**. The rail shows Garage between Inventory and Accounts; Setup lists 5 bays
   and 7 services.
8. Developer console at `/platform` with `developer@gmail.com`. **Turn two-factor on**, and make a
   second console account — there is only one active one, so one lost phone would shut the console.

## 4. The checks as commands

Git Bash. Set the two hosts once:

```bash
API=https://api-golden-arrow-385b.onrender.com
APP=https://goldenarrow.onrender.com
```

### Is it up, and has it finished building the database?

```bash
curl -s $API/api/v1/health
```

`{"success":true,"version":"2.5.0.0","startedAt":…,"ready":true,"yourAddress":"…"}`

**Wait for `ready: true`.** It is `false` while the start-up work runs, and a sign-in in that window
is refused. On a cold start the existing service answers `ready: false` immediately — that is normal,
poll again.

### Is the visitor's address right? (the check that keeps every rate limit alive)

```bash
curl -s $API/api/v1/health | grep -o '"yourAddress":"[^"]*"'
curl -s -H "X-Forwarded-For: 1.2.3.4" $API/api/v1/health | grep -o '"yourAddress":"[^"]*"'
```

Both must print **your own address**, unchanged by the forged header, and be stable across calls.
Measured on the existing Render service 8 Nov 2026: a real client IP, not a Cloudflare one — so the
defaults work and no `TRUST_PROXY_HOPS` / `TRUST_CF_CONNECTING_IP` override is needed.

### Is the frontend's /api/* rewrite above the SPA fallback?

```bash
curl -s $APP/api/v1/health
```

Must be **the same JSON**. HTML means rule 1 is below rule 2 and every API call is being answered
with `index.html`.

### Developer console

No password is written in this file — it is in the repository. Read it from the gitignored env file
that already holds it:

```bash
CONSOLE_EMAIL=$(grep -m1 '^PLATFORM_ADMIN_EMAIL=' .env.golden-arrow | cut -d= -f2-)
CONSOLE_PW=$(grep -m1 '^PLATFORM_ADMIN_PASSWORD=' .env.golden-arrow | cut -d= -f2-)

CONSOLE=$(curl -s -X POST $API/api/v1/platform/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$CONSOLE_EMAIL\",\"password\":\"$CONSOLE_PW\"}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).data.token")

echo "${CONSOLE:0:20}…"                                  # non-empty means the sign-in worked

curl -s $API/api/v1/platform/organisations -H "Authorization: Bearer $CONSOLE"
```

The organisation list must hold **golden-arrow and nothing else**. A console token lasts 8 hours and
has no renewal.

### The organisation itself

The owner's first password was printed once by the setup script and is stored nowhere, so it is typed
in rather than read from a file. `-s` keeps it off the screen and out of shell history:

```bash
read -rsp "owner password: " OWNER_PW; echo

TOKEN=$(curl -s -X POST $API/api/v1/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"owner@golden-arrow.ae\",\"password\":\"$OWNER_PW\"}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).data.tokens.accessToken")

curl -s $API/api/v1/organisation/status -H "Authorization: Bearer $TOKEN"
```

Look for `planCode: "standard"`, `modules.garage.on: true`, one branch, and
`me.mustChangePassword: true`.

**The owner is forced to change their password, so almost every other route answers
`403 PASSWORD_CHANGE_REQUIRED` until they do.** Only `GET /organisation/status`,
`GET /profile/me` and the change itself are allowed. That is the rule working, not a fault. Finish it
in the browser, or here:

```bash
read -rsp "new password: " NEW_PW; echo

curl -s -X PUT $API/api/v1/profile/change-password \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"currentPassword\":\"$OWNER_PW\",\"newPassword\":\"$NEW_PW\"}"
```

### The one no command can make

Sign in **in a browser**, then **hard-reload a deep link** such as `/garage/board`. It proves the
rewrite passes `Set-Cookie` back and `Cookie` forward. If the reload signs you out,
`SESSION_COOKIE_SAMESITE=lax` is missing or the rewrite is dropping the cookie — curl will not catch
that, because it does not behave like a browser about third-party cookies.

## 5. Still owed, and no deploy does them

- Settings → Business rules → Tax identity: the **15-digit TRN** and the **emirate**. Until the TRN is
  set, an approved sale prints "Invoice", not "Tax invoice".
- Settings → Company: real legal name, address, logo.
- `npm run backup` scheduled against this cluster, and **one rehearsed restore**.
- Drop the `sample_mflix` sample data Atlas loaded, to keep the collection budget for the client.
