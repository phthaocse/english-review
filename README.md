# English Review

A small site for reviewing the English I keep in my Obsidian vault: look up
anything I've recorded, and practise it until I can produce it, not just
recognise it.

**Live:** https://phthaocse.github.io/english-review/

The Markdown notes in the vault stay the source of truth. This repo holds the
site and a generated snapshot of the notes — the same relationship the vault's
Word document and Anki deck already have with it.

## Why it works the way it does

Three findings shaped the design, and each one is visible in the interface.

**You never grade yourself.** The usual flashcard loop shows an answer and asks
you to rate your own recall. That judgement is subjective, it is work, and
rating "easy" on something you barely remembered quietly corrupts your own
schedule. Here you type the answer and the app marks it, so the scheduler is
fed a fact rather than an opinion.

**Typing, not flipping.** Turning a card over lets recognition pass for recall —
you read the answer and think *I knew that*. Producing the answer first is the
thing that actually strengthens the memory.

**Recognition and production are separate skills.** Retrieval practice transfers
in the direction you practise it, so being able to pick a word out of four
options does not mean you can produce it when writing. Every item therefore
climbs three rungs:

| Rung | What you do | Why |
|---|---|---|
| Recognise | Pick the word from four options | Gentle first exposure. Multiple choice overstates what you know, so it is only the entry rung |
| Gap-fill | Type the word into one of your own example sentences | Cued recall, in the grammatical form the sentence needs |
| Produce | Type the English from the Vietnamese alone | Free production — the rung that matters for writing |

Two clean answers move an item up a rung. Forgetting it moves it back down, so
a word you have lost is re-earned receptively before you are asked to produce
it again.

