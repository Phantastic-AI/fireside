// S-13 — the pile. Every proposal on one screen, and the counts true.
//
// This is Naomi's longest hour. Six hundred and ninety-eight proposals came in
// through the call; she reads them in stolen half-hours at 07:10 and 23:40, and
// the only question the screen has to answer is "what needs me?". So:
//
//   The filter chips ARE the counts. There is no separate tally to disagree
//   with the list — pile() derives both from one predicate in one pass, and a
//   search narrows both together. A count that lies once costs Naomi her trust
//   in every count forever (11-hats.md).
//
//   Deciding is one click, because a decision goes nowhere when it is made.
//   stageDecision writes the state and stages the letter; nothing leaves the
//   building until somebody releases it from the outbox. That is D-024's first
//   half — one click for what only you can see and can undo — and it is why
//   there is no "are you sure" between Naomi and the Accept button.
//
//   Nothing here needs JavaScript. The checkboxes are checkboxes, the buttons
//   submit a form, the search is a GET. The island adds j/k/x/Enter on top,
//   because the keyboard is respect for someone reading six hundred of these.
//
// Register: backstage. Plain speech, counts, working labels, sentence case.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, decidedNotToldPill, FORMAT_KEY, LEVEL_KEY, type LabelKey } from '../../lib/labels';
import {
  adminEvents,
  pile,
  ScopeError,
  type AdminEvent,
  type Pile,
  type PileFilter,
  type PileRow,
  type SubmissionState,
} from '../../queries/admin';
import { initialsOf } from '../../queries/public';
import { reviewerOnly } from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { requireDecider, stageDecision, type Decision } from '../../workflows/decide';
// The island is hand-written browser JS, deliberately outside the TypeScript
// program (tsconfig has no allowJs, and types.d.ts declares only '*.css') —
// same convention as cfp.js.
// @ts-ignore -- plain-JS island; see the parcel report for the durable fix.
import pileIsland from '../../islands/pile.js';

/* ------------------------------------------------------------------ *
 * Shape of the screen
 * ------------------------------------------------------------------ */

/** Rows drawn at once. The counts above them are always the whole truth. */
const ROOM = 200;
/** One decision per proposal is two reads of the database; this is the ceiling. */
const BATCH = 200;
const NOTE_MAX = 400;
const SEARCH_MAX = 120;

const num = (n: number): string => n.toLocaleString('en-US');

/* ------------------------------------------------------------------ *
 * Words. Every state word comes out of the label map; the only thing this
 * file decides is grammar (lowercase inside a sentence, plural beside a
 * count) — 02 §6 owns the word itself.
 * ------------------------------------------------------------------ */

const STATE_KEY: Record<SubmissionState, LabelKey> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};

/** The chip skins the lifted CSS already carries, one per state. */
const CHIP: Record<SubmissionState, string> = {
  draft: 's-draft',
  submitted: 's-undecided',
  accepted: 's-accepted',
  waitlisted: 's-maybe',
  rejected: 's-declined',
  withdrawn: 's-withdrawn',
  // A talk that came off the program is still on the agenda until somebody
  // takes it off, so it reads as something that wants attention.
  cancelled: 'warn',
};

const word = (s: SubmissionState): string => label(STATE_KEY[s], 'backstage');

/** The filter chips, in the order a decision gets made. */
const CHIPS: PileFilter[] = [
  'all',
  'undecided',
  'maybe',
  'accepted',
  'declined',
  'drafts',
  'withdrawn',
];

function chipWord(f: PileFilter): string {
  switch (f) {
    case 'all':
      return 'All';
    case 'undecided':
      return word('submitted');
    case 'maybe':
      return word('waitlisted');
    case 'accepted':
      return word('accepted');
    case 'declined':
      return word('rejected');
    case 'withdrawn':
      return word('withdrawn');
    // The chip sits beside a count, so the label map's word takes the plural
    // the same way "{n} days" takes it — the word is still the map's.
    case 'drafts':
      return `${word('draft')}s`;
  }
}

/**
 * What ?f= accepts. The stored state names are taken as well as the filter's
 * own, so a link written from either vocabulary lands on the right chip.
 */
const FROM_QUERY: Record<string, PileFilter> = {
  all: 'all',
  undecided: 'undecided',
  submitted: 'undecided',
  maybe: 'maybe',
  waitlisted: 'maybe',
  accepted: 'accepted',
  declined: 'declined',
  rejected: 'declined',
  drafts: 'drafts',
  draft: 'drafts',
  withdrawn: 'withdrawn',
};

