// R-11 — the reviewer's room. Lena Fischer, eight proposals, one honest
// evening, and the two halves of D-024 side by side on a single screen:
//
//   ONE CLICK   — "Save my scores". The row is hers, nobody else can read it,
//                 and saving it again overwrites it. Undoable by definition.
//   TWO PASSES  — submitting. It feeds every average on every proposal screen
//                 and it cannot be taken back inside the round, so the first
//                 pass shows the exact arithmetic ("Submit 8 reviews"), the
//                 second repeats the number, and the number rides in the form
//                 to a server-side guard. Same law release.ts holds for
//                 letters, one desk over.
//
// Blind is not enforced here. It is enforced in queries/reviews.ts, which
// never selects a name — so this file could not print one if it tried. The
// missing per-event blind toggle is flagged there, at the place a fix would
// land.
//
// Neither is assignment enforced here. The queue reads what was handed to the
// person reading it, and a reviewer with nothing handed to her gets a calm
// empty evening rather than three hundred proposals that are not hers. The one
// screen this file adds for the chair — "Who reads what" — appears only for
// the standing that may decide, and it is the same read either way: Naomi sees
// the whole pile because she hands it out, not because a query string asked.
//
// Persona card, 11-hats.md — "the reviewer, Δ13, round-scoped, blind":
//   values comparison, and their score being theirs (per-reviewer rows, not
//   last-write-wins); needs progress that says "8 of 24" without being asked;
//   fears seeing decisions they shouldn't, and scoring outside their lane;
//   walks in asking "which of these are mine, and which are left?" — which is
//   why the masthead answers with two counts before she scrolls, and why the
//   evening's unfinished work sits at the top of the list rather than in it.
//
// Three acts joined the room afterwards, and each one landed on the side of
// the law its consequences put it on:
//
//   STEPPING ASIDE — one confirm. It is a reviewer saying "I know this
//     speaker", and it closes her row with nothing in it, permanently for the
//     round. It binds the committee's coverage rather than a person's letter,
//     so the confirm names the proposal and says out loud that it does not
//     come back, and that is the whole of the ceremony.
//   OPENING A ROUND — two passes. Every reader's list empties at once, so the
//     first pass states the arithmetic and the second carries the number.
//   NUDGING — one click, and the only act here that leaves the building. Being
//     undoable is not the question for a note that says "these are waiting";
//     being repeatable is, so a second one inside the day is refused.
//
// No client script. The scales are radios, the folds are links, the writes are
// forms — a reviewer on a hotel wifi gets the whole screen in one round trip.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, FORMAT_KEY, LEVEL_KEY, type LabelKey } from '../../lib/labels';
import { ScopeError } from '../../queries/admin';
import {
  reviewEvent,
  reviewQueue,
  reviewTeam,
  roundStanding,
  stagedReviews,
  weightedAverage,
  windowSize,
  NUDGE_HOURS,
  PAGE,
  MOST,
  TEXT_MARK_MAX,
  type QueueRow,
  type ReviewEvent,
  type ReviewQueue,
  type RoundStanding,
  type ScorecardKey,
  type Scores,
  type StagedReview,
  type TeamReader,
} from '../../queries/reviews';
import { principalFromCookie, type Principal } from '../../workflows/account';
import {
  upsertReview,
  submitReviews,
  handOutAssignments,
  takeBackAssignments,
  stepAside,
  openNextRound,
  nudgeReviewer,
  MOST_EACH,
  HANDOUT_CAP,
  type ReviewOutcome,
  type AssignOutcome,
  type NudgeOutcome,
  type RoundOutcome,
  type StepAsideOutcome,
} from '../../workflows/review';

/* ------------------------------------------------------------------ *
 * Words and numbers
 * ------------------------------------------------------------------ */

/** A label with its {tokens} filled. The map owns the words; this fills them. */
function say(key: LabelKey, values: Record<string, string> = {}): string {
  return label(key, 'backstage').replace(/\{(\w+)\}/g, (whole, token: string) =>
    values[token] ?? whole
  );
}

/**
 * A stored value that may have no row in 02 §6 — formats and levels arrive
 * from the database as they were written. An unknown one says nothing rather
 * than printing itself raw or taking the screen down.
 */
function word(key: string | undefined): string {
  if (!key) return '';
  try {
    return label(key as LabelKey, 'backstage');
  } catch {
    return '';
  }
}

const num = (v: number): string => v.toLocaleString('en-US');

const count = (v: number, one: string, many: string): string =>
  v === 1 ? `1 ${one}` : `${num(v)} ${many}`;

