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
// missing per-event blind toggle and the missing assignment concept are
// flagged there, at the place a fix would land.
//
// Persona card, 11-hats.md — "the reviewer, Δ13, round-scoped, blind":
//   values comparison, and their score being theirs (per-reviewer rows, not
//   last-write-wins); needs progress that says "8 of 24" without being asked;
//   fears seeing decisions they shouldn't, and scoring outside their lane;
//   walks in asking "which of these are mine, and which are left?" — which is
//   why the masthead answers with two counts before she scrolls, and why the
//   evening's unfinished work sits at the top of the list rather than in it.
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
  stagedReviews,
  windowSize,
  PAGE,
  MOST,
  type QueueRow,
  type ReviewEvent,
  type ReviewQueue,
  type ScorecardKey,
  type StagedReview,
} from '../../queries/reviews';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { upsertReview, submitReviews, type ReviewOutcome } from '../../workflows/review';

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

// The code arrives in a query string, so it is a stranger's word until it
// matches one of ours — and `in` would happily match 'constructor'.
function noteFor(raw: string | undefined): string | null {
  if (!raw) return null;
  const said: unknown = Object.prototype.hasOwnProperty.call(NOTES, raw)
    ? NOTES[raw as ReviewOutcome]
    : null;
  return typeof said === 'string' ? said : null;
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

// The anchor comes off a form, so it is encoded before it goes anywhere near
// a Location header.
const backTo = (slug: string, note: string, show: number, anchor?: string): string =>
  `${queueUrl(slug, { show: show > PAGE ? show : undefined, note })}` +
  `${anchor ? `#p-${encodeURIComponent(anchor)}` : ''}`;

/* ------------------------------------------------------------------ *
 * One row: a proposal, its scales, and where my marks stand
 * ------------------------------------------------------------------ */

function scale(k: ScorecardKey, mark: number | undefined): string {
  // .radio and .btnrow are the shared form vocabulary — the box, the border,
  // the accent colour and the tap target all come from the lifted CSS, so a
  // scale costs a few dozen bytes a mark instead of a paragraph of inline
  // style repeated on every proposal on the screen. Page weight is a product
  // requirement here, not an optimisation.
  const name = `score_${esc(k.key)}`;
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
    `<legend class="f-lab" style="padding:0">${esc(k.label)}</legend>` +
    `<div class="btnrow">${options.join('')}</div>` +
    '</fieldset>'
  );
}

