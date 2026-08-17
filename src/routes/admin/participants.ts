// Correcting a proposal's cast after a decision (scoreboard-2026-08-12.md,
// ABS cluster: "speakers cannot add a co-presenter, or otherwise edit, a
// proposal once it has been decided — participant lists cannot be corrected").
// workflows/edit.ts is right to lock the speaker's own form once the
// committee has acted; this is the organizer's separate door, on purpose no
// state guard at all. It reuses workflows/participants.ts, which reuses
// workflows/submit.ts's own find-or-create-by-address machinery, so "who
// counts as already on the talk" stays one true answer wherever it is asked.
//
// Sibling to routes/admin/proposal.ts's own detail page rather than folded
// into it — this file owns nothing proposal.ts already owns, only the one
// screen proposal.ts has no room for yet. See the build report for the one
// link proposal.ts would need to reach it directly.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, type LabelKey } from '../../lib/labels';
import { ScopeError, adminEvents, type AdminEvent } from '../../queries/admin';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { coRoleOf } from '../../workflows/submit';
import {
  addCoPresenter,
  castOf,
  removeCoPresenter,
  type ParticipantsOutcome,
} from '../../workflows/participants';
import type { OnTheTalk } from '../../workflows/submit';

const HTML = { 'content-type': 'text/html; charset=utf-8' };

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

// Word for word what proposal.ts's own ROLE_KEY says (02 §6's vocabulary).
const ROLE_KEY: Record<string, LabelKey> = {
  speaker: 'role.speaker',
  co_speaker: 'role.cospeaker',
  co_author: 'role.coauthor',
  panelist: 'role.panelist',
  moderator: 'role.host',
};

function shell(principal: Principal, ev: AdminEvent, title: string, body: string, crumb: string): string {
  return page({
    title: `${title} · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: ev.slug,
      eventName: ev.name,
      here: '/submissions',
      who: principal.name,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? '',
      body,
      crumb,
    }),
  });
}

type Loaded = { principal: Principal; ev: AdminEvent };

async function enter(
  db: D1Database,
  secret: string,
  cookie: string | undefined,
  slug: string
): Promise<Loaded | Response> {
  const principal = await principalFromCookie(db, secret, cookie);
  if (!principal) return new Response(null, { status: 302, headers: { location: '/sign-in' } });
  try {
    const events = await adminEvents(db, principal);
    const ev = events.find((e) => e.slug === slug);
    if (!ev) return new Response(deniedPage(), { status: 403, headers: HTML });
    return { principal, ev };
  } catch (e) {
    if (e instanceof ScopeError) return new Response(deniedPage(e.message), { status: 403, headers: HTML });
    throw e;
  }
}

function personRow(ev: AdminEvent, submissionId: string, p: OnTheTalk): string {
  const key = ROLE_KEY[p.role];
  const role = key ? label(key, 'backstage') : p.role;
  const canRemove = p.role === 'co_speaker' && !p.isSubmitter;
  return (
    '<div class="card card-pad" style="margin-top:10px;display:flex;justify-content:space-between;' +
    'align-items:center;gap:12px;flex-wrap:wrap">' +
    '<div>' +
    `<div style="font-weight:640">${esc(p.name)}${p.isSubmitter ? '<span class="sub"> · Submitter</span>' : ''}</div>` +
    `<div class="sub" style="margin-top:2px">${esc(role)}${p.email ? ` · ${esc(p.email)}` : ''}</div>` +
    '</div>' +
    (canRemove
      ? `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/submissions/` +
        `${encodeURIComponent(submissionId)}/participants/remove">` +
        `<input type="hidden" name="person" value="${esc(p.personId)}">` +
        '<button class="btn btn-sm btn-quiet" type="submit">Remove</button></form>'
      : '') +
    '</div>'
  );
}

