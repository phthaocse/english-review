# Setting up capture

Everything below needs a browser and your own accounts, so it is yours to do —
I can't create Google or Cloudflare accounts on your behalf. It takes about
twenty minutes once.

At the end you will have: a Google sign-in restricted to an allowlist, a
Cloudflare Worker holding your Gemini key, and a D1 database as the canonical
store.

---

## 1. A Google OAuth client ID

1. Open <https://console.cloud.google.com/> and create a project, e.g. `knowledge`.
2. **APIs & Services → OAuth consent screen**. Choose **External**, fill in the
   app name and your email, and save. You can leave it in *Testing*; add your own
   address under **Test users**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**
   - **Authorised JavaScript origins** — add both:
     - `https://phthaocse.github.io`
     - `http://localhost:8731`
4. Copy the client ID. It looks like `1234-abc.apps.googleusercontent.com`.

That ID is **public**. It goes in the repo; it identifies the app and authorises
nothing on its own.

---

## 2. Cloudflare: database and Worker

Install the CLI and sign in (this is the one step that changes your machine):

```bash
npm install -g wrangler        # or use npx wrangler for each command
wrangler login
```

Create the database and load the schema:

```bash
cd worker
wrangler d1 create knowledge         # copy the database_id it prints
wrangler d1 execute knowledge --remote --file=./schema.sql
```

Put the printed `database_id` and your client ID into `worker/wrangler.toml`,
replacing both `REPLACE_ME` values.

Add yourself to the allowlist — nobody can sign in until this row exists:

```bash
wrangler d1 execute knowledge --remote \
  --command "INSERT INTO user (email, name, role) VALUES ('thaop@ghn.vn', 'Thao', 'owner')"
```

---

## 3. The Gemini key

Never paste a key into a chat, and never pass one as a command argument —
arguments are visible in `history` and in `ps` while the command runs. Type it
once at a hidden prompt instead:

```bash
./save-secret.sh GEMINI_API_KEY
```

That writes `~/.config/knowledge/secrets.env`, mode 600 in a mode 700
directory, the same shape as the keys you already keep under
`~/.config/ghn-mcp/`. `setup.sh` uploads it with `wrangler secret bulk`, which
reads the file directly.

To do it by hand:

```bash
wrangler secret bulk ~/.config/knowledge/secrets.env
```

It is encrypted and **cannot be read back** — not from the CLI, not from the
dashboard. If you ever lose it, set a new one.

Never put it in `wrangler.toml`, in `config.js`, or anywhere under version
control. For local development use `worker/.dev.vars`, which is in `.gitignore`:

```
GEMINI_API_KEY="..."
```

Deploy:

```bash
wrangler deploy      # prints your Worker URL
```

---

## 4. Point the site at it

In `config.js`, replace both placeholders with your client ID and the Worker URL
from the deploy. Then publish as usual:

```bash
git add config.js worker/wrangler.toml
git commit -m "Point the site at my Worker"
git push origin main
```

---

## 5. Check it

1. Open the site and go to **Capture**. Sign in with the allowlisted account.
2. Type a word and save it. It should appear under *Recently captured*.
3. Sign in with a **different** Google account. You should be refused with
   "this account is not on the allowlist" — if you are not, stop and check that
   `GOOGLE_CLIENT_ID` in `wrangler.toml` matches the client ID in `config.js`.

---

## Managing the allowlist

```bash
# add someone
wrangler d1 execute knowledge --remote \
  --command "INSERT INTO user (email, role) VALUES ('friend@example.com', 'member')"

# revoke, effective on their next request
wrangler d1 execute knowledge --remote \
  --command "UPDATE user SET status='revoked' WHERE email='friend@example.com'"

# who is on it
wrangler d1 execute knowledge --remote \
  --command "SELECT email, role, status, last_seen_at FROM user"
```

---

## Backups

D1 is the live store; the portable copy is a dump:

```bash
wrangler d1 export knowledge --remote --output=knowledge-$(date +%F).sql
```

Keep that in Drive. It restores into D1, or into plain local SQLite, with
`wrangler d1 execute ... --file=` or `sqlite3 knowledge.db < dump.sql`.

Do **not** put a live `.sqlite` file in a syncing folder and write to it from
more than one device: Drive and Dropbox replace whole files and sync SQLite's
`-wal` sidecar separately, which produces conflicted copies or a corrupt
database with no way to merge.

---

## What it costs

| Service | Free allowance | Expected use |
|---|---|---|
| GitHub Pages | 100 GB/month, 1 GB site | negligible |
| Cloudflare Workers | 100,000 requests/day | tens |
| Cloudflare D1 | 5 GB, 5M row reads + 100k row writes/day | hundreds |
| Gemini API | free tier, limits shown in AI Studio | capped at 50 image reads/day in the Worker |

**One privacy note:** Google's pricing page marks *"content used to improve our
products"* as **Yes** for the Gemini free tier and **No** for paid. Photographs
of your notes go through it. If that matters, a paid key is a few dollars a
month at this volume and the Worker needs no change.
