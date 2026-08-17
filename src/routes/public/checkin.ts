// T611 — the check-in sheet a volunteer holds.
//
// No account, no role: the organizer minted a link with this person's name on
// it, and the link IS their standing. It opens today's run of show and does
// exactly one kind of write — this session's speaker has arrived, or that
// mark was a mistake, take it back. Every mark is stamped with the link's own
// name and the time, so the green room always knows which hands, which door,
// and when.
//
// The nonce follows the green room's own discipline (/gr/:nonce): a wrong or
// revoked link is a plain not-found, indistinguishable from a URL that never
// existed. What this surface can never do: see the pile, the people, the
// reviews, or anything that is not today's schedule.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page } from '../../lib/html';
import { newId, now } from '../../lib/db';
import { greenRoom } from '../../queries/admin';

type Link = { id: string; event_id: string; name: string; slug: string; event_name: string };

async function linkByNonce(db: D1Database, nonce: string): Promise<Link | null> {
  if (!nonce) return null;
  return await db
    .prepare(
      `SELECT cl.id, cl.event_id, cl.name, e.slug, e.name AS event_name
         FROM checkin_link cl JOIN event e ON e.id = cl.event_id
        WHERE cl.nonce = ? AND cl.revoked_at IS NULL`
    )
    .bind(nonce)
    .first<Link>();
}

type Mark = { submission_id: string; marked_at: number; who: string };

export function registerCheckin(app: Hono<{ Bindings: Env }>): void {
  app.get('/ci/:nonce', async (c) => {
    const link = await linkByNonce(c.env.DB, c.req.param('nonce'));
    if (!link) return c.notFound();
    const day = c.req.query('day') || undefined;
    const gr = await greenRoom(c.env.DB, link.event_id, day);
    if (!gr) return c.notFound();

    const marksRes = await c.env.DB
      .prepare(
        `SELECT ci.submission_id, ci.marked_at, cl.name AS who
           FROM checkin ci JOIN checkin_link cl ON cl.id = ci.link_id
           JOIN submission s ON s.id = ci.submission_id
          WHERE s.event_id = ?`
      )
      .bind(link.event_id)
      .all<Mark>();
    const marks = new Map((marksRes.results ?? []).map((m) => [m.submission_id, m]));

    const t = (ms: number): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: gr.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));

    const dayRow =
      gr.days.length > 1
        ? '<p class="sub" style="margin:6px 0 0">' +
          gr.days
            .map((d) =>
              d === gr.day
                ? `<b>${esc(d)}</b>`
                : `<a class="link" href="/ci/${esc(c.req.param('nonce'))}?day=${esc(d)}">${esc(d)}</a>`
            )
            .join(' · ') +
          '</p>'
        : '';

    const rows = gr.sessions
      .filter((s) => !s.cancelled)
      .map((s) => {
        const m = marks.get(s.id);
        const stamp = m
          ? `<span class="sub">arrived ${esc(t(m.marked_at))} · ${esc(m.who)}</span>`
          : '<span class="sub">not yet</span>';
        const btn = m
          ? `<button class="btn btn-sm btn-quiet" type="submit" name="on" value="0">Take it back</button>`
          : `<button class="btn btn-sm btn-primary" type="submit" name="on" value="1">Mark arrived</button>`;
        return (
          '<div class="card card-pad" style="margin-bottom:10px">' +
          `<div style="font-weight:640">${esc(t(s.startsAt))} · ${esc(s.title)}</div>` +
          `<div class="sub" style="margin-top:2px">${esc(
            s.speakers.map((p) => p.name).join(', ')
          )}${s.roomName ? ` · ${esc(s.roomName)}` : ''}</div>` +
          `<form method="post" action="/ci/${esc(c.req.param('nonce'))}/mark" ` +
          'style="display:flex;gap:10px;align-items:center;margin-top:8px">' +
          `<input type="hidden" name="session" value="${esc(s.id)}">` +
          `<input type="hidden" name="day" value="${esc(gr.day)}">` +
          btn +
          stamp +
          '</form></div>'
        );
      })
      .join('');

    const body =
      '<div class="wrap" style="padding:26px 0;max-width:38em">' +
      `<div class="kicker">Check-in · ${esc(link.name)}</div>` +
      `<h1 class="display" style="font-size:26px;margin:8px 0 2px">${esc(link.event_name)}</h1>` +
      dayRow +
      '<p class="sub" style="margin:10px 0 16px">Tap when the speaker is in the building. ' +
      'Every mark carries your link&#39;s name and the time.</p>' +
      (rows || '<p class="sub">Nothing is placed on this day.</p>') +
      '</div>';

    c.header('cache-control', 'private, no-store');
    return c.html(page({ title: `Check-in · ${link.event_name}`, register: 'backstage', body }));
  });

  app.post('/ci/:nonce/mark', async (c) => {
    const link = await linkByNonce(c.env.DB, c.req.param('nonce'));
    if (!link) return c.notFound();
    const form = await c.req.parseBody();
    const session = typeof form['session'] === 'string' ? form['session'] : '';
    const on = form['on'] === '1';
    const day = typeof form['day'] === 'string' ? form['day'] : '';
    if (session) {
      if (on) {
        // First mark wins: a second link marking the same session changes
        // nothing, so the stamp always names the hands that actually did it.
        await c.env.DB
          .prepare(
            `INSERT OR IGNORE INTO checkin (submission_id, link_id, marked_at)
             SELECT s.id, ?2, ?3 FROM submission s
              WHERE s.id = ?1 AND s.event_id = ?4 AND s.state = 'accepted'`
          )
          .bind(session, link.id, now(), link.event_id)
          .run();
      } else {
        await c.env.DB
          .prepare(
            `DELETE FROM checkin WHERE submission_id IN
               (SELECT id FROM submission WHERE id = ?1 AND event_id = ?2)`
          )
          .bind(session, link.event_id)
          .run();
      }
    }
    return c.redirect(
      `/ci/${encodeURIComponent(c.req.param('nonce'))}${day ? `?day=${encodeURIComponent(day)}` : ''}`,
      303
    );
  });
}

