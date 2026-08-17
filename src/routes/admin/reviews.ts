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
// Blind is not enforced here. It is enforced in queries/reviews.ts: row.authors
// stays null unless the round's own config said, on purpose, that it is not
// blind — this file only ever renders what that read handed it (authorLine),
// so it could not print a name on a blind round if it tried. Per-round dates,
// a name and the blind setting itself are edited from roundConfigForm, on the
// same screen the round history reads back from (ABS-01/ABS-07).
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
//   HANDING ONE OVER — one click, and the narrowest act in the room. `?hand=`
//     opens a card for one proposal, the chair picks one reader, and one empty
//     row lands on that reader's list. Same law as the hand-out below it: an
//     empty row holds nobody's work, and the take-back one table down undoes it
//     for as long as it stays empty.
//
// THE LIST IS A LIST, not a wall. Fifty rows a page, plain prev and next links
// that carry the search with them, and a title search — never a name, because
// the read underneath is blind and a search predicate is the quietest place a
// name could get in. A `?open=` link from anywhere in the product is answered
// with the page that holds that scorecard rather than with the top of the pile.
//
// No client script. The scales are radios, the folds are links, the writes are
// forms — a reviewer on a hotel wifi gets the whole screen in one round trip.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, FORMAT_KEY, LEVEL_KEY, type LabelKey } from '../../lib/labels';
import { ScopeError, type SubmissionState } from '../../queries/admin';
import {
  averageOf,
  handTarget,
  queuePosition,
  reviewEvent,
  reviewQueue,
  reviewResults,
  reviewTeam,
  roundHistory,
  scorecardFor,
  roundStanding,
  stagedReviews,
  needleOf,
  pageNumber,
  NUDGE_HOURS,
  PAGE,
  ROUND_NAME_MAX,
  SEARCH_MAX,
  TEXT_MARK_MAX,
  roundConfigFor,
  type HandTarget,
  type QueueAuthor,
  type QueueRow,
  type ResultsRow,
  type ReviewEvent,
  type ReviewQueue,
  type RoundHistoryEntry,
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
  handToReviewer,
  takeBackAssignments,
  stepAside,
  openNextRound,
  reopenRound,
  saveRoundConfig,
  nudgeReviewer,
  MOST_EACH,
  HANDOUT_CAP,
  type ReviewOutcome,
  type AssignOutcome,
  type HandOneOutcome,
  type NudgeOutcome,
  type RoundConfigInput,
  type RoundConfigOutcome,
  type RoundOutcome,
  type ReopenOutcome,
  type StepAsideOutcome,
} from '../../workflows/review';
// @ts-ignore -- plain-JS island shipped as its own source text; see cfp.ts.
import reviewDeckIsland from '../../islands/review-deck.js';

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
 * The blind hint, true of THIS round rather than assumed of every round
 * (ABS-07). §6's own 'review.blind' string is the product's original,
 * always-blind sentence — still correct on every round that has not said
 * otherwise — so only the un-blinded case is worded here, literal rather than
 * added to the shared map, the same accommodation the round panel's "average"
 * vs "weighted average" words already make while §6 has no row for them.
 */
