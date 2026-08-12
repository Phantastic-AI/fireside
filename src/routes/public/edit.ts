// S-3b — changing a proposal, which is the promise the thanks page makes.
//
// Priya, 23:50, the night before the call closes, on a phone: she has re-read
// her abstract and one sentence is wrong. She should not have to withdraw and
// send again, and she should not have to wonder whether the committee will see
// the old words. This screen is one door, one form, one save.
//
// Three things it is careful about:
//
//   IDENTITY LIVES IN THE PORTAL. The door to this page is on the proposal
//   card, not in an email and not on the thanks page — the thanks page sends
//   people to their portal, which is where signing in happens.
//
//   THE READ IS queries/portal.ts. That query is scoped to one person and it
//   owns the not-told invariant, so a decision that has been made but not sent
//   is invisible here exactly as it is invisible in the portal. This file never
//   reads the real state, so it can never say a decision out loud early.
//
//   THE WINDOW IS THE WRITER'S. workflows/edit.ts re-checks both the call and
//   the state inside the batch; what this screen checks is only what to draw.
//
// Register (onstage): second person, dates rather than statuses, sentence case.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, eventNav, onstageShell, page } from '../../lib/html';
import { label } from '../../lib/labels';
import { cfpQuestions, eventBySlug, type CfpQuestion, type EventHome } from '../../queries/public';
import { portalView, type PortalSubmission } from '../../queries/portal';
import { principalFromCookie } from '../../workflows/account';
import { ABSTRACT_MAX, FORMATS, LEVELS, tracksOfEvent, visibleQuestions, type TrackOption } from '../../workflows/submit';
import { editProposal } from '../../workflows/edit';
// The island is hand-written browser JS, deliberately outside the TypeScript
// program (tsconfig has no allowJs, and types.d.ts declares only '*.css').
// @ts-ignore -- plain-JS island; the call's form and this one run the same one.
import cfpIsland from '../../islands/cfp.js';

/* ------------------------------------------------------------------ *
 * Dates and numbers. A closing date is a local fact, so it is read on
 * the event's own clock.
 * ------------------------------------------------------------------ */

function instantOf(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' })
    .format(new Date(ms));
}

const num = (n: number): string => n.toLocaleString('en-US');

/** Open in the ordinary sense: opened, and not yet closed. The same reading
 *  routes/public/cfp.ts does — one window, two screens. */
function callIsOpen(ev: EventHome, nowMs: number): boolean {
  if (ev.cfpClosesAt === null || ev.cfpClosesAt <= nowMs) return false;
  return ev.cfpOpensAt === null || ev.cfpOpensAt <= nowMs;
}

/* ------------------------------------------------------------------ *
 * What is in the boxes. Posted values on the way back from a refusal;
 * stored values on the way in.
 * ------------------------------------------------------------------ */

type FormValues = {
  title: string;
  abstract: string;
  track: string;
  format: string;
  level: string;
  answers: Record<string, string | boolean>;
};

/** The stored answers, narrowed to what a control can hold. */
function answersOf(stored: Record<string, unknown>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  return out;
}

function valuesOf(s: PortalSubmission): FormValues {
  return {
    title: s.title,
    abstract: s.abstract ?? '',
    track: s.track ? s.track.slug : '',
    format: s.format,
    level: s.level ?? '',
    answers: answersOf(s.answers),
  };
}

const answerText = (v: FormValues, id: string): string => {
  const a = v.answers[id];
  return typeof a === 'string' ? a : '';
};
const answerOn = (v: FormValues, id: string): boolean => v.answers[id] === true;

/* ------------------------------------------------------------------ *
 * Form pieces. The markup vocabulary is the prototype's — .fw / .f /
 * .f-lab / .radios — because the lifted CSS in src/styles/ is the
 * binding skin. No teaching examples here: the words are already
 * written, and this screen is for changing them, not for learning the
 * shape of them.
 * ------------------------------------------------------------------ */