Intervals come from **FSRS-6**, via the official
[`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) implementation
vendored in `vendor/`. It is the scheduler Anki itself adopted as default, and
it needs roughly 20–30% fewer reviews than the old SM-2 algorithm for the same
retention.

### How answers are marked

| You typed | Verdict | Effect |
|---|---|---|
| The exact form, quickly | Correct | Longest interval |
| The exact form | Correct | Normal interval |
| Right word, wrong form (*turn out* for *turned out*) | Wrong form | Comes back sooner |
| One or two characters off, on a word of 5+ letters | Typo | Comes back sooner |
| Anything else | Not quite | Comes back shortly, one rung lower |

Punctuation drills are marked strictly, because in a comma-splice card the
punctuation *is* the answer. Every wrong verdict offers a one-click override for
when the marking is unfair.

## Capture (new)

The problem this solves: knowledge fragments in the gap between meeting a word
and being at the Mac. **Capture** lets you record it from any device — type it,
or photograph a notebook page and have it read — so the notebook and the
by-hand re-typing go away.

```
any device ── site (GitHub Pages)
   │  type a word, or photograph a page
   │      └─► Worker ─► Gemini (key lives here) ─► draft
   │             └─► REVIEW SCREEN — you correct it
   │                    └─► D1 (canonical SQLite)
   └─ look up / practise

Mac, later
   └─ enrich: Oxford lookup via english-vocab → IPA, CEFR, collocations
   └─ export: D1 → Obsidian .md → Anki CSV → .docx
```

**Nothing is stored without your confirmation.** The photo path returns a
*draft*; the review screen shows each reading with a confidence flag, you edit
or untick, and only what you keep is saved. Items stay `status = 'captured'`
until the Mac has verified them against Oxford — which is why the prompt
explicitly refuses to invent pronunciation or CEFR level.

SQLite is the source of truth and every destination is an exporter, so moving
off Obsidian later costs one plugin rather than a migration.

### Access and secrets

Sign-in is Google, restricted to an allowlist held in the database, so adding or
revoking someone never needs a deploy. The Worker verifies each ID token's
signature, issuer, audience, expiry and `email_verified` before touching
anything — identity comes only from the verified token, never from a field the
browser sends.

The Gemini key is a Worker secret. It is never in the repo, never in `config.js`
and never sent to the browser; the client calls the Worker, and the Worker calls
Google. The endpoint is itself behind the allowlist and capped at 50 image reads
per person per day, so a stolen session cannot drain the quota.

Setup is in [docs/SETUP.md](docs/SETUP.md); the structural view — components,
boundaries, where each kind of state lives — is in
[docs/architecture.md](docs/architecture.md).

## Repo layout

```
index.html        shell
app.js            views, routing, question generation
review.js         scheduling, grading, session queue
styles.css        light and dark themes
data/vocab.json   generated from the vault — do not hand-edit
vendor/           ts-fsrs, MIT, unmodified
test/             all suites (test/run.sh)
config.js         public config: OAuth client ID, Worker URL
auth-client.js    Google sign-in, token renewal, authenticated fetch
capture.js        capture form, photo upload, review screen
worker/
  schema.sql      the canonical store
  src/auth.js     ID token verification + allowlist
  src/gemini.js   image → draft, key never leaves here
  src/db.js       queries
  src/index.js    routes
docs/             architecture, setup, design notes
```

## Tests

```bash
./test/run.sh
```

The engine suite covers grading and scheduling. The UI suite drives a real
headless Chrome over the DevTools protocol: it generates a question for every
item at every rung and checks none is malformed or leaks its own answer. To run
it against the deployed site instead of a local server:

```bash
BASE=https://phthaocse.github.io/english-review node test/ui.test.mjs
```

### When the photo path itself is in question

`run.sh` stubs Gemini, so it proves the plumbing but never the model. One more
test goes all the way out:

```bash
node test/live.mjs                         # read the fixture page
node test/live.mjs ~/Desktop/notes.jpg     # read a photo of your own
GEMINI_API_KEY=nonsense node test/live.mjs # see the failure screen, no quota spent
```

A real browser drives the real front-end, which calls the real Worker code,
which calls Gemini with the real key. Only Google's signing keys and D1 are
stood in for. It prints what each model answered, the drafts that reached the
screen and the log rows, and leaves a screenshot behind. It is kept out of
`run.sh` because it spends daily free-tier quota.

## When a photo fails

Every read writes a row saying which models were asked, what each answered and
how long it took — visible three ways:

- **Recent reads** on the Capture screen, with a button that copies the lot.
- `GET /api/logs?limit=20` for the signed-in person.
- The Cloudflare dashboard, where the Worker's JSON log lines are kept 3 days.

Failures on screen quote their row (`log #41`), so a report can be traced to
the exact attempt. Writing the row is wrapped in a `try` — a broken log must
never turn a working read into a failure.

## Deployment

Pages builds straight from the `main` branch, so every push republishes the
site. There is nothing to compile — the data file is generated on the Mac,
because the vault lives on an external drive that CI cannot reach.

`.github/deploy.yml.disabled` is a GitHub Actions workflow that does the same
thing and additionally refuses to publish a `vocab.json` with no items in it.
Pushing a workflow file needs a token with the `workflow` scope, which the
GitHub CLI login does not have by default. To switch to it:

```bash
gh auth refresh -s workflow
mkdir -p .github/workflows
git mv .github/deploy.yml.disabled .github/workflows/deploy.yml
git commit -m "Deploy via GitHub Actions" && git push
gh api -X PUT repos/phthaocse/english-review/pages -f build_type=workflow
```

## Updating it

From the vault's script folder:

```bash
cd "/Volumes/Thao-Media/Obsidian Vault/English/_System/Scripts"
./publish_site.sh
```

That regenerates `data/vocab.json`, commits it and pushes. GitHub rebuilds the
site about a minute later. `--dry-run` shows what would change without
committing.

To rebuild the data without publishing:

```bash
python3 build_site.py
```

## Progress and privacy

Your review history is kept in the browser's local storage on the device you
study on. It never leaves the device, which also means it does not follow you to
another one — use **Progress → Export** to move it. Clearing site data for this
domain wipes it.

The vault notes published here are ordinary English study notes. Nothing from
work goes in them.