/** Why a chip came back with nothing behind it — one sentence per chip. */
function emptyWhy(f: PileFilter): string {
  switch (f) {
    case 'all':
      return 'Nothing has come through the call yet.';
    case 'drafts':
      return 'Nobody is part-way through writing one.';
    case 'withdrawn':
      return 'Nobody has taken a proposal back.';
    case 'undecided':
      return 'Nobody is waiting on you.';
    case 'maybe':
      return `Nothing is holding at ${word('waitlisted').toLowerCase()}.`;
    case 'accepted':
      return `Nothing is ${word('accepted').toLowerCase()} yet.`;
    case 'declined':
      return `Nothing has been ${word('rejected').toLowerCase()}.`;
  }
}

/** Which rows a decision is open on at all — the rest cannot be bulk-decided. */
const DECIDABLE = new Set<SubmissionState>(['submitted', 'waitlisted', 'accepted']);
/** Where one click of Accept makes sense on the row itself. */
const ACCEPTABLE = new Set<SubmissionState>(['submitted', 'waitlisted']);

const DECISIONS = new Set<string>(['accepted', 'waitlisted', 'rejected']);

/* ------------------------------------------------------------------ *
 * The review average — one extra prepared read, not owned by pile()
 * ------------------------------------------------------------------ *
 * queries/admin.ts's pile() belongs to a sibling and stays untouched. Its
 * `score` column is the chair's own stored number (schema/0001_init.sql:
 * "the chair's own call; averages derive") — a different fact from what the
 * committee actually scored, and (ABS-6) the two disagreed on screen: the
 * rail read a sum, "What the committee scored" read an average. This reads
 * the same submitted-review scores that section does, so every surface says
 * the one number: a review's own average is the mean of its scorecard's
 * numeric values, a submission's is the mean of its reviewers' averages. A
 * review with an empty scorecard still counts toward review_count — SQLite's
 * AVG skips the NULL it leaves behind, so the count never hides a committee
 * that opened the form and scored nothing.
 */

type ReviewAverage = { average: number | null; count: number };

/** D1 caps bound parameters well below a whole conference, so any id-list
 *  read walks in modest chunks. The page never notices; the CSV did. */
const ID_CHUNK = 80;
function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function reviewAverages(db: D1Database, ids: string[]): Promise<Map<string, ReviewAverage>> {
  const out = new Map<string, ReviewAverage>();
  if (ids.length === 0) return out;
  for (const group of chunks(ids, ID_CHUNK)) {
  const placeholders = group.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT submission_id, AVG(review_avg) AS average, COUNT(*) AS n
       FROM (
         SELECT rv.submission_id AS submission_id,
                (SELECT AVG(CAST(je.value AS REAL))
                 FROM json_each(CASE WHEN json_valid(rv.scores) THEN rv.scores ELSE '{}' END) je) AS review_avg
         FROM review rv
         WHERE rv.submitted_at IS NOT NULL AND rv.submission_id IN (${placeholders})
       ) sub
       GROUP BY submission_id`
    )
    .bind(...group)
    .all<{ submission_id: string; average: number | null; n: number }>();
  for (const r of res.results ?? []) {
    out.set(r.submission_id, { average: r.average, count: r.n });
  }
  }
  return out;
}

/** decision_version and the submitter's own address — CSV-only facts pile()
 *  does not carry (it shows a byline, not an address book). Same submitter
 *  ordering pile() uses for its byline, so the two never name different
 *  people for the same row. */
type SubmitterFacts = { decisionVersion: number; email: string | null };

async function submitterFacts(db: D1Database, ids: string[]): Promise<Map<string, SubmitterFacts>> {
  const out = new Map<string, SubmitterFacts>();
  if (ids.length === 0) return out;
  for (const group of chunks(ids, ID_CHUNK)) {
  const placeholders = group.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT s.id AS submission_id, s.decision_version AS decision_version,
              (SELECT pe.email FROM participation pa JOIN person pe ON pe.id = pa.person_id
               WHERE pa.submission_id = s.id
               ORDER BY pa.is_submitter DESC, pa.position, pe.name LIMIT 1) AS submitter_email
       FROM submission s
       WHERE s.id IN (${placeholders})`
    )
    .bind(...group)
    .all<{ submission_id: string; decision_version: number; submitter_email: string | null }>();
  for (const r of res.results ?? []) {
    out.set(r.submission_id, { decisionVersion: r.decision_version, email: r.submitter_email });
  }
  }
  return out;
}