type FieldOpts = {
  id: string;
  name: string;
  labelText: string;
  hint?: string | null;
  value: string;
  area?: boolean;
  rows?: number;
  optional?: boolean;
  required?: boolean;
  /** Required, but hidden until a condition says otherwise — the island puts it back. */
  needed?: boolean;
  /** Marks this control as one a show-if condition may watch. */
  qid?: string;
  /** A ceiling worth counting towards. */
  limit?: number;
};

function field(o: FieldOpts): string {
  const attrs =
    `id="${esc(o.id)}" name="${esc(o.name)}" data-count` +
    (o.needed ? ' data-needed' : '') +
    (o.qid ? ` data-qid="${esc(o.qid)}"` : '') +
    (o.required ? ' required' : '') +
    (o.limit ? ` maxlength="${o.limit}" data-limit="${o.limit}"` : '');

  const control = o.area
    ? `<textarea ${attrs} rows="${o.rows ?? 5}">${esc(o.value)}</textarea>`
    : `<input type="text" ${attrs} value="${esc(o.value)}">`;

  const counter = o.limit
    ? `<span class="counter" data-count-for="${esc(o.id)}" style="margin-left:auto">` +
      `${num(o.value.length)} / ${num(o.limit)}</span>`
    : '';

  return (
    '<div class="fw">' +
    `<label class="f" for="${esc(o.id)}">` +
    `<span class="f-lab">${esc(o.labelText)}` +
    (o.optional ? '<span class="opt">optional</span>' : '') +
    counter +
    '</span>' +
    control +
    (o.hint ? `<span class="hint">${esc(o.hint)}</span>` : '') +
    '</label></div>'
  );
}

function choice(o: {
  id: string;
  name: string;
  labelText: string;
  hint: string;
  qid: string;
  value: string;
  options: { value: string; word: string }[];
  required?: boolean;
  needed?: boolean;
}): string {
  const opts = o.options
    .map(
      (c) =>
        `<option value="${esc(c.value)}"${c.value === o.value ? ' selected' : ''}>${esc(c.word)}</option>`
    )
    .join('');
  return (
    `<label class="f" for="${esc(o.id)}"><span class="f-lab">${esc(o.labelText)}</span>` +
    `<select id="${esc(o.id)}" name="${esc(o.name)}" data-count data-qid="${esc(o.qid)}"` +
    (o.needed ? ' data-needed' : '') +
    (o.required ? ' required' : '') +
    '>' +
    `<option value="">Choose one</option>${opts}</select>` +
    `<span class="hint">${esc(o.hint)}</span></label>`
  );
}

/** The tracks, as the radio ladder the prototype draws. Colour is the track's own. */
function trackField(tracks: TrackOption[], chosen: string): string {
  const rows = tracks
    .map((t) => {
      const tint = /^#[0-9a-fA-F]{6}$/.test(t.colour)
        ? ` style="--tc:${esc(t.colour)};--tw:color-mix(in srgb, ${esc(t.colour)} 12%, transparent)"`
        : '';
      const on = t.slug === chosen;
      return (
        `<label class="radio${on ? ' on' : ''}"${tint} data-radio>` +
        `<input type="radio" name="track" value="${esc(t.slug)}" data-count data-qid="track"` +
        (on ? ' checked' : '') +
        ' required>' +
        `<span><span class="rname">${esc(t.name)}</span></span></label>`
      );
    })
    .join('');
  return (
    '<label class="f" id="f-track"><span class="f-lab">Track</span>' +
    `<div class="radios">${rows}</div>` +
    '<span class="hint">Where your talk lives in the program — the committee reads by track, ' +
    "and the tracks become the schedule's lanes.</span></label>"
  );
}

