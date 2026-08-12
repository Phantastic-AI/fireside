// S-14 — the agenda builder. Naomi is building Thursday while Wednesday burns:
// half-hours at 07:10 and 23:40, often standing up. So the screen answers one
// question in its first line — what is still without a room — and every act on
// it is a link or a form, never a gesture that needs a mouse and a steady hand.
//
// Placement is click, click: pick a talk in the rail, then click where it goes.
// The pick lives in the address bar (?pick=), which is why it survives a
// refusal, a day change, and a phone that went to sleep mid-thought.
//
// The interaction weights (D-024): placing, clearing and putting a session
// back are one click each — Naomi is the only person who can see the grid
// until she says otherwise, and each of them is undone by its opposite.
// Cancelling a session and publishing the agenda are two passes, because both
// change what a stranger sees, and the second pass carries the number the
// first one showed.
//
// The reads are queries/builder.ts; the writes are workflows/agenda.ts, which
// return a small closed word. The sentences for those words live here, because
// they are this screen's.

import type { Context, Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, FORMAT_KEY, type LabelKey } from '../../lib/labels';
import { ScopeError } from '../../queries/admin';
import {
  agendaBuilder,
  eventIdBySlug,
  type Builder,
  type BuilderSession,
  type BuilderWaiting,
} from '../../queries/builder';
import { initialsOf } from '../../queries/public';
import { principalFromCookie, type Principal } from '../../workflows/account';
import {
  cancelSession,
  clearPlacement,
  placeSession,
  publishAgenda,
  restoreSession,
  unpublishAgenda,
  type AgendaResult,
} from '../../workflows/agenda';

/* ------------------------------------------------------------------ *
 * Words and numbers
 * ------------------------------------------------------------------ */

function n(x: number): string {
  return x.toLocaleString('en-US');
}

function plural(x: number, one: string, many: string): string {
  return x === 1 ? `1 ${one}` : `${n(x)} ${many}`;
}

