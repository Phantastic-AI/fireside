// S-14 — one proposal, whole.
//
// Naomi's screen, at 23:40, on proposal 7 of 40. She has read six already and
// will read thirty-three more. The page owes her three things in this order:
// what this talk is, who is behind it, and the one act that moves it on. So the
// reading column is the proposal and the rail is the decision, and nothing on
// the page asks her a question it could answer itself.
//
// The two register laws hold every sentence here:
//   D-025 — every heading parses cold to a stranger.
//   D-027 — the product never narrates its own construction.
//
// The read is queries/admin.ts `proposal()` and nothing else; it owns scope, so
// this file never re-derives who may look. The write is workflows/decide.ts
// `stageDecision()` and nothing else; it owns the state machine, the letter and
// the reversal cascade, so this file never re-derives what a decision does. Its
// refusals arrive as sentences and leave this screen as the same sentences,
// word for word — see OUTCOMES.
//
// D-024 in one line: a first decision is one click (only Naomi has seen it and
// she can take it straight back), and changing a decision that already exists
// takes two passes, because the reversal releases a room, stops the tasks the
// speaker was working through, and stages a second letter to someone who has
// already had the first.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, FORMAT_KEY, LEVEL_KEY, type LabelKey } from '../../lib/labels';
import {
  adminEvents,
  proposal,
  requireScope,
  EDIT_ROLES,
  ScopeError,
  type AdminEvent,
  type Proposal,
  type ProposalMessage,
  type ProposalParticipant,
  type ProposalReview,
  type ProposalTask,
  type SubmissionState,
} from '../../queries/admin';
import { cfpQuestions, type CfpQuestion } from '../../queries/public';
import { reviewerOnly } from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { requireDecider, stageDecision, type Decision } from '../../workflows/decide';
import { createTask, TASK_KINDS } from '../../workflows/tasks';

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/** A label that may be missing. Stored values (formats, levels, message kinds)
 *  arrive from the database; one with no row in 02 §6 prints nothing rather
 *  than printing itself. */
function word(key: string | undefined): string {
  if (!key) return '';
  try {
    return label(key as LabelKey, 'backstage');
  } catch {
    return '';
  }
}

/** Fill a label's {tokens}. Values arrive already escaped. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');
}

const stateWord = (s: SubmissionState): string =>
  label(`submission.${s}` as LabelKey, 'backstage');

const STATE_CLASS: Record<SubmissionState, string> = {
  draft: 's-draft',
  submitted: 's-undecided',
  accepted: 's-accepted',
  waitlisted: 's-maybe',
  rejected: 's-declined',
  withdrawn: 's-withdrawn',
  cancelled: 's-declined',
};

// Where a proposal came from. 'seeded' has a label in the map and deliberately
// no row here: D-027 — the product does not tell anyone it was demonstrated.
const SOURCE_KEY: Record<string, string> = { cfp: 'source.public', organizer: 'source.admin' };

const ROLE_KEY: Record<string, string> = {
  speaker: 'role.speaker',
  co_speaker: 'role.cospeaker',
  moderator: 'role.host',
};

const MESSAGE_KIND_KEY: Record<string, string> = {
  received: 'message.kind.received',
  decision: 'message.kind.decision',
  task: 'message.kind.task',
  reminder: 'message.kind.task',
  schedule: 'message.kind.schedule',
};

// A cancelled task always says why (the schema insists). These are the three
// reasons in the speaker's terms, so the enum never reaches the page.
const CANCEL_REASON: Record<string, string> = {
  manual: 'Taken off the list by an organizer.',
  decision_reversal: 'The decision changed, so this stopped being asked for.',
  session_cancelled: 'The talk came off the program, so this stopped being asked for.',
};

/* ------------------------------------------------------------------ *
 * Dates, on the event's own clock
 * ------------------------------------------------------------------ */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec'];

type Parts = { y: number; m: number; d: number; hh: number; mi: number; dow: number };

