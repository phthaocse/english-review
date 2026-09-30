// Queries against the canonical store.
//
// Plain SQL on purpose: D1 is SQLite-compatible, so the same statements run in
// tests against node:sqlite. No ORM to diverge between the two.

/** Insert a reviewed draft. Returns the new id, or null if the term already exists. */
export async function createItem(db, item, userId) {
  const row = await db.prepare(`
    INSERT INTO item (term, kind, meaning, vi, ipa, cefr, pattern, rule, notes, status, source, source_note, captured_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (term, kind) DO NOTHING
    RETURNING id
  `).bind(
    item.term, item.kind, item.meaning ?? null, item.vi ?? null,
    item.ipa ?? null, item.cefr ?? null,
    item.pattern ?? null, item.rule ?? null, item.notes ?? null,
    item.status ?? 'captured', item.source ?? 'typed', item.source_note ?? null, userId,
  ).first();

  if (!row) return null;          // already captured; caller decides what to say
  const id = row.id;

  const examples = (item.examples || []).filter((t) => t && t.trim());
  for (const [position, text] of examples.entries()) {
    await db.prepare('INSERT INTO example (item_id, text, position) VALUES (?, ?, ?)')
      .bind(id, text.trim(), position).run();
  }
  for (const tag of item.tags || []) {
    await db.prepare('INSERT OR IGNORE INTO tag (item_id, tag) VALUES (?, ?)').bind(id, tag).run();
  }
  return id;
}

/**
 * Meeting a word again is not a mistake to reject - it is usually a second
 * sentence, or the preposition you did not have last time. So a repeat adds to
 * what is there instead of bouncing off it.
 *
 * Blank fields get filled; fields that already hold something do not, because
 * what is there was either checked against a dictionary or typed by hand, and a
 * fresh reading of a photograph is not grounds to overwrite either.
 */
export async function mergeIntoItem(db, existing, item) {
  const added = { fields: [], examples: 0 };

  const fillable = ['meaning', 'vi', 'ipa', 'cefr', 'pattern', 'rule', 'notes', 'source_note'];
  const sets = [], values = [];
  for (const field of fillable) {
    if (!existing[field] && item[field]) {
      sets.push(`${field} = ?`);
      values.push(item[field]);
      added.fields.push(field);
    }
  }

  // Examples accumulate. The same sentence twice is noise, so compare on text.
  const rows = await db.prepare('SELECT text FROM example WHERE item_id = ? ORDER BY position')
    .bind(existing.id).all();
  const have = (rows?.results || []).map((r) => r.text);
  const seen = new Set(have.map((s) => s.trim().toLowerCase()));
  let position = have.length;
  for (const raw of (item.examples || [])) {
    const text = (raw || '').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    await db.prepare('INSERT INTO example (item_id, text, position) VALUES (?, ?, ?)')
      .bind(existing.id, text, position++).run();
    added.examples += 1;
  }

  for (const tag of item.tags || []) {
    await db.prepare('INSERT OR IGNORE INTO tag (item_id, tag) VALUES (?, ?)').bind(existing.id, tag).run();
  }

  // A row that gained something is a row the next sync has to carry over.
  if (sets.length || added.examples) {
    sets.push("updated_at = datetime('now')");
    await db.prepare(`UPDATE item SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, existing.id).run();
  }
  return added;
}

export async function findItemByTerm(db, term, kind) {
  return db.prepare('SELECT * FROM item WHERE term = ? AND kind = ?').bind(term, kind).first();
}

export async function getItem(db, id) {
  const item = await db.prepare('SELECT * FROM item WHERE id = ?').bind(id).first();
  if (!item) return null;
  const [examples, senses, tags] = await Promise.all([
    db.prepare('SELECT text FROM example WHERE item_id = ? ORDER BY position').bind(id).all(),
    db.prepare('SELECT gloss, vi, example FROM sense WHERE item_id = ? ORDER BY position').bind(id).all(),
    db.prepare('SELECT tag FROM tag WHERE item_id = ?').bind(id).all(),
  ]);
  return {
    ...item,
    examples: examples.results.map((r) => r.text),
    senses: senses.results,
    tags: tags.results.map((r) => r.tag),
  };
}

/** Most recent items first — what the capture screen shows underneath the form. */
export async function listItems(db, { status = null, limit = 50, offset = 0 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const from = Math.max(Number(offset) || 0, 0);
  const sql = status
    ? 'SELECT * FROM item WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM item ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  const stmt = status
    ? db.prepare(sql).bind(status, capped, from)
    : db.prepare(sql).bind(capped, from);
  const { results } = await stmt.all();
  return results;
}

export async function countItems(db) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS total, SUM(status = 'captured') AS captured FROM item",
  ).first();
  return { total: row?.total ?? 0, captured: row?.captured ?? 0 };
}

/**
 * Count one use against a daily quota and say whether it was allowed.
 *
 * The increment happens first so two concurrent requests cannot both read the
 * old value and both be let through.
 */
export async function consumeQuota(db, userId, kind, limit, today = new Date().toISOString().slice(0, 10)) {
  await db.prepare(`
    INSERT INTO usage_counter (user_id, day, kind, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (user_id, day, kind) DO UPDATE SET count = count + 1
  `).bind(userId, today, kind).run();

  const row = await db.prepare(
    'SELECT count FROM usage_counter WHERE user_id = ? AND day = ? AND kind = ?',
  ).bind(userId, today, kind).first();

  const used = row?.count ?? 0;
  return { allowed: used <= limit, used, limit, remaining: Math.max(0, limit - used) };
}

/** Record one photo read - the whole point is that a failure leaves a trace. */
export async function logVision(db, userId, entry) {
  const row = await db.prepare(`
    INSERT INTO vision_log (user_id, at, ok, duration_ms, image_kb, model, items, attempts, error)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    userId, entry.ok ? 1 : 0, entry.durationMs ?? 0, entry.imageKb ?? null,
    entry.model ?? null, entry.items ?? null,
    JSON.stringify(entry.attempts ?? []), entry.error ?? null,
  ).first();
  return row?.id ?? null;
}

export async function listVisionLogs(db, userId, limit = 20) {
  const { results } = await db.prepare(
    'SELECT * FROM vision_log WHERE user_id = ? ORDER BY id DESC LIMIT ?',
  ).bind(userId, Math.min(Number(limit) || 20, 100)).all();

  return (results || []).map((row) => ({
    ...row,
    ok: !!row.ok,
    attempts: JSON.parse(row.attempts || '[]'),
  }));
}
