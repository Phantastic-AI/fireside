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
//   THE WORDS COME FROM queries/portal.ts. That query is scoped to one person
//   and it owns the not-told invariant, so a decision that has been made but
//   not sent is invisible in what this page renders, exactly as it is in the
//   portal. Nothing drawn here is read from anywhere else.
//
//   THE DOOR IS THE SHAPE OF THE LOCK. Which of the pages to draw is decided
//   from the real state instead (workflows/edit.ts, `trueStanding`), because a
//   form drawn over a proposal the write guard will refuse sends somebody away
//   with the wrong sentence — and a wrong sentence about a decided proposal is
//   worse than wrong, it is a tell. What that read returns is never printed:
//   the not-told case gets a page that says only what is true of every
//   proposal the committee is still holding.
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
import {
  ABSTRACT_MAX,
  CO_ROWS,
  FORMATS,
  LEVELS,
  coRowsFrom,
  peopleOnTalk,
  tracksOfEvent,
  visibleQuestions,
  type CoRow,
  type TrackOption,
  CO_ROLES,
  coRoleOf,
  type CoRole,
} from '../../workflows/submit';
import { editProposal, trueStanding } from '../../workflows/edit';
import { newId } from '../../lib/db';
// The island is hand-written browser JS, deliberately outside the TypeScript
// program (tsconfig has no allowJs, and types.d.ts declares only '*.css').
// @ts-ignore -- plain-JS island; the call's form and this talk run the same one.
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
  /** The people speaking with them, row by row, exactly as the form holds them. */
  co: CoRow[];
};

/** The rows the block draws: everyone already on the talk, and then empty ones
 *  until there are three. Every person it shows is a person it can also take
 *  off, which is the whole reason the number is not fixed at three. */
function coRowsOf(existing: readonly CoRow[]): CoRow[] {
  const rows: CoRow[] = existing.map((r) => ({ name: r.name, email: r.email, role: r.role }));
  while (rows.length < CO_ROWS) rows.push({ name: '', email: '', role: 'co_speaker' });
  return rows;
}

/** The stored answers, narrowed to what a control can hold. */
function answersOf(stored: Record<string, unknown>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  return out;
}

function valuesOf(s: PortalSubmission, co: readonly CoRow[]): FormValues {
  return {
    title: s.title,
    abstract: s.abstract ?? '',
    track: s.track ? s.track.slug : '',
    format: s.format,
    level: s.level ?? '',
    answers: answersOf(s.answers),
    co: coRowsOf(co),
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
    '<span class="hint">Where your talk sits in the program. The tracks become the lanes on ' +
    'the schedule.</span></label>'
  );
}

/**
 * A show-if rule, said out loud. The call's own reading, word for word: the
 * stored rule is `{ questionId, equals }`, its questionId is either an earlier
 * question's id or one of the three built-in choices the form draws itself —
 * `format`, `track`, `level` — and the stored `equals` is turned back into the
 * word on the control, since a level is stored as its enum and a track as its
 * slug.
 */
function conditionOn(
  s: { questionId: string; equals: string },
  questions: readonly CfpQuestion[],
  tracks: readonly TrackOption[]
): string {
  const parent = questions.find((q) => q.id === s.questionId);
  if (parent) {
    if (parent.kind === 'checkbox') {
      return s.equals === 'true'
        ? `Only if you tick ${parent.label}`
        : `Only if you leave ${parent.label} unticked`;
    }
    return `Only if your answer to ${parent.label} is ${s.equals}`;
  }
  if (s.questionId === 'format') return `Only if your answer to Format is ${s.equals}`;
  if (s.questionId === 'level') {
    return `Only if your answer to Who is this for is ${
      LEVELS.find((l) => l.value === s.equals)?.word ?? s.equals
    }`;
  }
  if (s.questionId === 'track') {
    return `Only if your answer to Track is ${
      tracks.find((t) => t.slug === s.equals)?.name ?? s.equals
    }`;
  }
  return `Only if your answer to ${s.questionId} is ${s.equals}`;
}