/** One decimal, and no trailing '.0' — the same rule proposal.ts's own
 *  oneDecimal uses, so the number reads the same on both screens. */
function oneDecimal(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** RFC 4180: a field is quoted, its own quotes doubled, whenever it holds a
 *  comma, a quote or a line break — a title is free to hold any of the three. */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

type Say = (ms: number | null) => string;

/** A date, short, in the conference's own timezone. One formatter per render. */
function dateSayer(timezone: string): Say {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
  });
  return (ms) => (ms === null ? '' : fmt.format(new Date(ms)));
}

function byline(r: PileRow): string {
  if (!r.speaker) return 'No name on it yet';
  if (r.speakerCount <= 1) return r.speaker;
  const others = r.speakerCount - 1;
  return `${r.speaker} with ${others === 1 ? 'one' : num(others)} more`;
}

/** The stored format words are already words; the map gives them their own. */
function formatWord(stored: string): string {
  const key = FORMAT_KEY[stored];
  return key ? label(key, 'backstage') : stored;
}

/**
 * The sentence under the chip. The chip is short; this line does the work,
 * and it is written to answer "does this proposal need me?" without a second look.
 * Not-told is deliberately absent here — the chip beside it says that.
 */
function standing(r: PileRow, say: Say): string {
  const told =
    r.notifiedAt !== null
      ? ` ${label('submission.told', 'backstage').replace('{date}', say(r.notifiedAt))}.`
      : '';
  const on = (verb: string) =>
    r.decidedAt !== null ? `${verb} ${say(r.decidedAt)}.` : `${verb}.`;

  switch (r.state) {
    case 'draft':
      return 'Not sent. Only the person writing it can see what is in it.';
    case 'submitted':
      return 'Waiting on you. Nobody has decided on this proposal.';
    case 'accepted':
      return on(word('accepted')) + told + (r.startsAt === null ? ' Not scheduled.' : '');
    case 'waitlisted':
      return on(word('waitlisted')) + told + ' Not scheduled.';
    case 'rejected':
      return on(word('rejected')) + told;
    case 'withdrawn':
      return 'Taken back by the speaker. Nothing is owed here.';
    case 'cancelled':
      return 'Came off the program, and stays on the agenda until you take it off.';
  }
}

function trackChip(r: PileRow): string {
  if (!r.track) return '';
  const tint = /^#[0-9a-fA-F]{6}$/.test(r.track.colour)
    ? ` style="--tc:${esc(r.track.colour)}"`
    : '';
  return `<span class="tk"${tint}>${esc(r.track.name)}</span>`;
}