/** R-10 — the organizer's own questions, with the answers already in them. */
function question(q: CfpQuestion, values: FormValues, shown: boolean): string {
  const id = `f-q-${q.id}`;
  const name = `q:${q.id}`;
  // A conditional question is released from being required while it is out of
  // sight — a browser must never refuse a save over something invisible. The
  // island puts `required` back when it appears; workflows/edit.ts is the
  // enforcer either way.
  const conditional = q.showIf !== null;
  const required = q.required && (!conditional || shown);
  const needed = q.required && conditional;
  const inner =
    q.kind === 'short' || q.kind === 'long'
      ? field({
          id,
          name,
          labelText: q.label,
          hint: q.hint,
          value: answerText(values, q.id),
          area: q.kind === 'long',
          rows: 3,
          optional: !q.required,
          required,
          needed,
          qid: q.id,
        })
      : q.kind === 'select'
        ? '<div class="fw">' +
          choice({
            id,
            name,
            labelText: q.label,
            hint: q.hint ?? '',
            qid: q.id,
            value: answerText(values, q.id),
            options: (q.options ?? []).map((o) => ({ value: o, word: o })),
            required,
            needed,
          }) +
          '</div>'
        : '<div class="fw"><label class="f radio' +
          (answerOn(values, q.id) ? ' on' : '') +
          `" for="${esc(id)}" data-radio>` +
          `<input type="checkbox" id="${esc(id)}" name="${esc(name)}" value="true"` +
          ` data-count data-qid="${esc(q.id)}"` +
          (needed ? ' data-needed' : '') +
          (answerOn(values, q.id) ? ' checked' : '') +
          (required ? ' required' : '') +
          '>' +
          `<span><span class="rname">${esc(q.label)}</span>` +
          (q.hint ? `<span class="rsub">${esc(q.hint)}</span>` : '') +
          '</span></label></div>';

  if (!conditional) return inner;
  const s = q.showIf as { questionId: string; equals: string };
  return (
    `<div data-when="${esc(s.questionId)}" data-is="${esc(s.equals)}"${shown ? '' : ' hidden'}>` +
    inner +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The pages
 * ------------------------------------------------------------------ */

// Nothing in the nav is this page, so nothing in it is marked as this page.
const shell = (ev: EventHome, body: string, script = ''): string =>
  onstageShell(eventNav(ev.slug, '/cfp/edit', callIsOpen(ev, Date.now())), body) + script;

/** Signed out: the portal's own door, because that is where identity lives. */
function signedOutPage(ev: EventHome): string {
  const body =
    '<div class="wrap" style="padding-top:44px">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    '<div class="sec state-out" style="max-width:40em">' +
    '<h2>Sign in to change your proposal.</h2>' +
    '<p>Every letter we send you carries a link straight back in — the one that says we have your ' +
    'proposal, and every one after it. Open the most recent one, or sign in with the address you ' +
    'sent your proposal from and we will send a fresh link.</p>' +
    '<div class="btnrow">' +
    `<a class="btn btn-primary btn-lg" href="/sign-in">${esc(label('auth.sign_in', 'onstage'))}</a>` +
    `<a class="btn btn-lg" href="/${esc(ev.slug)}/portal">Your portal</a>` +
    '</div>' +
    '<p class="aside">A proposal belongs to the people on it. Nothing in it is public.</p>' +
    '</div></div>';

  return page({
    title: `Change your proposal · ${ev.name}`,
    register: 'onstage',
    body: shell(ev, body),
  });
}

/** A refusal with a reason and a door. Never a bare no. */
function shutPage(ev: EventHome, head: string, why: string, door = 'See where it stands →'): string {
  const body =
    '<div class="wrap" style="padding-top:44px">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    '<div class="sec state-out" style="max-width:40em">' +
    `<h2>${esc(head)}</h2>` +
    `<p>${esc(why)}</p>` +
    '<div class="btnrow">' +
    `<a class="btn btn-primary btn-lg" href="/${esc(ev.slug)}/portal">${esc(door)}</a>` +
    `<a class="btn btn-lg" href="/${esc(ev.slug)}/agenda">See the program</a>` +
    '</div></div></div>';

  return page({
    title: `Your proposal · ${ev.name}`,
    register: 'onstage',
    body: shell(ev, body),
  });
}

/** The call has shut since the door was drawn. */
function callShutPage(ev: EventHome): string {
  const closed =
    ev.cfpClosesAt !== null
      ? `${label('call.closed', 'onstage').replace('{date}', instantOf(ev.cfpClosesAt, ev.timezone))}.`
      : 'The call for speakers is not taking proposals.';
  return shutPage(
    ev,
    'The call has closed.',
    `${closed} The committee is reading what came in, and the words they are reading are the ones that stay.`
  );
}

/** Past changing, in the speaker's own vocabulary. Every state named here has
 *  already been told — the read is told-gated — so naming it leaks nothing. */
function settledPage(ev: EventHome, s: PortalSubmission): string {
  switch (s.state) {
    case 'accepted':
      return shutPage(
        ev,
        'You are on the program.',
        'A talk keeps the words it was accepted with, so this one is settled. Everything still to ' +
          'come — the time, the room, what the organizers need from you — is in your portal.'
      );
    case 'waitlisted':
      return shutPage(
        ev,
        `${label('submission.waitlisted', 'onstage')}.`,
        'The committee is holding this one exactly as it is, so the words stay put while they decide.'
      );
    case 'rejected':
      return shutPage(
        ev,
        `${label('submission.rejected', 'onstage')}.`,
        'The committee has been through this one, so there is nothing here left to change. What ' +
          'they said about it is in your portal.'
      );
    case 'cancelled':
      return shutPage(
        ev,
        `${label('submission.cancelled', 'onstage')}.`,
        'This one has come off the program, so its words are no longer yours to change.'
      );
    default:
      return shutPage(
        ev,
        `${label('submission.withdrawn', 'onstage')}.`,
        'You pulled this one back, so there is nothing here to change. Your portal has the rest ' +
          'of where things stand.'
      );
  }
}

/** Signed in, but this is somebody else's talk — or nobody's. */
function notYoursPage(ev: EventHome): string {
  return shutPage(
    ev,
    'That proposal is not one of yours.',
    'A portal only ever holds the talks you are on. If you sent this one from another address, ' +
      'sign in with that address and it will be waiting.',
    'Open your portal →'
  );
}

/**
 * The form. Everything already in it, and one save.
 *
 * The island is the call's own, so the counter, the show-if conditions and the
 * chosen-track tint behave identically on both screens. Its device copy is
 * keyed per proposal and cleared as this page loads: on a form that is already
 * full, a half-typed copy coming back over stored words would be a lie about
 * what the committee holds.
 */
function editPage(o: {
  ev: EventHome;
  s: PortalSubmission;
  tracks: TrackOption[];
  questions: CfpQuestion[];
  values: FormValues;
  refusal?: { field: string | null; message: string } | null;
}): string {
  const { ev, s, values } = o;
  const shown = visibleQuestions(
    o.questions,
    { format: values.format, track: values.track, level: values.level },
    values.answers
  );
  const shownIds = new Set(shown.map((q) => q.id));
  const closes = ev.cfpClosesAt !== null ? instantOf(ev.cfpClosesAt, ev.timezone) : null;
  const sent = s.state !== 'draft';

  const refusal = o.refusal
    ? '<div class="notebox" role="alert" style="margin-bottom:20px;border-left-color:var(--ember)">' +
      `<p style="margin:0" class="serif">${esc(o.refusal.message)}</p>` +
      (o.refusal.field
        ? `<p style="margin:8px 0 0"><a class="link" href="#${esc(o.refusal.field)}">` +
          `${esc(label('tool.take_me_there', 'onstage'))} →</a></p>`
        : '') +
      '</div>'
    : '';

  const lede = sent
    ? 'The committee has the words you sent. What you save here takes their place' +
      (closes ? `, right up until the call closes on ${closes}.` : '.')
    : 'This one has not gone to the committee yet. Change anything you like — the words you save ' +
      'are the ones that will go.';

  const key = `edit-${s.id}`.replace(/[^A-Za-z0-9._-]/g, '');
  const script =
    '<script>' +
    // The island's device copy, cleared before it can restore over stored words.
    `try{localStorage.removeItem(${JSON.stringify(`fireside.cfp.${key}`)})}catch(e){};` +
    String(cfpIsland) +
    '</script>';

  const form =
    `<form class="cfpform" method="post" action="/${esc(ev.slug)}/cfp/edit/${esc(s.id)}" ` +
    `data-cfp="${esc(key)}">` +
    refusal +
    '<h2 class="display" style="font-size:28px">Your talk</h2>' +
    '<div style="margin-top:18px">' +
    field({
      id: 'f-title',
      name: 'title',
      labelText: 'Talk title',
      hint: 'This is the line a stranger reads on the schedule. If your talk is accepted, it goes on the program word for word.',
      value: values.title,
      required: true,
    }) +
    field({
      id: 'f-abs',
      name: 'abstract',
      labelText: 'Your talk in one paragraph',
      hint: `If your talk is accepted, this goes on the program word for word. Up to ${num(ABSTRACT_MAX)} characters.`,
      value: values.abstract,
      area: true,
      rows: 6,
      required: true,
      limit: ABSTRACT_MAX,
    }) +
    (o.tracks.length ? trackField(o.tracks, values.track) : '') +
    choice({
      id: 'f-fmt',
      name: 'format',
      labelText: 'Format',
      hint: 'Talks are thirty or forty-five minutes; we settle which when the grid comes together. Workshops need a room with tables.',
      qid: 'format',
      value: values.format,
      options: FORMATS.map((f) => ({ value: f.word, word: f.word })),
      required: true,
    }) +
    choice({
      id: 'f-lvl',
      name: 'level',
      labelText: 'Who is this for?',
      hint: 'Shown on the public agenda so nobody walks into the wrong room.',
      qid: 'level',
      value: values.level,
      options: LEVELS.map((l) => ({ value: l.value, word: l.word })),
      required: true,
    }) +
    o.questions.map((q) => question(q, values, shownIds.has(q.id))).join('') +
    '</div>' +
    '<div class="btnrow" style="margin-top:8px">' +
    '<button type="submit" class="btn btn-primary btn-lg">Save these words</button>' +
    `<a class="btn btn-lg" href="/${esc(ev.slug)}/portal">${esc(label('pane.leave', 'onstage'))}</a>` +
    '</div>' +
    '<p class="hint" style="margin-top:12px;max-width:40em">' +
    (sent
      ? 'Until you save, the committee still reads what you sent. '
      : 'Nobody on the committee sees this one yet. ') +
    (closes
      ? `The call closes on ${esc(closes)}, and nothing changed after that reaches them.`
      : '') +
    '</p>' +
    '</form>';

  const body =
    '<div class="wrap" style="padding-top:44px">' +
    '<div class="kicker">Your proposal</div>' +
    '<h1 class="display" style="margin-top:12px">Change your proposal</h1>' +
    `<p class="lede serif" style="margin-top:16px;font-size:19px;line-height:1.6">${esc(lede)}</p>` +
    `<div class="sec" style="max-width:46em">${form}</div>` +
    '</div>';

  return page({
    title: `Change your proposal · ${ev.name}`,
    register: 'onstage',
    body: shell(ev, body, script),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** What the screen is allowed to draw. Everything past 'ok' is a refusal with
 *  a reason; the reasons are told-gated because the read is. */
type Standing =
  | { kind: 'signed-out' }
  | { kind: 'not-yours' }
  | { kind: 'call-shut' }
  | { kind: 'settled'; s: PortalSubmission }
  | { kind: 'ok'; s: PortalSubmission; personId: string };

const EDITABLE = new Set(['draft', 'submitted']);

async function standingOf(
  env: Env,
  cookie: string | undefined,
  ev: EventHome,
  submissionId: string,
  nowMs: number
): Promise<Standing> {
  const principal = await principalFromCookie(env.DB, env.SESSION_SECRET, cookie);
  if (!principal) return { kind: 'signed-out' };

  // One read, one scope: portalView is already this person's own talks only.
  const view = await portalView(env.DB, ev.id, principal.personId);
  const s = view?.submissions.find((x) => x.id === submissionId);
  if (!s) return { kind: 'not-yours' };

  // The talk's own standing is read before the call's, because by the time a
  // decision exists the call has almost always closed — and "you are on the
  // program" is the truer reason than "the call has closed".
  if (!EDITABLE.has(s.state)) return { kind: 'settled', s };
  if (!callIsOpen(ev, nowMs)) return { kind: 'call-shut' };
  return { kind: 'ok', s, personId: principal.personId };
}

/** The one sentence the portal will say when this lands. */
const backToPortal = (slug: string, query: string): string =>
  `/${encodeURIComponent(slug)}/portal?${query}`;

export function registerEditProposal(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/cfp/edit/:submissionId', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();

    const standing = await standingOf(
      c.env,
      c.req.header('cookie'),
      ev,
      c.req.param('submissionId'),
      Date.now()
    );
    // One person's own words: never held in a shared cache anywhere.
    c.header('cache-control', 'private, no-store');

    if (standing.kind === 'signed-out') return c.html(signedOutPage(ev));
    if (standing.kind === 'not-yours') return c.html(notYoursPage(ev), 404);
    if (standing.kind === 'call-shut') return c.html(callShutPage(ev), 403);
    if (standing.kind === 'settled') return c.html(settledPage(ev, standing.s), 403);

    const [tracks, questions] = await Promise.all([
      tracksOfEvent(c.env.DB, ev.id),
      cfpQuestions(c.env.DB, ev.id),
    ]);
    return c.html(
      editPage({ ev, s: standing.s, tracks, questions, values: valuesOf(standing.s) })
    );
  });

  app.post('/:event/cfp/edit/:submissionId', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();

    const standing = await standingOf(
      c.env,
      c.req.header('cookie'),
      ev,
      c.req.param('submissionId'),
      Date.now()
    );
    c.header('cache-control', 'private, no-store');

    if (standing.kind === 'signed-out') return c.html(signedOutPage(ev), 401);
    if (standing.kind === 'not-yours') return c.html(notYoursPage(ev), 404);
    // Nothing was written, and the screen says why in its own words.
    if (standing.kind === 'call-shut') return c.html(callShutPage(ev), 422);
    if (standing.kind === 'settled') return c.html(settledPage(ev, standing.s), 422);

    const body = await c.req.parseBody();
    const text = (k: string): string => {
      const v = body[k];
      return typeof v === 'string' ? v : '';
    };
    const questions = await cfpQuestions(c.env.DB, ev.id);
    const answers: Record<string, string | boolean> = {};
    for (const q of questions) {
      answers[q.id] = q.kind === 'checkbox' ? body[`q:${q.id}`] !== undefined : text(`q:${q.id}`);
    }
    const values: FormValues = {
      title: text('title'),
      abstract: text('abstract'),
      track: text('track'),
      format: text('format'),
      level: text('level'),
      answers,
    };

    const outcome = await editProposal(
      c.env.DB,
      ev.id,
      standing.s.id,
      standing.personId,
      {
        title: values.title,
        abstract: values.abstract,
        trackSlug: values.track,
        format: values.format,
        level: values.level,
        answers,
        questions,
      }
    );

    if (outcome.ok) return c.redirect(backToPortal(ev.slug, 'edited=1'), 303);
    if (outcome.kind === 'refused') {
      const tracks = await tracksOfEvent(c.env.DB, ev.id);
      return c.html(
        editPage({
          ev,
          s: standing.s,
          tracks,
          questions,
          values,
          refusal: { field: outcome.field, message: outcome.message },
        }),
        422
      );
    }
    // It moved, or nothing is known about why. Either way the portal says the
    // sentence, because the portal is where the truth of it now is.
    return c.redirect(backToPortal(ev.slug, `note=${outcome.kind === 'moved' ? 'moved' : 'trouble'}`), 303);
  });
}