/** My marks, read back in the scorecard's own words and order. */
function marksLine(card: ScorecardKey[], scores: Record<string, number>): string {
  const parts = card
    .filter((k) => typeof scores[k.key] === 'number')
    .map(
      (k) =>
        `<span class="score">${scores[k.key]}/${k.max}</span> ${esc(k.label)}`
    );
  return parts.join('<span class="sep"> · </span>');
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

function queueRow(row: QueueRow, ev: ReviewEvent, show: number, open: boolean): string {
  const head =
    `<h2 class="display" style="font-size:22px;line-height:1.25">${esc(row.title)}</h2>` +
    abstractBlock(row, ev.slug, show, open);

  // Submitted: fixed for this round. The marks stay legible, the controls go.
  if (row.mySubmittedAt !== null) {
    const marks = marksLine(ev.scorecard, row.myScores);
    return (
      `<div class="card card-pad" id="p-${esc(row.id)}" style="margin-top:14px">` +
      rowHead(row, ev) +
      head +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">' +
      `<span class="chip s-accepted">Scored ${esc(onDay(row.mySubmittedAt, ev.timezone))}</span>` +
      (marks ? `<span class="sub">${marks}</span>` : '') +
      '</div>' +
      (row.myNote
        ? `<div class="notebox" style="margin-top:10px">${esc(row.myNote)}</div>`
        : '') +
      '</div>'
    );
  }

  const scales = ev.scorecard.map((k) => scale(k, row.myScores[k.key])).join('');
  return (
    `<form class="card card-pad" id="p-${esc(row.id)}" method="post" style="margin-top:14px"` +
    ` action="/admin/${encodeURIComponent(ev.slug)}/reviews/stage">` +
    `<input type="hidden" name="on" value="${esc(row.id)}">` +
    `<input type="hidden" name="show" value="${show}">` +
    rowHead(row, ev) +
    head +
    `<div style="margin-top:16px">${scales}</div>` +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">Your note' +
    '<span class="opt">only the committee reads this</span></span>' +
    '<textarea name="note" rows="2" maxlength="2000" placeholder="What would you tell the room about this one?">' +
    `${esc(row.myNote ?? '')}</textarea></label>` +
    '<div class="btnrow" style="margin-top:14px">' +
    `<button class="btn btn-primary" type="submit">${esc(say('review.save'))}</button>` +
    (row.staged
      ? '<span class="chip s-undecided">Staged — yours until you submit</span>'
      : '') +
    '</div>' +
    '</form>'
  );
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

function queuePage(
  principal: Principal,
  ev: ReviewEvent,
  q: ReviewQueue,
  opts: { show: number; open: string | null; note: string | null }
): string {
  const note = noteFor(opts.note ?? undefined);
  // The event's timezone is already in the footer of every backstage screen;
  // floating it into this counts line as well costs a phone a whole line and
  // says nothing twice.
  const round = esc(say('review.round', { n: num(q.round) }));
  const said = note ? `<div class="sec standing">${esc(note)}</div>` : '';

  // A screen with nothing on it says what the round is and nothing else. The
  // counts belong to a list; over an empty one they are two zeroes and a
  // sentence about hidden names nobody is reading.
  if (q.total === 0) {
    return shell(
      principal,
      ev,
      '<div style="padding:26px 0 0">' +
        '<h1 class="display" style="font-size:34px">Reviews</h1>' +
        `<p class="counts">${round}</p></div>` +
        said +
        '<div class="sec state-out"><h2>Nothing is waiting on the committee.</h2>' +
        '<p>Every proposal on this program has a decision. When the next call closes, ' +
        'what comes in lands here.</p>' +
        `<a class="btn btn-primary" href="/admin/${encodeURIComponent(ev.slug)}">See the program →</a>` +
        '</div>'
    );
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

  const done =
    q.left === 0
      ? `<div class="sec standing"><b>${esc(say('review.done', { n: num(q.total) }))}</b></div>`
      : '';

  const rows = q.rows.map((r) => queueRow(r, ev, opts.show, opts.open === r.id)).join('');

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

  // With nothing left, "Yours to score · 0" is a zero standing next to a
  // sentence that already says so. The progress count leads instead.
  const head =
    '<div style="padding:26px 0 0">' +
    '<h1 class="display" style="font-size:34px">Reviews</h1>' +
    '<p class="counts">' +
    (q.left > 0
      ? `<b>${esc(say('review.queue', { n: num(q.left) }))}</b><span class="sep">·</span>`
      : '') +
    `${esc(say('review.progress', { n: num(q.submitted), m: num(q.total) }))}` +
    `<span class="sep">·</span>${round}</p>` +
    `<p class="hint">${esc(say('review.blind'))}</p>` +
    '</div>' +
    said;

  return shell(principal, ev, head + staged + done + rows + more);
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
    .map(
      (s) =>
        '<div style="padding:14px 18px;border-bottom:1px solid var(--line-soft)">' +
        `<div style="font-weight:640">${esc(s.title)}</div>` +
        `<div class="sub" style="margin-top:4px">${marksLine(ev.scorecard, s.scores)}</div>` +
        (s.note ? `<div class="sub" style="margin-top:5px">${esc(s.note)}</div>` : '') +
        '</div>'
    )
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

function scoresFrom(
  form: Record<string, unknown>,
  card: ScorecardKey[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of card) {
    const raw = form[`score_${k.key}`];
    if (typeof raw !== 'string' || raw === '') continue;
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
    const q = await reviewQueue(c.env.DB, principal, ev, { show });
    return c.html(
      queuePage(principal, ev, q, {
        show,
        open: c.req.query('open') ?? null,
        note: c.req.query('note') ?? null,
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
    return c.redirect(backTo(ev.slug, outcome, show, on), 303);
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
}