function blindHint(ev: ReviewEvent): string {
  return ev.roundConfig.blind
    ? say('review.blind')
    : 'Author names and employers are visible while you score this round.';
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

// Exported so mcp.ts's submit_review tool can refuse in the form's own
// words — "the same refusal sentences", not a paraphrase that could drift
// from them. See the header note on queries/reviews.ts: the second copy of a
// rule is the one that goes wrong, and a copied sentence is a copy either way.
export const NOTES: Record<ReviewOutcome, string> = {
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

/** True when the form was rendered under a different round than the one the
 *  event is on now — a tab left open across a reopen. A form with no round
 *  field (an older cached page) is let through and the workflow's own
 *  current_round guard has the last word. */
function staleRound(form: Record<string, unknown>, current: number): boolean {
  const r = Number.parseInt(typeof form['round'] === 'string' ? form['round'] : '', 10);
  return Number.isInteger(r) && r >= 1 && r !== current;
}

const REOPEN_CODES: readonly ReopenOutcome[] = [
  'reopened', 'has-reviews', 'moved', 'refused', 'trouble',
];

function reopenCode(raw: string | undefined): ReopenOutcome | null {
  return REOPEN_CODES.find((c) => c === raw) ?? null;
}

/** `round` is the one the committee is on now — after reopening, the earlier one. */
function reopenSaid(code: ReopenOutcome, round: number): string {
  switch (code) {
    case 'reopened':
      return (
        `${say('review.round', { n: num(round) })} is open again. Its card and its reading ` +
        'lists are exactly as they were left, and nothing written later moved.'
      );
    case 'has-reviews':
      return (
        'This round already holds submitted reviews, and stepping back over sent-in work ' +
        'is a committee conversation, not a button. Nothing was changed.'
      );
    case 'moved':
      return 'The round moved while you were looking. This is the one the committee is on.';
    case 'refused':
      return 'Only an earlier round can be reopened. Nothing was changed.';
    case 'trouble':
      return 'That did not go through. Try it once more.';
  }
}

const ROUND_CONFIG_CODES: readonly RoundConfigOutcome[] = [
  'saved',
  'bad_date',
  'closes_first',
  'moved',
  'trouble',
];

function roundConfigCode(raw: string | undefined): RoundConfigOutcome | null {
  return ROUND_CONFIG_CODES.find((c) => c === raw) ?? null;
}

function roundConfigSaid(code: RoundConfigOutcome): string {
  switch (code) {
    case 'saved':
      return 'Saved.';
    case 'bad_date':
      return 'One of those dates is not a day the calendar has. Nothing was changed.';
    case 'closes_first':
      return 'The close date is before the open date. Nothing was changed.';
    case 'moved':
      return 'The round moved while you were looking. Read it again, then save.';
    case 'trouble':
      return 'That did not go through. Try it once more.';
  }
}

const HAND_CODES: readonly HandOneOutcome[] = [
  'handed',
  'already',
  'decided',
  'nobody',
  'moved',
  'trouble',
];

function handCode(raw: string | undefined): HandOneOutcome | null {
  return HAND_CODES.find((c) => c === raw) ?? null;
}

/**
 * What handing one proposal to one reader says afterwards. The reader is named
 * because the chair chose them by name; the proposal is not, because the card
 * that asked the question is still on the screen underneath the sentence.
 */
function handSaid(code: HandOneOutcome, name: string): string {
  switch (code) {
    case 'handed':
      return `${name} has it. It is on their list for this round, with nothing in it yet.`;
    case 'already':
      return `${name} already has that one this round, so nothing was written.`;
    case 'decided':
      return 'That one has an answer already, so there is nothing to hand out.';
    case 'nobody':
      return 'Nobody was chosen, so nothing was handed out.';
    case 'moved':
      return 'It moved while you were looking. Read it again, then hand it over.';
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

/**
 * Which slice of the queue a person is looking at: the search they typed and
 * the page they are on. It rides in every link and every form on the screen,
 * because a reviewer who saves a mark on page four of "agents" has to come back
 * to page four of "agents" — a save that returned her to the top of an
 * unsearched list would lose her place fifty rows at a time.
 *
 * The round is not in it: this room is always the round the committee is on,
 * and every read below is scoped to it.
 */
type View = { q: string; page: number };

const HERE: View = { q: '', page: 1 };

/** The two parameters of a view, left out when they are the defaults. */
const seen = (v: View): Record<string, string | number | undefined> => ({
  q: v.q || undefined,
  p: v.page > 1 ? v.page : undefined,
});

// Back to the top of the list, not to the proposal just saved: `#said` is the
// outcome sentence, and the band that says how many reviews are staged sits
// directly under it. Landing on the row instead would scroll both off the
// screen — which is exactly how a reviewer finishes an evening with eight
// staged reviews she never submitted (audit risk 1). The row she just saved is
// the first one under the band anyway, because staged sorts to the top.
const backTo = (slug: string, note: string, v: View): string =>
  `${queueUrl(slug, { ...seen(v), note })}#said`;

/** Where a hand-out comes back to: the team table, with its own sentence over it. */
const teamUrl = (
  slug: string,
  q: Record<string, string | number | undefined>
): string => `${queueUrl(slug, q)}#team`;

/** Where handing one proposal comes back to: the card that asked, still open. */
const handUrl = (
  slug: string,
  q: Record<string, string | number | undefined>
): string => `${queueUrl(slug, q)}#hand`;

/* ------------------------------------------------------------------ *
 * One row: a proposal, its scales, and where my marks stand
 * ------------------------------------------------------------------ */

/**
 * One line of the card, in whichever of its three shapes the committee chose.
 *
 * The weight is said out loud on the heavy and light lines and left silent on
 * the normal ones, because "Normal" on every line is nine words that tell a
 * reviewer nothing — and a heavy line is the one fact she needs before she
 * marks it, not after. Worded to echo the editor's own caption ("a heavy line
 * counts three times as much as a light one", settings.ts): heavy is weight 3
 * against light's weight 1, so "three times" is the arithmetic said plainly,
 * not a rounder word standing in for it.
 */
function criterion(k: ScorecardKey, mark: string | number | undefined): string {
  const name = `score_${esc(k.key)}`;
  const weight =
    k.weight === 3
      ? '<span class="opt">counts three times as much as a light line</span>'
      : k.weight === 1
        ? '<span class="opt">the lightest line</span>'
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

/**
 * An average, to one decimal, and the true word for it.
 *
 * "3.3 weighted" over three marks on a card where every line counts the same is
 * a plain mean claiming an arithmetic nobody asked for — so the word is only
 * printed when the lines this reviewer marked carry more than one weight
 * between them. When they do not, the number says what it is: an average.
 */
function mean(card: ScorecardKey[], scores: Scores): string {
  const a = averageOf(card, scores);
  return a === null
    ? ''
    : `<span class="score">${a.value.toFixed(1)}</span> ` +
      `<span class="sub">${a.weighted ? 'weighted average' : 'average'}</span>`;
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

// Word for word what proposal.ts's own ROLE_KEY says (02 §6's vocabulary) —
// a co-presenter should not learn a fourth word for the same role because a
// different screen happened to render it.
const PARTICIPATION_ROLE_KEY: Record<string, LabelKey> = {
  speaker: 'role.speaker',
  co_speaker: 'role.cospeaker',
  co_author: 'role.coauthor',
  panelist: 'role.panelist',
  moderator: 'role.host',
};

/**
 * Who wrote it, said out loud — the contrast ABS-07 asks the whole file for.
 * This line exists on the row only when reviewQueue actually fetched authors
 * for it, which it only does when the round's own config said, on purpose,
 * that it is not blind. A blind round renders nothing here no matter who is
 * reading the page, because row.authors is null before this function ever runs.
 */
function authorLine(row: QueueRow): string {
  if (!row.authors || row.authors.length === 0) return '';
  const said = row.authors
    .map((a) => {
      const key = PARTICIPATION_ROLE_KEY[a.role];
      const role = key ? label(key, 'backstage') : a.role;
      const org = a.organisation ? `, ${a.organisation}` : '';
      return a.role === 'speaker' ? `${a.name}${org}` : `${a.name} (${role})${org}`;
    })
    .join(' · ');
  return `<p class="sub" style="margin:0 0 8px">${esc(said)}</p>`;
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
    '</div>' +
    authorLine(row)
  );
}

function abstractBlock(row: QueueRow, slug: string, v: View, open: boolean): string {
  const text = (row.abstract ?? '').trim();
  if (!text) {
    return '<p class="sub" style="margin-top:10px">Nothing written in the body of this review.</p>';
  }
  const folded = clip(text);
  const anchor = `#p-${encodeURIComponent(row.id)}`;
  // `p` rides even on page one, because a bare ?open= is the shape a deep link
  // from anywhere else arrives in — and that shape is answered with a redirect
  // to the page holding the row. A fold-out that looked like a deep link would
  // bounce through it on every click.
  const wide = queueUrl(slug, { q: v.q || undefined, p: v.page, open: row.id }) + anchor;
  const shut = queueUrl(slug, { q: v.q || undefined, p: v.page }) + anchor;
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
  v: View,
  open: boolean,
  stepping: boolean
): string {
  const head =
    `<h2 class="display" style="font-size:22px;line-height:1.25">${esc(row.title)}</h2>` +
    abstractBlock(row, ev.slug, v, open);

  // Stepped aside: finished, and finished with nothing in it. No marks to read
  // back, because there are none — that is the whole point of the row.
  if (row.myRecused) {
    return (
      `<div class="card card-pad" id="p-${esc(row.id)}" style="margin-top:14px">` +
      rowHead(row, ev) +
      head +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">' +
      '<span class="chip s-withdrawn">Stepped aside</span>' +
      '<span class="sub">Nothing you marked on this proposal counts towards its average.</span>' +
      '</div></div>'
    );
  }

  // Submitted: fixed for this round. The marks stay legible, the controls go.
  if (row.mySubmittedAt !== null) {
    const marks = marksLine(ev.scorecard, row.myScores);
    const average = mean(ev.scorecard, row.myScores);
    return (
      `<div class="card card-pad" id="p-${esc(row.id)}" style="margin-top:14px">` +
      rowHead(row, ev) +
      head +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">' +
      `<span class="chip s-accepted">Scored ${esc(onDay(row.mySubmittedAt, ev.timezone))}</span>` +
      (marks ? `<span class="sub">${marks}</span>` : '') +
      (average ? `<span class="sub">${average}</span>` : '') +
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
  const aside = queueUrl(ev.slug, { ...seen(v), stepaside: row.id }) + anchor;
  // The chair reads the pile to hand it out, so the act belongs on the row she
  // is reading — not only on the proposal's own screen one click away.
  const over = ev.everything
    ? `<a class="btn btn-quiet" href="${esc(
        queueUrl(ev.slug, { ...seen(v), hand: row.id }) + '#hand'
      )}">Hand it to a reader</a>`
    : '';

  const card =
    `<form class="card card-pad" id="p-${esc(row.id)}" method="post" style="margin-top:14px"` +
    ` action="/admin/${encodeURIComponent(ev.slug)}/reviews/stage">` +
    `<input type="hidden" name="round" value="${ev.round}">` +
    `<input type="hidden" name="on" value="${esc(row.id)}">` +
    `<input type="hidden" name="q" value="${esc(v.q)}">` +
    `<input type="hidden" name="p" value="${v.page}">` +
    rowHead(row, ev) +
    head +
    `<div style="margin-top:16px">${lines}</div>` +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">Your note' +
    '<span class="opt">only the committee reads this</span></span>' +
    '<textarea name="note" rows="2" maxlength="2000" placeholder="What would you tell the room about this proposal?">' +
    `${esc(row.myNote ?? '')}</textarea></label>` +
    '<div class="btnrow" style="margin-top:14px">' +
    `<button class="btn btn-primary" type="submit">${esc(say('review.save'))}</button>` +
    over +
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
  const shut = queueUrl(ev.slug, seen(v)) + anchor;
  return (
    card +
    '<div class="card card-pad" style="margin-top:10px;border-left:3px solid var(--danger)">' +
    `<b>Step aside from ${esc(row.title)}?</b>` +
    '<p style="margin:6px 0 0">This cannot be taken back this round. The proposal leaves your ' +
    'list, nothing you marked on it is kept, and the committee reads it one voice short — so ' +
    'tell whoever hands the pile out.</p>' +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/step-aside"` +
    ' class="btnrow" style="margin-top:12px">' +
    `<input type="hidden" name="round" value="${ev.round}">` +
    `<input type="hidden" name="on" value="${esc(row.id)}">` +
    `<input type="hidden" name="q" value="${esc(v.q)}">` +
    `<input type="hidden" name="p" value="${v.page}">` +
    '<button class="btn btn-danger" type="submit">Step aside</button>' +
    `<a class="btn btn-quiet" href="${esc(shut)}">Keep it on my list</a>` +
    '</form></div>'
  );
}

/* ------------------------------------------------------------------ *
 * One proposal, one reader
 * ------------------------------------------------------------------ */

/**
 * The card `?hand=<proposal>` opens: this one proposal, the committee, and one
 * button.
 *
 * The round-robin below hands out a pile. This hands out a proposal — the act
 * a chair reaches for when one arrives late, when the person who knows the
 * subject should see it, or when a reader who is drowning should not get any
 * more. It is a deciders' control, and it names the proposal out loud: the
 * queue is blind, but the chair handing work out is not reading blind, and
 * "hand this one over" is not a question that can be asked without saying
 * which one.
 *
 * Each reader's line carries what they are already holding, because the fix
 * for one person holding a whole call is being able to see it at the moment of
 * choosing. Whoever already has this proposal is named in a sentence instead of
 * offered as a choice — the row exists, and a second one is not a thing the
 * schema will hold.
 */
function handCard(
  ev: ReviewEvent,
  team: TeamReader[],
  target: HandTarget | null,
  v: View,
  said: string | null
): string {
  const shut = queueUrl(ev.slug, seen(v));
  const sentence = said
    ? `<div class="standing" role="status" style="margin-top:12px">${esc(said)}</div>`
    : '';
  const head = `<h2 class="display" style="font-size:22px">${esc(say('review.assign'))}</h2>`;
  const framed = (inner: string): string =>
    `<section class="sec" id="hand"><div class="card card-pad">${head}${inner}</div></section>`;

  if (!target) {
    return framed(
      sentence +
        '<p class="sub" style="margin-top:10px">That proposal is not on this conference, so ' +
        'there is nothing to hand out.</p>' +
        `<p style="margin:10px 0 0"><a class="link" href="${esc(shut)}">Back to the list</a></p>`
    );
  }

  const title = `<p style="margin-top:10px;font-weight:640">${esc(target.title)}</p>`;

  if (!target.undecided) {
    return framed(
      sentence +
        title +
        '<p class="sub" style="margin-top:6px">This one has an answer already, so it is off ' +
        'the committee&#39;s list. Nothing can be handed out on it.</p>' +
        `<p style="margin:10px 0 0"><a class="link" href="/admin/${encodeURIComponent(ev.slug)}` +
        `/submissions/${encodeURIComponent(target.id)}">See where it stands</a>` +
        `<span class="sep"> · </span><a class="link" href="${esc(shut)}">Back to the list</a></p>`
    );
  }

  const holding = team.filter((r) => target.holders.includes(r.personId));
  const free = team.filter((r) => !target.holders.includes(r.personId));
  const held =
    holding.length > 0
      ? `<p class="sub" style="margin-top:6px">${esc(
          `Already reading it: ${holding.map((r) => r.name).join(', ')}.`
        )}</p>`
      : '';

  if (free.length === 0) {
    return framed(
      sentence +
        title +
        held +
        '<p class="sub" style="margin-top:6px">Everyone who reads on this conference already ' +
        'has this proposal.</p>' +
        `<p style="margin:10px 0 0"><a class="link" href="${esc(shut)}">Back to the list</a></p>`
    );
  }

  // Nothing is ticked to begin with. A default here would be a name the chair
  // did not choose, on a control whose whole point is choosing the name.
  const who = free
    .map(
      (r) =>
        '<label class="radio"><input type="radio" name="who" value="' +
        `${esc(r.personId)}"><span><span class="rname">${esc(r.name)}</span>` +
        `<span class="rsub"> · ${esc(
          r.assigned === 0 ? 'holding nothing' : `holding ${num(r.assigned)}`
        )}</span></span></label>`
    )
    .join('');

  return framed(
    sentence +
      title +
      held +
      `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/hand-one">` +
      `<input type="hidden" name="on" value="${esc(target.id)}">` +
      `<input type="hidden" name="q" value="${esc(v.q)}">` +
      `<input type="hidden" name="p" value="${v.page}">` +
      '<div class="f-lab" style="margin:14px 0 8px">Who should read this proposal' +
      '<span class="opt">what each of them is already holding is beside their name</span></div>' +
      `<div class="btnrow" style="flex-wrap:wrap">${who}</div>` +
      '<div class="btnrow" style="margin-top:16px;align-items:center">' +
      '<button class="btn btn-primary" type="submit">Hand it over</button>' +
      `<a class="btn btn-quiet" href="${esc(shut)}">Not now</a>` +
      '<span class="sub">It lands on their list empty. Taking it back is one button below, ' +
      'until they write in it.</span>' +
      '</div></form>'
  );
}

/* ------------------------------------------------------------------ *
 * Who reads what — the chair's half of the room
 * ------------------------------------------------------------------ */

// D-026 tiers have no §6 entry, so no label key exists for them; the same
// literal map the rest of backstage uses is the honest place for them.
//
// GAP, for the doc owner, on the same shelf: §1.23 gained four facts this room
// now shows and §6 has a row for none of them — "Stepped aside" (a review
// finished with nothing in it), "Nudge" (the chair's reminder), and the two
// words an average may carry, "average" and "weighted average", which are not
// interchangeable: the second is only true when the marked lines carry
// different weights. They are written as literals here and in settings until §6
// carries them; when it does, they move and these go.
// Word for word what settings says (STANDING_WORD there), because two screens
// naming the same standing differently is how a team list stops being read.
// 'viewer' and 'reviewer' are two standings and two words: one reads the whole
// backstage, the other reads only what was handed to them.
const STANDING: Record<string, string> = {
  organizer: 'Organizer',
  owner: 'Owner',
  approver: 'Approver',
  editor: 'Editor',
  viewer: 'Viewer',
  reviewer: 'Reviewer',
};

/**
 * What a reader is carrying and how far in they are. Two numbers where there
 * used to be one: a reader six proposals into an evening and a reader who has
 * recused herself from six are both "six finished", and telling them apart is
 * the difference between a chair who chases the right person and one who
 * chases the wrong one.
 *
 * Shared by teamRow (the table, ≥720px) and teamCard (the ≤720px composition
 * fresh-eyes-design-review.md item 1 asks for) so the two breakpoints can
 * never say a different thing about the same reader.
 */
function progressText(r: TeamReader): string {
  return (
    (r.assigned === 0
      ? `<span class="sub">Nothing handed to ${r.isYou ? 'you' : 'them'} yet.</span>`
      : r.recused > 0
        ? `${esc(num(r.completed))} scored<span class="sep"> · </span>` +
          `${esc(num(r.recused))} stepped aside`
        : esc(say('review.progress', { n: num(r.completed), m: num(r.assigned) }))) +
    (r.started > 0
      ? `<span class="sep"> · </span><span class="sub">${esc(num(r.started))} started</span>`
      : '')
  );
}

/** Only the untouched ones can come back, and the button says how many so the
 *  number she reads is the number the guard checks. */
function retractForm(ev: ReviewEvent, r: TeamReader): string {
  return r.untouched > 0
    ? `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/take-back">` +
      `<input type="hidden" name="who" value="${esc(r.personId)}">` +
      `<input type="hidden" name="expected" value="${r.untouched}">` +
      `<button class="btn btn-sm" type="submit">Retract ${esc(num(r.untouched))} unopened</button>` +
      '</form>'
    : r.assigned > 0
      ? `<span class="sub">Every one of ${r.isYou ? 'yours' : 'theirs'} has been written in.</span>`
      : '';
}

/** A nudge is for somebody who still owes the room something. Nudging
 *  yourself is a note to yourself, and nudging a person who is finished is
 *  noise, so neither turns up as a button. */
function nudgeControl(ev: ReviewEvent, r: TeamReader, nowMs: number): string {
  const open = r.started + r.untouched;
  const recent = r.nudgedAt !== null && nowMs - r.nudgedAt < NUDGE_HOURS * 3_600_000;
  return open === 0 || r.isYou
    ? ''
    : recent
      ? `<span class="sub">Nudged ${esc(onDay(r.nudgedAt ?? nowMs, ev.timezone))}</span>`
      : `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/nudge">` +
        `<input type="hidden" name="who" value="${esc(r.personId)}">` +
        `<button class="btn btn-sm" type="submit">Nudge</button></form>`;
}

/** One reader's line: what they are carrying, and how far in they are. */
function teamRow(r: TeamReader, ev: ReviewEvent, nowMs: number): string {
  return (
    '<tr>' +
    `<td><div class="t-name">${esc(r.name)}${r.isYou ? '<span class="sub"> · you</span>' : ''}</div>` +
    `<div class="t-sub">${esc(STANDING[r.standing] ?? r.standing)}</div></td>` +
    `<td style="font-variant-numeric:tabular-nums">${esc(num(r.assigned))}</td>` +
    `<td>${progressText(r)}</td>` +
    `<td>${nudgeControl(ev, r, nowMs)}</td>` +
    `<td>${retractForm(ev, r)}</td>` +
    '</tr>'
  );
}

/**
 * The same reader, as a card — the ≤720px composition fresh-eyes-design-
 * review.md item 1 asks for: a five-column table has nowhere to go on a
 * phone, so a phone gets one card per reader with the same three counts and
 * the same two acts, never a sixth column squeezed smaller. It calls the
 * same three functions teamRow does, so the two breakpoints can never drift.
 *
 * "Waiting on {name}" (the taste rules' team-handoff language) only prints
 * when it is true of real data: a reader who still has something started or
 * unopened is, in fact, who the chair is waiting on. It never prints for the
 * chair's own row.
 */
function teamCard(r: TeamReader, ev: ReviewEvent, nowMs: number): string {
  const waitingOn =
    !r.isYou && r.started + r.untouched > 0
      ? `<p class="rcard-waiting">Waiting on <b>${esc(r.name)}</b>.</p>`
      : '';
  return (
    '<div class="card card-pad rcard">' +
    `<div class="t-name">${esc(r.name)}${r.isYou ? '<span class="sub"> · you</span>' : ''}</div>` +
    `<div class="t-sub">${esc(STANDING[r.standing] ?? r.standing)}</div>` +
    '<div class="rcard-nums">' +
    `<div class="rcard-num"><b>${esc(num(r.assigned))}</b><span>holding</span></div>` +
    `<div class="rcard-num"><b>${esc(num(r.completed))}</b><span>scored</span></div>` +
    `<div class="rcard-num"><b>${esc(num(r.untouched))}</b><span>unopened</span></div>` +
    '</div>' +
    `<p class="sub" style="margin-top:8px">${progressText(r)}</p>` +
    waitingOn +
    `<div class="btnrow" style="margin-top:10px">${nudgeControl(ev, r, nowMs)}${retractForm(ev, r)}</div>` +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The round — the widest act in the room, and the quietest panel
 * ------------------------------------------------------------------ */

/** An epoch millisecond, as the day it names in UTC — the form field this
 *  round's dates are edited through, and the shape they are stored in. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * An open/close date, said in the same UTC day it was entered as and stored
 * as — saveRoundConfig (workflows/review.ts) parses the plain YYYY-MM-DD the
 * form collects through `Date.parse(\`${day}T00:00:00Z\`)`, a UTC anchor with
 * no timezone of its own, because a round opens and closes on a calendar day
 * an organizer typed, not at a moment. Reading it back through the event's
 * own timezone (onDay, above) re-applies a timezone the value never carried
 * and shifts it a day early for any organizer west of Greenwich — 2026-08-01
 * read back as "31 July". Same wall-date discipline agenda.ts's
 * dateFromKey/dateLabel hold for the CFP's own open/close dates: format a
 * plain day in UTC, the anchor it was stored against, never the viewer's zone.
 */
function onRoundDay(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  }).format(new Date(ms));
}

/** A round's dates, said as a range, an open end, or their absence — the
 *  same three shapes the history block and the masthead both need. */
function roundDates(opensAt: number | null, closesAt: number | null): string {
  if (opensAt !== null && closesAt !== null) {
    return `${onRoundDay(opensAt)} – ${onRoundDay(closesAt)}`;
  }
  if (opensAt !== null) return `Opens ${onRoundDay(opensAt)}`;
  if (closesAt !== null) return `Closes ${onRoundDay(closesAt)}`;
  return 'No dates set';
}

/**
 * The form a round's own facts are edited through: a name, an open and close
 * date, and whether readers see who wrote what — ABS-01's editable identity
 * and ABS-07's per-round anonymization, both missing before this file grew
 * them. One confirm, not two: it binds nobody's letter and moves no decision,
 * the same reasoning stepAside's header gives for a reviewer's own act.
 */
function roundConfigForm(ev: ReviewEvent, round: number): string {
  const cfg = round === ev.round ? ev.roundConfig : null;
  return (
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/round-config"` +
    ' style="margin-top:14px">' +
    `<input type="hidden" name="round" value="${round}">` +
    '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
    '<label class="f" style="flex:1;min-width:200px"><span class="f-lab">Name this round</span>' +
    `<input type="text" name="name" maxlength="${ROUND_NAME_MAX}" value="${esc(cfg?.name ?? '')}" ` +
    `placeholder="${esc(say('review.round', { n: num(round) }))}"></label>` +
    '<label class="f" style="min-width:140px"><span class="f-lab">Opens</span>' +
    `<input type="text" name="opens" value="${esc(cfg?.opensAt ? isoDay(cfg.opensAt) : '')}" ` +
    'placeholder="2026-08-01"></label>' +
    '<label class="f" style="min-width:140px"><span class="f-lab">Closes</span>' +
    `<input type="text" name="closes" value="${esc(cfg?.closesAt ? isoDay(cfg.closesAt) : '')}" ` +
    'placeholder="2026-10-15"></label>' +
    '</div>' +
    '<label class="radio" style="margin-top:10px;align-items:flex-start">' +
    `<input type="checkbox" name="blind" value="1"${cfg === null || cfg.blind ? ' checked' : ''}>` +
    '<span>Hide author names and employers from everyone reading this round</span></label>' +
    '<div class="btnrow" style="margin-top:10px">' +
    '<button class="btn btn-sm" type="submit">Save round details</button></div>' +
    '</form>'
  );
}

/** One earlier round, read back whole — the proof that opening the next one
 *  did not touch it: its own name, its own dates, its own counts, unmoved. */
function roundHistoryLine(ev: ReviewEvent, r: RoundHistoryEntry, current: number): string {
  const name = r.name ?? say('review.round', { n: num(r.round) });
  const record =
    r.onRecord === 0
      ? 'Nothing was sent in.'
      : `${count(r.onRecord, 'review is', 'reviews are')} on the record.`;
  const stepped = r.stepped > 0 ? ` ${count(r.stepped, 'reader', 'readers')} stepped aside.` : '';
  // The card this round actually used, read back read-only from the stored
  // per-round defs — so opening a later round never hides what an earlier one
  // asked its readers to weigh, and the two rounds' distinct scorecards sit
  // one above the other (ABS-01).
  const card = scorecardFor(ev.scorecardsRaw, r.round);
  const cardLine = card.length
    ? `<div class="sub" style="margin-top:2px">Scorecard: ${card
        .map(
          (k) =>
            esc(k.label) +
            (k.weight === 3 ? ' (heavy)' : k.weight === 1 ? ' (light)' : '')
        )
        .join(' · ')}</div>`
    : '';
  return (
    '<div style="padding:10px 0;border-top:1px solid var(--line-soft)">' +
    `<div style="font-weight:640">${esc(name)}` +
    (r.name ? `<span class="sub"> · ${esc(say('review.round', { n: num(r.round) }))}</span>` : '') +
    '</div>' +
    `<div class="sub" style="margin-top:2px">${esc(roundDates(r.opensAt, r.closesAt))} · ` +
    `${esc(r.blind ? 'Names hidden while scoring' : 'Names visible while scoring')}</div>` +
    `<div class="sub" style="margin-top:2px">${esc(`${record}${stepped}`)}</div>` +
    cardLine +
    // The way back (T603): an earlier round can be reopened, and the
    // workflow refuses when the current round already holds submitted work —
    // the button is always honest to press. A LATER round (kept on the page
    // after a reopen) is returned to through "Open round N" above instead.
    (r.round < current
      ? `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/reopen-round" style="margin-top:8px">` +
        `<input type="hidden" name="from" value="${esc(String(current))}">` +
        `<input type="hidden" name="to" value="${esc(String(r.round))}">` +
        '<button class="btn btn-sm btn-quiet" type="submit">Reopen this round</button>' +
        '</form>'
      : '<div class="sub" style="margin-top:6px">Waiting ahead — open it again from the round panel above when the committee is ready.</div>') +
    '</div>'
  );
}

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
 *
 * `history` is every round up to and including this one (ABS-01/ABS-08): the
 * evidence that opening round two left round one exactly where it was, each
 * with its own name, its own dates and its own counts rather than one number
 * overwriting the last.
 */
function roundPanel(
  ev: ReviewEvent,
  standing: RoundStanding,
  history: RoundHistoryEntry[],
  opening: boolean
): string {
  const here = ev.roundConfig.name ?? say('review.round', { n: num(standing.round) });
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

  // A round that was open before (reopened, then advanced again) keeps its
  // identity: the confirm prefils from the stored config so pressing Open
  // does not overwrite a saved name and dates with blanks (T603).
  const nextCfg = roundConfigFor(ev.roundConfigRaw, standing.round + 1);
  const confirm =
    '<div class="notebox" style="margin-top:12px;border-left-color:var(--danger)">' +
    `<b>Open ${esc(next.toLowerCase())}?</b>` +
    `<p style="margin:6px 0 0">${esc(
      `${count(standing.onRecord, 'review', 'reviews')} from ${here.toLowerCase()} ` +
        `stay on the record. ` +
        (standing.nextRoundRows > 0
          ? `${next} resumes the reading lists it was left with — ` +
            `${count(standing.nextRoundRows, 'assignment', 'assignments')} waiting.`
          : `${next} starts empty.`)
    )}</p>` +
    `<p style="margin:6px 0 0" class="sub">${esc(
      standing.nextCardExists
        ? `${next} already has a scorecard of its own, and it is left exactly as it is.`
        : `${here}'s scorecard is copied to ${next.toLowerCase()}, so nobody has to write it ` +
          'out again. Settings is where it changes.'
    )}</p>` +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/reviews/open-round"` +
    ' style="margin-top:12px">' +
    `<input type="hidden" name="from" value="${standing.round}">` +
    `<input type="hidden" name="to" value="${standing.round + 1}">` +
    '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
    '<label class="f" style="flex:1;min-width:200px"><span class="f-lab">Name it</span>' +
    `<input type="text" name="name" maxlength="${ROUND_NAME_MAX}" placeholder="${esc(next)}"` +
    ` value="${esc(nextCfg.name ?? '')}"></label>` +
    '<label class="f" style="min-width:140px"><span class="f-lab">Opens</span>' +
    `<input type="text" name="opens" placeholder="2026-10-16" value="${esc(nextCfg.opensAt ? isoDay(nextCfg.opensAt) : '')}"></label>` +
    '<label class="f" style="min-width:140px"><span class="f-lab">Closes</span>' +
    `<input type="text" name="closes" placeholder="2026-11-30" value="${esc(nextCfg.closesAt ? isoDay(nextCfg.closesAt) : '')}"></label>` +
    '</div>' +
    '<label class="radio" style="margin-top:10px;align-items:flex-start">' +
    `<input type="checkbox" name="blind" value="1"${nextCfg.blind ? ' checked' : ''}>` +
    '<span>Hide author names and employers from everyone reading it</span></label>' +
    '<div class="btnrow" style="margin-top:12px">' +
    `<button class="btn btn-danger" type="submit">Open ${esc(next.toLowerCase())}</button>` +
    `<a class="btn btn-quiet" href="${esc(queueUrl(ev.slug))}#team">Stay on ${esc(here.toLowerCase())}</a>` +
    '</div></form></div>';

  // Every round that is not the current one: earlier rounds, and — after a
  // reopen — the later round waiting ahead, which must stay on the page
  // rather than vanish because current_round stepped back.
  const others = history.filter((r) => !r.current).reverse();
  const past =
    others.length > 0
      ? '<div class="card card-pad" style="margin-top:12px">' +
        '<h4 class="serif" style="font-size:15.5px;font-weight:600">Other rounds</h4>' +
        others.map((r) => roundHistoryLine(ev, r, standing.round)).join('') +
        '</div>'
      : '';

  return (
    '<div class="card card-pad" style="margin-top:16px">' +
    `<h3 class="serif" style="font-size:19px;font-weight:600">${esc(here)}</h3>` +
    (ev.roundConfig.name
      ? `<p class="sub" style="margin:2px 0 0">${esc(say('review.round', { n: num(standing.round) }))}</p>`
      : '') +
    `<p class="sub" style="margin:6px 0 0">${esc(roundDates(ev.roundConfig.opensAt, ev.roundConfig.closesAt))} · ` +
    `${esc(ev.roundConfig.blind ? 'Names hidden while scoring' : 'Names visible while scoring')}</p>` +
    `<p class="sub" style="margin:6px 0 0">${esc(`${record}${stepped}`)} ` +
    'Every list on this page is this round&#39;s. Nothing written in an earlier one moves.</p>' +
    roundConfigForm(ev, standing.round) +
    (opening ? confirm : first) +
    past +
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
    `<form class="card card-pad" id="handout" method="post" style="margin-top:16px"` +
    ` action="/admin/${encodeURIComponent(ev.slug)}/reviews/hand-out">` +
    '<div class="f-lab" style="margin-bottom:8px">Give every undecided proposal to</div>' +
    `<div class="btnrow">${each.join('')}<span class="sub">readers</span></div>` +
    '<div class="f-lab" style="margin:16px 0 8px">Who is reading this round' +
    '<span class="opt">untick anyone sitting this round out</span></div>' +
    `<div class="btnrow" style="flex-wrap:wrap">${who}</div>` +
    '<div class="btnrow" style="margin-top:16px;align-items:center">' +
    '<button class="btn btn-primary" type="submit">Hand them out</button>' +
    `<span class="sub">${esc(count(pile, 'proposal is', 'proposals are'))} still undecided. ` +
    'Anyone already holding one keeps it.</span>' +
    '</div>' +
    '</form>'
  );
}

/**
 * The proposals that came in after the pile went out.
 *
 * A hand-out is a deliberate act on the pile as it stood, and nothing is
 * assigned quietly afterwards — so a proposal sent in this morning is on
 * nobody's list, and says so on its own screen, while a reader's list from last
 * week still holds three hundred. Both facts are true, and read together they
 * look like a contradiction unless somebody says this sentence. This is the
 * sentence, with the two ways out beside it.
 */
function newArrivals(ev: ReviewEvent, standing: RoundStanding): string {
  const n = standing.unassigned;
  if (n === 0) return '';
  const said =
    n === 1
      ? 'One undecided proposal is on nobody’s list this round. It came in after the pile ' +
        'was handed out, and nothing is assigned without you — so it waits here until you ' +
        'hand it out.'
      : `${num(n)} undecided proposals are on nobody’s list this round. They came in after ` +
        'the pile was handed out, and nothing is assigned without you — so they wait here ' +
        'until you hand them out.';
  return (
    '<div class="notebox" style="margin-top:16px">' +
    `<p style="margin:0">${esc(said)}</p>` +
    '<p style="margin:8px 0 0">' +
    '<a class="link" href="#handout">Hand out again — it only gives out what nobody holds</a>' +
    '<span class="sep"> · </span>' +
    `<a class="link" href="/admin/${encodeURIComponent(ev.slug)}/submissions?f=undecided">` +
    'Open one and hand it to a reader yourself</a></p>' +
    '</div>'
  );
}

function whoReadsWhat(
  ev: ReviewEvent,
  team: TeamReader[],
  pile: number,
  said: string | null,
  standing: RoundStanding,
  history: RoundHistoryEntry[],
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
      roundPanel(ev, standing, history, opening) +
      '</section>'
    );
  }

  return (
    '<section class="sec" id="team">' +
    heading +
    '<div class="tablewrap rteam-table" style="margin-top:14px"><table class="t"><thead><tr>' +
    '<th>Reader</th><th>Holding</th><th>Progress</th><th>Nudge</th><th>Retract</th>' +
    '</tr></thead><tbody>' +
    team.map((r) => teamRow(r, ev, nowMs)).join('') +
    '</tbody></table></div>' +
    `<div class="rteam-cards" style="margin-top:14px">${team
      .map((r) => teamCard(r, ev, nowMs))
      .join('')}</div>` +
    newArrivals(ev, standing) +
    (pile > 0
      ? handOutForm(ev, team, pile)
      : '<p class="sub" style="margin-top:16px">Nothing is undecided on this program, ' +
        'so there is nothing to hand out.</p>') +
    roundPanel(ev, standing, history, opening) +
    '</section>'
  );
}

/* ------------------------------------------------------------------ *
 * The results table (ABS-10/ABS-13) — the committee's own aggregate,
 * sortable, and a CSV of it besides.
 * ------------------------------------------------------------------ */

const resultsUrl = (
  slug: string,
  q: Record<string, string | number | undefined> = {}
): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const tail = params.toString();
  return `/admin/${encodeURIComponent(slug)}/reviews/results${tail ? `?${tail}` : ''}`;
};

// Word for word what proposal.ts's own STATE_KEY and CHIP maps say (02 §6's
// vocabulary and the lifted CSS's own chip skins) — a status should not learn
// a fifth name on the results table when the proposals list already gave it
// one.
const STATE_LABEL: Record<SubmissionState, LabelKey> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};
const STATE_CHIP: Record<SubmissionState, string> = {
  draft: 's-draft',
  submitted: 's-undecided',
  accepted: 's-accepted',
  waitlisted: 's-maybe',
  rejected: 's-declined',
  withdrawn: 's-withdrawn',
  cancelled: 'warn',
};

/** Highest first unless the address asked otherwise — the direction a chair
 *  opens a results table wanting, every time this screen has been watched
 *  used. */
type ResultsSort = 'desc' | 'asc';

function sortResults(rows: ResultsRow[], sort: ResultsSort): ResultsRow[] {
  const scored = rows.filter((r) => r.aggregate !== null);
  const unscored = rows.filter((r) => r.aggregate === null);
  scored.sort((a, b) =>
    sort === 'desc' ? (b.aggregate as number) - (a.aggregate as number) : (a.aggregate as number) - (b.aggregate as number)
  );
  // Unscored proposals sort last whichever direction is asked for: a sort
  // toggle is about the scores that exist, not about scrambling the ones that
  // do not.
  return [...scored, ...unscored];
}

function resultsRow(ev: ReviewEvent, r: ResultsRow): string {
  const track = r.track
    ? `<div style="margin-top:4px"><span class="tk" style="${esc(trackStyle(r.track.colour))}">` +
      `${esc(r.track.name)}</span></div>`
    : '';
  const score =
    r.aggregate === null
      ? '<span class="sub">Not scored yet</span>'
      : `<span class="score">${r.aggregate.toFixed(1)}</span> ` +
        `<span class="sub">${r.weighted ? 'weighted average' : 'average'} · ` +
        `${esc(count(r.reviewCount, 'review', 'reviews'))}</span>`;
  return (
    '<tr>' +
    `<td><a class="link" href="/admin/${encodeURIComponent(ev.slug)}/submissions/` +
    `${encodeURIComponent(r.submissionId)}">${esc(r.title)}</a>${track}</td>` +
    `<td>${esc(word(FORMAT_KEY[r.format]) || r.format)}</td>` +
    `<td><span class="chip ${esc(STATE_CHIP[r.state])}">${esc(label(STATE_LABEL[r.state], 'backstage'))}</span></td>` +
    `<td>${score}</td>` +
    `<td>${r.recommendation ? esc(r.recommendation) : '<span class="sub">—</span>'}</td>` +
    '</tr>'
  );
}

function resultsPage(
  principal: Principal,
  ev: ReviewEvent,
  results: { rows: ResultsRow[]; more: boolean },
  sort: ResultsSort
): string {
  const crumb = `<a href="${esc(queueUrl(ev.slug))}">Reviews</a> › <span>results</span>`;
  const ordered = sortResults(results.rows, sort);
  const scoredCount = results.rows.filter((r) => r.aggregate !== null).length;

  const head =
    '<div style="padding:26px 0 0">' +
    '<h1 class="display" style="font-size:32px">Results</h1>' +
    `<p class="counts">${esc(
      `${count(results.rows.length, 'submission', 'submissions')} · ` +
        `${count(scoredCount, 'has a score', 'have a score')}`
    )}${results.more ? esc(` · showing the first ${num(results.rows.length)}`) : ''}</p>` +
    '</div>';

  if (results.rows.length === 0) {
    return shell(
      principal,
      ev,
      head +
        '<div class="sec state-out"><h2>Nothing to show yet.</h2>' +
        '<p>Once a proposal has been sent in and a reviewer has scored it, it lands here.</p>' +
        `<a class="btn btn-primary" href="${esc(queueUrl(ev.slug))}">Back to Reviews →</a></div>`,
      crumb
    );
  }

  const csvHref = `/admin/${encodeURIComponent(ev.slug)}/reviews/results.csv${sort === 'asc' ? '?sort=asc' : ''}`;
  const sortBar =
    '<div class="btnrow" style="margin-top:14px">' +
    `<a class="btn btn-sm" href="${esc(resultsUrl(ev.slug, { sort: 'desc' }))}"` +
    `${sort === 'desc' ? ' aria-current="page"' : ''}>Highest score first</a>` +
    `<a class="btn btn-sm" href="${esc(resultsUrl(ev.slug, { sort: 'asc' }))}"` +
    `${sort === 'asc' ? ' aria-current="page"' : ''}>Lowest score first</a>` +
    `<a class="btn btn-sm" href="${esc(csvHref)}">Download as CSV →</a>` +
    '</div>';

  const table =
    '<div class="tablewrap" style="margin-top:14px"><table class="t"><thead><tr>' +
    '<th>Submission</th><th>Format</th><th>Status</th><th>Score</th><th>Recommendation</th>' +
    '</tr></thead><tbody>' +
    ordered.map((r) => resultsRow(ev, r)).join('') +
    '</tbody></table></div>';

  return shell(principal, ev, head + sortBar + table, crumb);
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function resultsCsv(ev: ReviewEvent, results: { rows: ResultsRow[] }, sort: ResultsSort): string {
  const header = ['title', 'track', 'format', 'status', 'aggregate_score', 'reviews', 'recommendation'];
  const lines = [header.map(csvField).join(',')];
  for (const r of sortResults(results.rows, sort)) {
    lines.push(
      [
        r.title,
        r.track?.name ?? '',
        word(FORMAT_KEY[r.format]) || r.format,
        label(STATE_LABEL[r.state], 'backstage'),
        r.aggregate === null ? '' : r.aggregate.toFixed(2),
        String(r.reviewCount),
        r.recommendation ?? '',
      ]
        .map(csvField)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

/**
 * The search box. Titles, and the screen says so — a reviewer who types a
 * speaker's name into this and gets nothing should be told why by the label
 * rather than left guessing whether the search is broken or the room is blind.
 *
 * It appears when there is more of the list than one page holds, or when a
 * search is already on. Eight proposals do not need finding; a control that has
 * nothing to do is a control that teaches people to stop reading the screen.
 */
function searchBar(ev: ReviewEvent, q: ReviewQueue, v: View): string {
  if (q.total <= PAGE && v.q === '') return '';
  return (
    '<div class="searchbar">' +
    `<form method="get" action="/admin/${encodeURIComponent(ev.slug)}/reviews"` +
    ' style="display:contents">' +
    `<input type="text" name="q" value="${esc(v.q)}" maxlength="${SEARCH_MAX}" ` +
    'placeholder="Search these titles" aria-label="Search these titles">' +
    '<button class="btn" type="submit">Search</button>' +
    '</form>' +
    (v.q ? `<a class="link" href="${esc(queueUrl(ev.slug))}">Clear the search</a>` : '') +
    '</div>'
  );
}

/**
 * Where in the list this page sits, and the two plain doors out of it.
 *
 * Links rather than a control: every one of them is a whole address, so the
 * back button, a bookmark and a middle click all behave, and the search and the
 * page number ride together because losing either one costs a reviewer her
 * place fifty rows at a time.
 */
function pager(ev: ReviewEvent, q: ReviewQueue, v: View): string {
  const first = (q.page - 1) * PAGE + 1;
  const last = first + q.shown - 1;
  const showing =
    q.matching === 0
      ? ''
      : q.pages === 1
        ? `Showing all ${num(q.matching)}.`
        : `Showing ${num(first)}–${num(last)} of ${num(q.matching)}.`;
  const about = v.q ? ` Matching “${v.q}”.` : '';
  if (q.pages <= 1) {
    return `<p class="sub" style="margin-top:20px">${esc(showing + about)}</p>`;
  }
  const back = queueUrl(ev.slug, { q: v.q || undefined, p: q.page > 2 ? q.page - 1 : undefined });
  const on = queueUrl(ev.slug, { q: v.q || undefined, p: q.page + 1 });
  return (
    '<div class="sec" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
    (q.page > 1 ? `<a class="btn" href="${esc(back)}">← The ${num(PAGE)} before these</a>` : '') +
    (q.page < q.pages ? `<a class="btn" href="${esc(on)}">The next ${num(PAGE)} →</a>` : '') +
    `<span class="sub">${esc(`${showing}${about} Page ${num(q.page)} of ${num(q.pages)}.`)}</span>` +
    '</div>'
  );
}

/**
 * The masthead's one live fact (fresh-eyes-design-review.md item 2): how many
 * undecided proposals nobody has been handed yet, read straight off the round
 * standing already fetched for "Who reads what" below — the same number
 * newArrivals() acts on, no second query. A reviewer's own screen has no
 * RoundStanding to read (it is scoped to one person's list, not the pile), so
 * there is nothing honest to say there, and this renders nothing.
 */
function readerFact(standing: RoundStanding | null): string {
  if (!standing) return '';
  const n = standing.unassigned;
  const said =
    n === 0
      ? 'Every undecided proposal has a reader.'
      : n === 1
        ? 'One proposal still needs a reader.'
        : `${num(n)} proposals still need a reader.`;
  return `<p class="livefact">${esc(said)}</p>`;
}

function queuePage(
  principal: Principal,
  ev: ReviewEvent,
  q: ReviewQueue,
  opts: {
    view: View;
    open: string | null;
    /** True when an ?open= link named something this queue does not hold. */
    openMissed: boolean;
    note: string | null;
    stepaside: string | null;
    /** The ?hand= card, when one was asked for: its proposal and its sentence. */
    hand: { target: HandTarget | null; said: string | null } | null;
    team: TeamReader[];
    /** The sentence the last act on the chair's half of the room left behind. */
    teamSaid: string | null;
    standing: RoundStanding | null;
    /** Every round up to this one, dates and all — null on a reviewer's own
     *  screen, which has no committee history to show. */
    history: RoundHistoryEntry[] | null;
    opening: boolean;
    nowMs: number;
  }
): string {
  const v = opts.view;
  const note = noteFor(opts.note ?? undefined);
  // The event's timezone is already in the footer of every backstage screen;
  // floating it into this counts line as well costs a phone a whole line and
  // says nothing twice.
  const round = esc(say('review.round', { n: num(q.round) }));
  // `#said` — where every save comes back to, with the staged band under it. A
  // deep link that named a proposal this queue does not hold says so in the
  // same place, because a link that lands nowhere is worse than one that lands
  // with an explanation.
  const missed = opts.openMissed
    ? ev.everything
      ? 'That proposal is not in this round’s queue. It has either been decided or was ' +
        'never sent in.'
      : 'That proposal is not on your list this round, so there is nothing here to score.'
    : null;
  const sentence = note ?? missed;
  const said = sentence
    ? `<div class="sec standing" id="said" role="status">${esc(sentence)}</div>`
    : '<span id="said"></span>';
  // The chair's control for one proposal. It renders only for the standing that
  // may hand work out, and only when the address asked for it.
  const hand =
    ev.everything && opts.hand
      ? handCard(ev, opts.team, opts.hand.target, v, opts.hand.said)
      : '';
  const team =
    ev.everything && opts.standing && opts.history
      ? whoReadsWhat(
          ev,
          opts.team,
          q.pile,
          opts.teamSaid,
          opts.standing,
          opts.history,
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
      `<p class="counts">${round}</p>` +
      readerFact(opts.standing) +
      '</div>' +
      said;

    // Three different silences, and they are not the same news. The chair's
    // means the committee is finished. A reviewer who was given a list and
    // read it out has a finished evening. A reviewer who was given nothing has
    // an evening that has not started — and none of the three may fall back to
    // the whole pile to fill the screen.
    const door = `<a class="btn btn-primary" href="/admin/${encodeURIComponent(ev.slug)}">See the program →</a>`;
    const results = ev.everything
      ? ` <a class="btn" href="${esc(resultsUrl(ev.slug))}">See the results table →</a>`
      : '';
    const thisRound = say('review.round', { n: num(q.round) }).toLowerCase();
    const empty = ev.everything
      ? '<div class="sec state-out"><h2>Nothing is waiting on the committee.</h2>' +
        '<p>Every proposal on this program has a decision. When the next call closes, ' +
        `what comes in lands here.</p>${door}${results}</div>`
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

    return shell(principal, ev, head + hand + empty + team);
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

  // Nothing on this page, and three different reasons for it: a search that
  // reaches nothing, an address asking for a page past the end, or a list that
  // is genuinely empty (handled above). Each one names its own way back.
  const list =
    q.rows.length > 0
      ? q.rows
          .map((r) => queueRow(r, ev, v, opts.open === r.id, opts.stepaside === r.id))
          .join('') + pager(ev, q, v)
      : q.matching === 0
        ? '<div class="sec state-out"><h2>Nothing here matches that.</h2>' +
          `<p>${esc(`No proposal on this list has “${v.q}” in its title.`)} ` +
          `${esc(blindHint(ev))}</p>` +
          `<a class="btn btn-primary" href="${esc(queueUrl(ev.slug))}">Back to the whole list →</a>` +
          '</div>'
        : '<div class="sec state-out"><h2>That page is past the end.</h2>' +
          `<p>${esc(`There ${q.pages === 1 ? 'is one page' : `are ${num(q.pages)} pages`} in this list.`)}</p>` +
          `<a class="btn btn-primary" href="${esc(queueUrl(ev.slug, { q: v.q || undefined }))}">` +
          'Back to the first page →</a></div>';

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

  // ABS-10/ABS-13: a chair should reach the aggregate table in one click from
  // the screen she is already on, not by finding it — so it sits beside the
  // heading rather than waiting at the foot of "Who reads what".
  const resultsLink = ev.everything
    ? `<a class="btn btn-primary" style="margin-top:14px" href="${esc(resultsUrl(ev.slug))}">` +
      'See the results table →</a>'
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
    readerFact(opts.standing) +
    whose +
    `<p class="hint">${esc(blindHint(ev))}</p>` +
    resultsLink +
    '</div>' +
    said;

  // The deck island turns this column of scorecard forms into one card at a
  // time with autosave; it self-activates only when there are two or more
  // editable forms, so a chair-only view or an empty queue is left exactly as
  // the server drew it. Scripts off, the column below is the honest whole.
  return shell(
    principal,
    ev,
    head + hand + staged + done + team + searchBar(ev, q, v) + list + `<script>${reviewDeckIsland}</script>`
  );
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
      const average = mean(ev.scorecard, s.scores);
      const marks = marksLine(ev.scorecard, s.scores);
      return (
        '<div style="padding:14px 18px;border-bottom:1px solid var(--line-soft)">' +
        `<div style="font-weight:640">${esc(s.title)}</div>` +
        (marks || average
          ? '<div class="sub" style="margin-top:4px">' +
            marks +
            (marks && average ? '<span class="sep"> · </span>' : '') +
            average +
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
      `<input type="hidden" name="round" value="${ev.round}">` +
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
 * The slice of the queue a form came back from. Same treatment as the query
 * string it was rendered from: a stranger's word until it is trimmed, folded
 * and counted, because a form field is as easy to hand-write as an address.
 */
function viewFrom(form: Record<string, unknown>): View {
  return {
    q: needleOf(typeof form['q'] === 'string' ? form['q'] : undefined),
    page: pageNumber(typeof form['p'] === 'string' ? form['p'] : undefined),
  };
}

/**
 * What came back off the card, checked line by line against the card itself.
 *
 * A scale keeps a whole number inside its own range; a select keeps a word
 * only if it is one of the words offered; a written line keeps what was
 * written, trimmed and capped. Anything else is dropped rather than stored,
 * so a hand-made form cannot put a mark on a line the committee never made.
 */
// Exported for mcp.ts's submit_review tool — a signed connection posts marks
// keyed the same way the reviewer's own form fields are, and this is the one
// place that shape is checked against the round's scorecard.
export function scoresFrom(form: Record<string, unknown>, card: ScorecardKey[]): Scores {
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

    const view: View = {
      q: needleOf(c.req.query('q')),
      page: pageNumber(c.req.query('p')),
    };
    const openId = (c.req.query('open') ?? '').trim();

    // A deep link arrives as an id and nothing else — a proposal's, or the id
    // of a review row on it — and the queue it points into is paged, so the id
    // alone is not an address. Turn it into one: the page holding that row,
    // with the row's own anchor on the end.
    //
    // THE REDIRECT CANNOT LOOP. It fires only when the address is not already
    // the canonical one — no page asked for, or the wrong page asked for — and
    // what it sends back always names the right page, so the second request
    // renders. Every ?open= link this file writes already carries its page.
    let openMissed = false;
    if (openId) {
      const asked = c.req.query('p');
      let spot = await queuePosition(c.env.DB, principal, ev, openId, view.q);
      // Searched down to a page that does not hold it: the proposal wins over
      // the search, and the address comes back without one.
      const dropSearch = spot === null && view.q !== '';
      if (dropSearch) spot = await queuePosition(c.env.DB, principal, ev, openId, '');
      if (spot === null) {
        openMissed = true;
      } else if (dropSearch || asked === undefined || spot.page !== view.page) {
        return c.redirect(
          queueUrl(ev.slug, {
            q: dropSearch ? undefined : view.q || undefined,
            p: spot.page,
            open: spot.submissionId,
          }) + `#p-${encodeURIComponent(spot.submissionId)}`,
          303
        );
      }
    }

    // The team read, the round read and the one-proposal card only happen for
    // the standing that may hand work out, so a reviewer's screen costs what it
    // costed before.
    const handAsked = ev.everything ? (c.req.query('hand') ?? '').trim() : '';
    const [q, team, standing, history, target] = await Promise.all([
      reviewQueue(c.env.DB, principal, ev, { page: view.page, q: view.q }),
      ev.everything ? reviewTeam(c.env.DB, principal, ev) : Promise.resolve([]),
      ev.everything ? roundStanding(c.env.DB, principal, ev) : Promise.resolve(null),
      ev.everything ? roundHistory(c.env.DB, principal, ev) : Promise.resolve(null),
      handAsked ? handTarget(c.env.DB, principal, ev, handAsked) : Promise.resolve(null),
    ]);

    // One act happened, so one sentence comes back. Each code is checked
    // against its own closed set before it is allowed to mean anything.
    const did = ev.everything ? assignCode(c.req.query('did')) : null;
    const rnd = ev.everything ? roundCode(c.req.query('round')) : null;
    const rop = ev.everything ? reopenCode(c.req.query('reopen')) : null;
    const rc = ev.everything ? roundConfigCode(c.req.query('rc')) : null;
    const nudged = ev.everything ? nudgeCode(c.req.query('nudged')) : null;
    // A name off the address bar would be a stranger's word. This one is
    // matched back to the committee the screen already read — the nudge and the
    // one-proposal hand both name a reader, and both name them this way.
    const whoAsked = c.req.query('who');
    const whoName = team.find((r) => r.personId === whoAsked)?.name ?? 'That reader';
    const handed = ev.everything ? handCode(c.req.query('handed')) : null;

    return c.html(
      queuePage(principal, ev, q, {
        view,
        open: openId || null,
        openMissed,
        note: c.req.query('note') ?? null,
        stepaside: c.req.query('stepaside') ?? null,
        hand: handAsked ? { target, said: handed ? handSaid(handed, whoName) : null } : null,
        team,
        standing,
        history,
        opening: ev.everything && c.req.query('open_round') === String(ev.round + 1),
        nowMs: Date.now(),
        teamSaid: did
          ? assignSaid(did, tally(c.req.query('gave')), tally(c.req.query('held')), c.req.query('more') === '1')
          : rnd
            ? roundSaid(rnd, ev.round)
            : rop
              ? reopenSaid(rop, ev.round)
              : rc
                ? roundConfigSaid(rc)
                : nudged
                  ? nudgeSaid(nudged, whoName, tally(c.req.query('open_left')))
                  : null,
      })
    );
  });

  // ABS-10 — the committee's own aggregate, sortable. Decider-only, the same
  // standing that hands the pile out: an aggregate is committee business.
  app.get('/admin/:eventSlug/reviews/results', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;
    if (!ev.everything) {
      return new Response(deniedPage('The results table is the committee&#39;s to read.'), {
        status: 403,
        headers: HTML,
      });
    }
    c.header('cache-control', 'private, no-store');
    const sort: ResultsSort = c.req.query('sort') === 'asc' ? 'asc' : 'desc';
    try {
      const results = await reviewResults(c.env.DB, principal, ev);
      return c.html(resultsPage(principal, ev, results, sort));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // ABS-13 — the same table, honouring the same ?sort=, as a file rather than
  // a screen. No ROOM ceiling here: a download is read somewhere else, later,
  // with nothing left on the page to page through.
  app.get('/admin/:eventSlug/reviews/results.csv', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;
    if (!ev.everything) {
      return new Response(deniedPage('The results table is the committee&#39;s to read.'), {
        status: 403,
        headers: HTML,
      });
    }
    const sort: ResultsSort = c.req.query('sort') === 'asc' ? 'asc' : 'desc';
    try {
      const results = await reviewResults(c.env.DB, principal, ev);
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="${ev.slug}-review-results.csv"`);
      c.header('cache-control', 'private, no-store');
      return c.body(resultsCsv(ev, results, sort));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // ONE CLICK — hers, and hers to overwrite. Nothing leaves the building.
  app.post('/admin/:eventSlug/reviews/stage', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const view = viewFrom(form);
    const on = typeof form['on'] === 'string' ? form['on'] : '';
    if (!on) return c.redirect(backTo(ev.slug, 'moved', view), 303);
    // A form rendered under one round never writes into another (a tab left
    // open across a reopen): the round it carried must be the round we're on.
    if (staleRound(form, ev.round)) {
      return c.req.header('x-fireside-deck') === '1'
        ? c.body('moved', 409)
        : c.redirect(backTo(ev.slug, 'moved', view), 303);
    }

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
    // The deck saves each card in the background as the reviewer scores it, so
    // its post gets a bare 204 rather than the whole queue back. Every other
    // caller (scripts off, the Save button) still gets the redirect it expects.
    if (c.req.header('x-fireside-deck') === '1') {
      // 'saved'/'noted' staged a mark or a note; 'blank' means there was
      // nothing to stage, which is not an error. Anything else (locked, gone,
      // moved) is a real conflict the deck should not paper over.
      return outcome === 'saved' || outcome === 'noted' || outcome === 'blank'
        ? c.body(null, 204)
        : c.body(outcome, 409);
    }
    return c.redirect(backTo(ev.slug, outcome, view), 303);
  });

  // ONE CONFIRM, AND IT DOES NOT COME BACK. The link put the sentence on the
  // screen with the title in it; this is the press underneath it.
  app.post('/admin/:eventSlug/reviews/step-aside', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const view = viewFrom(form);
    const on = typeof form['on'] === 'string' ? form['on'] : '';
    if (staleRound(form, ev.round)) return c.redirect(backTo(ev.slug, 'moved', view), 303);
    const outcome = await stepAside(c.env.DB, principal, ev.id, ev.round, on);
    return c.redirect(backTo(ev.slug, `aside_${outcome}`, view), 303);
  });

  // SECOND PASS — the number the reviewer read rides in the form, and the
  // guard in submitReviews refuses the batch if the list moved since.
  app.post('/admin/:eventSlug/reviews/submit', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    if (staleRound(form, ev.round)) return c.redirect(backTo(ev.slug, 'moved', HERE), 303);
    const expected = Number.parseInt(
      typeof form['expected'] === 'string' ? form['expected'] : '',
      10
    );
    const res = await submitReviews(c.env.DB, principal, ev.id, ev.round, expected);
    // Submitting empties the top of the list, so it comes back to the first
    // page of it: the rows she was reading are the ones that just went.
    return c.redirect(backTo(ev.slug, res.outcome, HERE), 303);
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

  // ONE PROPOSAL TO ONE READER — the act ?hand= opens, and the answer to a
  // late arrival that is on nobody's list. It comes back to the same card so a
  // chair can hand the same proposal to a second reader without finding it
  // again, and the card carries the sentence for what just happened.
  app.post('/admin/:eventSlug/reviews/hand-one', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const view = viewFrom(form);
    const on = typeof form['on'] === 'string' ? form['on'] : '';
    const who = typeof form['who'] === 'string' ? form['who'] : '';

    try {
      const outcome = await handToReviewer(c.env.DB, principal, ev.id, ev.round, on, who);
      return c.redirect(
        handUrl(ev.slug, {
          ...seen(view),
          hand: on || undefined,
          handed: outcome,
          who: who || undefined,
        }),
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Handing this proposal out is not yours to do.'), {
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
    // The round about to open can be named and dated in the same confirm —
    // ABS-S2's "Final Review" is this form's own fields, not a second trip
    // through settings afterwards.
    const config: RoundConfigInput = {
      name: typeof form['name'] === 'string' ? form['name'] : '',
      opensOn: typeof form['opens'] === 'string' ? form['opens'] : '',
      closesOn: typeof form['closes'] === 'string' ? form['closes'] : '',
      blind: form['blind'] === '1',
    };

    try {
      const outcome = await openNextRound(c.env.DB, principal, ev.id, from, to, config);
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

  // REOPENING AN EARLIER ROUND (T603) — the workflow itself refuses when the
  // current round holds submitted work, so the button's honesty lives in one
  // place and a crafted POST is told the same sentence as the screen.
  app.post('/admin/:eventSlug/reviews/reopen-round', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const from = Number.parseInt(typeof form['from'] === 'string' ? form['from'] : '', 10);
    const to = Number.parseInt(typeof form['to'] === 'string' ? form['to'] : '', 10);

    try {
      const outcome = await reopenRound(c.env.DB, principal, ev.id, from, to);
      return c.redirect(teamUrl(ev.slug, { reopen: outcome }), 303);
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Reopening a round is not yours to do.'), {
          status: 403,
          headers: HTML,
        });
      }
      throw e;
    }
  });

  // NAMING A ROUND — one confirm, since it binds nobody's letter and moves no
  // decision: the current round's own facts, or (from the confirm above) the
  // round about to open.
  app.post('/admin/:eventSlug/reviews/round-config', async (c) => {
    const slug = c.req.param('eventSlug');
    const opened = await enter(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'), slug);
    if (opened instanceof Response) return opened;
    const { principal, ev } = opened;

    const form = await c.req.parseBody();
    const round = Number.parseInt(typeof form['round'] === 'string' ? form['round'] : '', 10);
    const input: RoundConfigInput = {
      name: typeof form['name'] === 'string' ? form['name'] : '',
      opensOn: typeof form['opens'] === 'string' ? form['opens'] : '',
      closesOn: typeof form['closes'] === 'string' ? form['closes'] : '',
      blind: form['blind'] === '1',
    };

    try {
      const outcome = await saveRoundConfig(c.env.DB, principal, ev.id, round, input);
      return c.redirect(teamUrl(ev.slug, { rc: outcome }), 303);
    } catch (e) {
      if (e instanceof ScopeError) {
        return new Response(deniedPage('Naming a round is not yours to do.'), {
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
