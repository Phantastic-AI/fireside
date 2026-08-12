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
import { requireScope, READ_ROLES } from '../queries/admin';
import { principalFromCookie, type Principal } from '../workflows/account';
import { fileById, isPublicKey, type FileRow } from '../workflows/files';

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

/**
 * A private file opens for the person it belongs to, and for anyone with
 * backstage standing on the conference it was sent to. Both facts are asked
 * of the database rather than inferred from the id in the address bar.
 */
async function mayOpen(db: D1Database, principal: Principal, row: FileRow): Promise<boolean> {
  if (row.ownerKind === 'person') return row.ownerId === principal.personId;

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

    // The request's own conditional headers ride along, so a photograph that
    // has not changed comes back as a header and no bytes at all.
    const object = await c.env.FILES.get(row.r2Key, { onlyIf: c.req.raw.headers });
    if (!object) return c.notFound();

    const headers = new Headers();
    headers.set('content-type', row.contentType);
    headers.set('x-content-type-options', 'nosniff');
    headers.set(
      'content-disposition',
      disposition(SHOW_INLINE.has(row.contentType) ? 'inline' : 'attachment', row.filename)
    );
    headers.set('etag', object.httpEtag);
    headers.set(
      'cache-control',
      open ? 'public, max-age=3600' : 'private, no-store'
    );

    const body = 'body' in object ? object.body : null;
    if (!body) return new Response(null, { status: 304, headers });

    headers.set('content-length', String(object.size));
    return new Response(body, { headers });
  });
}
