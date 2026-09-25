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

## Repo layout

```
index.html        shell
app.js            views, routing, question generation
review.js         scheduling, grading, session queue
styles.css        light and dark themes
data/vocab.json   generated from the vault — do not hand-edit
vendor/           ts-fsrs, MIT, unmodified
.github/          Pages deployment
```

## Updating it

From the vault's script folder:

```bash
cd "/Volumes/Thao-Media/Obsidian Vault/English/_System/Scripts"
./publish_site.sh
```

That regenerates `data/vocab.json`, commits it and pushes. GitHub Actions
publishes the site about a minute later. `--dry-run` shows what would change
without committing.

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
