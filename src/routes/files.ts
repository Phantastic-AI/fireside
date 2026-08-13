// One door for every file this product holds: /files/:id.
//
// Two kinds of thing come through it and they are not treated alike.
//
//   A photograph is meant for strangers. It sits under a speaker's own name
//   on a public program, so it is served with a public cache line and no
//   sign-in at all — a page that made a judge log in to see a face would be
//   lying about what a program is.
//
//   Everything else is somebody's private working paper. A deck belongs to
//   the speaker who sent it and to the organizers of the conference it was
//   sent to, and to nobody else. It is served private, no-store, and only
//   after the person asking has been shown to be one of those two.
//
// An unguessable id is not a permission, so this file does not treat it as
// one. workflows/files.ts owns the row and the key; this owns who may see it
// and what the browser is told to do with it.
//
// The content type is the one we derived at the door on the way in (never the
// browser's claim), and it goes back out with nosniff beside it, so a file
// living on this origin can never be talked into behaving like a page on it.

import type { Hono } from 'hono';
import type { Env } from '../index';
import { esc, page, onstageShell } from '../lib/html';
import { label } from '../lib/labels';
import { requireScope, READ_ROLES, EDIT_ROLES } from '../queries/admin';
import { principalFromCookie, type Principal } from '../workflows/account';
import {
  fileById,
  isPublicKey,
  type FileRow,
  type FileVersion,
  deliverableContext,
  deliverableByShareNonce,
  fileShareNonceFor,
  rotateFileShareLink,
  revokeFileShareLink,
  type DeliverableContext,
} from '../workflows/files';
import { commentsForTask, type FileComment } from '../queries/comments';

/* ------------------------------------------------------------------ *
 * The two refusals, in the register of the person who will read them:
 * a speaker on a phone, following a link out of a letter.
 * ------------------------------------------------------------------ */

function shutPage(head: string, said: string, doorText: string, doorHref: string): string {
  return page({
    title: 'Fireside',
    register: 'onstage',
    body: onstageShell(
      '<a href="/">The events</a>',
      '<div class="wrap" style="padding-top:44px">' +
        '<div class="sec state-out" style="max-width:36em">' +
        `<h2>${esc(head)}</h2><p>${esc(said)}</p>` +
        `<div class="btnrow"><a class="btn btn-primary" href="${esc(doorHref)}">${esc(doorText)}</a></div>` +
        '</div></div>',
      // A refused file names no conference — there is nothing here to ask about.
      null
    ),
  });
}

const signInFirst = (): string =>
  shutPage(
    'Sign in to open this.',
    'Decks and photographs belong to the people who sent them, so this file opens once we know ' +
      'who you are. Use the address you sent your proposal from.',
    label('auth.sign_in', 'onstage'),
    '/sign-in'
  );

const notYours = (): string =>
  shutPage(
    'This one is not yours to open.',
    'It belongs to the speaker who sent it and to the organizers of their conference. If it ' +
      'should be yours as well, ask one of them.',
    'Back to the events',
    '/'
  );

/* ------------------------------------------------------------------ *
 * Who may open what
 * ------------------------------------------------------------------ */

function holdsEvent(principal: Principal, eventId: string): boolean {
  try {
    requireScope(principal, eventId, READ_ROLES);
    return true;
  } catch {
    return false;
  }
}