/** R-10 — the organizer's own questions, with the answers already in them. */
function question(
  q: CfpQuestion,
  values: FormValues,
  shown: boolean,
  questions: readonly CfpQuestion[],
  tracks: readonly TrackOption[]
): string {
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
  // The call's own rendering: drawn in the open, grouped under its condition
  // in words, and never required unless the answer already matches. The island
  // narrows it to the one question being asked; a browser that never runs it
  // can still read the rule and answer under it. No `display` in this style —
  // `hidden` is what the island toggles, and an inline display would out-rank
  // the browser's own rule for it.
  return (
    `<div data-when="${esc(s.questionId)}" data-is="${esc(s.equals)}" ` +
    'style="border-left:2px solid var(--line);padding-left:16px;margin:0 0 22px">' +
    `<p class="hint" style="margin:0 0 10px">${esc(conditionOn(s, questions, tracks))}</p>` +
    inner +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The people speaking with you. The call's own block, word for word and
 * box for box — a speaker who added somebody on the way in should find
 * the same two boxes here, already full, and taking a name out should be
 * rubbing it out rather than hunting for a control that does it.
 * ------------------------------------------------------------------ */

function coRow(i: number, row: CoRow): string {
  const n = i + 1;
  return (
    '<div class="fw" style="display:flex;gap:14px;flex-wrap:wrap">' +
    `<label class="f" for="f-co-name-${n}" style="flex:1 1 14em;margin-bottom:0">` +
    '<span class="f-lab">Name</span>' +
    `<input type="text" id="f-co-name-${n}" name="co_name_${n}" value="${esc(row.name)}" ` +
    'autocomplete="off"></label>' +
    `<label class="f" for="f-co-email-${n}" style="flex:1 1 14em;margin-bottom:0">` +
    '<span class="f-lab">Email</span>' +
    `<input type="email" id="f-co-email-${n}" name="co_email_${n}" value="${esc(row.email)}" ` +
    'autocomplete="off"></label>' +
    `<label class="f" for="f-co-role-${n}" style="flex:0 1 11em;margin-bottom:0">` +
    '<span class="f-lab">On the talk as</span>' +
    `<select id="f-co-role-${n}" name="co_role_${n}">` +
    CO_ROLES.map(
      (r) =>
        `<option value="${r}"${row.role === r ? ' selected' : ''}>${esc(coRoleWord(r))}</option>`
    ).join('') +
    '</select></label>' +
    '</div>'
  );
}

/** The word for a co-row's role, from the label map like every other word. */
function coRoleWord(r: CoRole): string {
  return r === 'co_author'
    ? label('role.coauthor', 'onstage')
    : r === 'panelist'
      ? label('role.panelist', 'onstage')
      : r === 'moderator'
        ? label('role.host', 'onstage')
        : label('role.cospeaker', 'onstage');
}

function coBlock(rows: readonly CoRow[]): string {
  return (
    '<hr class="rule">' +
    '<div role="group" aria-labelledby="co-head">' +
    '<h2 class="display" id="co-head" style="font-size:28px;display:flex;align-items:baseline;' +
    'gap:12px;flex-wrap:wrap">Co-presenters' +
    '<span style="font-size:13px;font-weight:400;color:var(--muted)">optional</span></h2>' +
    '<p class="hint" style="margin:6px 0 18px">They appear on the program beside you, and the ' +
    'talk shows in their portal too. Clearing a row takes that person off this talk.</p>' +
    rows.map((r, i) => coRow(i, r)).join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The pages
 * ------------------------------------------------------------------ */

// Nothing in the nav is this page, so nothing in it is marked as this page.
const shell = (ev: EventHome, body: string, script = ''): string =>
  onstageShell(eventNav(ev.slug, '/cfp/edit', callIsOpen(ev, Date.now())), body, ev.slug) + script;

/** Signed out: the portal's own door, because that is where identity lives. */
function signedOutPage(ev: EventHome): string {
  const body =
    '<div class="wrap" style="padding-top:44px">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    '<div class="sec state-out" style="max-width:40em">' +
    '<h2>Sign in to change your proposal.</h2>' +
    '<p>Every letter we send carries a link straight back in. Open the most recent one, or sign ' +
    'in with the address on your proposal and we will send a fresh one.</p>' +
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
function shutPage(
  ev: EventHome,
  head: string,
  why: string,
  door = 'See where it stands →',
  extra = ''
): string {
  const body =
    '<div class="wrap" style="padding-top:44px">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    '<div class="sec state-out" style="max-width:40em">' +
    `<h2>${esc(head)}</h2>` +
    `<p>${esc(why)}</p>` +
    '<div class="btnrow">' +
    `<a class="btn btn-primary btn-lg" href="/${esc(ev.slug)}/portal">${esc(door)}</a>` +
    `<a class="btn btn-lg" href="/${esc(ev.slug)}/agenda">See the program</a>` +
    '</div>' +
    extra +
    '</div></div>';

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
      ? `Proposals closed on ${instantOf(ev.cfpClosesAt, ev.timezone)}.`
      : 'This call is no longer taking proposals.';
  return shutPage(
    ev,
    'The call has closed.',
    `${closed} The words you sent are the ones the committee is reading.`
  );
}

/** Past changing, in the speaker's own vocabulary. Every state named here has
 *  already been told — the read is told-gated — so naming it leaks nothing. */
/** T609 — the door a settled talk still has: not the words (those are the
 *  committee's now) but a note straight to the organizers asking for a
 *  change. It lands on their conference dashboard. */
function changeRequestForm(ev: EventHome, s: PortalSubmission, sent: boolean): string {
  if (sent) {
    return (
      '<div class="card card-pad" style="margin-top:16px"><p><b>Your note is with the ' +
      'organizers.</b></p><p class="hint" style="margin-top:4px">It shows on their desk with ' +
      'this talk named. Changes to a settled talk are theirs to make.</p></div>'
    );
  }
  return (
    '<div class="card card-pad" style="margin-top:16px">' +
    '<h2 class="serif" style="font-size:18px;font-weight:600">Need something changed?</h2>' +
    '<p class="hint" style="margin:6px 0 10px">A settled talk&#39;s words are changed by the ' +
    'organizers, so ask them here — a new co-speaker, a corrected title, anything.</p>' +
    `<form method="post" action="/${esc(ev.slug)}/cfp/edit/${esc(s.id)}/note">` +
    '<textarea name="note" rows="3" maxlength="500" style="width:100%" ' +
    'placeholder="What needs changing, in a sentence or two"></textarea>' +
    '<div class="btnrow" style="margin-top:10px">' +
    '<button class="btn btn-primary" type="submit">Send it to the organizers</button></div>' +
    '</form></div>'
  );
}

function settledPage(ev: EventHome, s: PortalSubmission, noteSent = false): string {
  switch (s.state) {
    case 'accepted':
      return shutPage(
        ev,
        'You are on the program.',
        'A talk keeps the words it was accepted with, so this talk is settled. Everything still to ' +
          'come — the time, the room, what the organizers need from you — is in your portal.',
        undefined,
        changeRequestForm(ev, s, noteSent)
      );
    case 'waitlisted':
      return shutPage(
        ev,
        `${label('submission.waitlisted', 'onstage')}.`,
        'The committee is holding this talk exactly as it is, so the words stay put while they decide.',
        undefined,
        changeRequestForm(ev, s, noteSent)
      );
    case 'rejected':
      return shutPage(
        ev,
        `${label('submission.rejected', 'onstage')}.`,
        'The committee has been through this talk, so there is nothing here left to change. What ' +
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
        'You pulled this talk back, so there is nothing here to change. Your portal has the rest ' +
          'of where things stand.'
      );
  }
}

/**
 * Decided, and the letter has not gone yet.
 *
 * This is the one page in the product a speaker can reach while something is
 * true about their talk that they have not been told. So it says nothing a
 * proposal still being read would not say: no state word, no date, no hint
 * that anything has happened at all. Every sentence here is equally true of a
 * proposal sitting in the middle of the pile, which is exactly what makes it
 * safe — read it beside a friend's and there is nothing to compare.
 *
 * If a sentence is ever added to this page, it has to pass that test first.
 */
function inHandPage(ev: EventHome): string {
  return shutPage(
    ev,
    'The committee has this talk in hand.',
    'While they read, the words stay as you sent them. Anything you need them to know, add a ' +
      'note from your portal.',
    'Open your portal →'
  );
}

/** Signed in, but this is somebody else's talk — or nobody's. */
function notYoursPage(ev: EventHome): string {
  return shutPage(
    ev,
    'That proposal is not one of yours.',
    'A portal only ever holds the talks you are on. If you sent this talk from another address, ' +
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

  // Under the save. The lede has already said what the committee is holding,
  // so this is the date, and the one fact a draft still needs.
  const closing =
    (sent ? '' : 'Nobody on the committee sees this talk yet. ') +
    (closes ? `The call closes on ${esc(closes)}, and nothing changed after that reaches them.` : '');

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
    o.questions.map((q) => question(q, values, shownIds.has(q.id), o.questions, o.tracks)).join('') +
    '</div>' +
    coBlock(values.co) +
    '<div class="btnrow" style="margin-top:8px">' +
    '<button type="submit" class="btn btn-primary btn-lg">Save these words</button>' +
    `<a class="btn btn-lg" href="/${esc(ev.slug)}/portal">${esc(label('pane.leave', 'onstage'))}</a>` +
    '</div>' +
    (closing ? `<p class="hint" style="margin-top:12px;max-width:40em">${closing}</p>` : '') +
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
 *  a reason, and every reason is one a speaker may hear. */
type Standing =
  | { kind: 'signed-out' }
  | { kind: 'not-yours' }
  | { kind: 'call-shut' }
  /** Decided, and not yet told. Named for what the speaker is shown, never
   *  for what is true — nothing downstream of this word may print it. */
  | { kind: 'in-hand' }
  | { kind: 'settled'; s: PortalSubmission }
  | { kind: 'ok'; s: PortalSubmission; personId: string };

/**
 * What to draw, and what to draw it from.
 *
 * The words on the page come from the portal's read, which is told-gated: it
 * cannot see a decision that has not been sent, and that is the product's
 * promise, not an oversight. But the door has to be the same shape as the lock
 * behind it — a form drawn over a proposal the write guard will refuse ends in
 * a sentence about the proposal moving, which is both wrong and, to somebody
 * re-reading it later, a hint. So the *choice* is made from the real state
 * (workflows/edit.ts, `trueStanding`), and none of what it read is printed.
 *
 * The order of the three closed doors is deliberate:
 *
 *   Told first — "you are on the program" is a truer reason than "the call has
 *   closed", and by then the speaker already knows it.
 *
 *   Then the call. A proposal nobody has been told about reads the same after
 *   the call closes whether the committee has decided it or not, which is the
 *   point: two speakers comparing screens see one sentence between them.
 *
 *   The quiet page last, for a decision made while the call is still open.
 */
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

  const truth = await trueStanding(env.DB, ev.id, submissionId, principal.personId);
  if (!truth) return { kind: 'not-yours' };

  const decided =
    truth.state === 'accepted' || truth.state === 'waitlisted' || truth.state === 'rejected';
  const over = truth.state === 'withdrawn' || truth.state === 'cancelled';

  if (over || (decided && truth.told)) return { kind: 'settled', s };
  if (!callIsOpen(ev, nowMs)) return { kind: 'call-shut' };
  if (decided) return { kind: 'in-hand' };
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

    if (standing.kind === 'signed-out') return c.html(signedOutPage(ev), 401);
    if (standing.kind === 'not-yours') return c.html(notYoursPage(ev), 404);
    if (standing.kind === 'call-shut') return c.html(callShutPage(ev), 403);
    if (standing.kind === 'settled') {
      return c.html(settledPage(ev, standing.s, c.req.query('sent') === '1'), 403);
    }
    if (standing.kind === 'in-hand') return c.html(inHandPage(ev), 403);

    const [tracks, questions, people] = await Promise.all([
      tracksOfEvent(c.env.DB, ev.id),
      cfpQuestions(c.env.DB, ev.id),
      peopleOnTalk(c.env.DB, standing.s.id),
    ]);
    // The block comes back full: everyone on the talk who has an address to
    // come back to. Somebody an organizer put on without one is not shown and
    // not touched — this form only takes off what it can put back.
    const co = people
      .filter((p) => p.role !== 'speaker' && !p.isSubmitter && p.email !== null)
      .map((p) => ({ name: p.name, email: p.email ?? '', role: coRoleOf(p.role) }));
    return c.html(
      editPage({ ev, s: standing.s, tracks, questions, values: valuesOf(standing.s, co) })
    );
  });

  // T609 — the settled talk's one write: a change request, straight to the
  // organizers' desk. The words themselves stay the committee's.
  app.post('/:event/cfp/edit/:submissionId/note', async (c) => {
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
    if (standing.kind !== 'settled') {
      // A talk still changeable changes itself; the note door is the settled
      // talk's alone.
      return c.redirect(`/${encodeURIComponent(ev.slug)}/cfp/edit/${encodeURIComponent(c.req.param('submissionId'))}`, 303);
    }
    const form = await c.req.parseBody();
    const note = (typeof form['note'] === 'string' ? form['note'] : '').trim().slice(0, 500);
    const back = `/${encodeURIComponent(ev.slug)}/cfp/edit/${encodeURIComponent(standing.s.id)}`;
    if (!note) return c.redirect(back, 303);
    await c.env.DB
      .prepare(
        `INSERT INTO question (id, event_id, scope, text, answered, asked_at)
         VALUES (?, ?, 'speaker', ?, 0, ?)`
      )
      .bind(
        newId('qq'),
        ev.id,
        `Change request on “${standing.s.title}”: ${note}`,
        Date.now()
      )
      .run();
    return c.redirect(`${back}?sent=1`, 303);
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
    // Nothing was written here either, and the sentence for it is the portal's
    // — the same one the page above says, for the same reason.
    if (standing.kind === 'in-hand') {
      return c.redirect(backToPortal(ev.slug, 'note=in-hand'), 303);
    }

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
    const co = coRowsFrom(text);
    const typedTo = co.reduce((n, r, i) => (r.name || r.email ? i + 1 : n), 0);
    const values: FormValues = {
      title: text('title'),
      abstract: text('abstract'),
      track: text('track'),
      format: text('format'),
      level: text('level'),
      answers,
      // A refusal comes back with the block as it was left — including the row
      // somebody had just rubbed out.
      co: co.slice(0, Math.max(CO_ROWS, typedTo)),
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
        co,
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