function durationLabel(minutes: number): string {
  return minutes >= 90 && minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

/** Epoch ms to "HH:MM" on the conference's own clock. */
function timeOfDay(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A day key ('2026-09-03') to "Thu 3 Sep" — the prototype's chip, built from
 * fixed words rather than Intl, which spells the ninth month "Sept" in some
 * versions and "Sep" in others. A chip that changes width between releases is
 * not a chip.
 */
function dayChipLabel(iso: string): string {
  const d = iso.split('-');
  const at = new Date(
    Date.UTC(Number(d[0] ?? '1970'), Number(d[1] ?? '1') - 1, Number(d[2] ?? '1'))
  );
  const weekday = WEEKDAYS[at.getUTCDay()] ?? '';
  const month = MONTHS[at.getUTCMonth()] ?? '';
  return `${weekday} ${at.getUTCDate()} ${month}`;
}

/** Formats arrive stored ('Talk'); a value with no row in 02 §6 says nothing. */
function formatWord(stored: string): string {
  const key: LabelKey | undefined = FORMAT_KEY[stored];
  return key ? label(key, 'backstage') : '';
}

/** "Priya Raghunathan" → "Priya". Naomi thinks in names, not roles. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function joinDots(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(' · ');
}

/** A session's track colour, or the quiet default when it has no track. */
function trackStyle(session: { track: { colour: string } | null }): string {
  return `--tc:${esc(session.track ? session.track.colour : 'var(--muted-2)')}`;
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

type Params = Record<string, string | null | undefined>;

function here(slug: string, params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `/admin/${encodeURIComponent(slug)}/agenda${s ? `?${s}` : ''}`;
}

const postTo = (slug: string, action: string): string =>
  `/admin/${encodeURIComponent(slug)}/agenda/${action}`;

const proposalHref = (slug: string, id: string): string =>
  `/admin/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}`;

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

/* ------------------------------------------------------------------ *
 * What just happened — the closed set, and this screen's sentences
 * ------------------------------------------------------------------ */

const NOTES = [
  'placed',
  'cleared',
  'cancelled',
  'restored',
  'published',
  'unpublished',
  'room-taken',
  'speaker-busy',
  'not-accepted',
  'moved',
  'count-moved',
  'trouble',
] as const;

type Note = (typeof NOTES)[number];

function asNote(raw: string | undefined): Note | null {
  return raw && (NOTES as readonly string[]).includes(raw) ? (raw as Note) : null;
}

const CALM: Partial<Record<Note, string>> = {
  placed: 'That talk has a room and a time. Pick another one when you are ready.',
  cleared: 'Off the grid, and picked up — click where it goes, or leave it in the list on the left.',
  cancelled:
    'Cancelled, and still in its own place on the agenda, struck through, so nobody queues at that door.',
  restored: 'Back on. It reads as a normal session again.',
  published: 'The public agenda is live.',
  unpublished:
    'The public agenda is down. Speakers still see their own times in their portal.',
  'not-accepted': 'Only accepted talks go on the grid.',
  moved: 'That one moved while you were looking at it. Nothing changed — look again.',
  'count-moved': 'The grid moved while you were reading. Look again, then publish.',
  trouble: 'That did not save. Nothing changed.',
};

/* ------------------------------------------------------------------ *
 * The strips above the grid — one calm region, one thing at a time
 * ------------------------------------------------------------------ */

function findPlaced(view: Builder, id: string | undefined): BuilderSession | null {
  if (!id) return null;
  return view.placed.find((s) => s.id === id) ?? null;
}

function findWaiting(view: Builder, id: string | undefined): BuilderWaiting | null {
  if (!id) return null;
  return view.waiting.find((s) => s.id === id) ?? null;
}

function speakersOf(view: Builder, id: string | undefined): string[] {
  return findPlaced(view, id)?.speakers ?? findWaiting(view, id)?.speakers ?? [];
}

function whenWhere(view: Builder, startsAt: number, roomName: string | null): string {
  const at = timeOfDay(startsAt, view.timezone);
  return roomName ? `${at}, ${roomName}` : at;
}

/** The two refusals that are news: a room already in use, a person already on. */
function conflictSentence(view: Builder, note: Note, q: Params): string | null {
  if (note === 'room-taken') {
    const room = view.rooms.find((r) => r.id === q['room']);
    const at = Number(q['t']);
    const session = findPlaced(view, q['on'] ?? undefined);
    const when = Number.isFinite(at) && at > 0 ? timeOfDay(at, view.timezone) : null;
    if (room && when) return `${esc(room.name)} is taken at ${esc(when)}.`;
    if (session) {
      return `${esc(session.roomName ?? 'That room')} is taken at ${esc(
        timeOfDay(session.startsAt, view.timezone)
      )}.`;
    }
    return 'That room already has somebody in it then.';
  }
  if (note === 'speaker-busy') {
    const clash = findPlaced(view, q['clash'] ?? undefined);
    const mine = speakersOf(view, q['pick'] ?? q['on'] ?? undefined);
    const shared = clash ? clash.speakers.find((name) => mine.includes(name)) : undefined;
    if (clash && shared) {
      return `${esc(firstName(shared))} is already speaking at ${esc(
        whenWhere(view, clash.startsAt, clash.roomName)
      )}.`;
    }
    if (clash) {
      return `Somebody on that talk is already speaking at ${esc(
        whenWhere(view, clash.startsAt, clash.roomName)
      )}.`;
    }
    return 'Somebody on that talk is already speaking then.';
  }
  return null;
}

function noteStrip(view: Builder, q: Params): string {
  const note = asNote(q['note'] ?? undefined);
  if (!note) return '';
  const clash = conflictSentence(view, note, q);
  if (clash) {
    return (
      '<div class="conflict"><span class="cwarn">' +
      clash +
      '</span><span class="sub">Pick another slot — the pick is still in your hand.</span></div>'
    );
  }
  const calm = CALM[note];
  return calm ? `<div class="standing" style="margin-top:14px">${esc(calm)}</div>` : '';
}

function pickStrip(view: Builder, pick: BuilderWaiting): string {
  const meta = joinDots([formatWord(pick.format), durationLabel(pick.minutes)]);
  return (
    '<div class="standing" style="margin-top:14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
    `<span><b>${esc(pick.title)}</b>${meta ? ` — ${esc(meta)}` : ''}</span>` +
    '<span class="sub">Click where it goes. Any open square on any day.</span>' +
    `<a class="link" style="margin-left:auto" href="${esc(here(view.slug, { day: view.day }))}">Leave it in the list</a>` +
    '</div>'
  );
}

function selectedStrip(view: Builder, session: BuilderSession): string {
  const where = whenWhere(view, session.startsAt, session.roomName);
  const day = view.day;
  const actions = session.cancelled
    ? `<form method="post" action="${esc(postTo(view.slug, 'restore'))}" style="margin:0">` +
      hidden('talk', session.id) +
      hidden('day', day) +
      `<button class="btn btn-sm" type="submit">${esc(label('submission.reinstate', 'backstage'))}</button>` +
      '</form>'
    : `<form method="post" action="${esc(postTo(view.slug, 'clear'))}" style="margin:0">` +
      hidden('talk', session.id) +
      hidden('day', day) +
      '<button class="btn btn-sm" type="submit">Take it off the grid</button>' +
      '</form>' +
      `<a class="btn btn-sm btn-danger" href="${esc(
        here(view.slug, { day, cancel: session.id })
      )}">Cancel this session</a>`;
  return (
    '<div class="standing" style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
    `<span><b>${esc(session.title)}</b> — ${esc(where)}.</span>` +
    (session.cancelled
      ? `<span class="sub">${esc(label('submission.cancelled', 'backstage'))}</span>`
      : '') +
    `<a class="link" href="${esc(proposalHref(view.slug, session.id))}">Open the proposal →</a>` +
    actions +
    `<a class="link" href="${esc(here(view.slug, { day }))}">Never mind</a>` +
    '</div>'
  );
}

function cancelStrip(view: Builder, session: BuilderSession): string {
  const where = whenWhere(view, session.startsAt, session.roomName);
  return (
    '<div class="standing" style="margin-top:14px">' +
    '<p style="margin:0"><b>Cancel this session?</b></p>' +
    `<p style="margin:4px 0 0">${esc(session.title)} — ${esc(where)}. It keeps that place on the ` +
    'agenda and reads as cancelled, so nobody queues at a door where nothing is happening.</p>' +
    `<form method="post" action="${esc(postTo(view.slug, 'cancel'))}" ` +
    'style="margin:10px 0 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    hidden('talk', session.id) +
    hidden('day', view.day) +
    '<label class="sub" for="cancel-note">What should people be told?</label>' +
    '<input type="text" id="cancel-note" name="note" maxlength="160" ' +
    'placeholder="The speaker is unwell — this one comes back next year." style="flex:1;min-width:16em">' +
    '<button class="btn btn-danger" type="submit">Cancel this session</button>' +
    `<a class="link" href="${esc(here(view.slug, { day: view.day, on: session.id }))}">Leave it on</a>` +
    '</form></div>'
  );
}

function publishStrip(view: Builder, taking: 'up' | 'down'): string {
  const count = view.counts.placed;
  const line =
    taking === 'up'
      ? `<b>Publish the agenda</b> — ${esc(
          plural(count, 'placed session becomes public', 'placed sessions become public')
        )}. Speakers can already see their own times.`
      : `<b>Take the agenda down</b> — ${esc(
          plural(count, 'placed session stops being public', 'placed sessions stop being public')
        )}. Speakers keep their own times in their portal.`;
  return (
    '<div class="standing" style="margin-top:14px">' +
    `<p style="margin:0">${line}</p>` +
    `<form method="post" action="${esc(postTo(view.slug, taking === 'up' ? 'publish' : 'unpublish'))}" ` +
    'style="margin:10px 0 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
    hidden('placed', String(count)) +
    hidden('day', view.day) +
    `<button class="btn${taking === 'up' ? ' btn-primary' : ''}" type="submit">` +
    (taking === 'up' ? 'Publish the agenda' : 'Take the agenda down') +
    '</button>' +
    `<a class="link" href="${esc(here(view.slug, { day: view.day }))}">` +
    (taking === 'up' ? 'Not yet' : 'Leave it up') +
    '</a></form></div>'
  );
}

/* ------------------------------------------------------------------ *
 * The rail and the grid
 * ------------------------------------------------------------------ */

function railCard(view: Builder, talk: BuilderWaiting, picked: boolean): string {
  const meta = joinDots([formatWord(talk.format), durationLabel(talk.minutes), talk.speakers[0]]);
  const href = here(view.slug, { day: view.day, pick: picked ? null : talk.id });
  return (
    `<a class="tocard${picked ? ' on' : ''}" href="${esc(href)}" ` +
    'style="display:block;text-decoration:none;color:inherit">' +
    `<div class="tt">${esc(talk.title)}</div>` +
    `<div class="tm">${esc(meta)}</div></a>`
  );
}

function rail(view: Builder, pickId: string | null): string {
  const count = view.counts.waiting;
  const head =
    count > 0
      ? `<h4><span>To place · ${esc(n(count))}</span></h4>`
      : '<h4><span>To place</span></h4>';

  if (count === 0) {
    const empty =
      view.counts.placed > 0
        ? '<div class="sub" style="padding:8px 2px">Everything accepted is on the grid.' +
          (view.canEdit && !view.agendaPublished
            ? ` <a class="link" href="${esc(
                here(view.slug, { day: view.day, confirm: 'publish' })
              )}">Publish the agenda →</a>`
            : '') +
          '</div>'
        : '<div class="sub" style="padding:8px 2px">Nothing is accepted yet. Talks land here the moment ' +
          `the committee says yes. <a class="link" href="/admin/${esc(
            view.slug
          )}/submissions">Go to the proposals →</a></div>`;
    return `<div class="torail">${head}${empty}</div>`;
  }

  const cards = view.canEdit
    ? view.waiting.map((t) => railCard(view, t, t.id === pickId)).join('')
    : view.waiting
        .map(
          (t) =>
            '<div class="tocard" style="cursor:default">' +
            `<div class="tt">${esc(t.title)}</div>` +
            `<div class="tm">${esc(
              joinDots([formatWord(t.format), durationLabel(t.minutes), t.speakers[0]])
            )}</div></div>`
        )
        .join('');
  return `<div class="torail">${head}${cards}</div>`;
}

function placedCell(view: Builder, session: BuilderSession, selected: boolean): string {
  const meta = joinDots([session.speakers[0], durationLabel(session.minutes)]);
  const title = session.cancelled
    ? `<span style="text-decoration:line-through;text-decoration-color:var(--muted-2)">${esc(
        session.title
      )}</span>`
    : esc(session.title);
  const sub = session.cancelled
    ? esc(joinDots([session.speakers[0], label('submission.cancelled', 'backstage')]))
    : esc(meta);
  const href = view.canEdit
    ? here(view.slug, { day: view.day, on: selected ? null : session.id })
    : proposalHref(view.slug, session.id);
  return (
    `<a class="placed" style="${trackStyle(session)};text-decoration:none;display:block${
      selected ? ';box-shadow:inset 0 0 0 2px var(--ember-btn)' : ''
    }" href="${esc(href)}">` +
    `<div class="pt">${title}</div><div class="pn">${sub}</div></a>`
  );
}

function openCell(view: Builder, pick: BuilderWaiting | null, roomId: string, roomName: string, at: number): string {
  if (!pick || !view.canEdit) return '<span class="empty-slot" aria-hidden="true"></span>';
  const when = timeOfDay(at, view.timezone);
  return (
    `<form method="post" action="${esc(postTo(view.slug, 'place'))}" style="margin:0;height:100%">` +
    hidden('talk', pick.id) +
    hidden('room', roomId) +
    hidden('at', String(at)) +
    hidden('day', view.day) +
    `<button class="empty-slot" type="submit" aria-label="Put ${esc(pick.title)} here — ${esc(
      when
    )}, ${esc(roomName)}"></button></form>`
  );
}

function grid(view: Builder, pick: BuilderWaiting | null, selectedId: string | null): string {
  if (view.rooms.length === 0) {
    return (
      '<div class="gridwrap" style="padding:20px">' +
      '<p>Rooms come before the grid — it is your day laid out across them. ' +
      `<a class="link" href="/admin/${esc(view.slug)}/settings">Name your rooms →</a></p></div>`
    );
  }
  const head =
    '<thead><tr><th></th>' +
    view.rooms.map((r) => `<th>${esc(r.name)}</th>`).join('') +
    '</tr></thead>';

  const body = view.slots
    .map((at) => {
      const cells = view.rooms
        .map((room) => {
          const inCell = view.placed.filter((s) => s.startsAt === at && s.roomId === room.id);
          if (inCell.length === 0) {
            return `<td>${openCell(view, pick, room.id, room.name, at)}</td>`;
          }
          return `<td>${inCell.map((s) => placedCell(view, s, s.id === selectedId)).join('')}</td>`;
        })
        .join('');
      return `<tr><td class="timecell">${esc(timeOfDay(at, view.timezone))}</td>${cells}</tr>`;
    })
    .join('');

  return `<div class="gridwrap"><table class="grid">${head}<tbody>${body}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

function headline(view: Builder): string {
  const parts: string[] = [];
  if (view.counts.placed > 0) {
    parts.push(
      `${plural(view.counts.placed, 'session', 'sessions')} across ${plural(
        view.counts.rooms,
        'room',
        'rooms'
      )}`
    );
  } else {
    parts.push('Nothing is on the grid yet');
  }
  if (view.counts.waiting > 0) {
    parts.push(plural(view.counts.waiting, 'still to place', 'still to place'));
  }
  if (view.counts.placed > 0) {
    parts.push(
      view.agendaPublished
        ? label('placement.published', 'backstage')
        : label('placement.set', 'backstage')
    );
  }
  return parts.map((p) => esc(p)).join('<span class="sep">·</span>');
}

function publishButton(view: Builder): string {
  if (!view.canEdit) return '';
  if (view.agendaPublished) {
    return `<a class="btn" href="${esc(
      here(view.slug, { day: view.day, confirm: 'unpublish' })
    )}">Take the agenda down</a>`;
  }
  if (view.counts.placed === 0) return '';
  return `<a class="btn btn-primary" href="${esc(
    here(view.slug, { day: view.day, confirm: 'publish' })
  )}">Publish the agenda</a>`;
}