/** The prototype's own minute rule: 120 reads "2 hr", 90 stays "90 min". */
function mins(m: number): string {
  return m >= 90 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`;
}

function onDay(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
  }).format(new Date(ms));
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Track chip styling, same two custom properties every other screen sets. */
function trackStyle(colour: string): string {
  return `--tc:${colour};--tw:color-mix(in srgb, ${colour} 16%, white)`;
}

/** An abstract, folded: enough to judge by, on a phone, without scrolling. */
function clip(text: string, at = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= at) return flat;
  const cut = flat.slice(0, at);
  const space = cut.lastIndexOf(' ');
  return `${(space > at * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}

/* ------------------------------------------------------------------ *
 * The outcome sentences — one closed set, and the screen owns the words
 * ------------------------------------------------------------------ */

const NOTES: Record<ReviewOutcome, string> = {
  saved: 'Saved. It stays yours until you submit.',
  noted: 'Your note is kept. Mark a score and it joins the ones ready to submit.',
  sent: 'Your marks are in. They count towards the average on each proposal now.',
  locked: 'You submitted that one already this round, so it stays as it is.',
  gone: 'That one has been decided since you opened it. There is nothing left to score there.',
  blank: 'Nothing was marked, so nothing was staged.',
  nothing: 'Nothing is staged right now.',
  moved: 'The list moved while you were reading. Look again, then submit.',
  trouble: 'That did not save. Try it once more.',
};

/**
 * Stepping aside gets its own closed set rather than a code in NOTES, because
 * its sentences are about one proposal leaving a person's evening, and the
 * queue's sentences are about marks. Same channel back to the screen, same
 * discipline: the workflow says which one is true, this says it in words.
 */
const STEP_NOTES: Record<`aside_${StepAsideOutcome}`, string> = {
  aside_stepped:
    'You have stepped aside from that one. It is off your list for this round, and none of ' +
    'your marks on it were kept.',
  aside_already: 'That one was already finished this round, so it stays as it is.',
  aside_gone:
    'That one has been decided since you opened it. There is nothing left to step aside from.',
  aside_moved: 'It was finished while you were looking. Nothing was changed.',
  aside_trouble: 'That did not go through. Try it once more.',
};

// The code arrives in a query string, so it is a stranger's word until it
// matches one of ours — and `in` would happily match 'constructor'.
function noteFor(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const set of [NOTES, STEP_NOTES] as Record<string, string>[]) {
    const said: unknown = Object.prototype.hasOwnProperty.call(set, raw) ? set[raw] : null;
    if (typeof said === 'string') return said;
  }
  return null;
}

/**
 * What a hand-out says afterwards. The counts ride in the address beside the
 * code, the way the proposals list carries its own, because the sentence is
 * only true with them in it: "312 handed out" and "312 handed out, 16 already
 * held" are different facts about the same click.
 */
const ASSIGN_CODES: readonly AssignOutcome[] = [
  'handed',
  'nobody',
  'nothing',
  'freed',
  'kept',
  'moved',
  'trouble',
];

function assignCode(raw: string | undefined): AssignOutcome | null {
  return ASSIGN_CODES.find((c) => c === raw) ?? null;
}

/** A count off the address bar: a stranger's number until it is one of ours. */
function tally(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : 0;
}

function assignSaid(code: AssignOutcome, gave: number, held: number, more: boolean): string {
  switch (code) {
    case 'handed':
      return (
        `${num(gave)} handed out.` +
        (held > 0 ? ` ${num(held)} were already held.` : '') +
        (more ? ` Only the longest-waiting ${num(HANDOUT_CAP)} went out this time.` : '')
      );
    case 'nobody':
      return 'Nobody was chosen to read, so nothing was handed out.';
    case 'nothing':
      return 'Every undecided proposal already has the readers you asked for.';
    case 'freed':
      return `${count(gave, 'proposal', 'proposals')} came back. They are free to hand out again.`;
    case 'kept':
      return 'Nothing came back. Every one they hold has been written in, and that work is theirs.';
    case 'moved':
      return 'The numbers moved while you were looking. Read them again, then hand them out.';
    case 'trouble':
      return 'That did not go through. Try it once more.';
  }
}

const ROUND_CODES: readonly RoundOutcome[] = ['opened', 'moved', 'refused', 'trouble'];

function roundCode(raw: string | undefined): RoundOutcome | null {
  return ROUND_CODES.find((c) => c === raw) ?? null;
}

/** `round` is the one the committee is on now — after opening, the new one. */
function roundSaid(code: RoundOutcome, round: number): string {
  switch (code) {
    case 'opened':
      return (
        `${say('review.round', { n: num(round) })} is open. Every reading list starts empty, ` +
        'and nothing written before it moved.'
      );
    case 'moved':
      return 'Somebody opened it first. This is the round the committee is on.';
    case 'refused':
      return 'That is not the round after this one. Nothing was changed.';
    case 'trouble':
      return 'That did not go through. Try it once more.';
  }
}

const NUDGE_CODES: readonly NudgeOutcome[] = [
  'nudged',
  'recent',
  'nothing',
  'nobody',
  'moved',
  'trouble',
];

function nudgeCode(raw: string | undefined): NudgeOutcome | null {
  return NUDGE_CODES.find((c) => c === raw) ?? null;
}

function nudgeSaid(code: NudgeOutcome, name: string, open: number): string {
  switch (code) {
    case 'nudged':
      return `${name} has a note about it. ${count(open, 'proposal is', 'proposals are')} still open on their list.`;
    case 'recent':
      return 'Nudged yesterday — give it a day.';
    case 'nothing':
      return `Nothing is open on ${name}'s list, so nothing was sent.`;
    case 'nobody':
      return 'That person does not read on this conference. Nothing was sent.';
    case 'moved':
      return 'The list moved while you were looking. Read it again, then nudge.';
    case 'trouble':
      return 'That did not go through. Try it once more.';
  }
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

const queueUrl = (slug: string, q: Record<string, string | number | undefined> = {}): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const tail = params.toString();
  return `/admin/${encodeURIComponent(slug)}/reviews${tail ? `?${tail}` : ''}`;
};

// Back to the top of the list, not to the proposal just saved: `#said` is the
// outcome sentence, and the band that says how many reviews are staged sits
// directly under it. Landing on the row instead would scroll both off the
// screen — which is exactly how a reviewer finishes an evening with eight
// staged reviews she never submitted (audit risk 1). The row she just saved is
// the first one under the band anyway, because staged sorts to the top.
const backTo = (slug: string, note: string, show: number): string =>
  `${queueUrl(slug, { show: show > PAGE ? show : undefined, note })}#said`;

/** Where a hand-out comes back to: the team table, with its own sentence over it. */
const teamUrl = (
  slug: string,
  q: Record<string, string | number | undefined>
): string => `${queueUrl(slug, q)}#team`;

/* ------------------------------------------------------------------ *
 * One row: a proposal, its scales, and where my marks stand
 * ------------------------------------------------------------------ */

/**
 * One line of the card, in whichever of its three shapes the committee chose.
 *
 * The weight is said out loud on the heavy and light lines and left silent on
 * the normal ones, because "Normal" on every line is nine words that tell a
 * reviewer nothing — and a line that counts double is the one fact she needs
 * before she marks it, not after.
 */
function criterion(k: ScorecardKey, mark: string | number | undefined): string {
  const name = `score_${esc(k.key)}`;
  const weight =
    k.weight === 3
      ? '<span class="opt">counts double</span>'
      : k.weight === 1
        ? '<span class="opt">counts light</span>'
        : '';

  if (k.kind === 'text') {
    return (
      '<label class="f" style="margin-bottom:14px"><span class="f-lab">' +
      `${esc(k.label)}${weight}</span>` +
      `<textarea name="${name}" rows="2" maxlength="${TEXT_MARK_MAX}">` +
      `${esc(typeof mark === 'string' ? mark : '')}</textarea></label>`
    );
  }

  if (k.kind === 'select') {
    const options = [
      `<option value=""${mark === undefined ? ' selected' : ''}>Not answered yet</option>`,
      ...k.options.map(
        (o) => `<option value="${esc(o)}"${o === mark ? ' selected' : ''}>${esc(o)}</option>`
      ),
    ].join('');
    return (
      '<label class="f" style="margin-bottom:14px"><span class="f-lab">' +
      `${esc(k.label)}${weight}</span>` +
      `<select name="${name}">${options}</select></label>`
    );
  }

  // .radio and .btnrow are the shared form vocabulary — the box, the border,
  // the accent colour and the tap target all come from the lifted CSS, so a
  // scale costs a few dozen bytes a mark instead of a paragraph of inline
  // style repeated on every proposal on the screen. Page weight is a product
  // requirement here, not an optimisation.
  const options = [
    `<label class="radio"><input type="radio" name="${name}" value=""` +
      `${mark === undefined ? ' checked' : ''} aria-label="No mark yet for ${esc(k.label)}">` +
      '<span aria-hidden="true">–</span></label>',
  ];
  for (let v = 1; v <= k.max; v++) {
    options.push(
      `<label class="radio"><input type="radio" name="${name}" value="${v}"` +
        `${mark === v ? ' checked' : ''}>${v}</label>`
    );
  }
  return (
    '<fieldset style="border:0;padding:0;margin:0 0 14px;min-width:0">' +
    `<legend class="f-lab" style="padding:0">${esc(k.label)}${weight}</legend>` +
    `<div class="btnrow">${options.join('')}</div>` +
    '</fieldset>'
  );
}

/** A weighted average, to one decimal. One number, one word for what it is. */
function weighted(card: ScorecardKey[], scores: Scores): string {
  const value = weightedAverage(card, scores);
  return value === null
    ? ''
    : `<span class="score">${value.toFixed(1)}</span> <span class="sub">weighted</span>`;
}

/**
 * My marks, read back in the scorecard's own words and order.
 *
 * A number reads as a number over its top mark; a word reads as the word. A
 * line or two of writing is not folded in here — it is a sentence, and a
 * sentence in a run-on list of marks is a sentence nobody reads.
 */
function marksLine(card: ScorecardKey[], scores: Scores): string {
  const parts: string[] = [];
  for (const k of card) {
    const mark = scores[k.key];
    if (mark === undefined) continue;
    if (k.kind === 'scale' && typeof mark === 'number') {
      parts.push(`<span class="score">${mark}/${k.max}</span> ${esc(k.label)}`);
    } else if (k.kind === 'select' && typeof mark === 'string') {
      parts.push(`${esc(k.label)} <span class="score">${esc(mark)}</span>`);
    }
  }
  return parts.join('<span class="sep"> · </span>');
}

/** The written lines, if the card asked for any and the reviewer wrote them. */
function writtenMarks(card: ScorecardKey[], scores: Scores): string {
  return card
    .filter((k) => k.kind === 'text' && typeof scores[k.key] === 'string')
    .map(
      (k) =>
        '<div class="notebox" style="margin-top:10px">' +
        `<div class="t-sub">${esc(k.label)}</div>${esc(String(scores[k.key]))}</div>`
    )
    .join('');
}

function rowHead(row: QueueRow, ev: ReviewEvent): string {
  const bits = [word(FORMAT_KEY[row.format]), mins(row.minutes), word(LEVEL_KEY[row.level ?? ''])]
    .filter(Boolean)
    .join(' · ');
  const waited = row.waitingSince ? ` · Waiting since ${onDay(row.waitingSince, ev.timezone)}` : '';
  return (
    '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
    (row.track
      ? `<span class="tk" style="${esc(trackStyle(row.track.colour))}">${esc(row.track.name)}</span>`
      : '') +
    `<span class="sub">${esc(bits)}${esc(waited)}</span>` +
    '</div>'
  );
}

function abstractBlock(row: QueueRow, slug: string, show: number, open: boolean): string {
  const text = (row.abstract ?? '').trim();
  if (!text) {
    return '<p class="sub" style="margin-top:10px">Nothing written in the body of this one.</p>';
  }
  const folded = clip(text);
  const anchor = `#p-${encodeURIComponent(row.id)}`;
  const wide = queueUrl(slug, { show: show > PAGE ? show : undefined, open: row.id }) + anchor;
  const shut = queueUrl(slug, { show: show > PAGE ? show : undefined }) + anchor;
  if (open) {
    return (
      `<div class="abstract" style="font-size:16.5px;margin-top:10px">${paragraphs(text)}</div>` +
      `<p style="margin:0 0 4px"><a class="link" href="${esc(shut)}">Fold it away ↑</a></p>`
    );
  }
  return (
    `<div class="abstract" style="font-size:16.5px;margin-top:10px"><p>${esc(folded)}</p></div>` +
    (folded.length < text.length
      ? `<p style="margin:0 0 4px"><a class="link" href="${esc(wide)}">Read the whole thing →</a></p>`
      : '')
  );
}

function queueRow(
  row: QueueRow,
  ev: ReviewEvent,
  show: number,
  open: boolean,
  stepping: boolean
): string {
  const head =
    `<h2 class="display" style="font-size:22px;line-height:1.25">${esc(row.title)}</h2>` +
    abstractBlock(row, ev.slug, show, open);

  // Stepped aside: finished, and finished with nothing in it. No marks to read
  // back, because there are none — that is the whole point of the row.
  if (row.myRecused) {
    return (
      `<div class="card card-pad" id="p-${esc(row.id)}" style="margin-top:14px">` +
      rowHead(row, ev) +
      head +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">' +
      '<span class="chip s-withdrawn">Stepped aside</span>' +
      '<span class="sub">Nothing you marked on this one counts towards its average.</span>' +
      '</div></div>'
    );
  }

  // Submitted: fixed for this round. The marks stay legible, the controls go.
  if (row.mySubmittedAt !== null) {
    const marks = marksLine(ev.scorecard, row.myScores);
    const mean = weighted(ev.scorecard, row.myScores);
    return (
      `<div class="card card-pad" id="p-${esc(row.id)}" style="margin-top:14px">` +
      rowHead(row, ev) +
      head +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">' +
      `<span class="chip s-accepted">Scored ${esc(onDay(row.mySubmittedAt, ev.timezone))}</span>` +
      (marks ? `<span class="sub">${marks}</span>` : '') +
      (mean ? `<span class="sub">${mean}</span>` : '') +
      '</div>' +
      writtenMarks(ev.scorecard, row.myScores) +
      (row.myNote
        ? `<div class="notebox" style="margin-top:10px">${esc(row.myNote)}</div>`
        : '') +
      '</div>'
    );
  }

  const lines = ev.scorecard.map((k) => criterion(k, row.myScores[k.key])).join('');
  const anchor = `#p-${encodeURIComponent(row.id)}`;
  const aside = queueUrl(ev.slug, {
    show: show > PAGE ? show : undefined,
    stepaside: row.id,
  }) + anchor;

  const card =
    `<form class="card card-pad" id="p-${esc(row.id)}" method="post" style="margin-top:14px"` +
    ` action="/admin/${encodeURIComponent(ev.slug)}/reviews/stage">` +
    `<input type="hidden" name="on" value="${esc(row.id)}">` +
    `<input type="hidden" name="show" value="${show}">` +
    rowHead(row, ev) +
    head +
    `<div style="margin-top:16px">${lines}</div>` +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">Your note' +
    '<span class="opt">only the committee reads this</span></span>' +
    '<textarea name="note" rows="2" maxlength="2000" placeholder="What would you tell the room about this one?">' +
    `${esc(row.myNote ?? '')}</textarea></label>` +
    '<div class="btnrow" style="margin-top:14px">' +
    `<button class="btn btn-primary" type="submit">${esc(say('review.save'))}</button>` +
    // The quiet half of the pair. A reviewer who knows the speaker should not
    // have to hunt for the way out, and should not trip over it either.
    (stepping ? '' : `<a class="btn btn-quiet" href="${esc(aside)}">I know this speaker — step aside</a>`) +
    (row.staged
      ? '<span class="chip s-undecided">Staged — yours until you submit</span>'
      : '') +
    '</div>' +
    '</form>';

  if (!stepping) return card;

  // The confirm sits under the card rather than inside it: the card is a form
  // already, and a form inside a form is not a thing a browser will send.
  const shut = queueUrl(ev.slug, { show: show > PAGE ? show : undefined }) + anchor;
  return (
    card +
    '<div class="card card-pad" style="margin-top:10px;border-left:3px solid var(--danger)">' +
    `<b>Step aside from ${esc(row.title)}?</b>` +
    '<p style="margin:6px 0 0">This cannot be taken back this round. The proposal leaves your ' +
    'list, nothing you marked on it is kept, and the committee reads it one voice short — so ' +
    'tell whoever hands the pile out.</p>' +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/step-aside"` +
    ' class="btnrow" style="margin-top:12px">' +
    `<input type="hidden" name="on" value="${esc(row.id)}">` +
    `<input type="hidden" name="show" value="${show}">` +
    '<button class="btn btn-danger" type="submit">Step aside</button>' +
    `<a class="btn btn-quiet" href="${esc(shut)}">Keep it on my list</a>` +
    '</form></div>'
  );
}

/* ------------------------------------------------------------------ *
 * Who reads what — the chair's half of the room
 * ------------------------------------------------------------------ */

// D-026 tiers have no §6 entry, so no label key exists for them; the same
// literal map the rest of backstage uses is the honest place for them.
//
// GAP, for the doc owner, on the same shelf: §1.23 gained three facts this
// room now shows and §6 has a row for none of them — "Stepped aside" (a review
// finished with nothing in it), "Nudge" (the chair's reminder), and the word
// "weighted" beside an average. They are written as literals here and in
// settings until §6 carries them; when it does, they move and these go.
const STANDING: Record<string, string> = {
  organizer: 'Organizer',
  owner: 'Owner',
  approver: 'Approver',
  editor: 'Editor',
  viewer: 'Reviewer',
};

/** One reader's line: what they are carrying, and how far in they are. */
function teamRow(r: TeamReader, ev: ReviewEvent, nowMs: number): string {
  // Two numbers where there used to be one. A reader six proposals into an
  // evening and a reader who has recused herself from six are both "six
  // finished", and telling them apart is the difference between a chair who
  // chases the right person and one who chases the wrong one.
  const progress =
    r.assigned === 0
      ? `<span class="sub">Nothing handed to ${r.isYou ? 'you' : 'them'} yet.</span>`
      : (r.recused > 0
          ? `${esc(num(r.completed))} scored<span class="sep"> · </span>` +
            `${esc(num(r.recused))} stepped aside`
          : esc(say('review.progress', { n: num(r.completed), m: num(r.assigned) }))) +
        (r.started > 0
          ? `<span class="sep"> · </span><span class="sub">${esc(num(r.started))} started</span>`
          : '');

  // Only the untouched ones can come back, and the button says how many so the
  // number she reads is the number the guard checks.
  const back =
    r.untouched > 0
      ? `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/take-back">` +
        `<input type="hidden" name="who" value="${esc(r.personId)}">` +
        `<input type="hidden" name="expected" value="${r.untouched}">` +
        `<button class="btn btn-sm" type="submit">Take back ${esc(num(r.untouched))} untouched</button>` +
        '</form>'
      : r.assigned > 0
        ? `<span class="sub">Every one of ${r.isYou ? 'yours' : 'theirs'} has been written in.</span>`
        : '';

  // A nudge is for somebody who still owes the room something. Nudging
  // yourself is a note to yourself, and nudging a person who is finished is
  // noise, so neither turns up as a button.
  const open = r.started + r.untouched;
  const recent = r.nudgedAt !== null && nowMs - r.nudgedAt < NUDGE_HOURS * 3_600_000;
  const nudge =
    open === 0 || r.isYou
      ? ''
      : recent
        ? `<span class="sub">Nudged ${esc(onDay(r.nudgedAt ?? nowMs, ev.timezone))}</span>`
        : `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/nudge">` +
          `<input type="hidden" name="who" value="${esc(r.personId)}">` +
          `<button class="btn btn-sm" type="submit">Nudge</button></form>`;

  return (
    '<tr>' +
    `<td><div class="t-name">${esc(r.name)}${r.isYou ? '<span class="sub"> · you</span>' : ''}</div>` +
    `<div class="t-sub">${esc(STANDING[r.standing] ?? r.standing)}</div></td>` +
    `<td style="font-variant-numeric:tabular-nums">${esc(num(r.assigned))}</td>` +
    `<td>${progress}</td>` +
    `<td>${nudge}</td>` +
    `<td>${back}</td>` +
    '</tr>'
  );
}

/* ------------------------------------------------------------------ *
 * The round — the widest act in the room, and the quietest panel
 * ------------------------------------------------------------------ */

/**
 * Round n, and the door to n+1.
 *
 * TWO PASSES, because this one binds everybody: every reader's list empties at
 * once. The first pass states the arithmetic — what stays on the record, and
 * that the next round starts empty — and the second carries the number back,
 * where a guard checks it against the round the database is actually on. Two
 * chairs on two laptops: the first wins, the second is told, nothing happens
 * twice.
 *
 * It is a panel rather than a banner on purpose. Most evenings nobody opens a
 * round, and a control that shouts every time it is not needed teaches people
 * to stop reading the screen.
 */
function roundPanel(ev: ReviewEvent, standing: RoundStanding, opening: boolean): string {
  const here = say('review.round', { n: num(standing.round) });
  const next = say('review.round', { n: num(standing.round + 1) });
  const record =
    standing.onRecord === 0
      ? 'Nothing has been sent in yet.'
      : `${count(standing.onRecord, 'review is', 'reviews are')} in.`;
  const stepped =
    standing.stepped > 0
      ? ` ${count(standing.stepped, 'reader', 'readers')} stepped aside.`
      : '';

  const openHref = queueUrl(ev.slug, { open_round: standing.round + 1 }) + '#team';

  const first =
    '<div class="btnrow" style="margin-top:12px">' +
    `<a class="btn" href="${esc(openHref)}">Open ${esc(next.toLowerCase())}</a>` +
    '<span class="sub">Everyone starts again on the proposals that are still undecided.</span>' +
    '</div>';

  const confirm =
    '<div class="notebox" style="margin-top:12px;border-left-color:var(--danger)">' +
    `<b>Open ${esc(next.toLowerCase())}?</b>` +
    `<p style="margin:6px 0 0">${esc(
      `${count(standing.onRecord, 'review', 'reviews')} from ${here.toLowerCase()} ` +
        `stay on the record. ${next} starts empty.`
    )}</p>` +
    `<p style="margin:6px 0 0" class="sub">${esc(
      standing.nextCardExists
        ? `${next} already has a scorecard of its own, and it is left exactly as it is.`
        : `${here}'s scorecard is copied to ${next.toLowerCase()}, so nobody has to write it ` +
          'out again. Settings is where it changes.'
    )}</p>` +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/open-round"` +
    ' class="btnrow" style="margin-top:12px">' +
    `<input type="hidden" name="from" value="${standing.round}">` +
    `<input type="hidden" name="to" value="${standing.round + 1}">` +
    `<button class="btn btn-danger" type="submit">Open ${esc(next.toLowerCase())}</button>` +
    `<a class="btn btn-quiet" href="${esc(queueUrl(ev.slug))}#team">Stay on ${esc(here.toLowerCase())}</a>` +
    '</form></div>';

  return (
    '<div class="card card-pad" style="margin-top:16px">' +
    `<h3 class="serif" style="font-size:19px;font-weight:600">${esc(here)}</h3>` +
    `<p class="sub" style="margin:6px 0 0">${esc(`${record}${stepped}`)} ` +
    'Every list on this page is this round&#39;s. Nothing written in an earlier one moves.</p>' +
    (opening ? confirm : first) +
    '</div>'
  );
}

