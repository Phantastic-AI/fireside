// S-3 / S-4 — the call for speakers, and the moment after sending.
//
// This is the product's face: for most people it is the first Fireside screen
// they ever see, and they are on a phone, on a sofa, at 21:40, about to hand
// over something they care about. Everything here follows from that.
//
// The teaching form. Every craft field carries a real example of a good answer
// — a whole ghost proposal, coherent field to field, that Tab accepts on a
// keyboard and one tap accepts on a phone. Nobody has to guess what this
// committee wants; they can read it and then write their own.
//
// Nothing is lost. The form keeps itself in localStorage as it is typed, and a
// refusal comes back with every word still in place — a refused proposal is a
// sentence and a full form, never a blank page.
//
// No account until you press send. The address on the proposal is the identity;
// this screen mints no session, so typing someone else's address gains nobody
// anything (see workflows/submit.ts).
//
// Register (11-hats.md, Priya): onstage-warm, second person, dates not
// statuses, sentence case, the committee's own words in the serif.

import { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, eventNav, onstageShell } from '../../lib/html';
import { label } from '../../lib/labels';
import {
  eventBySlug,
  cfpQuestions,
  speakersGallery,
  type CfpQuestion,
  type EventHome,
  type GallerySpeaker,
} from '../../queries/public';
import { principalFromCookie } from '../../workflows/account';
import {
  submitProposal,
  tracksOfEvent,
  visibleQuestions,
  ABSTRACT_MAX,
  FORMATS,
  LEVELS,
  type TrackOption,
} from '../../workflows/submit';
// The island is hand-written browser JS, deliberately outside the TypeScript
// program (tsconfig has no allowJs, and types.d.ts declares only '*.css').
// @ts-ignore -- plain-JS island; see the parcel report for the durable fix.
import cfpIsland from '../../islands/cfp.js';

/* ------------------------------------------------------------------ *
 * Dates. A conference day is a local fact, so every date is rendered in
 * the event's own timezone.
 * ------------------------------------------------------------------ */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '2026-08-27' → '27 August'. */
function dayOf(iso: string): string {
  const parts = iso.split('-');
  const month = MONTHS[Number(parts[1] ?? '0') - 1] ?? '';
  return `${Number(parts[2] ?? '0')} ${month}`.trim();
}

/** An instant, as the day it falls on where the conference is. */
function instantOf(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' })
    .format(new Date(ms));
}

function datesOf(ev: EventHome): string {
  const year = ev.startsOn.slice(0, 4);
  if (ev.startsOn === ev.endsOn) return `${dayOf(ev.startsOn)} ${year}`;
  // One month, one naming of it: "3 – 4 September 2026".
  const sameMonth = ev.startsOn.slice(0, 7) === ev.endsOn.slice(0, 7);
  const from = sameMonth ? String(Number(ev.startsOn.slice(8))) : dayOf(ev.startsOn);
  return `${from} – ${dayOf(ev.endsOn)} ${year}`;
}

const num = (n: number): string => n.toLocaleString('en-US');

/* ------------------------------------------------------------------ *
 * What the speaker typed. Carried back into the form on a refusal, so no
 * word is ever retyped.
 * ------------------------------------------------------------------ */

type FormValues = {
  title: string;
  abstract: string;
  track: string;
  format: string;
  level: string;
  name: string;
  org: string;
  email: string;
  answers: Record<string, string | boolean>;
};

const blank = (): FormValues => ({
  title: '', abstract: '', track: '', format: '', level: '',
  name: '', org: '', email: '', answers: {},
});

const answerText = (v: FormValues, id: string): string => {
  const a = v.answers[id];
  return typeof a === 'string' ? a : '';
};
const answerOn = (v: FormValues, id: string): boolean => v.answers[id] === true;

/* ------------------------------------------------------------------ *
 * The ghost proposal. One coherent example, field to field, so the person
 * reading it learns the shape of an answer this committee says yes to
 * rather than a shape of words. Every name in it is invented.
 * ------------------------------------------------------------------ */