function builderPage(view: Builder, principal: Principal, q: Params): string {
  const pick = view.canEdit ? findWaiting(view, q['pick'] ?? undefined) : null;
  const selected = view.canEdit ? findPlaced(view, q['on'] ?? undefined) : null;
  const cancelling = view.canEdit ? findPlaced(view, q['cancel'] ?? undefined) : null;
  const confirm = q['confirm'];

  const dayTabs = view.days
    .map(
      (d) =>
        `<a class="fchip" href="${esc(
          here(view.slug, { day: d, pick: pick ? pick.id : null })
        )}" aria-pressed="${d === view.day ? 'true' : 'false'}">${esc(dayChipLabel(d))}</a>`
    )
    .join('');

  const strips =
    noteStrip(view, q) +
    (confirm === 'publish' && view.canEdit && !view.agendaPublished ? publishStrip(view, 'up') : '') +
    (confirm === 'unpublish' && view.canEdit && view.agendaPublished ? publishStrip(view, 'down') : '') +
    (cancelling && !cancelling.cancelled ? cancelStrip(view, cancelling) : '') +
    (pick ? pickStrip(view, pick) : '') +
    (selected && !cancelling ? selectedStrip(view, selected) : '');

  const body =
    '<div style="padding:24px 0 0;display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">' +
    '<div><h1 class="display">Agenda</h1>' +
    `<p class="counts">${headline(view)}</p></div>` +
    `<div class="btnrow" style="margin-left:auto">${publishButton(view)}</div>` +
    '</div>' +
    `<div class="filters daybar" style="margin-top:14px">${dayTabs}` +
    (view.tzLabel ? `<span class="sub" style="margin-left:auto">${esc(view.tzLabel)}</span>` : '') +
    '</div>' +
    `<div id="conflict">${strips}</div>` +
    `<div class="build${pick ? ' arming' : ''}" style="margin-top:8px">` +
    rail(view, pick ? pick.id : null) +
    grid(view, pick, selected ? selected.id : null) +
    '</div>' +
    '<p class="hint">' +
    (view.canEdit
      ? 'Pick a talk on the left, then click where it goes. A clash comes back as a sentence right here, not a warning you have to go looking for.'
      : 'This is the program as it stands. Ask an organizer of this event for a hand in changing it.') +
    '</p>';

  return page({
    title: `Agenda · ${view.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: view.slug,
      eventName: view.name,
      here: '/agenda',
      who: principal.name,
      whoInitials: initialsOf(principal.name),
      tzLabel: view.tzLabel ?? '',
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** Every write comes back to the grid, on the day it was working on. */
function back(slug: string, params: Params): string {
  return here(slug, params);
}

function noteOf(res: AgendaResult, done: Note): Note {
  return res.ok ? done : res.reason;
}

type AgendaCtx = Context<{ Bindings: Env }>;

/** Form values arrive as strings or files; only the string reading is a fact. */
function field(form: Record<string, unknown>, name: string): string {
  const v = form[name];
  return typeof v === 'string' ? v : '';
}

export function registerAdminAgenda(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/agenda', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    try {
      const view = await agendaBuilder(
        c.env.DB,
        principal,
        c.req.param('eventSlug'),
        c.req.query('day')
      );
      if (!view) return c.notFound();
      c.header('cache-control', 'private, no-store');
      return c.html(builderPage(view, principal, c.req.query()));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /** One click: an accepted talk gets a room and a time. */
  app.post('/admin/:eventSlug/agenda/place', async (c) => {
    const slug = c.req.param('eventSlug');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const talk = field(form, 'talk');
    const room = field(form, 'room');
    const at = Number(field(form, 'at'));
    const day = field(form, 'day');
    const eventId = await eventIdBySlug(c.env.DB, slug);
    if (!eventId) return c.notFound();
    if (!talk || !room || !Number.isFinite(at)) {
      return c.redirect(back(slug, { day, note: 'moved' }), 303);
    }
    try {
      const res = await placeSession(c.env.DB, principal, eventId, talk, room, at);
      if (res.ok) return c.redirect(back(slug, { day, note: 'placed' }), 303);
      // The pick stays in her hand: a refusal is a reason to choose another
      // square, not a reason to start again.
      return c.redirect(
        back(slug, {
          day,
          note: res.reason,
          pick: talk,
          room: res.reason === 'room-taken' ? room : null,
          t: res.reason === 'room-taken' ? String(at) : null,
          clash: res.clashId ?? null,
        }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /** One click, and its undo: off the grid, and straight back into her hand. */
  app.post('/admin/:eventSlug/agenda/clear', async (c) => {
    const slug = c.req.param('eventSlug');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const talk = field(form, 'talk');
    const day = field(form, 'day');
    const eventId = await eventIdBySlug(c.env.DB, slug);
    if (!eventId) return c.notFound();
    if (!talk) return c.redirect(back(slug, { day, note: 'moved' }), 303);
    try {
      const res = await clearPlacement(c.env.DB, principal, eventId, talk);
      return c.redirect(
        back(slug, { day, note: noteOf(res, 'cleared'), pick: res.ok ? talk : null }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /** Second pass: the confirm named the talk, and the guard names the state. */
  app.post('/admin/:eventSlug/agenda/cancel', async (c) => {
    const slug = c.req.param('eventSlug');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const talk = field(form, 'talk');
    const day = field(form, 'day');
    const note = field(form, 'note');
    const eventId = await eventIdBySlug(c.env.DB, slug);
    if (!eventId) return c.notFound();
    if (!talk) return c.redirect(back(slug, { day, note: 'moved' }), 303);
    try {
      const res = await cancelSession(c.env.DB, principal, eventId, talk, note);
      return c.redirect(
        back(slug, { day, note: noteOf(res, 'cancelled'), on: res.ok ? talk : null }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /** One click: a cancelled session goes back on, in the place it kept. */
  app.post('/admin/:eventSlug/agenda/restore', async (c) => {
    const slug = c.req.param('eventSlug');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const talk = field(form, 'talk');
    const day = field(form, 'day');
    const eventId = await eventIdBySlug(c.env.DB, slug);
    if (!eventId) return c.notFound();
    if (!talk) return c.redirect(back(slug, { day, note: 'moved' }), 303);
    try {
      const res = await restoreSession(c.env.DB, principal, eventId, talk);
      return c.redirect(
        back(slug, {
          day,
          note: noteOf(res, 'restored'),
          on: talk,
          clash: res.ok ? null : (res.clashId ?? null),
        }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /** Second pass: the number she read is the number that goes public. */
  app.post('/admin/:eventSlug/agenda/publish', async (c) => {
    return await flipAgenda(c, 'publish');
  });

  app.post('/admin/:eventSlug/agenda/unpublish', async (c) => {
    return await flipAgenda(c, 'unpublish');
  });

  async function flipAgenda(c: AgendaCtx, which: 'publish' | 'unpublish'): Promise<Response> {
    const slug = c.req.param('eventSlug') ?? '';
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const day = field(form, 'day');
    const placed = Number(field(form, 'placed'));
    const eventId = await eventIdBySlug(c.env.DB, slug);
    if (!eventId) return c.notFound();
    if (!Number.isFinite(placed)) return c.redirect(back(slug, { day, note: 'count-moved' }), 303);
    try {
      const res =
        which === 'publish'
          ? await publishAgenda(c.env.DB, principal, eventId, placed)
          : await unpublishAgenda(c.env.DB, principal, eventId, placed);
      return c.redirect(
        back(slug, { day, note: noteOf(res, which === 'publish' ? 'published' : 'unpublished') }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  }
}