/**
 * The hand-out. One number, one set of readers, one click — see the note on
 * handOutAssignments for why this is not a two-pass act. Everyone is ticked to
 * begin with, because the committee is the committee; unticking is how a chair
 * says "not this round".
 */
function handOutForm(ev: ReviewEvent, team: TeamReader[], pile: number): string {
  const each: string[] = [];
  for (let n = 1; n <= MOST_EACH; n++) {
    each.push(
      `<label class="radio"><input type="radio" name="each" value="${n}"` +
        `${n === 2 ? ' checked' : ''}>${n}</label>`
    );
  }
  const who = team
    .map(
      (r) =>
        '<label class="radio"><input type="checkbox" name="who" value="' +
        `${esc(r.personId)}" checked><span class="rname">${esc(r.name)}</span></label>`
    )
    .join('');

  return (
    `<form class="card card-pad" method="post" style="margin-top:16px"` +
    ` action="/admin/${encodeURIComponent(ev.slug)}/reviews/hand-out">` +
    '<div class="f-lab" style="margin-bottom:8px">Give every undecided proposal to</div>' +
    `<div class="btnrow">${each.join('')}<span class="sub">readers</span></div>` +
    '<div class="f-lab" style="margin:16px 0 8px">Who is reading this round' +
    '<span class="opt">untick anyone sitting this one out</span></div>' +
    `<div class="btnrow" style="flex-wrap:wrap">${who}</div>` +
    '<div class="btnrow" style="margin-top:16px;align-items:center">' +
    '<button class="btn btn-primary" type="submit">Hand them out</button>' +
    `<span class="sub">${esc(count(pile, 'proposal is', 'proposals are'))} still undecided. ` +
    'Anyone already holding one keeps it.</span>' +
    '</div>' +
    '</form>'
  );
}