const GHOST_TITLE = 'Claims agents: three rollouts, one that stuck';

const GHOST_ABSTRACT =
  'In 18 months we went from a pilot nobody used to agents drafting two thirds of first-pass ' +
  'claims notes. This talk walks through the three failed rollouts before the one that stuck: ' +
  'the eval set of 212 real claims that finally told us the truth, the 11 days that came off ' +
  'the median cycle time, and the operating-model changes that made it durable.';

const GHOST_ORG = 'Meridian Underwriting · SVP Engineering';

/* ------------------------------------------------------------------ *
 * Form pieces. The markup vocabulary is the prototype's, verbatim: the
 * lifted CSS in src/styles/ is the binding skin, and .fw / .f / .ghosted /
 * .eg are what turn a placeholder into a lesson on a phone.
 * ------------------------------------------------------------------ */

type FieldOpts = {
  id: string;
  name: string;
  labelText: string;
  hint?: string | null;
  /** A model answer: accepted by Tab, or by one tap on a phone. */
  example?: string | null;
  /** Shown when there is no model answer to accept. */
  placeholder?: string | null;
  value?: string;
  area?: boolean;
  rows?: number;
  optional?: boolean;
  type?: 'text' | 'email';
  required?: boolean;
  /** Required, but hidden until a condition says otherwise — the island puts it back. */
  needed?: boolean;
  /** Marks this control as one a show-if condition may watch. */
  qid?: string;
  /** A ceiling worth counting towards. */
  limit?: number;
};