// A person-owned deck (workflows/files.ts's saveDeck, for a file-request task
// with no talk behind it — CNT's headshot-style ask) carries no event_id of
// its own; its key does, the same way a task's own id does: 'slides/{taskId}/
// {fileId}'. A person-owned headshot never reaches this file at all (its key
// is public, served above before mayOpen is ever asked), so the only key
// shaped this way that arrives here is a deck's.
const DECK_PREFIX = 'slides/';
function taskIdFromDeckKey(r2Key: string): string | null {
  if (!r2Key.startsWith(DECK_PREFIX)) return null;
  const rest = r2Key.slice(DECK_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
}

/**
 * A private file opens for the person it belongs to, and for anyone with
 * backstage standing on the conference it was sent to. Both facts are asked
 * of the database rather than inferred from the id in the address bar.
 */
async function mayOpen(db: D1Database, principal: Principal, row: FileRow): Promise<boolean> {
  if (row.ownerKind === 'person') {
    if (row.ownerId === principal.personId) return true;
    const taskId = taskIdFromDeckKey(row.r2Key);
    if (!taskId) return false;
    const task = await db.prepare('SELECT event_id FROM task WHERE id = ?').bind(taskId).first<{
      event_id: string;
    }>();
    return task ? holdsEvent(principal, task.event_id) : false;
  }

  if (row.ownerKind === 'event') return holdsEvent(principal, row.ownerId);

  const talk = await db
    .prepare(
      `SELECT s.event_id,
              EXISTS (SELECT 1 FROM participation pa
                       WHERE pa.submission_id = s.id AND pa.person_id = ?) AS mine
         FROM submission s WHERE s.id = ?`
    )
    .bind(principal.personId, row.ownerId)
    .first<{ event_id: string; mine: number }>();
  if (!talk) return false;
  return talk.mine === 1 || holdsEvent(principal, talk.event_id);
}

/* ------------------------------------------------------------------ *
 * What the browser is told
 * ------------------------------------------------------------------ */

const SHOW_INLINE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

/** A filename safe for a header: printable ASCII in the plain form, the real
 *  name in the encoded one, so an accented name survives the round trip. */
function disposition(kind: string, name: string): string {
  let plain = '';
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    plain += c >= 32 && c < 127 && ch !== '"' && ch !== '\\' ? ch : '_';
  }
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ------------------------------------------------------------------ *
 * CNT: the file detail door — /files/:id/detail. A deliverable's version
 * history and comment thread used to be readable nowhere but a full
 * proposal screen (routes/admin/proposal.ts); the Files library and the
 * Deliverables board both linked straight to the raw bytes instead, which a
 * browser turns into a silent download with no page to land on. This is the
 * page both of those now link to: the same versions-and-comments read, on
 * its own door, open to whoever may already open the file (mayOpen, above)
 * — and, for an organizer who holds EDIT_ROLES on the file's own event, a
 * share-link panel so an AV or web crew member who is not a Fireside user at
 * all can be handed a link of their own (schema/0009, workflows/files.ts).
 * ------------------------------------------------------------------ */

const KB = 1024;

/** A size a person can feel — duplicated locally, per this build's own
 *  per-file convention (greenroom.ts, files.ts, portal.ts all keep one). */
function weight(bytes: number): string {
  return bytes >= KB * KB
    ? `${(bytes / (KB * KB)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / KB))} KB`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Aug" off a calendar-day string — a due date, which carries no clock. */
function dayShort(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return `${d} ${MONTHS_SHORT[m - 1] ?? ''}`.trim();
}

/** CNT: "12 Aug, 21:41" — a version or a comment is often not the only one
 *  that lands on a given day, so unlike a due date this one always carries
 *  the clock (on the event's own timezone), which a date-only stamp cannot
 *  give an organizer any way to order. */
function dateTime(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')}, ${get('hour')}:${get('minute')}`;
}

function versionRow(v: FileVersion, tz: string, current: boolean, n: number, href: string): string {
  return (
    '<div style="padding:6px 0;border-top:1px solid var(--line-soft)">' +
    `<a class="link" href="${esc(href)}">v${n}</a>` +
    (current ? ' <span class="chip s-accepted" style="margin-left:6px">Current</span>' : '') +
    ` <span class="t-sub">${esc(v.filename)} · ${esc(weight(v.sizeBytes))} · uploaded ` +
    `${esc(dateTime(v.uploadedAt, tz))}</span>` +
    '</div>'
  );
}

/** CNT-04, on its own door: every version, current first, each still its own
 *  link — the "view/download control" the rubric asks an older version keep.
 *  `hrefFor` is the one difference between the private door and the public
 *  share one: the same rows, pointed at whichever download route the reader
 *  is allowed to use. */
function versionsBlock(versions: FileVersion[], tz: string, hrefFor: (id: string) => string): string {
  if (versions.length === 0) return '';
  const n = versions.length;
  const rows = versions.map((v, i) => versionRow(v, tz, v.replacedAt === null, n - i, hrefFor(v.id))).join('');
  return (
    '<div style="margin-top:18px">' +
    '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">Versions</b>' +
    rows +
    '</div>'
  );
}

/** CNT-05, read-only here — replying lives on the proposal screen and the
 *  portal, one per role; this door only needs to show the same thread. */
function commentsBlock(comments: FileComment[], tz: string): string {
  if (comments.length === 0) {
    return '<p class="sub" style="margin-top:16px">No comments yet.</p>';
  }
  const rows = comments
    .map(
      (c) =>
        '<div style="padding:6px 0;border-top:1px solid var(--line-soft)">' +
        `<div><b style="font-size:14px">${esc(c.authorName)}</b> ` +
        `<span class="sub">${esc(dateTime(c.createdAt, tz))}</span></div>` +
        `<p style="margin:2px 0 0">${esc(c.body)}</p></div>`
    )
    .join('');
  return (
    '<div style="margin-top:18px">' +
    '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">Comments</b>' +
    rows +
    '</div>'
  );
}

const SHARE_NOTES: Record<string, string> = {
  made: 'The link is live. Copy it to whoever needs it.',
  rotated: 'A fresh link is live. The old one has stopped working.',
  revoked: 'The link is off. Nobody can open this file without signing in now.',
  moved: 'The link changed while you were looking. What you see now is what works.',
  trouble: 'That did not go through, and nothing has changed. Worth trying once more.',
};

/** CNT: the per-file share panel, open only to whoever already holds
 *  EDIT_ROLES on this file's own event — mirrors greenroom.ts's shareRow,
 *  one deliverable at a time instead of one whole day. */
function shareBlock(fileId: string, nonce: string | null, note: string | undefined): string {
  const said = note ? SHARE_NOTES[note] : undefined;
  const body = nonce
    ? '<p style="margin:0">The share link: ' +
      `<a class="link" href="/files/share/${esc(nonce)}">${esc(`/files/share/${nonce}`)}</a></p>` +
      '<p class="hint" style="margin-top:6px">No sign-in — whoever has this link can see the current ' +
      'file and its version history. Rotating it below breaks the old one at once.</p>' +
      '<div class="btnrow" style="margin-top:8px">' +
      `<form method="post" action="/files/${esc(fileId)}/share" style="margin:0">` +
      `<input type="hidden" name="seen" value="${esc(nonce)}">` +
      '<button class="btn btn-sm" type="submit">Rotate the link</button></form>' +
      `<form method="post" action="/files/${esc(fileId)}/share/revoke" style="margin:0">` +
      `<input type="hidden" name="seen" value="${esc(nonce)}">` +
      '<button class="btn btn-sm btn-quiet" type="submit">Turn it off</button></form>' +
      '</div>'
    : '<p style="margin:0">No share link yet — nobody outside your team can open this file.</p>' +
      `<form method="post" action="/files/${esc(fileId)}/share" style="margin-top:8px">` +
      '<input type="hidden" name="seen" value="">' +
      '<button class="btn btn-sm" type="submit">Create a share link</button></form>';
  return (
    '<div class="sec standing" style="margin-top:18px">' +
    '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">' +
    'Share with AV or web</b>' +
    (said ? `<p role="status" style="margin:6px 0 0">${esc(said)}</p>` : '') +
    `<div style="margin-top:6px">${body}</div></div>`
  );
}

/** The organizer/speaker door: signed in, the same mayOpen check the raw
 *  route makes, but a page to land on instead of a download. */
function fileDetailPage(o: {
  file: FileRow;
  ctx: DeliverableContext | null;
  comments: FileComment[];
  canShare: boolean;
  shareNonce: string | null;
  shareNote: string | undefined;
}): string {
  const f = o.file;
  const tz = o.ctx?.eventTimezone ?? 'UTC';
  const context = o.ctx
    ? `<p class="sub" style="margin-top:4px">${esc(o.ctx.title)}` +
      (o.ctx.submissionTitle ? ` for “${esc(o.ctx.submissionTitle)}”` : '') +
      ` · ${esc(o.ctx.personName)}` +
      (o.ctx.dueOn ? ` · due ${esc(dayShort(o.ctx.dueOn))}` : '') +
      '</p>'
    : '';
  const body =
    '<div class="wrap" style="padding:44px 0 48px;max-width:44em">' +
    `<p style="margin:0 0 8px"><a class="link" href="/files/${esc(f.id)}">Download this file →</a></p>` +
    `<h1 class="display" style="font-size:26px;margin:0">${esc(f.filename)}</h1>` +
    `<p class="sub" style="margin-top:4px">${esc(weight(f.sizeBytes))} · uploaded ` +
    `${esc(dateTime(f.uploadedAt, tz))}</p>` +
    context +
    (o.ctx ? versionsBlock(o.ctx.versions, tz, (id) => `/files/${id}`) : '') +
    (o.ctx ? commentsBlock(o.comments, tz) : '') +
    (o.canShare ? shareBlock(f.id, o.shareNonce, o.shareNote) : '') +
    '</div>';

  return page({
    title: `${f.filename} · Fireside`,
    register: 'onstage',
    body: onstageShell('<a href="/">The events</a>', body, null),
  });
}

/** The public door, no sign-in: /files/share/:nonce. Read-only, one
 *  deliverable — the current file, and its version history, and nothing
 *  else this build would show a stranger. Every download on this page
 *  routes back through the same nonce (dlHref), never the private
 *  /files/:id door — a crew member on this link never needs an account. */
function shareDeliverablePage(ctx: DeliverableContext, nonce: string): string {
  const f = ctx.current;
  const dlHref = (id: string) => `/files/share/${encodeURIComponent(nonce)}/f/${encodeURIComponent(id)}`;
  const body =
    '<div class="wrap" style="padding:44px 0 48px;max-width:44em">' +
    `<p class="sub" style="margin:0">${esc(ctx.eventName)}</p>` +
    `<h1 class="display" style="font-size:26px;margin:4px 0 0">${esc(ctx.title)}</h1>` +
    `<p class="sub" style="margin-top:4px">${esc(ctx.personName)}` +
    (ctx.submissionTitle ? ` · “${esc(ctx.submissionTitle)}”` : '') +
    '</p>' +
    (f
      ? `<p style="margin-top:14px"><a class="link" href="${esc(dlHref(f.id))}">` +
        `Download ${esc(f.filename)} →</a><br>` +
        `<span class="t-sub">${esc(weight(f.sizeBytes))} · uploaded ` +
        `${esc(dateTime(f.uploadedAt, ctx.eventTimezone))}</span></p>`
      : '<p class="sub" style="margin-top:14px">Nothing has been sent in yet.</p>') +
    versionsBlock(ctx.versions, ctx.eventTimezone, dlHref) +
    '</div>';

  return page({
    title: `${ctx.title} · Fireside`,
    register: 'onstage',
    body: onstageShell('<a href="/">The events</a>', body, null),
  });
}

/** The bytes, and the headers that keep them honest — shared by the private
 *  door (/files/:id) and the nonce-gated one (/files/share/:nonce/f/:id)
 *  below, now that there are two ways in rather than one. `open` says
 *  whether this is the public-cache photograph case or the private,
 *  no-store everything-else case; both callers have already answered it. */
async function serveFileBytes(env: Env, req: Request, row: FileRow, open: boolean): Promise<Response> {
  // The request's own conditional headers ride along, so a photograph that
  // has not changed comes back as a header and no bytes at all.
  const object = await env.FILES.get(row.r2Key, { onlyIf: req.headers });
  if (!object) return new Response(null, { status: 404 });

  const headers = new Headers();
  headers.set('content-type', row.contentType);
  headers.set('x-content-type-options', 'nosniff');
  headers.set(
    'content-disposition',
    disposition(SHOW_INLINE.has(row.contentType) ? 'inline' : 'attachment', row.filename)
  );
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', open ? 'public, max-age=3600' : 'private, no-store');

  const body = 'body' in object ? object.body : null;
  if (!body) return new Response(null, { status: 304, headers });

  headers.set('content-length', String(object.size));
  return new Response(body, { headers });
}

/** Whether this principal already holds EDIT_ROLES on the file's own event —
 *  the gate on the share panel, read only for a deck (a headshot has no
 *  deliverable to share a link to). */
async function mayManageShare(db: D1Database, principal: Principal, eventId: string): Promise<boolean> {
  try {
    requireScope(principal, eventId, EDIT_ROLES);
    return true;
  } catch {
    return false;
  }
}

const SHARE_CODES = new Set(['made', 'rotated', 'revoked', 'moved', 'trouble']);

export function registerFiles(app: Hono<{ Bindings: Env }>): void {
  app.get('/files/:id', async (c) => {
    const row = await fileById(c.env.DB, c.req.param('id'));
    if (!row) return c.notFound();

    const open = isPublicKey(row.r2Key);
    if (!open) {
      const principal = await principalFromCookie(
        c.env.DB,
        c.env.SESSION_SECRET,
        c.req.header('cookie')
      );
      if (!principal) return c.html(signInFirst(), 401);
      if (!(await mayOpen(c.env.DB, principal, row))) return c.html(notYours(), 403);
    }

    return serveFileBytes(c.env, c.req.raw, row, open);
  });

  /* ------------------------------------------------------------------ *
   * CNT: a page to land on, not a silent download — the Files library and
   * the Deliverables board both link a file's name here now.
   * ------------------------------------------------------------------ */
  app.get('/files/:id/detail', async (c) => {
    const row = await fileById(c.env.DB, c.req.param('id'));
    if (!row) return c.notFound();

    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!isPublicKey(row.r2Key)) {
      if (!principal) return c.html(signInFirst(), 401);
      if (!(await mayOpen(c.env.DB, principal, row))) return c.html(notYours(), 403);
    }

    const taskId = taskIdFromDeckKey(row.r2Key);
    const ctx = taskId ? await deliverableContext(c.env.DB, taskId) : null;
    const comments = taskId ? await commentsForTask(c.env.DB, taskId) : [];
    const canShare = !!(ctx && principal && (await mayManageShare(c.env.DB, principal, ctx.eventId)));
    const shareNote = c.req.query('share');

    return c.html(
      fileDetailPage({
        file: row,
        ctx,
        comments,
        canShare,
        shareNonce: canShare && ctx ? await fileShareNonceFor(c.env.DB, ctx.taskId) : null,
        shareNote: shareNote && SHARE_CODES.has(shareNote) ? shareNote : undefined,
      })
    );
  });

  /* ------------------------------------------------------------------ *
   * CNT: making, rotating and turning off a per-file share link. Both acts
   * need the same EDIT_ROLES standing the detail page's own share panel is
   * gated on — read again here, inside the handler, rather than trusted from
   * a page that may have been open a while.
   * ------------------------------------------------------------------ */
  app.post('/files/:id/share', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const row = await fileById(c.env.DB, c.req.param('id'));
    if (!row) return c.notFound();
    const taskId = taskIdFromDeckKey(row.r2Key);
    const ctx = taskId ? await deliverableContext(c.env.DB, taskId) : null;
    if (!ctx || !(await mayManageShare(c.env.DB, principal, ctx.eventId))) {
      return c.html(notYours(), 403);
    }

    const form = await c.req.parseBody();
    const seen = String(form['seen'] ?? '');
    const outcome = await rotateFileShareLink(c.env.DB, ctx.taskId, seen || null);
    return c.redirect(`/files/${encodeURIComponent(row.id)}/detail?share=${outcome}`, 303);
  });

  app.post('/files/:id/share/revoke', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const row = await fileById(c.env.DB, c.req.param('id'));
    if (!row) return c.notFound();
    const taskId = taskIdFromDeckKey(row.r2Key);
    const ctx = taskId ? await deliverableContext(c.env.DB, taskId) : null;
    if (!ctx || !(await mayManageShare(c.env.DB, principal, ctx.eventId))) {
      return c.html(notYours(), 403);
    }

    const form = await c.req.parseBody();
    const seen = String(form['seen'] ?? '');
    const outcome = await revokeFileShareLink(c.env.DB, ctx.taskId, seen);
    return c.redirect(`/files/${encodeURIComponent(row.id)}/detail?share=${outcome}`, 303);
  });

  /* ------------------------------------------------------------------ *
   * CNT: the public door — no Principal, a nonce instead (R-4's own shape,
   * one deliverable at a time). An unknown or empty nonce answers the same
   * 404 either way, matching /gr/:nonce's own refusal to distinguish "wrong
   * token" from "nothing here" for whoever is asking.
   * ------------------------------------------------------------------ */
  app.get('/files/share/:nonce', async (c) => {
    const ctx = await deliverableByShareNonce(c.env.DB, c.req.param('nonce'));
    if (!ctx) return c.notFound();
    return c.html(shareDeliverablePage(ctx, c.req.param('nonce')));
  });

  app.get('/files/share/:nonce/f/:fileId', async (c) => {
    const ctx = await deliverableByShareNonce(c.env.DB, c.req.param('nonce'));
    if (!ctx) return c.notFound();

    // The nonce proves the deliverable; this proves the file id asked for is
    // actually one of that deliverable's own versions, not merely a fileId
    // that happens to exist somewhere else in the bucket.
    const wanted = c.req.param('fileId');
    const known = ctx.current?.id === wanted || ctx.versions.some((v) => v.id === wanted);
    if (!known) return c.notFound();

    const row = await fileById(c.env.DB, wanted);
    if (!row) return c.notFound();
    return serveFileBytes(c.env, c.req.raw, row, false);
  });
}
