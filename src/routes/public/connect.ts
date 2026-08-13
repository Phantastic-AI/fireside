// Δ conn — the exchange. Two people meet, one finds the other by name, and
// only a mutual accept turns that into anything either of them can read: the
// double opt-in, the operator's own word for it, kept RELIABLE by living
// entirely server-side (no QR, no offline handshake — a name is enough).
//
// Becoming friends does two things at once, and only two: it opens each
// other's contact card (gated per-field by that person's own share_contact
// opt-ins, live, forever — queries/friends.ts) and it opens each other's
// starred schedule (queries/friends.ts's friendSchedule, gated on the
// friendship alone). Nothing else. No message thread, no notification, no
// count shown to anyone who is not one of the two.
//
// Reached from My schedule (routes/public/schedule.ts's own link) — the
// operator's ≤2-taps bar: nav → My schedule → Find someone you met.
//
// No island. Search is a GET form (a URL with ?q= is the whole feature),
// request/accept/remove are POST forms that redirect back — every part of
// this page works with scripts off, because none of it needed them.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, onstageShell, eventNav } from '../../lib/html';
import { label } from '../../lib/labels';
import { eventBySlug } from '../../queries/public';
import {
  searchAttendees,
  incomingFriendRequests,
  myFriends,
  friendSchedule,
  type AttendeeMatch,
  type IncomingFriendRequest,
  type MyFriend,
} from '../../queries/friends';
import { principalFromCookie } from '../../workflows/account';
import { sendFriendRequest, acceptFriendRequest, endFriendship } from '../../workflows/friends';

/* ------------------------------------------------------------------ *
 * Small render helpers — each route file in this product keeps its own
 * (schedule.ts's initialsMark, speakers.ts's avatar/face); this one is no
 * different, and the two styles do the same job for the same reason: no
 * image request until there is a photo to ask for.
 * ------------------------------------------------------------------ */

function face(p: { name: string; initials: string; headshotFileId: string | null }, size = 34): string {
  if (p.headshotFileId) {
    return (
      `<img class="av" src="/files/${esc(p.headshotFileId)}" alt="" width="${size}" height="${size}" ` +
      `loading="lazy" decoding="async" style="width:${size}px;height:${size}px;object-fit:cover">`
    );
  }
  return (
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(p.name)}">` +
    '<circle cx="20" cy="20" r="19.2" fill="none" stroke="#D8CEBE" stroke-width="1.2" stroke-dasharray="3 3"/>' +
    '<text x="20" y="20" text-anchor="middle" dominant-baseline="central" ' +
    `font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600" fill="#B4A996">${esc(p.initials)}</text></svg>`
  );
}

function linksLine(links: string): string {
  const parts = links.split(/[\s,]+/).map((p) => p.trim()).filter((p) => p !== '');
  if (!parts.length) return '';
  return parts
    .map((p) =>
      /^https:\/\/[^\s]+$/.test(p)
        ? `<a class="link" href="${esc(p)}" rel="noopener nofollow">${esc(p.replace(/^https:\/\//, ''))}</a>`
        : esc(p)
    )
    .join(' · ');
}

function fmtWhen(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(ms));
}

/* ------------------------------------------------------------------ *
 * Search results — the button is one of exactly three shapes, chosen by the
 * live status this same read already computed (queries/friends.ts), so the
 * page never asks "which button" with a stale answer.
 * ------------------------------------------------------------------ */