function field(o: FieldOpts): string {
  const ghost = o.example ?? null;
  const ph = ghost ?? o.placeholder ?? '';
  const attrs =
    `id="${esc(o.id)}" name="${esc(o.name)}" data-count` +
    (o.needed ? ' data-needed' : '') +
    (o.qid ? ` data-qid="${esc(o.qid)}"` : '') +
    (ph ? ` placeholder="${esc(ph)}"` : '') +
    (ghost ? ' data-ghost' : '') +
    (o.required ? ' required' : '') +
    (o.limit ? ` maxlength="${o.limit}" data-limit="${o.limit}"` : '');

  const control = o.area
    ? `<textarea ${attrs} rows="${o.rows ?? 5}">${esc(o.value ?? '')}</textarea>`
    : `<input type="${o.type ?? 'text'}" ${attrs} value="${esc(o.value ?? '')}">`;

  // On a phone there is no Tab key, and a one-line input truncates the example,
  // so the model answer is printed in full with one tap to accept it.
  const example = ghost
    ? o.area
      ? '<div class="eg eg-plain"><button type="button" class="egbtn" data-eg>Use the example above</button></div>'
      : '<div class="eg"><span class="eglab">A good answer looks like</span>' +
        `<span class="egtxt">${esc(ghost)}</span>` +
        '<button type="button" class="egbtn" data-eg>Use this example</button></div>'
    : '';

  const counter = o.limit
    ? `<span class="counter" data-count-for="${esc(o.id)}" style="margin-left:auto">` +
      `${num((o.value ?? '').length)} / ${num(o.limit)}</span>`
    : '';

  return (
    '<div class="fw">' +
    `<label class="f${ghost ? ' ghosted' : ''}" for="${esc(o.id)}">` +
    `<span class="f-lab">${esc(o.labelText)}` +
    (o.optional ? '<span class="opt">optional</span>' : '') +
    counter +
    '</span>' +
    control +
    (ghost ? '<span class="ghosthint"><kbd>Tab</kbd> accepts the example</span>' : '') +
    (o.hint ? `<span class="hint">${esc(o.hint)}</span>` : '') +
    '</label>' +
    example +
    '</div>'
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

/* ------------------------------------------------------------------ *
 * R-10 — the organizer's own questions.
 * ------------------------------------------------------------------ */

function question(q: CfpQuestion, values: FormValues, shown: boolean): string {
  const id = `f-q-${q.id}`;
  const name = `q:${q.id}`;
  // A conditional question is released from being required while it is out of
  // sight — a browser must never refuse a send over something invisible. The
  // island puts `required` back when it appears; workflows/submit.ts is the
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
 * The page.
 * ------------------------------------------------------------------ */

function factRail(ev: EventHome): string {
  const bar = '<span style="opacity:.4">│</span>';
  const state =
    ev.cfpClosesAt !== null
      ? label('call.open', 'onstage').replace('{date}', instantOf(ev.cfpClosesAt, ev.timezone))
      : '';
  const bits = [
    state ? `<span>${esc(state)}</span>` : '',
    ev.decideBy ? `<span>Decisions by <b style="color:var(--ink-soft)">${esc(dayOf(ev.decideBy))}</b></span>` : '',
    `<span>${esc(datesOf(ev))}</span>`,
    ev.venueName ? `<span>${esc(ev.venueName)}</span>` : '',
    `<a class="link" href="/${esc(ev.slug)}/agenda">Program ↗</a>`,
    `<a class="link" href="/${esc(ev.slug)}/speakers">Speakers ↗</a>`,
  ].filter(Boolean);
  return (
    '<div class="sub" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:18px;' +
    'padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">' +
    bits.join(bar) +
    '</div>'
  );
}

/** Initials in a dashed ring — the prototype's stand-in when there is no headshot. */
function initialsAvatar(initials: string): string {
  return (
    '<svg class="av" width="46" height="46" viewBox="0 0 40 40" aria-hidden="true">' +
    '<circle cx="20" cy="20" r="19.2" fill="none" stroke="#D8CEBE" stroke-width="1.2" stroke-dasharray="3 3"/>' +
    '<text x="20" y="20" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600" ' +
    `fill="#B4A996">${esc(initials)}</text></svg>`
  );
}

/**
 * The people already on the program, as a strip under the form: eight of them,
 * spread evenly through the whole gallery rather than taken off the top, so a
 * conference with sixty speakers does not introduce itself with eight surnames
 * beginning with A. The count beside it is the event's own.
 */
function speakerStrip(ev: EventHome, speakers: GallerySpeaker[]): string {
  if (!speakers.length) return '';
  const room = 8;
  const step = Math.max(1, Math.floor(speakers.length / room));
  const cards = speakers
    .filter((_, i) => i % step === 0)
    .slice(0, room)
    .map((p) => {
      const role = [p.jobTitle, p.organisation].filter(Boolean).map((x) => esc(x)).join('<br>');
      return (
        `<a class="gcard" href="/${esc(ev.slug)}/speakers/${esc(p.personId)}">` +
        initialsAvatar(p.initials) +
        `<div class="gname">${esc(p.name)}</div>` +
        (role ? `<div class="grole">${role}</div>` : '') +
        '</a>'
      );
    })
    .join('');
  return (
    '<div class="sec"><h2 class="display" style="font-size:26px">Already on the program</h2>' +
    `<p class="sub" style="margin:6px 0 14px">${num(ev.counts.speakers)} ` +
    `${ev.counts.speakers === 1 ? 'person' : 'people'} so far. The committee is still reading.</p>` +
    `<div class="gal">${cards}</div>` +
    `<p style="margin-top:14px"><a class="link" href="/${esc(ev.slug)}/speakers">` +
    'See everyone speaking →</a></p></div>'
  );
}

function shell(ev: EventHome, callOpen: boolean, body: string, script = ''): string {
  return onstageShell(eventNav(ev.slug, '/cfp', callOpen), body) + script;
}

/** The call, open: intro, the form, and the people already on the program. */
function cfpPage(o: {
  ev: EventHome;
  tracks: TrackOption[];
  questions: CfpQuestion[];
  speakers: GallerySpeaker[];
  values: FormValues;
  refusal?: { field: string | null; message: string } | null;
}): string {
  const { ev, values } = o;
  const shown = visibleQuestions(
    o.questions,
    { format: values.format, track: values.track, level: values.level },
    values.answers
  );
  const shownIds = new Set(shown.map((q) => q.id));

  // Every count on this screen is counted, never typed: the answered tally is
  // the length of the list of things being asked for right now.
  const asked: string[] = [
    values.title, values.abstract,
    ...(o.tracks.length ? [values.track] : []),
    values.format, values.level,
    ...shown.filter((q) => q.kind !== 'checkbox').map((q) => answerText(values, q.id)),
    values.name, values.org, values.email,
  ];
  const answered = asked.filter((v) => v.trim() !== '').length;

  // A refusal names the thing to fix and walks them to it — the form below can
  // be a long scroll on a phone, and hunting for the sentence's subject is not
  // the speaker's job.
  const refusal = o.refusal
    ? '<div class="notebox" role="alert" style="margin-bottom:20px;border-left-color:var(--ember)">' +
      `<p style="margin:0" class="serif">${esc(o.refusal.message)}</p>` +
      (o.refusal.field
        ? `<p style="margin:8px 0 0"><a class="link" href="#${esc(o.refusal.field)}">` +
          `${esc(label('tool.take_me_there', 'onstage'))} →</a></p>`
        : '') +
      '</div>'
    : '';

  const closes = ev.cfpClosesAt !== null ? instantOf(ev.cfpClosesAt, ev.timezone) : null;

  const form =
    `<form class="cfpform" method="post" action="/${esc(ev.slug)}/cfp" data-cfp="${esc(ev.slug)}">` +
    refusal +
    '<h2 class="display" style="font-size:28px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">' +
    'Your talk' +
    `<span class="counter" data-answered style="font-size:14px">${num(answered)} of ${num(asked.length)} answered</span>` +
    '</h2>' +
    '<div style="margin-top:18px">' +
    field({
      id: 'f-title',
      name: 'title',
      labelText: 'Talk title',
      hint: 'This is the line a stranger reads on the schedule. If your talk is accepted, it goes on the program word for word.',
      example: GHOST_TITLE,
      value: values.title,
      required: true,
    }) +
    field({
      id: 'f-abs',
      name: 'abstract',
      labelText: 'Your talk in one paragraph',
      hint: `If your talk is accepted, this goes on the program word for word. Up to ${num(ABSTRACT_MAX)} characters.`,
      example: GHOST_ABSTRACT,
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
    '<hr class="rule">' +
    '<h2 class="display" style="font-size:28px">About you</h2>' +
    '<div style="margin-top:18px">' +
    field({
      id: 'f-name',
      name: 'name',
      labelText: 'Your name',
      hint: 'As you would like it printed on the schedule.',
      value: values.name,
      required: true,
    }) +
    field({
      id: 'f-org',
      name: 'org',
      labelText: 'Organisation and role',
      hint: 'Shown under your name on the public agenda.',
      example: GHOST_ORG,
      value: values.org,
      optional: true,
    }) +
    field({
      id: 'f-email',
      name: 'email',
      labelText: 'Email',
      hint: 'Your portal link lands here, and so does the decision. Nobody else sees it.',
      value: values.email,
      type: 'email',
      required: true,
    }) +
    '</div>' +
    '<div class="btnrow" style="margin-top:8px">' +
    '<button type="submit" class="btn btn-primary btn-lg">Send my proposal</button>' +
    '<button type="button" class="btn btn-lg" data-save>Save and finish later</button>' +
    '<span class="counter" data-saved></span>' +
    '</div>' +
    '<p class="hint" style="margin-top:12px;max-width:40em">' +
    'Nothing is lost while you write: this page keeps itself on your own device as you type. ' +
    (closes ? `You can change every word until the call closes on ${esc(closes)}. ` : '') +
    `Up to ${num(ev.maxSubmissions)} ${ev.maxSubmissions === 1 ? 'proposal' : 'proposals'} per person.</p>` +
    '</form>';

  const body =
    '<div class="wrap" style="padding-top:44px">' +
    '<div class="kicker">Call for speakers</div>' +
    `<h1 class="display" style="margin-top:12px">${esc(ev.name)}</h1>` +
    (ev.cfpIntro
      ? `<p class="lede serif" style="margin-top:16px;font-size:19px;line-height:1.6">${esc(ev.cfpIntro)}</p>`
      : '') +
    factRail(ev) +
    `<div class="sec" style="max-width:46em">${form}</div>` +
    speakerStrip(ev, o.speakers) +
    '</div>';

  return page({
    title: `Call for speakers — ${ev.name}`,
    description:
      `Send a talk proposal to ${ev.name}` +
      (closes ? `. The call is open until ${closes}.` : '.'),
    register: 'onstage',
    body: shell(ev, true, body, `<script>${String(cfpIsland)}</script>`),
  });
}

/** The call, not open. Two different sentences, because they are two different days. */
function callShutPage(ev: EventHome, opensLater: boolean): string {
  const closed = ev.cfpClosesAt !== null
    ? label('call.closed', 'onstage').replace('{date}', instantOf(ev.cfpClosesAt, ev.timezone))
    : 'The call for speakers is not taking proposals.';
  const opens = ev.cfpOpensAt !== null
    ? label('call.before', 'onstage').replace('{date}', instantOf(ev.cfpOpensAt, ev.timezone))
    : 'The call for speakers opens later this year.';
  const past = ev.lifecycle === 'happened';

  const card = opensLater
    ? '<div class="state-out"><h2>The call has not opened yet.</h2>' +
      `<p>${esc(opens)}. Everything you need to write a proposal is on the event page until then.</p>` +
      `<a class="btn btn-primary" href="/${esc(ev.slug)}">See the event →</a></div>`
    : '<div class="state-out"><h2>The call has closed.</h2>' +
      `<p>${esc(closed)}.` +
      (ev.decideBy && !past ? ` Decisions go out by ${esc(dayOf(ev.decideBy))}.` : '') +
      '</p>' +
      (ev.counts.proposals > 0
        ? `<p class="aside">${num(ev.counts.proposals)} proposals came in. Reading them all is the best week of the year.</p>`
        : '') +
      (past
        ? `<a class="btn btn-primary" href="/${esc(ev.slug)}/agenda">See the program →</a>`
        : `<a class="btn btn-primary" href="/${esc(ev.slug)}/speakers">See who is speaking →</a>`) +
      '</div>';

  const body =
    '<div class="wrap" style="padding-top:48px">' +
    '<div class="kicker">Call for speakers</div>' +
    `<h1 class="display" style="margin:12px 0 22px">${esc(ev.name)}</h1>` +
    card +
    '</div>';

  return page({
    title: `Call for speakers — ${ev.name}`,
    register: 'onstage',
    body: shell(ev, false, body),
  });
}

/** S-4 — the moment after sending. Priya's two questions, in her order. */
function thanksPage(ev: EventHome, email: string, callOpen: boolean): string {
  const closes = ev.cfpClosesAt !== null ? instantOf(ev.cfpClosesAt, ev.timezone) : null;
  const body =
    '<div class="wrap" style="padding-top:56px">' +
    '<div class="state-out" style="max-width:40em">' +
    '<h2>Your proposal is in.</h2>' +
    // The organizer's own sentence when they wrote one; ours when they did not.
    `<p>${esc(ev.cfpSuccessMessage ?? 'The committee has it, and you can change every word until the call closes.')}` +
    (ev.decideBy ? ` Decisions go out by <b>${esc(dayOf(ev.decideBy))}</b>.` : '') +
    '</p>' +
    `<p><b>${esc(email)}</b> is the address on it. The decision goes there, and it is how you ` +
    'get back into your speaker portal — no password to remember.</p>' +
    (closes
      ? `<p>The call closes on <b>${esc(closes)}</b>. Nothing you change after that reaches the ` +
        'committee, so this is the moment to fix the title you are not sure about.</p>'
      : '') +
    '<div class="btnrow">' +
    `<a class="btn btn-primary btn-lg" href="/${esc(ev.slug)}/portal">Open your speaker portal</a>` +
    (callOpen ? `<a class="btn btn-lg" href="/${esc(ev.slug)}/cfp">Send another proposal</a>` : '') +
    '</div>' +
    `<p class="hint" style="margin-top:16px">Up to ${num(ev.maxSubmissions)} ` +
    `${ev.maxSubmissions === 1 ? 'proposal' : 'proposals'} per person. ` +
    `<a class="link" href="/${esc(ev.slug)}/speakers">See who is speaking →</a></p>` +
    '</div></div>';

  return page({
    title: `Your proposal is in — ${ev.name}`,
    register: 'onstage',
    body: shell(ev, callOpen, body),
  });
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

/** The receipt: the address they typed, handed to the next page and nothing more. */
const RECEIPT = 'fs_cfp';

function receiptCookie(slug: string, email: string): string {
  // The path is built from a stored value, so it is reduced to the alphabet a
  // slug is allowed to use before it goes anywhere near a header.
  const path = slug.replace(/[^A-Za-z0-9._~-]/g, '');
  return `${RECEIPT}=${encodeURIComponent(email)}; Path=/${path}/cfp; Max-Age=1800; HttpOnly; Secure; SameSite=Lax`;
}

function readReceipt(cookieHeader: string | undefined): string | null {
  const m = new RegExp(`(?:^|;\\s*)${RECEIPT}=([^;]+)`).exec(cookieHeader ?? '');
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Open in the ordinary sense: opened, and not yet closed. */
function callIsOpen(ev: EventHome, nowMs: number): boolean {
  if (ev.cfpClosesAt === null || ev.cfpClosesAt <= nowMs) return false;
  return ev.cfpOpensAt === null || ev.cfpOpensAt <= nowMs;
}

export function registerCfp(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/cfp', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const now = Date.now();
    if (!callIsOpen(ev, now)) {
      return c.html(callShutPage(ev, ev.cfpOpensAt !== null && ev.cfpOpensAt > now));
    }

    const [tracks, questions, speakers, principal] = await Promise.all([
      tracksOfEvent(c.env.DB, ev.id),
      cfpQuestions(c.env.DB, ev.id),
      speakersGallery(c.env.DB, ev.id),
      principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie')),
    ]);

    // Somebody already signed in should not retype who they are.
    const values = blank();
    if (principal) {
      values.name = principal.name;
      values.email = principal.email ?? '';
    }

    return c.html(
      cfpPage({ ev, tracks, questions, speakers, values })
    );
  });

  app.post('/:event/cfp', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const now = Date.now();
    if (!callIsOpen(ev, now)) {
      // Nothing was written, and the screen says why in its own words.
      return c.html(callShutPage(ev, ev.cfpOpensAt !== null && ev.cfpOpensAt > now), 422);
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
    const values: FormValues = {
      title: text('title'),
      abstract: text('abstract'),
      track: text('track'),
      format: text('format'),
      level: text('level'),
      name: text('name'),
      org: text('org'),
      email: text('email'),
      answers,
    };

    const outcome = await submitProposal(c.env.DB, ev.id, {
      title: values.title,
      abstract: values.abstract,
      trackSlug: values.track,
      format: values.format,
      level: values.level,
      name: values.name,
      email: values.email,
      organisation: values.org,
      answers,
      questions,
    });

    if (!outcome.ok) {
      const [tracks, speakers] = await Promise.all([
        tracksOfEvent(c.env.DB, ev.id),
        speakersGallery(c.env.DB, ev.id),
      ]);
      return c.html(
        cfpPage({
          ev,
          tracks,
          questions,
          speakers,
          values,
          refusal: { field: outcome.field, message: outcome.message },
        }),
        422
      );
    }

    c.header('set-cookie', receiptCookie(ev.slug, outcome.email));
    return c.redirect(`/${ev.slug}/cfp/thanks`, 303);
  });

  app.get('/:event/cfp/thanks', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const email = readReceipt(c.req.header('cookie'));
    // Nothing was sent from this browser, so there is nothing to confirm.
    if (!email) return c.redirect(`/${ev.slug}/cfp`, 302);
    return c.html(thanksPage(ev, email, callIsOpen(ev, Date.now())));
  });
}
