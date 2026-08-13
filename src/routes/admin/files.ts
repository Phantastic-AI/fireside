// CNT-13/CNT-14 — the files library: every deliverable an organizer has ever
// been sent, aggregated in one place, with a bulk download of the latest
// version of whichever ones a organizer selects.
//
// The read is workflows/files.ts `deliverableRows()` — the same task-centric
// read the Deliverables board (greenroom.ts) uses, filtered to rows that
// actually have a current file. One source for "what has been sent in"
// across both screens, so a version count here and on the board can never
// disagree.
//
// The export is a real ZIP, built in the Worker with fflate (pure JS, no
// native zlib) — not a queued placeholder. Selecting → reviewing the
// grouping and the set → generating is the same two-step shape as the
// outbox's own two-pass sends (D-024), except nothing here is guarded on a
// count: a download costs nobody anything to redo, so there is no "someone
// else got there first" to protect against.

import type { Hono } from 'hono';
import { zipSync, type Zippable } from 'fflate';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { adminEvents, requireScope, READ_ROLES, ScopeError, type AdminEvent } from '../../queries/admin';
import { reviewerOnly } from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { deliverableRows, fileById, type DeliverableRow } from '../../workflows/files';

/* ------------------------------------------------------------------ *
 * Small words and numbers — duplicated locally per this build's own
 * per-file convention (see greenroom.ts, agenda.ts, outbox.ts).
 * ------------------------------------------------------------------ */

const num = (x: number): string => x.toLocaleString('en-US');
const plural = (x: number, one: string, many: string): string =>
  x === 1 ? `1 ${one}` : `${num(x)} ${many}`;

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((p) => p !== '')
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '·';

const KB = 1024;
const weight = (bytes: number): string =>
  bytes >= KB * KB
    ? `${(bytes / (KB * KB)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / KB))} KB`;

function dShort(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', month: 'short' }).format(
    new Date(ms)
  );
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/* ------------------------------------------------------------------ *
 * Access — the same eventFor shape every backstage screen in this build
 * uses (greenroom.ts, outbox.ts): adminEvents() already scopes to what this
 * principal may see, and a reviewer's standing is the reading room only —
 * files carry the same names a blind round exists to keep from them.
 * ------------------------------------------------------------------ */