function partsOf(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(f.find((p) => p.type === t)?.value ?? '0');
  const y = n('year');
  const m = n('month');
  const d = n('day');
  return { y, m, d, hh: n('hour') % 24, mi: n('minute'), dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** A calendar day ('2026-08-28') is a date, not an instant: no zone applies. */
function partsOfIso(iso: string): Parts {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return { y, m, d, hh: 0, mi: 0, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
const shortOf = (p: Parts): string => `${p.d} ${MONTHS_SHORT[p.m - 1] ?? ''}`;
const longOf = (p: Parts): string => `${p.d} ${MONTHS[p.m - 1] ?? ''}`;
const dayLongOf = (p: Parts): string => `${DAY_NAMES[p.dow] ?? ''} ${p.d} ${MONTHS_SHORT[p.m - 1] ?? ''}`;

const dShort = (ms: number, tz: string): string => shortOf(partsOf(ms, tz));
const dLong = (ms: number, tz: string): string => longOf(partsOf(ms, tz));
const dTime = (ms: number, tz: string): string => {
  const p = partsOf(ms, tz);
  return `${pad(p.hh)}:${pad(p.mi)}`;
};
const isoDayLong = (iso: string): string => dayLongOf(partsOfIso(iso));

/** Relative for the last week, a date after that. Never a machine timestamp. */
function rel(ms: number, nowMs: number, tz: string): string {
  const diff = nowMs - ms;
  const hrs = diff / 3_600_000;
  if (diff >= 0 && hrs < 1) return `${Math.max(1, Math.round(diff / 60_000))} minutes ago`;
  if (diff >= 0 && hrs < 22) {
    const x = Math.round(hrs);
    return x === 1 ? '1 hour ago' : `${x} hours ago`;
  }
  const a = partsOf(ms, tz);
  const b = partsOf(nowMs, tz);
  const days = Math.round(
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000
  );
  if (days === 1) return 'yesterday';
  if (days > 1 && days < 7) return DAY_NAMES[a.dow] ?? shortOf(a);
  return shortOf(a);
}

/** Today on the event's clock, as an ISO day, so a due date can be compared. */
const todayIso = (tz: string, nowMs: number): string => {
  const p = partsOf(nowMs, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

/** The prototype's own rendering of a length. */
const mins = (m: number): string => (m >= 90 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`);

/** One decimal, and no trailing '.0' — a number Naomi can repeat out loud. */
const oneDecimal = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/* ------------------------------------------------------------------ *
 * Small pieces of markup
 * ------------------------------------------------------------------ */

const AVPAL: [string, string][] = [
  ['#F3DDC6', '#8A4E1C'],
  ['#DDE8E4', '#1F5B4E'],
  ['#EEDCE4', '#7B3352'],
  ['#E3E1EF', '#3F3A72'],
  ['#EFE6C9', '#6B5A15'],
  ['#E0EAEF', '#1E5468'],
  ['#F0DFD8', '#8C3B2B'],
  ['#DFE9D6', '#3E5C26'],
];

function hashOf(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

function initialsOf(name: string): string {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  const first = parts[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return `${first[0] ?? '?'}${last[0] ?? ''}`.toUpperCase();
}

/** The prototype's generated portrait. No image request leaves the page. */
function avatar(name: string, size: number): string {
  const pair = AVPAL[hashOf(name) % AVPAL.length] ?? AVPAL[0]!;
  const seed = hashOf(`${name}·`);
  const ax = (26 + (seed % 9)) / 40;
  const ay = (8 + ((seed >> 3) % 9)) / 40;
  return (
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    `<defs><radialGradient id="g${seed}" cx="${ax}" cy="${ay}" r="1">` +
    '<stop offset="0" stop-color="#fff" stop-opacity=".72"/>' +
    `<stop offset=".55" stop-color="${pair[0]}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="20" cy="20" r="20" fill="${pair[0]}"/>` +
    `<circle cx="20" cy="20" r="20" fill="url(#g${seed})"/>` +
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="Iowan Old Style,Palatino,Georgia,serif" font-size="15" font-weight="600" ' +
    `fill="${pair[1]}">${esc(initialsOf(name))}</text>` +
    '<circle cx="20" cy="20" r="19.4" fill="none" stroke="rgba(34,30,23,.12)" stroke-width="1.2"/></svg>'
  );
}

const trackChip = (t: { name: string; colour: string }): string =>
  `<span class="tk" style="--tc:${esc(t.colour)};--tw:color-mix(in srgb, ${esc(t.colour)} 16%, white)">${esc(t.name)}</span>`;

/** Prose with line breaks in it, as paragraphs. `style` is for the places with
 *  no paragraph rule of their own (a letter body, a long answer); inside
 *  `.abstract` the stylesheet already owns the spacing, so it is left off. */
const paras = (text: string, style?: string): string => {
  const attr = style ? ` style="${style}"` : '';
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p${attr}>${esc(line)}</p>`)
    .join('');
};

const smallHead = (text: string): string =>
  `<h3 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">${esc(text)}</h3>`;

const sectionHead = (text: string): string =>
  `<h2 class="display" style="font-size:22px;margin-bottom:10px">${esc(text)}</h2>`;

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ *
 * What just happened. One closed set of codes in the query string, one
 * sentence each here — no free text ever travels through a URL.
 *
 * The four refusals that come from workflows/decide.ts are reproduced word
 * for word; the workflow owns those sentences, this screen only carries them.
 * ------------------------------------------------------------------ */

const OUTCOMES: Record<string, string> = {
  // staged, by decision — the letter exists and has not left
  accepted: 'Accepted. The letter is written and waiting in the outbox.',
  maybe: 'Marked a maybe. The letter is written and waiting in the outbox.',
  declined: 'Declined. The letter is written and waiting in the outbox.',
  // verbatim from workflows/decide.ts
  'not-here': 'That proposal is not on this event.',
  'not-open': 'That move is not open from where this proposal stands.',
  moved: 'Someone else decided this one while you were reading it.',
  // this screen's own guards
  'look-again': 'Something moved while this page was open. Look again, then decide.',
  'second-look': 'A decision already made takes the second look first. Nothing has changed.',
  'no-decision': 'That carried no decision, so nothing changed.',
  trouble: 'That did not go through, and nothing has changed. Worth trying once more.',
  // asking — its own codes, because "not here" means something else here than
  // it does about a decision: the speaker, not the proposal
  asked: 'Asked. It is on their portal now.',
  'ask-not-here':
    'An ask has to go to somebody on this conference, about something of theirs. Nothing was asked.',
  'ask-no-title': 'An ask needs a short line saying what you are asking for.',
  'ask-no-kind': 'Say what kind of ask it is, so they know what to send back.',
  'ask-bad-date': 'That is not a day anyone has. Give the date again and it goes on their list.',
  'ask-trouble': 'The ask did not go through, and nothing changed. Worth trying once more.',
};

/** decide.ts speaks in sentences; this maps each back to its code so the same
 *  sentence comes out the other side. Anything unrecognised reads as trouble. */
function codeForRefusal(message: string): string {
  for (const [code, sentence] of Object.entries(OUTCOMES)) {
    if (sentence === message) return code;
  }
  return 'trouble';
}

function outcomeNote(code: string | undefined): string {
  const text = code ? OUTCOMES[code] : undefined;
  if (!text) return '';
  return (
    '<div class="notebox" style="margin-top:18px" role="status">' +
    `<p style="margin:0" class="serif">${esc(text)}</p></div>`
  );
}

/* ------------------------------------------------------------------ *
 * The reading column
 * ------------------------------------------------------------------ */

/** R-10: the organizer's own questions, answered. The words on the left are
 *  theirs — this screen supplies none of them. */
function answersSection(p: Proposal, questions: readonly CfpQuestion[]): string {
  const blocks: string[] = [];

  if (p.level) {
    const levelWord = word(LEVEL_KEY[p.level]);
    if (levelWord) {
      blocks.push(
        `<div class="sec">${smallHead('Who is this for?')}` +
          `<p style="margin-top:6px">${esc(levelWord)}</p></div>`
      );
    }
  }

  for (const q of questions) {
    const given = p.answers[q.id];
    // Only the three shapes a call can actually produce; anything else is not
    // an answer this screen knows how to read aloud, so it says nothing.
    const answer =
      typeof given === 'boolean'
        ? given
          ? 'Yes'
          : 'No'
        : typeof given === 'string' || typeof given === 'number'
          ? String(given)
          : '';
    if (answer === '') continue;
    const long = q.kind === 'long' || answer.length > 140;
    const rendered = long
      ? `<div class="notebox" style="margin-top:8px">${paras(answer, 'margin:0 0 .6em')}</div>`
      : `<p style="margin-top:6px">${esc(answer)}</p>`;
    blocks.push(`<div class="sec">${smallHead(q.label)}${rendered}</div>`);
  }

  return blocks.join('');
}

function participantRow(part: ProposalParticipant, sent: boolean): string {
  const role = word(ROLE_KEY[part.role]);
  const line = [role, part.jobTitle ?? '', part.organisation ?? '']
    .filter((x) => x !== '')
    .map((x) => esc(x))
    .join(' · ');
  const address = part.email
    ? `<span class="sub">${esc(part.email)}</span>`
    : `<span class="chip warn">${esc(label('message.blocked', 'backstage'))}</span>`;
  return (
    '<div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;' +
    'border-bottom:1px solid var(--line-soft);flex-wrap:wrap">' +
    avatar(part.name, 40) +
    '<div style="min-width:0;flex:1">' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    `<span style="font-weight:640">${esc(part.name)}</span>` +
    (part.isSubmitter
      ? `<span class="chip plain">${sent ? 'Sent this one in' : 'Wrote this one'}</span>`
      : '') +
    '</div>' +
    (line ? `<div class="sub">${line}</div>` : '') +
    `<div style="margin-top:3px">${address}</div>` +
    '</div></div>'
  );
}

function peopleSection(p: Proposal, slug: string): string {
  const sent = p.submittedAt !== null;
  if (p.participation.length === 0) {
    return (
      `<div class="sec" id="people">${sectionHead('Who is speaking')}` +
      '<div class="state-out"><h2>Nobody’s speaking on this one yet.</h2>' +
      '<p>A proposal with no speaker on it cannot be told anything. Put a name on it from the ' +
      'roster and the letters have somewhere to go.</p>' +
      `<div class="btnrow"><a class="btn btn-primary" href="/admin/${esc(slug)}/people">Open the roster →</a></div>` +
      '</div></div>'
    );
  }
  return (
    `<div class="sec" id="people">${sectionHead('Who is speaking')}` +
    p.participation.map((part) => participantRow(part, sent)).join('') +
    '</div>'
  );
}

/* ---------- what the committee scored ---------- */

/** A scorecard key is the organizer's own word for a criterion. 02 §6 has no
 *  row for these (they are per-event, not an enum), so they print as written
 *  with a capital on the front and nothing else done to them. */
const criterionWord = (key: string): string =>
  key.replace(/[_-]+/g, ' ').replace(/^./, (ch) => ch.toUpperCase());

function reviewRow(r: ProposalReview): string {
  const scores = Object.entries(r.scores)
    .map(([k, v]) => `<b>${esc(criterionWord(k))}</b> ${esc(String(v))}`)
    .join('<span style="color:var(--muted-2);margin:0 6px">·</span>');
  return (
    '<div style="padding:12px 0;border-bottom:1px solid var(--line-soft)">' +
    '<div style="display:flex;gap:9px;align-items:baseline;flex-wrap:wrap">' +
    `<span style="font-weight:640">${esc(r.reviewerName)}</span>` +
    `<span class="sub">${esc(fill(label('review.round', 'backstage'), { n: String(r.round) }))}</span>` +
    '</div>' +
    (scores ? `<div style="margin-top:5px;font-variant-numeric:tabular-nums">${scores}</div>` : '') +
    (r.note ? `<div class="notebox" style="margin-top:8px"><p style="margin:0">${esc(r.note)}</p></div>` : '') +
    '</div>'
  );
}

function reviewsSection(p: Proposal, slug: string, inPlay: boolean): string {
  const head = sectionHead('What the committee scored');

  // A draft has not been sent, so it is not in front of anybody. Saying "on
  // nobody's list" there would be true and useless.
  if (!inPlay && p.reviews.length === 0) return '';

  if (p.reviews.length === 0) {
    return (
      `<div class="sec" id="scores">${head}` +
      '<div class="state-out"><h2>This one is on nobody’s list.</h2>' +
      '<p>Put it in front of the committee and their scores land here.</p>' +
      `<div class="btnrow"><a class="btn btn-primary" href="/admin/${esc(slug)}/reviews?hand=${encodeURIComponent(p.id)}#hand">Hand it to a reviewer →</a></div>` +
      '</div></div>'
    );
  }

  // D-024, held all the way to the committee's own chair: a score is staged
  // until its reviewer sends it, and staged means invisible — here too.
  const sent = p.reviews.filter((r) => r.submittedAt !== null);
  if (sent.length === 0) {
    return (
      `<div class="sec" id="scores">${head}` +
      `<div class="state-out"><h2>Nothing has come back yet.</h2>` +
      `<p>This one is on ${esc(plural(p.reviews.length, 'reviewer’s list', 'reviewers’ lists'))}. ` +
      'Scores stay with the person writing them until they send them, so there is nothing to read ' +
      'until then.</p>' +
      `<div class="btnrow"><a class="btn" href="/admin/${esc(slug)}/reviews">See where the committee is →</a></div>` +
      '</div></div>'
    );
  }

  const total = p.reviewAggregates.reduce((sum, a) => sum + a.average * a.count, 0);
  const counted = p.reviewAggregates.reduce((sum, a) => sum + a.count, 0);
  const overall = counted > 0 ? oneDecimal(total / counted) : '';
  const summary = overall
    ? `<p class="sub" style="margin-bottom:12px">${esc(
        fill(label('review.average', 'backstage'), {
          score: overall,
          n: String(p.reviewsSubmitted),
          m: String(p.reviews.length),
        })
      )}</p>`
    : '';
  const byCriterion = p.reviewAggregates.length
    ? '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px">' +
      p.reviewAggregates
        .map(
          (a) =>
            '<div><div class="sub">' +
            `${esc(criterionWord(a.key))}</div>` +
            `<div class="display" style="font-size:26px;font-variant-numeric:tabular-nums">${esc(oneDecimal(a.average))}</div></div>`
        )
        .join('') +
      '</div>'
    : '';

  return (
    `<div class="sec" id="scores">${head}${summary}${byCriterion}` +
    sent.map(reviewRow).join('') +
    '</div>'
  );
}

/* ---------- the letters ---------- */

function messageRow(m: ProposalMessage, tz: string): string {
  const kind = word(MESSAGE_KIND_KEY[m.kind]);
  const when = m.staged
    ? `<span class="chip notold">${esc(label('message.staged', 'backstage'))}</span>`
    : `<span class="sub">${esc(fill(label('message.delivered', 'backstage'), { date: dShort(m.deliveredAt ?? m.createdAt, tz) }))}</span>`;
  const emailed =
    m.emailedAt !== null
      ? `<div class="sub" style="margin-top:4px">${esc(fill(label('message.emailed', 'backstage'), { date: dShort(m.emailedAt, tz) }))}</div>`
      : '';
  const blocked =
    m.blockedReason !== null
      ? `<div style="margin-top:6px"><span class="chip warn">${esc(label('message.blocked', 'backstage'))}</span></div>`
      : '';
  const staging = m.staged
    ? '<div class="sub" style="margin-top:6px">Nothing has gone out. It leaves with the next send ' +
      'from the outbox.</div>'
    : '';
  return (
    '<div class="msg">' +
    `<div class="mk">${esc(kind)}</div>` +
    '<div>' +
    `<div class="msub">${esc(m.subject)}</div>` +
    `<div class="mprev">${paras(m.body, 'margin:0 0 .6em')}</div>` +
    `<div class="sub" style="margin-top:6px">To ${esc(m.personName)}</div>` +
    blocked +
    staging +
    '</div>' +
    `<div>${when}${emailed}</div>` +
    '</div>'
  );
}

function lettersSection(p: Proposal, slug: string, tz: string, inPlay: boolean): string {
  const head = sectionHead('Letters');
  const door = `<a class="link" href="/admin/${esc(slug)}/outbox">Open the outbox →</a>`;

  if (p.messages.length === 0) {
    return (
      `<div class="sec" id="letters">${head}` +
      '<div class="state-out"><h2>No letters yet.</h2>' +
      `<p>${inPlay ? 'The first one goes with your decision.' : 'A draft has not been sent, so there is nothing to write about yet.'}</p>` +
      `<div class="btnrow"><a class="btn" href="/admin/${esc(slug)}/outbox">Open the outbox →</a></div>` +
      '</div></div>'
    );
  }

  return (
    `<div class="sec" id="letters">${head}` +
    '<p class="sub" style="margin-bottom:8px">Newest first, in the words that go out. ' +
    `${door}</p>` +
    p.messages.map((m) => messageRow(m, tz)).join('') +
    '</div>'
  );
}

/* ---------- earlier versions ---------- */

function revisionsSection(p: Proposal, tz: string): string {
  if (p.revisions.length === 0) return '';
  return (
    `<div class="sec" id="versions">${sectionHead(label('pane.versions', 'backstage'))}` +
    '<p class="sub" style="margin-bottom:8px">Only organizers see these.</p>' +
    p.revisions
      .map(
        (r) =>
          `<details style="border-bottom:1px solid var(--line-soft);padding:10px 0">` +
          `<summary style="cursor:pointer"><span style="font-weight:620">${esc(dLong(r.createdAt, tz))}</span></summary>` +
          `<div class="abstract" style="font-size:16px;margin-top:8px">${paras(r.body)}</div>` +
          '</details>'
      )
      .join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The rail — where this stands, and the one act that moves it
 * ------------------------------------------------------------------ */

function taskChip(t: ProposalTask, todayKey: string): { text: string; cls: string } {
  if (t.completedAt !== null && t.cancelledAt !== null) {
    return { text: label('task.done_cancelled', 'backstage'), cls: 'chip plain' };
  }
  if (t.completedAt !== null) return { text: label('task.done', 'backstage'), cls: 'chip s-accepted' };
  if (t.cancelledAt !== null) return { text: label('task.cancelled', 'backstage'), cls: 'chip s-declined' };
  if (t.dueOn !== null && t.dueOn < todayKey) {
    return { text: label('task.overdue', 'backstage'), cls: 'chip warn' };
  }
  return { text: label('task.open', 'backstage'), cls: 'chip s-undecided' };
}

function tasksBox(p: Proposal, tz: string, todayKey: string, askable: boolean): string {
  if (p.tasks.length === 0) {
    return (
      '<div class="railbox" id="tasks"><h4>To do</h4>' +
      '<p class="sub">Nothing is being asked of them yet.' +
      (askable ? ' Ask below and it lands on their portal against this proposal.' : '') +
      '</p></div>'
    );
  }
  const rows = p.tasks
    .map((t) => {
      const chip = taskChip(t, todayKey);
      const struck = t.completedAt !== null ? ';text-decoration:line-through;color:var(--muted)' : '';
      const due =
        t.completedAt === null && t.cancelledAt === null && t.dueOn
          ? `<div class="sub" style="flex:1 1 100%">${t.dueOn < todayKey ? 'Was due ' : 'Due '}${esc(isoDayLong(t.dueOn))}</div>`
          : '';
      const done =
        t.completedAt !== null
          ? `<div class="sub" style="flex:1 1 100%">on ${esc(dShort(t.completedAt, tz))}</div>`
          : '';
      const why =
        t.cancelledAt !== null && t.cancelReason
          ? `<div class="sub" style="flex:1 1 100%">${esc(CANCEL_REASON[t.cancelReason] ?? '')}</div>`
          : '';
      return (
        '<div style="display:flex;gap:9px;align-items:center;padding:7px 0;' +
        'border-bottom:1px solid var(--line-soft);flex-wrap:wrap">' +
        `<span style="flex:1;min-width:120px${struck}">${esc(t.title)}</span>` +
        `<span class="${chip.cls}">${esc(chip.text)}</span>` +
        due +
        done +
        why +
        '</div>'
      );
    })
    .join('');
  return `<div class="railbox" id="tasks"><h4>To do</h4>${rows}</div>`;
}

/* ---------- asking the speaker for something ---------- */

// input[type=date] sits outside the field rule in shared.css (text, email, tel,
// textarea, select), so it carries that rule's own skin inline.
const DATE_FIELD =
  'style="width:100%;font:inherit;font-size:15px;color:var(--ink);background:var(--card);' +
  'border:1px solid var(--field-line);border-radius:var(--r-sm);padding:9px 11px"';

/**
 * The same ask as on the person's own page, standing where the proposal is —
 * scoped to whoever sent this one in, and about this one, so neither has to be
 * chosen twice. The write is workflows/tasks.ts and nothing else.
 */
function askBox(p: Proposal, slug: string, who: ProposalParticipant): string {
  const first = who.name.trim().split(/\s+/)[0] ?? who.name;
  const kinds = TASK_KINDS.map(
    (k) => `<option value="${esc(k.value)}">${esc(k.word)}</option>`
  ).join('');
  return (
    '<div class="railbox" id="ask"><h4>Ask for something</h4>' +
    `<p class="sub" style="margin:0 0 10px">It lands on ${esc(first)}’s portal against this ` +
    'proposal, with the day it is due. Nothing is emailed.</p>' +
    `<form method="post" action="/admin/${esc(slug)}/submissions/${esc(p.id)}/ask">` +
    '<label class="f" style="margin-bottom:12px"><span class="f-lab">What are you asking for?</span>' +
    '<input type="text" name="title" required maxlength="140" placeholder="Send your slides"></label>' +
    '<label class="f" style="margin-bottom:12px"><span class="f-lab">What kind of ask</span>' +
    `<select name="kind">${kinds}</select></label>` +
    '<label class="f" style="margin-bottom:12px"><span class="f-lab">Due by</span>' +
    `<input type="date" name="due" required ${DATE_FIELD}></label>` +
    `<div class="btnrow"><button class="btn btn-primary btn-sm" type="submit">Ask ${esc(
      first
    )}</button></div>` +
    '</form></div>'
  );
}

/** Whose ask this is: the person who sent it in, or the first name on it when
 *  nobody was marked the sender. */
function askable(p: Proposal): ProposalParticipant | undefined {
  return p.participation.find((x) => x.isSubmitter) ?? p.participation[0];
}

function scoreBox(p: Proposal, slug: string): string {
  const number =
    p.score !== null
      ? `<div style="display:flex;gap:10px;align-items:baseline">` +
        `<span class="display" style="font-size:30px;font-variant-numeric:tabular-nums">${esc(String(p.score))}</span>` +
        '</div>'
      : '<p class="sub">Nobody has put a number on this one.</p>' +
        `<p style="margin-top:8px"><a class="link" style="font-size:14px" href="/admin/${esc(slug)}/reviews?hand=${encodeURIComponent(p.id)}#hand">Hand it to a reviewer →</a></p>`;
  const notes = p.scoreNotes
    ? `<div style="margin-top:12px"><h4>Our notes</h4><p class="sub">${esc(p.scoreNotes)}</p>` +
      '<div class="hint">Only organizers see this.</div></div>'
    : '';
  return `<div class="railbox"><h4>Score</h4>${number}${notes}</div>`;
}

/** The one-line answer to "where does this stand". */
function standingLine(p: Proposal, tz: string, nowMs: number): string {
  const decided = p.decidedAt !== null ? ` ${dShort(p.decidedAt, tz)}` : '';
  const told =
    p.notifiedAt !== null
      ? `${fill(label('submission.told', 'backstage'), { date: dShort(p.notifiedAt, tz) })}.`
      : 'Not told yet.';
  const scheduled =
    p.startsAt === null ? ` ${label('placement.none', 'backstage')}.` : '';

  switch (p.state) {
    case 'draft':
      return `Started ${rel(p.createdAt, nowMs, tz)}. Not sent — only the writer can see it.`;
    case 'submitted':
      return 'Waiting on you. Nobody has decided on this one.';
    case 'accepted':
      return `${stateWord('accepted')}${decided}. ${told}${scheduled}`;
    case 'waitlisted':
      return `${stateWord('waitlisted')}${decided}. ${told} Decide before the agenda goes out.`;
    case 'rejected':
      return `${stateWord('rejected')}${decided}. ${told}`;
    case 'withdrawn':
      return 'The speaker pulled this one back. It is off the committee’s list.';
    case 'cancelled':
      return `Came off the program${p.cancelledAt !== null ? ` ${dShort(p.cancelledAt, tz)}` : ''}. ` +
        'It keeps its place on the agenda so nobody turns up expecting it.';
  }
}

const NOTE_FIELD =
  '<label class="f" style="margin:14px 0 12px">' +
  '<span class="f-lab">Note to the speaker <span class="opt">Optional</span></span>' +
  '<textarea name="note" rows="3" placeholder="This one was close and it came down to overlap — ' +
  'please send it again next year."></textarea>' +
  '<span class="hint">Goes out with the decision, in your own words.</span></label>';

const DECIDE_BUTTONS =
  '<div class="btnrow">' +
  '<button class="btn btn-primary" type="submit" name="decision" value="accepted">Accept</button>' +
  `<button class="btn" type="submit" name="decision" value="waitlisted">${esc(label('submission.waitlisted', 'backstage'))}</button>` +
  '<button class="btn" type="submit" name="decision" value="rejected">Decline</button>' +
  '</div>';

/**
 * What changing an existing decision actually costs, counted from this
 * proposal and not from a guess. This is the arithmetic the second pass
 * carries back: `openTasks` rides in the form and is checked again server-side
 * before anything moves.
 */
function reversalCost(p: Proposal, tz: string): { openTasks: number; sentences: string[] } {
  const openTasks = p.tasks.filter((t) => t.completedAt === null && t.cancelledAt === null).length;
  const sentences: string[] = [];

  sentences.push(
    p.startsAt !== null
      ? `Its slot frees up — ${esc(dLong(p.startsAt, tz))}, ${esc(dTime(p.startsAt, tz))}` +
        `${p.roomName ? `, ${esc(p.roomName)}` : ''}.`
      : 'Nothing is scheduled for it, so no slot changes hands.'
  );
  sentences.push(
    openTasks === 0
      ? 'Nothing is being asked of them right now.'
      : `${esc(plural(openTasks, 'open task stops', 'open tasks stop'))} being asked for. Anything already sent in stays.`
  );
  sentences.push(
    p.notifiedAt !== null
      ? `They were told on ${esc(dLong(p.notifiedAt, tz))}, so a second letter goes to the outbox and they have to be told again.`
      : 'They have not been told yet, so there is nothing to take back.'
  );

  return { openTasks, sentences };
}

function decideBox(
  p: Proposal,
  slug: string,
  tz: string,
  nowMs: number,
  mayDecide: boolean,
  armed: boolean
): string {
  const notold = p.decidedNotTold
    ? `<div style="margin-bottom:9px"><span class="chip notold">${esc(label('submission.decided_not_told', 'backstage'))}</span></div>`
    : '';
  const standing = `<p class="sub" style="margin:0 0 12px">${standingLine(p, tz, nowMs)}</p>`;
  const action = `/admin/${esc(slug)}/submissions/${esc(p.id)}/decide`;
  const self = `/admin/${esc(slug)}/submissions/${esc(p.id)}`;
  const version = `<input type="hidden" name="version" value="${esc(String(p.decisionVersion))}">`;

  let acts: string;
  if (!mayDecide) {
    acts =
      '<p class="sub">Deciding on this event is held by its organizers. Everything on this page ' +
      'is yours to read.</p>';
  } else if (p.state === 'draft') {
    acts =
      '<p class="sub">A draft belongs to the person writing it until they send it. There is ' +
      'nothing to decide yet.</p>';
  } else if (p.state === 'withdrawn') {
    acts =
      '<p class="sub">They took this one back, so there is nothing left to decide.</p>';
  } else if (p.decidedAt === null) {
    // D-024, one click: only you have seen this, and you can take it straight
    // back. Nothing leaves the building until the outbox act.
    acts =
      `<form method="post" action="${action}">${version}${NOTE_FIELD}${DECIDE_BUTTONS}</form>` +
      `<p class="hint">The letter waits in the ` +
      `<a class="link" href="/admin/${esc(slug)}/outbox">outbox</a> until you send it.</p>`;
  } else if (!armed) {
    // D-024, first pass: name the act, do not perform it.
    acts =
      `<div class="btnrow"><a class="btn" href="${self}?change=1#decide">Change the decision</a></div>`;
  } else {
    // D-024, second pass: the arithmetic, then the same three buttons, with the
    // number carried in the form and checked again before anything moves.
    const cost = reversalCost(p, tz);
    acts =
      '<div class="notebox" style="margin:0 0 12px">' +
      '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">' +
      'What changing it does</b>' +
      cost.sentences.map((s) => `<p style="margin:6px 0 0">${s}</p>`).join('') +
      '</div>' +
      `<form method="post" action="${action}">${version}` +
      `<input type="hidden" name="confirm" value="${esc(String(cost.openTasks))}">` +
      NOTE_FIELD +
      DECIDE_BUTTONS +
      '</form>' +
      `<p style="margin-top:10px"><a class="link" href="${self}">Keep it as it is</a></p>`;
  }

  return `<div class="railbox" id="decide"><h4>Where this stands</h4>${notold}${standing}${acts}</div>`;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

function shell(ev: AdminEvent, principal: Principal, body: string, crumb: string): string {
  return backstageShell({
    eventSlug: ev.slug,
    eventName: ev.name,
    here: '/submissions',
    who: principal.name,
    whoInitials: initialsOf(principal.name),
    tzLabel: ev.tzLabel ?? '',
    body,
    crumb,
  });
}

const CRUMB = (slug: string): string =>
  `<a href="/admin/${esc(slug)}/submissions">Proposals</a> › <span>this one</span>`;

/** The proposal that is not here. Naomi followed a stale link; say so and give
 *  her the pile back in one click. */
function missingPage(ev: AdminEvent, principal: Principal): string {
  const body =
    '<div class="sec state-out" style="max-width:40em">' +
    '<h2>Not on this program.</h2>' +
    `<p>There is no proposal at that address for ${esc(ev.name)}. It may have been withdrawn, or ` +
    'the link may be older than the pile.</p>' +
    `<div class="btnrow"><a class="btn btn-primary" href="/admin/${esc(ev.slug)}/submissions">Back to proposals →</a></div>` +
    '</div>';
  return page({
    title: `Proposals · ${ev.name}`,
    register: 'backstage',
    body: shell(ev, principal, body, CRUMB(ev.slug)),
  });
}

function renderProposal(o: {
  ev: AdminEvent;
  principal: Principal;
  p: Proposal;
  questions: readonly CfpQuestion[];
  mayDecide: boolean;
  mayAsk: boolean;
  armed: boolean;
  outcome: string | undefined;
  nowMs: number;
}): string {
  const { ev, p, nowMs } = o;
  const tz = ev.timezone;
  const slug = ev.slug;

  // A draft has not been sent anywhere, so it does not get told where it came
  // from — "Sent through the call" on something nobody has sent is a small lie.
  // No fallback to the stored format either: a value with no row in the label
  // map is a gap in the map, and printing it raw would hide the gap.
  const inPlay = p.state !== 'draft';
  const metaBits = [
    word(FORMAT_KEY[p.format]),
    mins(p.minutes),
    p.submittedAt !== null ? word(SOURCE_KEY[p.source]) : '',
  ].filter((b) => b !== '');
  const sent = p.submittedAt !== null ? `, ${rel(p.submittedAt, nowMs, tz)}` : '';

  const speakers = p.participation;
  const names = speakers.map((s) => s.name);
  const byline =
    names.length === 0
      ? 'Nobody on it yet'
      : names.length === 1
        ? (names[0] ?? '')
        : names.length === 2
          ? `${names[0]} with ${names[1]}`
          : `${names[0]} with ${names.slice(1, -1).join(', ')} and ${names[names.length - 1]}`;
  const first = speakers[0];
  const firstLine = first
    ? [first.organisation ?? '', first.jobTitle ?? ''].filter((x) => x !== '').map((x) => esc(x)).join(' · ')
    : '';

  const abstract = p.abstract
    ? paras(p.abstract)
    : p.state === 'draft'
      ? '<p>Nothing written yet — this one is still a draft, and only the writer can see what is in it.</p>'
      : '<p>No abstract came with this one.</p>';

  const publicDoor =
    p.publicSlug !== null
      ? `<p style="margin-top:20px"><a class="link" href="/${esc(slug)}/s/${esc(p.publicSlug)}">See it on the public agenda →</a></p>`
      : '';

  const head =
    '<div style="padding:22px 0 0">' +
    '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:10px">' +
    `<span class="chip ${STATE_CLASS[p.state]}">${esc(stateWord(p.state))}</span>` +
    (p.track ? trackChip(p.track) : '') +
    `<span class="sub">${esc(metaBits.join(' · '))}${esc(sent)}</span>` +
    '</div>' +
    `<h1 class="display" style="font-size:32px">${esc(p.title || 'Untitled draft')}</h1>` +
    '<div class="byline" style="margin-top:12px">' +
    speakers
      .slice(0, 4)
      .map((s) => avatar(s.name, 32))
      .join('') +
    `<span>${esc(byline)}${firstLine ? ` <span class="sub">· ${firstLine}</span>` : ''}</span>` +
    `<a class="link" style="margin-left:auto;font-size:14px" href="/admin/${esc(slug)}/people">See what they owe →</a>` +
    '</div>' +
    outcomeNote(o.outcome) +
    '</div><hr class="rule">';

  const main =
    '<div>' +
    `<div class="abstract">${abstract}</div>` +
    answersSection(p, o.questions) +
    peopleSection(p, slug) +
    lettersSection(p, slug, tz, inPlay) +
    reviewsSection(p, slug, inPlay) +
    revisionsSection(p, tz) +
    publicDoor +
    `<p style="margin-top:14px"><a class="link" href="/admin/${esc(slug)}/submissions">← Back to the ` +
    'proposals</a></p>' +
    '</div>';

  // A draft has not been sent, so nobody on it is on the roster yet and there
  // is nothing to ask them for. Everywhere else, the ask stands under the list
  // it lands in.
  const asker = askable(p);
  const canAskHere = inPlay && o.mayAsk && asker !== undefined;
  const rail =
    '<aside class="rail">' +
    decideBox(p, slug, tz, nowMs, o.mayDecide, o.armed) +
    // A draft is nobody's to score yet, so the box does not sit there empty.
    (inPlay ? scoreBox(p, slug) : '') +
    tasksBox(p, tz, todayIso(tz, nowMs), canAskHere) +
    (canAskHere && asker ? askBox(p, slug, asker) : '') +
    '</aside>';

  return page({
    title: `${p.title} · ${ev.name}`,
    register: 'backstage',
    body: shell(ev, o.principal, head + `<div class="det">${main}${rail}</div>`, CRUMB(slug)),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const DECISIONS: Record<string, Decision> = {
  accepted: 'accepted',
  waitlisted: 'waitlisted',
  rejected: 'rejected',
};

const OUTCOME_FOR: Record<Decision, string> = {
  accepted: 'accepted',
  waitlisted: 'maybe',
  rejected: 'declined',
};

export function registerProposal(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/submissions/:id', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    const id = c.req.param('id');
    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === slug);
      if (!ev) return c.html(deniedPage(), 403);
      // This page names the person who wrote the proposal, their employer and
      // their history. A reviewer scores it blind on their own screen, so this
      // one is shut to them outright, not trimmed.
      if (reviewerOnly(principal, ev.id)) return c.html(deniedPage(), 403);

      const [p, questions] = await Promise.all([
        proposal(c.env.DB, principal, ev.id, id),
        cfpQuestions(c.env.DB, ev.id),
      ]);
      if (!p) return c.html(missingPage(ev, principal), 404);

      // One committee's private reading of one person's proposal.
      c.header('cache-control', 'private, no-store');
      return c.html(
        renderProposal({
          ev,
          principal,
          p,
          questions,
          mayDecide: mayDecide(principal, ev.id),
          mayAsk: mayAsk(principal, ev.id),
          armed: c.req.query('change') === '1',
          outcome: c.req.query('outcome'),
          nowMs: Date.now(),
        })
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/submissions/:id/decide', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const id = c.req.param('id');
    const home = `/admin/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}`;
    const back = (code: string, anchor: string): string =>
      `${home}?outcome=${encodeURIComponent(code)}${anchor}`;

    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === slug);
      if (!ev) return c.html(deniedPage(), 403);
      if (reviewerOnly(principal, ev.id)) return c.html(deniedPage(), 403);
      // Said here in this screen's words rather than letting the workflow's
      // ScopeError become a heading — a refusal is a sentence, not a stack.
      if (!mayDecide(principal, ev.id)) {
        return c.html(deniedPage('Deciding on this event is held by its organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const decision = DECISIONS[String(form['decision'] ?? '')];
      if (!decision) return c.redirect(back('no-decision', '#decide'), 303);
      const noteRaw = String(form['note'] ?? '').trim();
      const note = noteRaw === '' ? null : noteRaw;

      // Read it again before writing: the page may have been open for an hour
      // while somebody else worked the same pile.
      const fresh = await proposal(c.env.DB, principal, ev.id, id);
      if (!fresh) return c.redirect(back('not-here', '#decide'), 303);
      if (String(form['version'] ?? '') !== String(fresh.decisionVersion)) {
        return c.redirect(back('look-again', '#decide'), 303);
      }

      // D-024 second pass, enforced here and not only in the markup: a decision
      // that already exists cannot be changed without the arithmetic coming
      // back with it, and the number has to still be true.
      if (fresh.decidedAt !== null) {
        const confirm = form['confirm'];
        if (confirm === undefined) return c.redirect(back('second-look', '#decide'), 303);
        const openTasks = fresh.tasks.filter(
          (t) => t.completedAt === null && t.cancelledAt === null
        ).length;
        if (String(confirm) !== String(openTasks)) {
          return c.redirect(back('look-again', '#decide'), 303);
        }
      }

      const result = await stageDecision(c.env.DB, principal, ev.id, id, decision, note);
      if (!result.ok) return c.redirect(back(codeForRefusal(result.error), '#decide'), 303);
      // Straight to the words that will leave: the letter is written, and the
      // organizer reads it before the outbox act, not after it.
      return c.redirect(back(OUTCOME_FOR[decision], '#letters'), 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // Asking the speaker for something, from the proposal it is about. One click:
  // it is only on their list, and it comes off from their own page.
  app.post('/admin/:eventSlug/submissions/:id/ask', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const id = c.req.param('id');
    const home = `/admin/${encodeURIComponent(slug)}/submissions/${encodeURIComponent(id)}`;
    const back = (code: string, anchor: string): string =>
      `${home}?outcome=${encodeURIComponent(code)}${anchor}`;

    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === slug);
      if (!ev) return c.html(deniedPage(), 403);
      if (reviewerOnly(principal, ev.id)) return c.html(deniedPage(), 403);
      if (!mayAsk(principal, ev.id)) {
        return c.html(deniedPage('Asking speakers for things is held by this event’s organizers.'), 403);
      }

      // Read it again before writing: who sent this one in is a fact about the
      // proposal, and the page may have been open a while.
      const fresh = await proposal(c.env.DB, principal, ev.id, id);
      if (!fresh) return c.redirect(back('not-here', '#tasks'), 303);
      const who = askable(fresh);
      if (!who) return c.redirect(back('ask-not-here', '#people'), 303);

      const form = await c.req.parseBody();
      const result = await createTask(c.env.DB, principal, ev.id, {
        personId: who.personId,
        submissionId: id,
        kind: String(form['kind'] ?? ''),
        title: String(form['title'] ?? ''),
        dueOn: String(form['due'] ?? ''),
      });
      if (!result.ok) return c.redirect(back(`ask-${result.code}`, '#ask'), 303);
      return c.redirect(back('asked', '#tasks'), 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });
}

/** May this principal decide here? The rule lives in decide.ts; this only asks
 *  it, so the screen and the write can never disagree about who holds it. */
function mayDecide(principal: Principal, eventId: string): boolean {
  try {
    requireDecider(principal, eventId);
    return true;
  } catch {
    return false;
  }
}

/** May they ask this speaker for something? Same question, one standing wider:
 *  an editor who cannot decide can still chase the slides. */
function mayAsk(principal: Principal, eventId: string): boolean {
  try {
    requireScope(principal, eventId, EDIT_ROLES);
    return true;
  } catch {
    return false;
  }
}
