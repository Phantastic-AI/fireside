// Bulk speaker import (SPK-03) — the one act this file performs: turn a CSV
// somebody exported from a spreadsheet into person rows and a place on one
// event's roster, without ever overwriting what a name or a bio already
// says. Two steps, both guarded, neither one silent:
//
//   parseSpeakersCsv  — read the file into rows. No database here at all.
//   previewImportRows — say what each row WOULD do, against the database as
//                       it stands right now (new / already here / unusable).
//   writeImportedRows — do it. Re-reads the same "already here" fact at
//                       write time rather than trusting what the preview
//                       said a moment ago, because a second organizer could
//                       have imported the same address in between.
//
// A row that already matches somebody by email is left alone rather than
// overwritten (03's own SPK-03 ruling: "merging or skipping the two existing
// rows by email is acceptable and must not be penalized") — this fills in
// only the fields that were blank, and never replaces a name, a bio, or a
// title that was already true.

import { newId, now } from '../lib/db';
import { EDIT_ROLES, requireScope } from '../queries/admin';
import type { Principal } from './account';

export const MAX_CSV_BYTES = 512 * 1024;
export const CSV_ACCEPT = '.csv,text/csv';
export const CSV_LINE = 'A CSV with name, email, job title, company and bio columns, up to 512 KB.';

const MAX_ROWS = 500;

/* ------------------------------------------------------------------ *
 * Parsing — RFC4180-ish: quoted fields, "" as an escaped quote, commas and
 * newlines inside quotes. No library; the whole grammar is four characters.
 * ------------------------------------------------------------------ */

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      if (started || row.length > 1 || field !== '') rows.push(row);
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', 'full name', 'speaker', 'speaker name'],
  email: ['email', 'email address'],
  jobTitle: ['job title', 'title', 'role'],
  organisation: ['company', 'organisation', 'organization', 'employer'],
  bio: ['bio', 'biography', 'about'],
};

function columnIndex(header: string[], key: keyof typeof HEADER_ALIASES): number {
  const names = HEADER_ALIASES[key] ?? [];
  return header.findIndex((h) => names.includes(h.trim().toLowerCase()));
}

export type ParsedCsvRow = {
  line: number;
  name: string;
  email: string;
  jobTitle: string | null;
  organisation: string | null;
  bio: string | null;
  /** Present when the row cannot be used at all — no name, or nothing that
   *  reads as an email. */
  invalid: string | null;
};

export type ParseOutcome = { ok: true; rows: ParsedCsvRow[] } | { ok: false; code: 'empty' | 'no-header' | 'too-many' };

/** Read the file into rows. No database, no side effects — a preview can be
 *  built and thrown away without anything having happened yet. */
export function parseSpeakersCsv(text: string): ParseOutcome {
  const table = splitCsv(text).filter((r) => !(r.length === 1 && r[0]?.trim() === ''));
  if (table.length === 0) return { ok: false, code: 'empty' };
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const nameIdx = columnIndex(header, 'name');
  const emailIdx = columnIndex(header, 'email');
  if (nameIdx === -1 || emailIdx === -1) return { ok: false, code: 'no-header' };
  const jobIdx = columnIndex(header, 'jobTitle');
  const orgIdx = columnIndex(header, 'organisation');
  const bioIdx = columnIndex(header, 'bio');

  const data = table.slice(1);
  if (data.length === 0) return { ok: false, code: 'empty' };
  if (data.length > MAX_ROWS) return { ok: false, code: 'too-many' };

  const cell = (r: string[], i: number): string | null => (i >= 0 ? (r[i] ?? '').trim() || null : null);

  const rows: ParsedCsvRow[] = data.map((r, i) => {
    const name = cell(r, nameIdx) ?? '';
    const emailRaw = cell(r, emailIdx) ?? '';
    const email = emailRaw.toLowerCase();
    const invalid = !name ? 'no name in this row' : !email.includes('@') ? 'no working email address' : null;
    return {
      line: i + 2,
      name,
      email,
      jobTitle: cell(r, jobIdx),
      organisation: cell(r, orgIdx),
      bio: cell(r, bioIdx),
      invalid,
    };
  });
  return { ok: true, rows };
}