async function eventFor(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<AdminEvent | undefined> {
  const events = await adminEvents(db, principal);
  const ev = events.find((e) => e.slug === slug);
  return ev && reviewerOnly(principal, ev.id) ? undefined : ev;
}

/* ------------------------------------------------------------------ *
 * The library — CNT-13
 * ------------------------------------------------------------------ */

const SELECT_CAP = 50;

function libraryRow(r: DeliverableRow, tz: string): string {
  const f = r.file;
  if (!f) return '';
  const who = r.submissionTitle
    ? `<span class="t-name">${esc(r.submissionTitle)}</span><br><span class="t-sub">${esc(r.personName)}</span>`
    : `<span class="t-name">${esc(r.personName)}</span>`;
  const versions =
    r.versionCount > 1 ? esc(plural(r.versionCount, 'version', 'versions')) : '1 version';
  return (
    '<tr>' +
    `<td><input type="checkbox" name="file" value="${esc(f.id)}" aria-label="Choose ${esc(f.filename)}"></td>` +
    `<td><a class="link" href="/files/${esc(f.id)}">${esc(f.filename)}</a><br>` +
    `<span class="t-sub">${esc(r.title)} · ${esc(weight(f.sizeBytes))}</span></td>` +
    `<td>${who}</td>` +
    '<td style="white-space:nowrap">' +
    `${esc(dShort(f.uploadedAt, tz))}<br><span class="t-sub">${versions}</span></td>` +
    '</tr>'
  );
}

function libraryPage(principal: Principal, ev: AdminEvent, rows: DeliverableRow[]): string {
  const slug = ev.slug;
  const withFile = rows.filter((r) => r.file !== null);

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Files</h1>' +
    '<p class="counts">' +
    (withFile.length ? `<b>${esc(plural(withFile.length, 'file', 'files'))}</b>` : '<b>Nothing sent in yet</b>') +
    `<span class="sep">·</span>${esc(ev.tzLabel ?? ev.timezone)}</p></div>`;

  let body: string;
  if (withFile.length === 0) {
    body =
      '<div class="sec state-out"><h2>Nothing sent in yet.</h2>' +
      '<p>Every deliverable a speaker sends turns up here, whichever proposal or task it was asked ' +
      `against. <a class="link" href="/admin/${encodeURIComponent(slug)}/slides">See what has been asked for →</a></p></div>`;
  } else {
    body =
      `<form method="get" action="/admin/${encodeURIComponent(slug)}/files/export">` +
      '<div class="tablewrap" style="margin-top:16px"><table class="t"><thead><tr>' +
      '<th></th><th>File</th><th>Session / speaker</th><th>Uploaded</th></tr></thead><tbody>' +
      withFile.map((r) => libraryRow(r, ev.timezone)).join('') +
      '</tbody></table></div>' +
      '<div class="btnrow" style="margin-top:14px">' +
      '<button class="btn btn-primary" type="submit">Download selected →</button></div>' +
      '<p class="hint" style="margin-top:8px">Choose one or more, then pick how to group them. Each ' +
      'download carries the latest version only.</p>' +
      '</form>';
  }

  return page({
    title: `Files · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: slug,
      eventName: ev.name,
      here: '/files',
      who: `${principal.name} · ${cap(ev.standing)}`,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body: head + body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * The export dialog — CNT-14, first pass: name the set, offer grouping,
 * let a file be dropped before anything is built.
 * ------------------------------------------------------------------ */

function exportPage(principal: Principal, ev: AdminEvent, chosen: DeliverableRow[], note: string | undefined): string {
  const slug = ev.slug;
  const rows = chosen
    .map((r) => {
      const f = r.file!;
      const who = r.submissionTitle ? `${r.submissionTitle} · ${r.personName}` : r.personName;
      return (
        '<label style="display:flex;gap:10px;align-items:baseline;padding:8px 0;' +
        'border-bottom:1px solid var(--line-soft)">' +
        `<input type="checkbox" name="file" value="${esc(f.id)}" checked>` +
        `<span><b>${esc(f.filename)}</b> — ${esc(who)}<br><span class="t-sub">${esc(r.title)}</span></span>` +
        '</label>'
      );
    })
    .join('');

  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Download files</h1>' +
    `<p class="counts"><b>${esc(plural(chosen.length, 'file', 'files'))} chosen</b></p></div>` +
    (note ? `<div class="sec standing" role="status"><p style="margin:0">${esc(note)}</p></div>` : '') +
    `<form method="post" action="/admin/${encodeURIComponent(slug)}/files/export">` +
    '<div class="sec" style="max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:8px">Group the download</h2>' +
    '<label class="f" style="flex-direction:row;align-items:center;gap:8px;margin-bottom:8px">' +
    '<input type="radio" name="group" value="none" checked style="width:auto">' +
    '<span>One folder</span></label>' +
    '<label class="f" style="flex-direction:row;align-items:center;gap:8px">' +
    '<input type="radio" name="group" value="session" style="width:auto">' +
    '<span>One folder per session (or speaker, when there is no session)</span></label>' +
    '</div>' +
    '<div class="sec" style="max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:8px">What goes in</h2>' +
    rows +
    '</div>' +
    '<div class="btnrow" style="margin-top:16px">' +
    '<button class="btn btn-primary" type="submit">Generate download</button>' +
    `<a class="btn" href="/admin/${encodeURIComponent(slug)}/files">Start over</a></div>` +
    '<p class="hint" style="margin-top:10px">Every file is the latest version sent in — earlier ones ' +
    'stay on the proposal they belong to.</p>' +
    '</form>';

  return page({
    title: `Download files · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: slug,
      eventName: ev.name,
      here: '/files',
      who: `${principal.name} · ${cap(ev.standing)}`,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Building the archive
 * ------------------------------------------------------------------ */

function pathSafe(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|]/g, '-').trim();
  return cleaned.slice(0, 80) || 'file';
}

function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Reads each chosen file's current bytes out of R2 and zips them in memory —
 *  small enough at one conference's scale (a handful of decks, capped at 15
 *  MB apiece) to do inside one request rather than behind a queue. */
async function buildZip(env: Env, rows: DeliverableRow[], group: boolean): Promise<Uint8Array> {
  const data: Zippable = {};
  const used = new Set<string>();
  for (const r of rows) {
    if (!r.file) continue;
    const row = await fileById(env.DB, r.file.id);
    if (!row) continue;
    const object = await env.FILES.get(row.r2Key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());

    const folder = group ? pathSafe(r.submissionTitle ?? r.personName) : '';
    const baseName = group ? row.filename : `${pathSafe(r.personName)} - ${row.filename}`;
    let name = baseName;
    let path = folder ? `${folder}/${name}` : name;
    for (let n = 2; used.has(path); n++) {
      name = withSuffix(baseName, n);
      path = folder ? `${folder}/${name}` : name;
    }
    used.add(path);
    data[path] = bytes;
  }
  return zipSync(data, { level: 6 });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerFilesLibrary(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/files', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, READ_ROLES);

      const rows = await deliverableRows(c.env.DB, ev.id);
      return c.html(libraryPage(principal, ev, rows));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // First pass: the chosen set, and the grouping choice to make about it.
  // Nothing is read out of R2 yet — a GET here costs nothing to reload.
  app.get('/admin/:eventSlug/files/export', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, READ_ROLES);

      const ids = new Set(c.req.queries('file') ?? []);
      const all = await deliverableRows(c.env.DB, ev.id);
      const chosen = all.filter((r) => r.file && ids.has(r.file.id)).slice(0, SELECT_CAP);

      if (chosen.length === 0) {
        return c.html(libraryPage(principal, ev, all), 200);
      }
      return c.html(exportPage(principal, ev, chosen, undefined));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // Second pass: build the archive and start the download. The set is
  // re-read against this event's own deliverables rather than trusted from
  // the form — a file id that is not actually a current deliverable here
  // never reaches R2.
  app.post('/admin/:eventSlug/files/export', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, READ_ROLES);

      const form = await c.req.parseBody({ all: true });
      const raw = form['file'];
      const ids = new Set(Array.isArray(raw) ? raw.map(String) : raw !== undefined ? [String(raw)] : []);
      const group = String(form['group'] ?? '') === 'session';

      const all = await deliverableRows(c.env.DB, ev.id);
      const chosen = all.filter((r) => r.file && ids.has(r.file.id)).slice(0, SELECT_CAP);

      if (chosen.length === 0) {
        return c.html(exportPage(principal, ev, [], 'Nothing was chosen, so nothing was built.'));
      }

      const zip = await buildZip(c.env, chosen, group);
      const name = `${ev.slug}-files.zip`;
      return new Response(zip, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': String(zip.byteLength),
        },
      });
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });
}