function whoReadsWhat(
  ev: ReviewEvent,
  team: TeamReader[],
  pile: number,
  said: string | null,
  standing: RoundStanding,
  opening: boolean,
  nowMs: number
): string {
  const heading =
    '<h2 class="display" style="font-size:26px">Who reads what</h2>' +
    (said
      ? `<div class="standing" role="status" style="margin-top:12px">${esc(said)}</div>`
      : '');

  // A chair always appears in her own committee, so one row means she is it —
  // and handing a pile to yourself when you already read all of it is not an
  // act. The next one is finding somebody to read with. The round panel still
  // belongs on the screen: a committee of one still finishes a round.
  if (team.length <= 1) {
    return (
      '<section class="sec" id="team">' +
      heading +
      '<div class="state-out" style="margin-top:14px"><h2>The committee is one person.</h2>' +
      '<p>Nobody else holds a standing on this program yet, so there is nobody to hand ' +
      'proposals to. Add readers from settings and they turn up here.</p>' +
      `<a class="btn btn-primary" href="/admin/${encodeURIComponent(ev.slug)}/settings">` +
      'Add someone to the team →</a></div>' +
      roundPanel(ev, standing, opening) +
      '</section>'
    );
  }

  return (
    '<section class="sec" id="team">' +
    heading +
    '<div class="tablewrap" style="margin-top:14px"><table class="t"><thead><tr>' +
    '<th>Reader</th><th>Holding</th><th>Progress</th><th>Nudge</th><th>Take back</th>' +
    '</tr></thead><tbody>' +
    team.map((r) => teamRow(r, ev, nowMs)).join('') +
    '</tbody></table></div>' +
    (pile > 0
      ? handOutForm(ev, team, pile)
      : '<p class="sub" style="margin-top:16px">Nothing is undecided on this program, ' +
        'so there is nothing to hand out.</p>') +
    roundPanel(ev, standing, opening) +
    '</section>'
  );
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

function queuePage(
  principal: Principal,
  ev: ReviewEvent,
  q: ReviewQueue,
  opts: {
    show: number;
    open: string | null;
    note: string | null;
    stepaside: string | null;
    team: TeamReader[];
    /** The sentence the last act on the chair's half of the room left behind. */
    teamSaid: string | null;
    standing: RoundStanding | null;
    opening: boolean;
    nowMs: number;
  }
): string {
  const note = noteFor(opts.note ?? undefined);
  // The event's timezone is already in the footer of every backstage screen;
  // floating it into this counts line as well costs a phone a whole line and
  // says nothing twice.
  const round = esc(say('review.round', { n: num(q.round) }));
  // `#said` — where every save comes back to, with the staged band under it.
  const said = note
    ? `<div class="sec standing" id="said" role="status">${esc(note)}</div>`
    : '<span id="said"></span>';
  const team =
    ev.everything && opts.standing
      ? whoReadsWhat(
          ev,
          opts.team,
          q.pile,
          opts.teamSaid,
          opts.standing,
          opts.opening,
          opts.nowMs
        )
      : '';

  // A screen with nothing on it says what the round is and nothing else. The
  // counts belong to a list; over an empty one they are two zeroes and a
  // sentence about hidden names nobody is reading.
  if (q.total === 0) {
    const head =
      '<div style="padding:26px 0 0">' +
      '<h1 class="display" style="font-size:34px">Reviews</h1>' +
      `<p class="counts">${round}</p></div>` +
      said;

    // Three different silences, and they are not the same news. The chair's
    // means the committee is finished. A reviewer who was given a list and
    // read it out has a finished evening. A reviewer who was given nothing has
    // an evening that has not started — and none of the three may fall back to
    // the whole pile to fill the screen.
    const door = `<a class="btn btn-primary" href="/admin/${encodeURIComponent(ev.slug)}">See the program →</a>`;
    const thisRound = say('review.round', { n: num(q.round) }).toLowerCase();
    const empty = ev.everything
      ? '<div class="sec state-out"><h2>Nothing is waiting on the committee.</h2>' +
        '<p>Every proposal on this program has a decision. When the next call closes, ' +
        `what comes in lands here.</p>${door}</div>`
      : q.mine > 0
        ? '<div class="sec state-out"><h2>Everything on your list has been decided.</h2>' +
          `<p>The ${esc(count(q.mine, 'proposal', 'proposals'))} handed to you in ` +
          `${esc(thisRound)} have answers now` +
          (q.mineDone > 0
            ? `, and the ${esc(count(q.mineDone, 'review', 'reviews'))} you sent in are ` +
              'part of how they got there'
            : '') +
          '. When the next batch is handed out, it lands here.</p>' +
          `${door}</div>`
        : '<div class="sec state-out"><h2>Nothing is assigned to you this round.</h2>' +
          `<p>Your share of ${esc(thisRound)} lands here the moment the chair hands it out. ` +
          'The rest of the pile is not yours to read, and there is nothing here you are ' +
          `keeping anyone waiting on.</p>${door}</div>`;

    return shell(principal, ev, head + empty + team);
  }

  const staged =
    q.staged > 0
      ? '<div class="sec attn">' +
        `<div class="n">${esc(num(q.staged))}</div>` +
        `<div><div class="lab">You have ${esc(count(q.staged, 'staged review', 'staged reviews'))}.</div>` +
        '<div class="why">Nobody else can read them yet. Submitting puts them into the ' +
        'committee&#39;s average on every proposal, and in this round they are fixed afterwards.</div></div>' +
        `<a class="btn btn-primary go" href="${esc(queueUrl(ev.slug, { confirm: 1 }))}">` +
        `Submit ${esc(count(q.staged, 'review', 'reviews'))}</a>` +
        '</div>'
      : '';

  // "All 8 scored" over an evening that ended in a recusal would be the screen
  // telling a reviewer she did something she deliberately did not do. Three
  // endings, and each one names what actually happened.
  const done =
    q.left > 0
      ? ''
      : q.recused === 0
        ? `<div class="sec standing"><b>${esc(say('review.done', { n: num(q.total) }))}</b></div>`
        : q.submitted === 0
          ? '<div class="sec standing"><b>' +
            `${esc(`You stepped aside from ${q.recused === 1 ? 'the one proposal' : `all ${num(q.recused)}`} on your list.`)}` +
            '</b></div>'
          : '<div class="sec standing"><b>' +
            `${esc(
              `${count(q.submitted, 'proposal', 'proposals')} scored and ` +
                `${num(q.recused)} stepped aside. That's everything on your list.`
            )}</b></div>`;

  const rows = q.rows
    .map((r) => queueRow(r, ev, opts.show, opts.open === r.id, opts.stepaside === r.id))
    .join('');

  // Three honest endings, and never a button that would come back unchanged:
  // more to fetch, all of it already here, or a screenful that has reached its
  // ceiling — in which case the rest arrive as these ones are finished.
  const showing = `Showing ${esc(num(q.shown))} of ${esc(num(q.total))}.`;
  const more =
    q.shown >= q.total
      ? `<p class="sub" style="margin-top:20px">Showing all ${esc(num(q.total))}.</p>`
      : opts.show < MOST
        ? '<div class="sec" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
          `<a class="btn" href="${esc(queueUrl(ev.slug, { show: opts.show + PAGE }))}">` +
          `Show ${esc(num(Math.min(PAGE, q.total - q.shown)))} more</a>` +
          `<span class="sub">${showing}</span></div>`
        : `<p class="sub" style="margin-top:20px">${showing} The rest come up as you ` +
          'work through these.</p>';

  // The exception, said out loud. A chair reading three hundred proposals
  // should know she is reading them because she hands them out, not because
  // the committee has no lists — and "Yours to score · 328" would say the
  // opposite one line above it, so on this view the count leaves with it.
  const whose = ev.everything
    ? `<p class="hint">The whole pile — ${esc(count(q.pile, 'undecided proposal', 'undecided proposals'))}, ${
        q.assigned === 0
          ? 'and nothing is assigned to you personally.'
          : q.assigned === 1
            ? 'one of them assigned to you personally.'
            : `${esc(num(q.assigned))} of them assigned to you personally.`
      }</p>`
    : '';

  // With nothing left, "Yours to score · 0" is a zero standing next to a
  // sentence that already says so. The progress count leads instead.
  const head =
    '<div style="padding:26px 0 0">' +
    '<h1 class="display" style="font-size:34px">Reviews</h1>' +
    '<p class="counts">' +
    (q.left > 0 && !ev.everything
      ? `<b>${esc(say('review.queue', { n: num(q.left) }))}</b><span class="sep">·</span>`
      : '') +
    `${esc(say('review.progress', { n: num(q.submitted), m: num(q.total) }))}` +
    (q.recused > 0
      ? `<span class="sep">·</span>${esc(`${num(q.recused)} stepped aside`)}`
      : '') +
    `<span class="sep">·</span>${round}</p>` +
    whose +
    `<p class="hint">${esc(say('review.blind'))}</p>` +
    '</div>' +
    said;

  return shell(principal, ev, head + staged + done + team + rows + more);
}

/* ------------------------------------------------------------------ *
 * The second pass
 * ------------------------------------------------------------------ */

function confirmPage(
  principal: Principal,
  ev: ReviewEvent,
  staged: StagedReview[]
): string {
  const crumb =
    `<a href="${esc(queueUrl(ev.slug))}">Reviews</a> › <span>submitting</span>`;

  if (staged.length === 0) {
    return shell(
      principal,
      ev,
      '<div class="sec state-out"><h2>Nothing is staged.</h2>' +
        '<p>Score a proposal and it waits here, yours alone, until you send it to the committee.</p>' +
        `<a class="btn btn-primary" href="${esc(queueUrl(ev.slug))}">Back to your list →</a></div>`,
      crumb
    );
  }

  const list = staged
    .map((s) => {
      const mean = weighted(ev.scorecard, s.scores);
      const marks = marksLine(ev.scorecard, s.scores);
      return (
        '<div style="padding:14px 18px;border-bottom:1px solid var(--line-soft)">' +
        `<div style="font-weight:640">${esc(s.title)}</div>` +
        (marks || mean
          ? '<div class="sub" style="margin-top:4px">' +
            marks +
            (marks && mean ? '<span class="sep"> · </span>' : '') +
            mean +
            '</div>'
          : '') +
        (s.note ? `<div class="sub" style="margin-top:5px">${esc(s.note)}</div>` : '') +
        '</div>'
      );
    })
    .join('');

  const many = count(staged.length, 'review', 'reviews');
  return shell(
    principal,
    ev,
    '<div style="padding:26px 0 0">' +
      `<h1 class="display" style="font-size:32px">Submit ${esc(many)}?</h1>` +
      '<p class="counts">They join the committee&#39;s average on each proposal. ' +
      `Nothing you send in ${esc(say('review.round', { n: num(ev.round) }).toLowerCase())} ` +
      'can be changed afterwards.</p>' +
      '</div>' +
      `<div class="card" style="margin-top:16px;overflow:hidden">${list}</div>` +
      `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/submit"` +
      ' class="btnrow" style="margin-top:20px">' +
      `<input type="hidden" name="expected" value="${staged.length}">` +
      `<button class="btn btn-primary btn-lg" type="submit">Submit ${esc(many)}</button>` +
      `<a class="btn" href="${esc(queueUrl(ev.slug))}">Keep them staged</a>` +
      '</form>',
    crumb
  );
}