function matchCard(slug: string, m: AttendeeMatch): string {
  const together = m.goingTo
    ? `<p class="sub" style="margin:6px 0 0">Going to ${
        m.goingTo.publicSlug
          ? `<a class="link" href="/${esc(slug)}/s/${esc(m.goingTo.publicSlug)}">${esc(m.goingTo.title)}</a>`
          : esc(m.goingTo.title)
      }</p>`
    : '';

  let action: string;
  if (m.status === 'friends') {
    action =
      `<div class="btnrow" style="margin-top:10px">` +
      `<a class="btn btn-sm" href="/${esc(slug)}/connect/${esc(m.personId)}/schedule">${esc(
        label('friend.schedule', 'onstage')
      )}</a>` +
      `<form method="post" action="/${esc(slug)}/connect/end">` +
      `<input type="hidden" name="person" value="${esc(m.personId)}">` +
      `<button class="btn btn-quiet btn-sm" type="submit">${esc(label('friend.remove', 'onstage'))}</button>` +
      '</form></div>';
  } else if (m.status === 'pending_out') {
    action =
      `<div class="btnrow" style="margin-top:10px"><span class="chip">${esc(
        label('friend.sent', 'onstage')
      )}</span>` +
      `<form method="post" action="/${esc(slug)}/connect/end">` +
      `<input type="hidden" name="person" value="${esc(m.personId)}">` +
      `<button class="btn btn-quiet btn-sm" type="submit">${esc(label('friend.cancel', 'onstage'))}</button>` +
      '</form></div>';
  } else if (m.status === 'pending_in') {
    action =
      `<div class="btnrow" style="margin-top:10px">` +
      `<form method="post" action="/${esc(slug)}/connect/accept">` +
      `<input type="hidden" name="person" value="${esc(m.personId)}">` +
      `<button class="btn btn-primary btn-sm" type="submit">${esc(label('friend.accept', 'onstage'))}</button>` +
      '</form>' +
      `<form method="post" action="/${esc(slug)}/connect/end">` +
      `<input type="hidden" name="person" value="${esc(m.personId)}">` +
      `<button class="btn btn-quiet btn-sm" type="submit">${esc(label('friend.not_now', 'onstage'))}</button>` +
      '</form></div>';
  } else {
    action =
      `<form method="post" action="/${esc(slug)}/connect/request" style="margin-top:10px">` +
      `<input type="hidden" name="person" value="${esc(m.personId)}">` +
      `<button class="btn btn-sm" type="submit">${esc(label('friend.request', 'onstage'))}</button>` +
      '</form>';
  }

  return (
    '<div class="card card-pad" style="margin-bottom:12px">' +
    `<div class="byline">${face(m)}<span class="serif" style="font-size:17px;font-weight:600">${esc(
      m.name
    )}</span></div>` +
    together +
    action +
    '</div>'
  );
}

function incomingCard(slug: string, r: IncomingFriendRequest): string {
  const words = label('friend.incoming', 'onstage').split('{name}').join(r.name);
  return (
    '<div class="card card-pad" style="margin-bottom:10px">' +
    `<div class="byline">${face(r)}<span style="font-size:15px">${esc(words)}</span></div>` +
    `<div class="btnrow" style="margin-top:10px">` +
    `<form method="post" action="/${esc(slug)}/connect/accept">` +
    `<input type="hidden" name="person" value="${esc(r.personId)}">` +
    `<button class="btn btn-primary btn-sm" type="submit">${esc(label('friend.accept', 'onstage'))}</button>` +
    '</form>' +
    `<form method="post" action="/${esc(slug)}/connect/end">` +
    `<input type="hidden" name="person" value="${esc(r.personId)}">` +
    `<button class="btn btn-quiet btn-sm" type="submit">${esc(label('friend.not_now', 'onstage'))}</button>` +
    '</form></div></div>'
  );
}

function friendCard(slug: string, f: MyFriend): string {
  const facts: string[] = [];
  const work = [f.jobTitle, f.organisation].filter((x) => x).join(' at ');
  if (work) facts.push(esc(work));
  if (f.links) {
    const line = linksLine(f.links);
    if (line) facts.push(line);
  }
  if (f.email) facts.push(`<a class="link" href="mailto:${esc(f.email)}">${esc(f.email)}</a>`);

  return (
    '<div class="card card-pad" style="margin-bottom:12px">' +
    `<div class="byline">${face(f)}<span class="serif" style="font-size:17px;font-weight:600">${esc(
      f.name
    )}</span></div>` +
    (facts.length ? `<p class="sub" style="margin:8px 0 0">${facts.join(' · ')}</p>` : '') +
    `<div class="btnrow" style="margin-top:10px">` +
    `<a class="btn btn-sm" href="/${esc(slug)}/connect/${esc(f.personId)}/schedule">${esc(
      label('friend.schedule', 'onstage')
    )}</a>` +
    `<form method="post" action="/${esc(slug)}/connect/end">` +
    `<input type="hidden" name="person" value="${esc(f.personId)}">` +
    `<button class="btn btn-quiet btn-sm" type="submit">${esc(label('friend.remove', 'onstage'))}</button>` +
    '</form></div></div>'
  );
}