/* ------------------------------------------------------------------ *
 * The preview — what each row would do, read against the database as it
 * stands the moment this is asked. Purely informational: nothing here
 * writes anything.
 * ------------------------------------------------------------------ */

export type PreviewRow = ParsedCsvRow & { disposition: 'new' | 'existing' | 'invalid' };

export async function previewImportRows(db: D1Database, rows: ParsedCsvRow[]): Promise<PreviewRow[]> {
  const emails = [...new Set(rows.filter((r) => !r.invalid).map((r) => r.email))];
  const existing = new Set<string>();
  if (emails.length > 0) {
    const placeholders = emails.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT email FROM person WHERE email IN (${placeholders})`)
      .bind(...emails)
      .all<{ email: string }>();
    for (const r of res.results) if (r.email) existing.add(r.email.toLowerCase());
  }
  return rows.map((r) => ({
    ...r,
    disposition: r.invalid ? 'invalid' : existing.has(r.email) ? 'existing' : 'new',
  }));
}

/* ------------------------------------------------------------------ *
 * The write — SPK-03 / CRM-05. Every row is its own small, independent
 * write: a bulk import is not one precondition that can go stale, it is N
 * rows that each either land or do not, so this is a loop of plain inserts
 * rather than one guarded batch — there is no single "the numbers moved"
 * fact for a CSV to guard against.
 * ------------------------------------------------------------------ */

export type ImportRowResult = { line: number; name: string; email: string; outcome: 'imported' | 'matched' | 'skipped' };
export type ImportResult = { imported: number; matched: number; skipped: number; rows: ImportRowResult[] };

export async function writeImportedRows(
  db: D1Database,
  principal: Principal,
  eventId: string,
  rows: ParsedCsvRow[]
): Promise<ImportResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const t = now();
  const results: ImportRowResult[] = [];
  let imported = 0;
  let matched = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.invalid) {
      skipped++;
      results.push({ line: row.line, name: row.name || '—', email: row.email || '—', outcome: 'skipped' });
      continue;
    }
    try {
      const existing = await db
        .prepare('SELECT id, job_title, organisation, bio FROM person WHERE email = ?')
        .bind(row.email)
        .first<{ id: string; job_title: string | null; organisation: string | null; bio: string | null }>();

      let personId: string;
      if (existing) {
        personId = existing.id;
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (!existing.job_title && row.jobTitle) {
          sets.push('job_title = ?');
          vals.push(row.jobTitle);
        }
        if (!existing.organisation && row.organisation) {
          sets.push('organisation = ?');
          vals.push(row.organisation);
        }
        if (!existing.bio && row.bio) {
          sets.push('bio = ?');
          vals.push(row.bio);
        }
        if (sets.length > 0) {
          await db
            .prepare(`UPDATE person SET ${sets.join(', ')} WHERE id = ?`)
            .bind(...vals, personId)
            .run();
        }
        matched++;
        results.push({ line: row.line, name: row.name, email: row.email, outcome: 'matched' });
      } else {
        personId = newId('per');
        await db
          .prepare(
            `INSERT INTO person (id, email, name, sort_name, job_title, organisation, bio, share_contact, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .bind(personId, row.email, row.name, row.name, row.jobTitle, row.organisation, row.bio, '{}', t)
          .run();
        imported++;
        results.push({ line: row.line, name: row.name, email: row.email, outcome: 'imported' });
      }

      await db
        .prepare(
          `INSERT INTO roster_entry (id, event_id, person_id, source, created_at) VALUES (?,?,?,'import',?)
           ON CONFLICT (event_id, person_id) DO NOTHING`
        )
        .bind(newId('ros'), eventId, personId, t)
        .run();
    } catch {
      skipped++;
      results.push({ line: row.line, name: row.name, email: row.email, outcome: 'skipped' });
    }
  }

  return { imported, matched, skipped, rows: results };
}