function participantsPage(
  principal: Principal,
  ev: AdminEvent,
  submission: { id: string; title: string },
  cast: OnTheTalk[],
  said: string | null
): string {
  const crumb =
    `<a href="/admin/${esc(ev.slug)}/submissions/${esc(submission.id)}">${esc(submission.title)}</a> › ` +
    '<span>participants</span>';
  const sentence = said
    ? `<div class="sec standing" role="status" style="margin-top:14px">${esc(said)}</div>`
    : '';
  const rows = cast.map((p) => personRow(ev, submission.id, p)).join('');
  const addForm =
    '<div class="card card-pad" style="margin-top:16px">' +
    '<h4 class="serif" style="font-size:15.5px;font-weight:600">Add a co-presenter</h4>' +
    '<p class="sub" style="margin:4px 0 12px">Works whatever this proposal&#39;s decision is — ' +
    'correcting the cast is not the same act as changing the talk.</p>' +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/submissions/` +
    `${encodeURIComponent(submission.id)}/participants/add">` +
    '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
    '<label class="f" style="flex:1;min-width:180px"><span class="f-lab">Name</span>' +
    '<input type="text" name="name" maxlength="120"></label>' +
    '<label class="f" style="flex:1;min-width:220px"><span class="f-lab">Email</span>' +
    '<input type="email" name="email" maxlength="200"></label>' +
    '<label class="f" style="min-width:11em"><span class="f-lab">On the talk as</span>' +
    '<select name="role">' +
    `<option value="co_speaker">${esc(label('role.cospeaker', 'backstage'))}</option>` +
    `<option value="co_author">${esc(label('role.coauthor', 'backstage'))}</option>` +
    `<option value="panelist">${esc(label('role.panelist', 'backstage'))}</option>` +
    `<option value="moderator">${esc(label('role.host', 'backstage'))}</option>` +
    '</select></label>' +
    '</div>' +
    '<div class="btnrow" style="margin-top:12px">' +
    '<button class="btn btn-primary" type="submit">Add</button></div>' +
    '</form></div>';

  return shell(
    principal,
    ev,
    `Participants · ${submission.title}`,
    '<div style="padding:26px 0 0">' +
      `<h1 class="display" style="font-size:30px">${esc(submission.title)}</h1>` +
      '<p class="counts">Participants</p>' +
      '</div>' +
      sentence +
      rows +
      addForm,
    crumb
  );
}

function resultHref(slug: string, submissionId: string, outcome: ParticipantsOutcome): string {
  const base =
    `/admin/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(submissionId)}/participants`;
  const said = outcome.ok
    ? 'Saved.'
    : outcome.kind === 'refused'
      ? outcome.message
      : outcome.kind === 'moved'
        ? 'The proposal moved while you were looking. Read it again, then try once more.'
        : 'That did not go through. Try it once more.';
  return `${base}?said=${encodeURIComponent(said)}`;
}

export function registerParticipants(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/submissions/:id/participants', async (c) => {
    const slug = c.req.param('eventSlug');
    const id = c.req.param('id');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    try {
      const sub = await c.env.DB
        .prepare('SELECT id, title FROM submission WHERE id = ?1 AND event_id = ?2')
        .bind(id, ev.id)
        .first<{ id: string; title: string }>();
      const cast = sub ? await castOf(c.env.DB, principal, ev.id, id) : null;
      if (!sub || !cast) {
        return new Response(deniedPage('That proposal is not on this program.'), {
          status: 403,
          headers: HTML,
        });
      }
      const said = (c.req.query('said') ?? '').slice(0, 200) || null;
      return c.html(participantsPage(principal, ev, sub, cast, said));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/submissions/:id/participants/add', async (c) => {
    const slug = c.req.param('eventSlug');
    const id = c.req.param('id');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const row = {
      name: typeof form['name'] === 'string' ? form['name'] : '',
      email: typeof form['email'] === 'string' ? form['email'] : '',
      role: coRoleOf(typeof form['role'] === 'string' ? form['role'] : ''),
    };

    try {
      const outcome = await addCoPresenter(c.env.DB, principal, ev.id, id, row);
      return c.redirect(resultHref(ev.slug, id, outcome), 303);
    } catch (e) {
      if (e instanceof ScopeError) {
        return c.html(deniedPage('Correcting this proposal&#39;s cast is not yours to do.'), 403);
      }
      throw e;
    }
  });

  app.post('/admin/:eventSlug/submissions/:id/participants/remove', async (c) => {
    const slug = c.req.param('eventSlug');
    const id = c.req.param('id');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const personId = typeof form['person'] === 'string' ? form['person'] : '';

    try {
      const outcome = await removeCoPresenter(c.env.DB, principal, ev.id, id, personId);
      return c.redirect(resultHref(ev.slug, id, outcome), 303);
    } catch (e) {
      if (e instanceof ScopeError) {
        return c.html(deniedPage('Correcting this proposal&#39;s cast is not yours to do.'), 403);
      }
      throw e;
    }
  });
}