function row(r: PileRow, base: string, say: Say, canDecide: boolean, scored: ReviewAverage | undefined): string {
  const title = r.title.trim() || 'Untitled draft';
  const open = `${base}/${esc(r.id)}`;
  const dot = '<span>·</span>';

  const pick =
    canDecide && DECIDABLE.has(r.state)
      ? `<input class="pick" type="checkbox" name="id" value="${esc(r.id)}" ` +
        `aria-label="Choose ${esc(title)}">`
      : '<span></span>';

  const when =
    r.submittedAt !== null
      ? `<span>${esc(say(r.submittedAt))}</span>`
      : '<span>Not sent yet</span>';

  // The average of the committee's submitted reviews — the one number this
  // screen, the proposal's own body, and the CSV all agree on (ABS-6).
  const score =
    scored && scored.average !== null
      ? `<span class="score" title="Average of ${num(scored.count)} submitted ${scored.count === 1 ? 'review' : 'reviews'}">${esc(oneDecimal(scored.average))}</span>`
      : `<a class="link" style="font-size:13.5px" href="${open}">Score it</a>`;

  const act =
    canDecide && ACCEPTABLE.has(r.state)
      ? `<button class="btn btn-sm btn-primary" type="submit" name="one" ` +
        `value="accepted:${esc(r.id)}">Accept</button>`
      : `<a class="btn btn-sm" href="${open}">Open</a>`;

  return (
    `<div class="prow" data-row="${esc(r.id)}">` +
    pick +
    '<div>' +
    `<h3><a href="${open}">${esc(title)}</a></h3>` +
    '<div class="pby">' +
    `<span>${esc(byline(r))}</span>` +
    (r.track ? dot + trackChip(r) : '') +
    dot +
    `<span>${esc(formatWord(r.format))}</span>` +
    dot +
    when +
    '</div>' +
    '<div class="pstate">' +
    `<span class="chip ${CHIP[r.state]}">${esc(word(r.state))}</span>` +
    `<span>${esc(standing(r, say))}</span>` +
    (r.decidedNotTold
      ? `<span class="chip notold">${esc(label('submission.decided_not_told', 'backstage'))}</span>`
      : '') +
    '</div>' +
    '</div>' +
    `<div class="pacts">${score}${act}</div>` +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * What came back from a decision — one sentence, from a closed set.
 * ------------------------------------------------------------------ */

function outcome(done: number, held: number, base: string): string {
  let line: string;
  if (done === 0 && held === 0) {
    line = 'Nothing was chosen, so nothing changed.';
  } else if (held === 0) {
    line =
      `${num(done)} staged. Nothing has gone out — the letters are waiting in the outbox.`;
  } else if (done === 0) {
    line = `${num(held)} held — someone else got there first. Nothing changed.`;
  } else {
    line = `${num(done)} staged. ${num(held)} held — someone else got there first.`;
  }
  const door =
    done > 0
      ? ` <a class="link" href="${base.replace(/\/submissions$/, '')}/outbox">Read the letters →</a>`
      : '';
  return `<div class="standing" role="status" style="margin-top:16px">${esc(line)}${door}</div>`;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

function pilePage(o: {
  ev: AdminEvent;
  p: Pile;
  principal: Principal;
  canDecide: boolean;
  told: string | null;
  scores: Map<string, ReviewAverage>;
  sortByScore: boolean;
}): string {
  const { ev, p } = o;
  const base = `/admin/${esc(ev.slug)}/submissions`;
  const say = dateSayer(ev.timezone);
  const search = p.search;
  const filterBits: string[] = [];
  if (p.filter !== 'all') filterBits.push(`f=${p.filter}`);
  if (search) filterBits.push(`q=${encodeURIComponent(search)}`);
  const qs = (f: PileFilter): string => {
    const bits: string[] = [];
    if (f !== 'all') bits.push(`f=${f}`);
    if (search) bits.push(`q=${encodeURIComponent(search)}`);
    return bits.length ? `${base}?${bits.join('&')}` : base;
  };
  // The sort control and the CSV link both carry the same filter and search
  // every other link on this screen does — one adds a param, the other a suffix.
  const scoreSortHref = `${base}?${[...filterBits, 'sort=score'].join('&')}`;
  const csvHref = filterBits.length ? `${base}.csv?${filterBits.join('&')}` : `${base}.csv`;

  // Counts. Every one of these comes off the list behind it: the header and
  // the chips read the same pass, so they cannot drift, and a search narrows
  // both together.
  const sep = '<span class="sep">·</span>';
  const headline = search
    ? `<b>${num(p.counts.all)} ${p.counts.all === 1 ? 'proposal matches' : 'proposals match'} ` +
      `“${esc(search)}”</b>`
    : `<b>${num(p.counts.all)} ${p.counts.all === 1 ? 'proposal' : 'proposals'}</b>`;
  const counts =
    '<p class="counts">' +
    headline +
    sep +
    `${num(p.counts.accepted)} ${word('accepted').toLowerCase()}` +
    sep +
    `${num(p.counts.maybe)} ${word('waitlisted').toLowerCase()}` +
    sep +
    `${num(p.counts.declined)} ${word('rejected').toLowerCase()}` +
    sep +
    `${num(p.counts.undecided)} ${word('submitted').toLowerCase()}` +
    `<span style="float:right;color:var(--muted)">${esc(ev.tzLabel ?? ev.timezone)}</span>` +
    '</p>';

  // The door to the outbox. Its number is the event's own, never the search's:
  // it is the same count the outbox will show when she gets there.
  const band =
    ev.counts.decidedNotTold > 0
      ? '<div class="sec attn"><div>' +
        `<div class="lab">${esc(decidedNotToldPill(ev.counts.decidedNotTold))}</div>` +
        '<div class="why">Nothing has gone out. Read them before they do.</div></div>' +
        `<a class="btn btn-primary go" href="/admin/${esc(ev.slug)}/outbox">Read the letters →</a>` +
        '</div>'
      : '';

  const chips = CHIPS.map((f) => {
    const n = p.counts[f];
    return (
      `<a class="fchip" href="${qs(f)}" aria-pressed="${f === p.filter}">` +
      `${esc(chipWord(f))} <span class="num" style="opacity:.65">${num(n)}</span></a>`
    );
  }).join('');

  const searchbar =
    '<div class="searchbar">' +
    `<form method="get" action="${base}" style="display:contents">` +
    (p.filter === 'all' ? '' : `<input type="hidden" name="f" value="${p.filter}">`) +
    `<input type="text" name="q" value="${esc(search ?? '')}" maxlength="${SEARCH_MAX}" ` +
    'placeholder="Search titles and speakers" aria-label="Search titles and speakers">' +
    '<button class="btn" type="submit">Search</button>' +
    '</form>' +
    (search ? `<a class="link" href="${qs(p.filter)}">Clear the search</a>` : '') +
    `<div class="filters scrollx" style="margin:0">${chips}</div>` +
    '</div>';

  const csvLink =
    `<p class="sub" style="margin:8px 0 0"><a class="link" href="${csvHref}">Download these as CSV</a></p>`;

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Proposals</h1>' +
    counts +
    '</div>' +
    band +
    (o.told ?? '') +
    searchbar +
    csvLink;

  let body: string;

  if (p.rows.length === 0) {
    // Never a bare zero: say why it is empty, then name the next thing and
    // open the door to it.
    const nothingAtAll = ev.counts.proposals === 0 && p.counts.drafts === 0;
    // The tail only speaks when it adds something she does not already know.
    const tail =
      ev.counts.undecided > 0
        ? ` ${num(ev.counts.undecided)} ${ev.counts.undecided === 1 ? 'is' : 'are'} ` +
          `still ${esc(word('submitted').toLowerCase())}.`
        : ev.counts.proposals > 0
          ? ' Every proposal has an answer.'
          : '';
    const door =
      search || p.filter !== 'all'
        ? `<a class="btn btn-primary" href="${base}">Show all proposals →</a>`
        : `<a class="btn btn-primary" href="${qs('drafts')}">See what is part-written →</a>`;
    const card = nothingAtAll
      ? '<div class="sec state-out"><h2>No proposals yet.</h2>' +
        '<p>They arrive through the call for speakers. Send people to it and the first ' +
        'one turns up here.</p>' +
        `<a class="btn btn-primary" href="/${esc(ev.slug)}/cfp">See the public call →</a></div>`
      : '<div class="sec state-out"><h2>Nothing here.</h2>' +
        '<p>' +
        (search ? `No proposal matches “${esc(search)}”.` : esc(emptyWhy(p.filter))) +
        tail +
        '</p>' +
        door +
        '</div>';
    body = head + card;
  } else {
    // ?sort=score reorders the page already fetched — it does not requery.
    // Unscored rows sort to the bottom; ties (including two unscored rows)
    // break on the title, so the order stays reproducible without a second
    // sort key riding along in the query string.
    const shown = o.sortByScore
      ? [...p.rows].sort((a, b) => {
          const sa = o.scores.get(a.id)?.average ?? null;
          const sb = o.scores.get(b.id)?.average ?? null;
          if (sa === null && sb === null) return a.title.localeCompare(b.title);
          if (sa === null) return 1;
          if (sb === null) return -1;
          return sb !== sa ? sb - sa : a.title.localeCompare(b.title);
        })
      : p.rows;

    const anyScored = p.rows.some((r) => (o.scores.get(r.id)?.count ?? 0) > 0);
    const scoreColumnHead = anyScored
      ? '<div style="display:flex;justify-content:flex-end;padding:0 6px 6px">' +
        `<a class="link" style="font-size:13px" href="${scoreSortHref}" ` +
        `aria-current="${o.sortByScore}">Score ↓</a></div>`
      : '';

    const rows = shown.map((r) => row(r, base, say, o.canDecide, o.scores.get(r.id))).join('');
    const more =
      p.rows.length >= ROOM && p.counts[p.filter] > p.rows.length
        ? `<p class="sub" style="margin-top:12px">The newest ${num(p.rows.length)} of ` +
          `${num(p.counts[p.filter])} are on this page. Search a title or a name to reach the rest.</p>`
        : '';

    // The action bar is always here, not conjured by a selection: without it
    // the checkboxes would be a promise the screen could not keep with the
    // keyboard off.
    const bar = o.canDecide
      ? '<div class="bulkbar">' +
        '<b data-chosen>Nothing chosen yet</b>' +
        '<button class="btn btn-sm btn-primary" type="submit" name="decision" value="accepted">Accept</button>' +
        `<button class="btn btn-sm" type="submit" name="decision" value="waitlisted">${esc(word('waitlisted'))}</button>` +
        '<button class="btn btn-sm" type="submit" name="decision" value="rejected">Decline</button>' +
        `<textarea name="note" rows="1" maxlength="${NOTE_MAX}" ` +
        'placeholder="A line to go with it, in your own words (optional)" ' +
        'aria-label="A line to go with it, in your own words" ' +
        'style="flex:1;min-width:190px;resize:vertical"></textarea>' +
        `<span class="sub">Nothing goes out until you send it from the ` +
        `<a class="link" href="/admin/${esc(ev.slug)}/outbox">outbox</a>.</span>` +
        '<span class="kbdhints"><kbd>x</kbd> choose <kbd>Esc</kbd> let go of them all</span></div>'
      : '';

    body =
      head +
      `<form method="post" action="${base}/decide" data-pile>` +
      `<input type="hidden" name="f" value="${p.filter}">` +
      `<input type="hidden" name="q" value="${esc(search ?? '')}">` +
      scoreColumnHead +
      `<div class="card" style="margin-top:${anyScored ? '0' : '14px'};overflow:hidden">` +
      rows +
      '</div>' +
      more +
      bar +
      '</form>' +
      (o.canDecide
        ? '<p class="sub" style="margin-top:14px;display:flex;gap:14px;flex-wrap:wrap">' +
          '<span><kbd>j</kbd> <kbd>k</kbd> move</span><span><kbd>x</kbd> choose</span>' +
          '<span><kbd>Enter</kbd> open</span></p>'
        : '');
  }

  return page({
    title: `Proposals — ${ev.name}`,
    register: 'backstage',
    body:
      backstageShell({
        eventSlug: ev.slug,
        eventName: ev.name,
        here: '/submissions',
        who: o.principal.name,
        whoInitials: initialsOf(o.principal.name),
        tzLabel: ev.tzLabel ?? ev.timezone,
        body,
      }) + `<script>${String(pileIsland)}</script>`,
  });
}

/* ------------------------------------------------------------------ *
 * Reading the request
 * ------------------------------------------------------------------ */

function filterOf(raw: string | undefined): PileFilter {
  return FROM_QUERY[(raw ?? '').trim().toLowerCase()] ?? 'all';
}

function searchOf(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim().slice(0, SEARCH_MAX);
  return s === '' ? undefined : s;
}

/** A count that came back on the query string. Anything else is nothing. */
function tally(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, BATCH) : 0;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Where to send her back to, with the same list under her hands. */
function backTo(slug: string, filter: PileFilter, search: string | undefined, done: number, held: number): string {
  const bits = [`done=${done}`, `held=${held}`];
  if (filter !== 'all') bits.unshift(`f=${filter}`);
  if (search) bits.unshift(`q=${encodeURIComponent(search)}`);
  return `/admin/${encodeURIComponent(slug)}/submissions?${bits.join('&')}`;
}

/* ------------------------------------------------------------------ *
 * Routes
 *
 * Somebody whose standing here is 'reviewer' holds the reading room and
 * nothing else, so this whole file is shut to them in the same words a
 * stranger gets. The check is at each door rather than left to the scope sets
 * in queries/admin.ts, because this screen carries names and employers and a
 * blind round is only blind while that stays true.
 * ------------------------------------------------------------------ */

export function registerPile(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/submissions', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === c.req.param('eventSlug'));
      if (!ev) return c.html(deniedPage(), 403);
      if (reviewerOnly(principal, ev.id)) return c.html(deniedPage(), 403);

      const filter = filterOf(c.req.query('f'));
      const search = searchOf(c.req.query('q'));
      const p = await pile(c.env.DB, principal, ev.id, filter, { search, limit: ROOM });
      const scores = await reviewAverages(c.env.DB, p.rows.map((r) => r.id));

      const done = tally(c.req.query('done'));
      const held = tally(c.req.query('held'));
      const said = c.req.query('done') !== undefined || c.req.query('held') !== undefined;

      // One sentence for what just happened, where the eye already is: under
      // the counts, beside the band.
      const base = `/admin/${esc(ev.slug)}/submissions`;
      return c.html(
        pilePage({
          ev,
          p,
          principal,
          canDecide: ['organizer', 'owner', 'approver'].includes(ev.standing),
          told: said ? outcome(done, held, base) : null,
          scores,
          sortByScore: c.req.query('sort') === 'score',
        })
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // ABS-13: the same list, honouring the same ?f= and ?q=, as a file rather
  // than a screen. No ROOM ceiling here — a download is read somewhere else,
  // later, with nothing left on the page to page through.
  app.get('/admin/:eventSlug/submissions.csv', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === c.req.param('eventSlug'));
      if (!ev) return c.html(deniedPage(), 403);
      if (reviewerOnly(principal, ev.id)) return c.html(deniedPage(), 403);

      const filter = filterOf(c.req.query('f'));
      const search = searchOf(c.req.query('q'));
      const p = await pile(c.env.DB, principal, ev.id, filter, { search });
      const ids = p.rows.map((r) => r.id);
      const [scores, facts] = await Promise.all([
        reviewAverages(c.env.DB, ids),
        submitterFacts(c.env.DB, ids),
      ]);

      const header = [
        'title',
        'submitter',
        'email',
        'track',
        'format',
        'level',
        'state',
        'decision_version',
        'review_average',
        'review_count',
        'submitted_at',
      ];
      const lines = [header.map(csvField).join(',')];
      for (const r of p.rows) {
        const sc = scores.get(r.id);
        const inf = facts.get(r.id);
        const levelKey = r.level ? LEVEL_KEY[r.level] : undefined;
        const level = levelKey ? label(levelKey, 'backstage') : (r.level ?? '');
        lines.push(
          [
            r.title,
            r.speaker ?? '',
            inf?.email ?? '',
            r.track?.name ?? '',
            formatWord(r.format),
            level,
            word(r.state),
            inf !== undefined ? String(inf.decisionVersion) : '',
            sc && sc.average !== null ? sc.average.toFixed(1) : '',
            sc ? String(sc.count) : '0',
            r.submittedAt !== null ? new Date(r.submittedAt).toISOString() : '',
          ]
            .map(csvField)
            .join(',')
        );
      }

      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="${ev.slug}-proposals.csv"`);
      c.header('cache-control', 'private, no-store');
      return c.body(lines.join('\r\n') + '\r\n');
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/submissions/decide', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    let eventId: string;
    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === slug);
      if (!ev) return c.html(deniedPage(), 403);
      if (reviewerOnly(principal, ev.id)) return c.html(deniedPage(), 403);
      eventId = ev.id;
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }

    // One refusal for the whole batch, before anything is written — and in the
    // refusal page's own register, which the workflow's internal sentence is
    // not written for.
    try {
      requireDecider(principal, eventId);
    } catch (e) {
      if (e instanceof ScopeError) {
        return c.html(deniedPage('Deciding on this program is not yours to do.'), 403);
      }
      throw e;
    }

    const form = await c.req.parseBody({ all: true });
    const filter = filterOf(text(form['f']));
    const search = searchOf(text(form['q']));
    const note = text(form['note']).trim().slice(0, NOTE_MAX) || null;

    // Either one row's own button, or everything ticked plus one word from the
    // action bar. The row's button carries its decision with it, so a tick
    // somewhere else on the page can never ride along with it.
    let decision: Decision | null = null;
    let ids: string[] = [];

    const one = text(form['one']);
    if (one) {
      const cut = one.indexOf(':');
      const which = cut < 0 ? '' : one.slice(0, cut);
      const id = cut < 0 ? '' : one.slice(cut + 1);
      if (DECISIONS.has(which) && id) {
        decision = which as Decision;
        ids = [id];
      }
    } else {
      const asked = text(form['decision']);
      if (DECISIONS.has(asked)) {
        decision = asked as Decision;
        const raw = form['id'];
        const many = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
        ids = many.map((v) => (typeof v === 'string' ? v : '')).filter(Boolean);
      }
    }

    let done = 0;
    let held = 0;
    if (decision !== null) {
      for (const id of ids.slice(0, BATCH)) {
        const res = await stageDecision(c.env.DB, principal, eventId, id, decision, note);
        if (res.ok) done += 1;
        else held += 1;
      }
      // Anything past the ceiling was not touched, and says so in the same word.
      held += Math.max(0, ids.length - BATCH);
    }

    return c.redirect(backTo(slug, filter, search, done, held), 303);
  });
}