function shell(principal: Principal, ev: ReviewEvent, body: string, crumb?: string): string {
  return page({
    title: `Reviews · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: ev.slug,
      eventName: ev.name,
      here: '/reviews',
      who: principal.name,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? '',
      body,
      crumb,
      // A pure reviewer gets her own room's chrome, not the organizer's doors.
      nav: ev.everything ? 'full' : 'reviewer',
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

type Loaded = { principal: Principal; ev: ReviewEvent };

/**
 * The door, opened once for all three handlers: a session, then an event this
 * person holds a standing on. A slug that is not theirs and a slug that is
 * nobody's answer identically — the refusal page tells them what to do next.
 */
async function enter(
  db: D1Database,
  secret: string,
  cookie: string | undefined,
  slug: string
): Promise<Loaded | Response> {
  const principal = await principalFromCookie(db, secret, cookie);
  if (!principal) return new Response(null, { status: 302, headers: { location: '/sign-in' } });
  try {
    const ev = await reviewEvent(db, principal, slug);
    if (!ev) return new Response(deniedPage(), { status: 403, headers: HTML });
    return { principal, ev };
  } catch (e) {
    if (e instanceof ScopeError) return new Response(deniedPage(e.message), { status: 403, headers: HTML });
    throw e;
  }
}

const HTML = { 'content-type': 'text/html; charset=utf-8' };

/**
 * What came back off the card, checked line by line against the card itself.
 *
 * A scale keeps a whole number inside its own range; a select keeps a word
 * only if it is one of the words offered; a written line keeps what was
 * written, trimmed and capped. Anything else is dropped rather than stored,
 * so a hand-made form cannot put a mark on a line the committee never made.
 */
function scoresFrom(form: Record<string, unknown>, card: ScorecardKey[]): Scores {
  const out: Scores = {};
  for (const k of card) {
    const raw = form[`score_${k.key}`];
    if (typeof raw !== 'string' || raw === '') continue;
    if (k.kind === 'text') {
      const written = raw.trim().slice(0, TEXT_MARK_MAX);
      if (written !== '') out[k.key] = written;
      continue;
    }
    if (k.kind === 'select') {
      if (k.options.includes(raw)) out[k.key] = raw;
      continue;
    }
    const v = Number.parseInt(raw, 10);
    if (!Number.isInteger(v) || v < 1 || v > k.max) continue;
    out[k.key] = v;
  }
  return out;
}

export function registerReviews(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/reviews', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    // One reviewer's own marks: never held in a shared cache anywhere.
    c.header('cache-control', 'private, no-store');

    if (c.req.query('confirm')) {
      const staged = await stagedReviews(c.env.DB, principal, ev.id, ev.round);
      return c.html(confirmPage(principal, ev, staged));
    }

    const show = windowSize(c.req.query('show'));
    // The team read and the round read only happen for the standing that may
    // hand the pile out, so a reviewer's screen costs what it costed before.
    const [q, team, standing] = await Promise.all([
      reviewQueue(c.env.DB, principal, ev, { show }),
      ev.everything ? reviewTeam(c.env.DB, principal, ev) : Promise.resolve([]),
      ev.everything ? roundStanding(c.env.DB, principal, ev) : Promise.resolve(null),
    ]);

    // One act happened, so one sentence comes back. Each code is checked
    // against its own closed set before it is allowed to mean anything.
    const did = ev.everything ? assignCode(c.req.query('did')) : null;
    const rnd = ev.everything ? roundCode(c.req.query('round')) : null;
    const nudged = ev.everything ? nudgeCode(c.req.query('nudged')) : null;
    // A name off the address bar would be a stranger's word. This one is
    // matched back to the committee the screen already read.
    const nudgedWho = c.req.query('who');
    const nudgedName = team.find((r) => r.personId === nudgedWho)?.name ?? 'That reader';

    return c.html(
      queuePage(principal, ev, q, {
        show,
        open: c.req.query('open') ?? null,
        note: c.req.query('note') ?? null,
        stepaside: c.req.query('stepaside') ?? null,
        team,
        standing,
        opening: ev.everything && c.req.query('open_round') === String(ev.round + 1),
        nowMs: Date.now(),
        teamSaid: did
          ? assignSaid(did, tally(c.req.query('gave')), tally(c.req.query('held')), c.req.query('more') === '1')
          : rnd
            ? roundSaid(rnd, ev.round)
            : nudged
              ? nudgeSaid(nudged, nudgedName, tally(c.req.query('open_left')))
              : null,
      })
    );
  });

  // ONE CLICK — hers, and hers to overwrite. Nothing leaves the building.
  app.post('/admin/:eventSlug/reviews/stage', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const show = windowSize(typeof form['show'] === 'string' ? form['show'] : undefined);
    const on = typeof form['on'] === 'string' ? form['on'] : '';
    if (!on) return c.redirect(backTo(ev.slug, 'moved', show), 303);

    const note = typeof form['note'] === 'string' ? form['note'].slice(0, 2000) : null;
    const outcome = await upsertReview(
      c.env.DB,
      principal,
      ev.id,
      ev.round,
      on,
      scoresFrom(form, ev.scorecard),
      note
    );
    return c.redirect(backTo(ev.slug, outcome, show), 303);
  });

  // ONE CONFIRM, AND IT DOES NOT COME BACK. The link put the sentence on the
  // screen with the title in it; this is the press underneath it.
  app.post('/admin/:eventSlug/reviews/step-aside', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const show = windowSize(typeof form['show'] === 'string' ? form['show'] : undefined);
    const on = typeof form['on'] === 'string' ? form['on'] : '';
    const outcome = await stepAside(c.env.DB, principal, ev.id, ev.round, on);
    return c.redirect(backTo(ev.slug, `aside_${outcome}`, show), 303);
  });

  // SECOND PASS — the number the reviewer read rides in the form, and the
  // guard in submitReviews refuses the batch if the list moved since.
  app.post('/admin/:eventSlug/reviews/submit', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const expected = Number.parseInt(
      typeof form['expected'] === 'string' ? form['expected'] : '',
      10
    );
    const res = await submitReviews(c.env.DB, principal, ev.id, ev.round, expected);
    return c.redirect(backTo(ev.slug, res.outcome, PAGE), 303);
  });

  // THE HAND-OUT — one guarded batch, one sentence back. The refusal for a
  // person who may read but not hand out is the same refusal page every other
  // backstage screen uses, in this act's own words.
  app.post('/admin/:eventSlug/reviews/hand-out', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody({ all: true });
    const chosen = form['who'];
    const readers = (Array.isArray(chosen) ? chosen : [chosen]).filter(
      (v): v is string => typeof v === 'string'
    );
    const each = Number.parseInt(typeof form['each'] === 'string' ? form['each'] : '', 10);

    try {
      const res = await handOutAssignments(c.env.DB, principal, ev.id, ev.round, readers, each);
      return c.redirect(
        teamUrl(ev.slug, {
          did: res.outcome,
          gave: res.handed || undefined,
          held: res.held || undefined,
          more: res.more ? 1 : undefined,
        }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Handing this pile out is not yours to do.'), {
          status: 403,
          headers: HTML,
        });
      }
      throw e;
    }
  });

  // THE SECOND PASS ON THE WIDEST ACT — the round the confirm named rides in
  // the form, and the guard in openNextRound checks it against the round the
  // database is on. Two chairs, one round, one winner.
  app.post('/admin/:eventSlug/reviews/open-round', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const from = Number.parseInt(typeof form['from'] === 'string' ? form['from'] : '', 10);
    const to = Number.parseInt(typeof form['to'] === 'string' ? form['to'] : '', 10);

    try {
      const outcome = await openNextRound(c.env.DB, principal, ev.id, from, to);
      return c.redirect(teamUrl(ev.slug, { round: outcome }), 303);
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Opening a round is not yours to do.'), {
          status: 403,
          headers: HTML,
        });
      }
      throw e;
    }
  });

  // THE NUDGE — one click, and it leaves the building, so the workflow counts
  // the hours since the last one and refuses a second inside the day.
  app.post('/admin/:eventSlug/reviews/nudge', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const who = typeof form['who'] === 'string' ? form['who'] : '';

    try {
      const res = await nudgeReviewer(
        c.env.DB,
        principal,
        ev.id,
        ev.round,
        who,
        c.env.EMAIL && c.env.FROM_EMAIL
          ? { binding: c.env.EMAIL, from: c.env.FROM_EMAIL }
          : null,
        (p) => c.executionCtx.waitUntil(p)
      );
      return c.redirect(
        teamUrl(ev.slug, {
          nudged: res.outcome,
          who: who || undefined,
          open_left: res.open || undefined,
        }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Nudging a reader is not yours to do.'), {
          status: 403,
          headers: HTML,
        });
      }
      throw e;
    }
  });

  // TAKING ONE BACK — only the untouched ones, and only the number she read.
  app.post('/admin/:eventSlug/reviews/take-back', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const who = typeof form['who'] === 'string' ? form['who'] : '';
    const expected = Number.parseInt(
      typeof form['expected'] === 'string' ? form['expected'] : '',
      10
    );

    try {
      const res = await takeBackAssignments(c.env.DB, principal, ev.id, ev.round, who, expected);
      return c.redirect(
        teamUrl(ev.slug, { did: res.outcome, gave: res.freed || undefined }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Changing who reads what is not yours to do.'), {
          status: 403,
          headers: HTML,
        });
      }
      throw e;
    }
  });
}