/* ------------------------------------------------------------------ *
 * The organizer's side: mint a named link, list them, revoke one alone.
 * Registered here to keep every checkin fact in one file; the green room
 * admin page renders the section and posts to these.
 * ------------------------------------------------------------------ */

export type CheckinLinkRow = { id: string; name: string; nonce: string; revokedAt: number | null };

export async function checkinLinks(db: D1Database, eventId: string): Promise<CheckinLinkRow[]> {
  const res = await db
    .prepare(
      `SELECT id, name, nonce, revoked_at FROM checkin_link
        WHERE event_id = ? ORDER BY created_at`
    )
    .bind(eventId)
    .all<{ id: string; name: string; nonce: string; revoked_at: number | null }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    nonce: r.nonce,
    revokedAt: r.revoked_at,
  }));
}

export async function mintCheckinLink(
  db: D1Database,
  eventId: string,
  name: string
): Promise<string | null> {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const nonce = `ci-${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare(
      `INSERT INTO checkin_link (id, event_id, name, nonce, created_at)
       VALUES (?,?,?,?,?)`
    )
    .bind(newId('cil'), eventId, clean, nonce, now())
    .run();
  return nonce;
}

export async function revokeCheckinLink(db: D1Database, eventId: string, id: string): Promise<void> {
  await db
    .prepare('UPDATE checkin_link SET revoked_at = ? WHERE id = ? AND event_id = ?')
    .bind(now(), id, eventId)
    .run();
}

/** Every arrival at this event, keyed by session, said as "09:42 · Sam" —
 *  the green room's own read (both doors), one query. */
export async function arrivalsFor(
  db: D1Database,
  eventId: string,
  timezone: string
): Promise<Map<string, { at: string; who: string }>> {
  const res = await db
    .prepare(
      `SELECT ci.submission_id, ci.marked_at, cl.name AS who
         FROM checkin ci JOIN checkin_link cl ON cl.id = ci.link_id
         JOIN submission s ON s.id = ci.submission_id
        WHERE s.event_id = ?`
    )
    .bind(eventId)
    .all<{ submission_id: string; marked_at: number; who: string }>();
  const t = (ms: number): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  return new Map(
    (res.results ?? []).map((r) => [r.submission_id, { at: t(r.marked_at), who: r.who }])
  );
}