/* ------------------------------------------------------------------ *
 * Outcomes — a closed set of codes, one sentence each, same shape as
 * routes/public/schedule.ts's own NOTES map.
 * ------------------------------------------------------------------ */

const NOTES: Record<string, string> = {
  sent: label('friend.done', 'onstage'),
  accepted: label('friend.accepted', 'onstage'),
  removed: label('friend.removed', 'onstage'),
  moved: label('friend.moved', 'onstage'),
  trouble: label('friend.trouble', 'onstage'),
};

function noteLine(code: string | undefined): string {
  if (!code) return '';
  const sentence = NOTES[code];
  if (!sentence) return '';
  return `<p class="chip" style="margin-top:14px">${esc(sentence)}</p>`;
}

const back = (slug: string, code?: string, q?: string): string => {
  const params = new URLSearchParams();
  if (code) params.set('note', code);
  if (q) params.set('q', q);
  const qs = params.toString();
  return `/${encodeURIComponent(slug)}/connect${qs ? `?${qs}` : ''}`;
};

const codeFor = (outcome: 'done' | 'moved' | 'trouble', done: string): string =>
  outcome === 'done' ? done : outcome;

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerConnect(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/connect', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();

    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));

    const head =
      `<h1 class="display">${esc(label('friend.find', 'onstage'))}</h1>` +
      `<p class="sub" style="margin-top:8px">${esc(ev.name)}</p>`;

    let inner: string;
    if (!principal) {
      inner =
        '<div class="wrap" style="padding-top:44px">' +
        head +
        '<div class="sec state-out"><h2>Sign in to find someone you met.</h2>' +
        '<p>Search only works for a signed-in account — a request has to say who it is from.</p>' +
        `<a class="btn btn-primary" href="/sign-in">Sign in</a></div></div>`;
    } else {
      const q = (c.req.query('q') ?? '').trim();
      const [matches, incoming, friends] = await Promise.all([
        q ? searchAttendees(c.env.DB, ev.id, principal.personId, q) : Promise.resolve([] as AttendeeMatch[]),
        incomingFriendRequests(c.env.DB, ev.id, principal.personId),
        myFriends(c.env.DB, ev.id, principal.personId),
      ]);

      const searchSection =
        `<form method="get" action="/${esc(ev.slug)}/connect" style="margin-top:14px" role="search">` +
        `<input type="text" name="q" value="${esc(q)}" placeholder="Their name" aria-label="Search by name" ` +
        'style="max-width:26em">' +
        ` <button class="btn" type="submit">${esc(label('friend.search_button', 'onstage'))}</button>` +
        '</form>' +
        (q
          ? matches.length
            ? matches.map((m) => matchCard(ev.slug, m)).join('')
            : `<p class="hint" style="margin-top:14px">${esc(label('friend.search_empty', 'onstage'))}</p>`
          : '');

      const incomingSection = incoming.length
        ? '<div class="sec" style="max-width:46em;margin-top:26px">' +
          `<h2 class="display" style="font-size:22px;margin-bottom:10px">${esc(
            label('friend.incoming_section', 'onstage')
          )}</h2>` +
          incoming.map((r) => incomingCard(ev.slug, r)).join('') +
          '</div>'
        : '';

      const friendsSection =
        '<div class="sec" style="max-width:46em;margin-top:26px">' +
        `<h2 class="display" style="font-size:22px;margin-bottom:10px">${esc(
          label('friend.list', 'onstage')
        )}</h2>` +
        (friends.length
          ? friends.map((f) => friendCard(ev.slug, f)).join('')
          : `<p class="hint">${esc(label('friend.list_empty', 'onstage'))}</p>`) +
        '</div>';

      inner =
        '<div class="wrap" style="padding-top:44px">' +
        head +
        noteLine(c.req.query('note')) +
        `<div class="sec" style="max-width:46em">${searchSection}</div>` +
        incomingSection +
        friendsSection +
        `<p class="hint" style="margin-top:22px">${esc(
          label('auth.signed_in', 'onstage').split('{name}').join(principal.name)
        )} · <a class="link" href="/sign-out">${esc(label('auth.sign_out', 'onstage'))}</a></p>` +
        '</div>';
    }

    const body = onstageShell(eventNav(ev.slug, '/connect', ev.lifecycle === 'open'), inner, ev.slug);
    if (principal) c.header('cache-control', 'private, no-store');

    return c.html(
      page({
        title: `${label('friend.find', 'onstage')} · ${ev.name}`,
        description: `Find someone you met at ${ev.name} and connect, once you both agree.`,
        register: 'onstage',
        body,
      })
    );
  });

  app.post('/:event/connect/request', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const q = String(form['q'] ?? '');
    const outcome = await sendFriendRequest(c.env.DB, ev.id, principal.personId, String(form['person'] ?? ''));
    return c.redirect(back(slug, codeFor(outcome, 'sent'), q), 303);
  });

  app.post('/:event/connect/accept', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const outcome = await acceptFriendRequest(c.env.DB, ev.id, principal.personId, String(form['person'] ?? ''));
    return c.redirect(back(slug, codeFor(outcome, 'accepted')), 303);
  });

  app.post('/:event/connect/end', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const outcome = await endFriendship(c.env.DB, ev.id, principal.personId, String(form['person'] ?? ''));
    return c.redirect(back(slug, codeFor(outcome, 'removed')), 303);
  });

  /* -- a friend's schedule: gated on the friendship alone, works any time
        the event exists — a tribe plans together weeks before it runs, not
        only day-of. -- */
  app.get('/:event/connect/:friend/schedule', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const their = await friendSchedule(c.env.DB, ev.id, principal.personId, c.req.param('friend'));
    if (!their) return c.notFound();

    const rows = their.sessions.length
      ? their.sessions
          .map((s) => {
            const strike = s.cancelled ? ' style="text-decoration:line-through;color:var(--muted)"' : '';
            const title = s.publicSlug
              ? `<a href="/${esc(ev.slug)}/s/${esc(s.publicSlug)}"${strike}>${esc(s.title)}</a>`
              : `<span${strike}>${esc(s.title)}</span>`;
            return (
              '<article class="sesh" style="--tc:#726858">' +
              `<div class="sesh-main"><div class="sesh-when"><span class="time">${esc(
                fmtWhen(s.startsAt, ev.timezone)
              )}</span>` +
              (s.roomName ? `<span class="room">${esc(s.roomName)}</span>` : '') +
              `</div><h3>${title}</h3></div></article>`
            );
          })
          .join('')
      : `<div class="sec state-out"><p>${esc(
          label('friend.schedule_empty', 'onstage').split('{name}').join(their.name)
        )}</p></div>`;

    const inner =
      '<div class="wrap" style="padding-top:44px">' +
      `<h1 class="display">${esc(their.name)}’s schedule</h1>` +
      `<p class="sub" style="margin-top:8px">${esc(ev.name)}</p>` +
      `<div class="sec"><div class="slot">${rows}</div></div>` +
      `<p class="hint" style="margin-top:22px"><a class="link" href="/${esc(ev.slug)}/connect">Back to your people</a></p>` +
      '</div>';

    const body = onstageShell(eventNav(ev.slug, '/connect', ev.lifecycle === 'open'), inner, ev.slug);
    c.header('cache-control', 'private, no-store');
    return c.html(
      page({
        title: `${their.name}’s schedule · ${ev.name}`,
        description: `What ${their.name} has starred at ${ev.name}.`,
        register: 'onstage',
        body,
      })
    );
  });
}
