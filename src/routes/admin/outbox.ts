// S-19 — the outbox. The thesis screen: a decision leaves when you send it,
// not when you make it. Naomi at 23:40, at the moment of telling — six hundred
// people are about to learn something, and this is the last screen between the
// committee's mind and their evening. It owes her calm, and it owes her a
// number she can repeat out loud without checking twice.
//
// The laws this screen is built on:
//   D-024 — telling leaves the building, so it takes two passes. The first
//           states the arithmetic ("Send 610 decisions"), the second repeats
//           that exact number, carries it in the form, and the server guards
//           on it. The number a person confirms is the number that goes.
//   D-025 — every heading parses cold.
//   D-027 — nothing here knows the software is new.
//
// The read is queries/admin.ts `outbox()` (which denies a viewer outright) plus
// one local query for the history of what has already gone. The writes are
// workflows/release.ts `releaseDecisions()` and workflows/tasks.ts
// `stageNotes` / `withdrawNotes` / `releaseNotes` — the guards, the cohort and
// the email pass all live there, so this file never re-derives what "staged"
// means or who may send.
//
// Two things leave from this screen and they never share a number. A decision
// cohort is guarded on the decisions count; a message to a room is guarded on
// its own. Each has its own band, its own arithmetic and its own confirm, and
// no button on this page can send the other one's post.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, type LabelKey } from '../../lib/labels';
import {
  adminEvents,
  outbox,
  requireScope,
  LETTER_ROLES,
  ScopeError,
  type AdminEvent,
  type Outbox,
  type OutboxMessage,
  type SubmissionState,
} from '../../queries/admin';
import { reviewerOnly } from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { requireDecider } from '../../workflows/decide';
import { releaseDecisions } from '../../workflows/release';
import { AUDIENCES, releaseNotes, stageNotes, withdrawNotes } from '../../workflows/tasks';

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/** A label that may be missing: an unmapped kind says nothing rather than
 *  printing its stored value or taking the page down. */
function word(key: string): string {
  try {
    return label(key as LabelKey, 'backstage');
  } catch {
    return '';
  }
}

const STATE_KEY: Record<string, string> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};

const KIND_KEY: Record<string, string> = {
  received: 'message.kind.received',
  decision: 'message.kind.decision',
  task: 'message.kind.task',
  reminder: 'message.kind.task',
  schedule: 'message.kind.schedule',
};

/** The word above a letter written to a room. 02 §6 names five kinds of message
 *  and this is not one of them, so this screen supplies its own word — and
 *  supplies the same one in all three places such a letter can appear: staged,
 *  in the band, and in the history afterwards. */
const TO_PEOPLE = 'To people';

const kindWord = (kind: string): string =>
  kind === 'note' ? TO_PEOPLE : word(KIND_KEY[kind] ?? '');

/** The order the committee thinks in: yes, maybe, no. */
const STATE_ORDER: SubmissionState[] = ['accepted', 'waitlisted', 'rejected'];

const stateWord = (s: SubmissionState | null): string => (s ? word(STATE_KEY[s] ?? '') : '');

/** Fill a label's {tokens}; values arrive already escaped. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');
}

const num = (x: number): string => x.toLocaleString('en-US');
const plural = (x: number, one: string, many: string): string =>
  x === 1 ? `1 ${one}` : `${num(x)} ${many}`;

/* ------------------------------------------------------------------ *
 * Dates, on the event's own clock
 * ------------------------------------------------------------------ */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec'];

type Parts = { y: number; m: number; d: number; hh: number; mi: number };

function partsOf(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(f.find((p) => p.type === t)?.value ?? '0');
  return { y: n('year'), m: n('month'), d: n('day'), hh: n('hour') % 24, mi: n('minute') };
}

const pad = (x: number): string => (x < 10 ? `0${x}` : String(x));
/** "4 Aug" */
const dShort = (ms: number, tz: string): string => {
  const p = partsOf(ms, tz);
  return `${p.d} ${MONTHS_SHORT[p.m - 1]}`;
};
/** "17:10" */
const dTime = (ms: number, tz: string): string => {
  const p = partsOf(ms, tz);
  return `${pad(p.hh)}:${pad(p.mi)}`;
};

/* ------------------------------------------------------------------ *
 * What has already gone — the local read
 *
 * A release delivers its whole cohort on one instant, so the history is read
 * as batches rather than as six hundred identical lines: one moment, one
 * subject, a count, and how many of them also went by email. This is the only
 * query in this file, and it takes the same standing the outbox does.
 * ------------------------------------------------------------------ */

type SentBatch = {
  kind: string;
  subject: string;
  deliveredAt: number;
  count: number;
  emailed: number;
};

type SentHistory = { total: number; emailed: number; batches: SentBatch[] };

const HISTORY_LIMIT = 24;

async function sentHistory(
  db: D1Database,
  principal: Principal,
  eventId: string
): Promise<SentHistory> {
  requireScope(principal, eventId, LETTER_ROLES);

  const [batchRes, totalRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT m.kind, m.subject, m.delivered_at, COUNT(*) AS n,
                COUNT(m.emailed_at) AS emailed
         FROM message m
         WHERE m.event_id = ? AND m.delivered_at IS NOT NULL
         GROUP BY m.delivered_at, m.kind, m.subject
         ORDER BY m.delivered_at DESC, n DESC
         LIMIT ${HISTORY_LIMIT}`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(emailed_at) AS emailed
         FROM message WHERE event_id = ? AND delivered_at IS NOT NULL`
      )
      .bind(eventId),
  ]);

  const rows = (batchRes?.results ?? []) as unknown as {
    kind: string;
    subject: string;
    delivered_at: number;
    n: number;
    emailed: number;
  }[];
  const totals = ((totalRes?.results ?? []) as unknown as { n: number; emailed: number }[])[0];

  return {
    total: totals?.n ?? 0,
    emailed: totals?.emailed ?? 0,
    batches: rows.map((r) => ({
      kind: r.kind,
      subject: r.subject,
      deliveredAt: r.delivered_at,
      count: r.n,
      emailed: r.emailed,
    })),
  };
}

/**
 * Relative time for something recently prepared — same phrasing family as
 * the register's other relative timestamps (proposal.ts's rel()), scoped
 * locally per this build's per-file convention (see agenda.ts, greenroom.ts).
 */
function agoText(ms: number, nowMs: number, tz: string): string {
  const diff = Math.max(0, nowMs - ms);
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'moments ago';
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  return `on ${dShort(ms, tz)}`;
}

/**
 * The masthead's one live fact (fresh-eyes-design-review.md item 2): how
 * fresh the staged pile is, read off the messages already fetched for this
 * screen — the newest createdAt across every staged group, decisions and
 * notes alike. No second query.
 */
function lastPreparedFact(ob: Outbox, tz: string): string {
  const stamps = ob.groups.flatMap((g) => g.messages.map((m) => m.createdAt));
  if (stamps.length === 0) return '';
  const latest = Math.max(...stamps);
  return `<p class="livefact">Last prepared ${esc(agoText(latest, Date.now(), tz))}.</p>`;
}

/* ------------------------------------------------------------------ *
 * One letter
 * ------------------------------------------------------------------ */

// stageDecision writes the committee's note onto the end of the letter under
// this exact heading, so the screen can lift it back out and show it in its
// own box — the organizer sees her own words where the speaker will see them.
const NOTE_MARK = '\n\nFrom the committee:\n';

function splitLetter(body: string): { main: string; note: string | null } {
  const at = body.indexOf(NOTE_MARK);
  if (at === -1) return { main: body, note: null };
  return { main: body.slice(0, at), note: body.slice(at + NOTE_MARK.length) };
}

/** The first breath of the letter, for the closed row. */
function preview(flat: string): string {
  if (flat.length <= 116) return flat;
  const cut = flat.slice(0, 116);
  const space = cut.lastIndexOf(' ');
  return `${space > 60 ? cut.slice(0, space) : cut}…`;
}

function committeeNote(text: string): string {
  return (
    '<div class="notebox" style="margin-top:10px">' +
    '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">' +
    'Your note</b>' +
    `<p style="margin:6px 0 0" class="serif">${esc(text)}</p></div>`
  );
}

/**
 * The letter as the organizer reads it. Nothing is folded away that is not
 * genuinely there: a short letter with no note has no chevron to click, and a
 * letter that goes on opens onto the whole of itself with her note at the end.
 */
function letterBody(main: string, note: string | null): string {
  const flat = main.replace(/\s+/g, ' ').trim();
  const head = preview(flat);
  const more = head !== flat;
  if (!more && !note) return `<div class="mprev">${esc(head)}</div>`;
  return (
    '<details>' +
    `<summary class="mprev" style="cursor:pointer">${esc(head)}</summary>` +
    (more ? `<div class="mprev" style="white-space:pre-wrap;margin-top:8px">${esc(main)}</div>` : '') +
    (note ? committeeNote(note) : '') +
    '</details>'
  );
}

function letterRow(slug: string, m: OutboxMessage): string {
  const { main, note } = splitLetter(m.body);
  const kind = kindWord(m.kind);
  const chip = m.hasEmail
    ? `<span class="chip s-undecided">${esc(label('message.staged', 'backstage'))}</span>`
    : `<span class="chip warn">${esc(label('message.blocked', 'backstage'))}</span>`;
  const about =
    m.submissionId && m.submissionTitle
      ? `<div class="sub" style="margin-top:5px"><a class="link" href="/admin/${encodeURIComponent(
          slug
        )}/submissions/${encodeURIComponent(m.submissionId)}">${esc(m.submissionTitle)}</a></div>`
      : '';

  return (
    '<div class="msg">' +
    `<div class="mk">${esc(kind)}</div>` +
    '<div>' +
    `<div class="msub">${esc(m.subject)} <span class="sub" style="font-weight:400">— ${esc(
      m.recipient
    )}</span></div>` +
    letterBody(main, note) +
    about +
    '</div>' +
    `<div>${chip}</div></div>`
  );
}

/** How much of a group to draw. The whole set is read; the page stays light. */
const SAMPLE = 12;

function lettersBlock(slug: string, heading: string, rows: OutboxMessage[]): string {
  const shown = rows.slice(0, SAMPLE);
  const line =
    shown.length === rows.length
      ? `All ${plural(rows.length, 'letter', 'letters')}, in the order they will go.`
      : `Showing ${num(shown.length)} of ${num(rows.length)} — every one reads like this, with ` +
        'your note underneath.';
  return (
    '<div class="sec">' +
    `<h2 class="display" style="font-size:24px">${esc(heading)} · ${esc(num(rows.length))}</h2>` +
    `<p class="sub" style="margin:4px 0 8px">${esc(line)}</p>` +
    shown.map((m) => letterRow(slug, m)).join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The bands at the top
 * ------------------------------------------------------------------ */

/** "12 maybe, 598 declined" — the words are the label map's, always. */
function breakdown(ob: Outbox): string {
  const known = STATE_ORDER.map((s) => ob.decisionsByState.find((r) => r.state === s)).filter(
    (r): r is { state: SubmissionState; count: number } => r !== undefined && r.count > 0
  );
  const rest = ob.decisionsByState.filter((r) => !STATE_ORDER.includes(r.state) && r.count > 0);
  return [...known, ...rest]
    .map((r) => `${num(r.count)} ${stateWord(r.state).toLowerCase()}`)
    .join(', ');
}

function noteBox(text: string): string {
  return (
    '<div class="notebox" style="margin-top:18px" role="status">' +
    `<p style="margin:0" class="serif">${esc(text)}</p></div>`
  );
}

/** First pass: the arithmetic, and a button that only asks the question. */
function askBand(slug: string, ob: Outbox): string {
  const n = ob.decisionsStaged;
  const send = `Send ${plural(n, 'decision', 'decisions')}`;
  return (
    `<form class="sec attn" method="get" action="/admin/${encodeURIComponent(slug)}/outbox">` +
    `<div class="n">${esc(num(n))}</div>` +
    '<div>' +
    `<div class="lab">${esc(send)}. Each person gets the letter you have read.</div>` +
    '<div class="why">They land in the speakers’ portals at once, and real addresses get an ' +
    'email too. You cannot take it back.</div>' +
    '</div>' +
    `<input type="hidden" name="confirm" value="${esc(String(n))}">` +
    `<button class="btn btn-primary go" type="submit">${esc(send)}</button>` +
    '</form>'
  );
}

/** Second pass: the same number, carried in the form and guarded on the way in. */
function confirmBand(slug: string, ob: Outbox): string {
  const n = ob.decisionsStaged;
  const send = `Send ${plural(n, 'decision', 'decisions')}`;
  const spread = breakdown(ob);
  return (
    `<form class="sec attn" method="post" action="/admin/${encodeURIComponent(
      slug
    )}/outbox/release">` +
    `<div class="n">${esc(num(n))}</div>` +
    '<div>' +
    `<div class="lab">${esc(send)}?</div>` +
    `<div class="why">${spread ? `${esc(spread)}. ` : ''}Every one carries your note. Once this ` +
    `goes, ${esc(plural(n, 'person knows', 'people know'))}.</div>` +
    '</div>' +
    `<input type="hidden" name="expected" value="${esc(String(n))}">` +
    '<div class="btnrow go">' +
    `<button class="btn btn-primary" type="submit">${esc(send)}</button>` +
    `<a class="btn" href="/admin/${encodeURIComponent(slug)}/outbox">Not yet</a>` +
    '</div></form>'
  );
}

function blockedBand(slug: string, ob: Outbox): string {
  if (ob.missingEmail.length === 0) return '';
  const first = ob.missingEmail[0];
  if (!first) return '';
  const others = ob.missingEmail.length - 1;
  const who =
    others === 0
      ? first.name
      : others === 1
        ? `${first.name} and one other`
        : `${first.name} and ${num(others)} others`;
  return (
    '<div class="sec" style="border:1px solid #E4C4BF;background:var(--danger-wash);' +
    'border-radius:var(--r);padding:14px 16px">' +
    `<b>No email address for ${esc(who)}.</b> The letter still lands in the portal, and that is ` +
    'where it stays. ' +
    `<a class="link" href="/admin/${encodeURIComponent(slug)}/people">Add one on their profile →</a>` +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * Writing to people
 *
 * A message to a whole room is one letter with many recipients, so it is drawn
 * as one letter with a count on it — six hundred identical rows would be six
 * hundred ways of saying the same sentence. Its own band, its own number, its
 * own confirm; the decisions arithmetic above never sees it.
 * ------------------------------------------------------------------ */

type NoteBatch = { at: number; subject: string; body: string; count: number; blocked: number };

/** Staged messages, gathered back into the groups they were written in. The
 *  instant is the group's name: one write, one instant, one batch. */
function noteBatches(rows: OutboxMessage[]): NoteBatch[] {
  const byInstant = new Map<number, NoteBatch>();
  for (const m of rows) {
    const found = byInstant.get(m.createdAt);
    const batch = found ?? {
      at: m.createdAt,
      subject: m.subject,
      body: m.body,
      count: 0,
      blocked: 0,
    };
    batch.count += 1;
    if (!m.hasEmail) batch.blocked += 1;
    if (!found) byInstant.set(m.createdAt, batch);
  }
  return [...byInstant.values()].sort((a, b) => b.at - a.at);
}

function noteBatchRow(slug: string, ev: AdminEvent, b: NoteBatch): string {
  const flat = b.body.replace(/\s+/g, ' ').trim();
  const written = `${esc(plural(b.count, 'person', 'people'))}, written at ${esc(
    dTime(b.at, ev.timezone)
  )}`;
  const inPortalOnly =
    b.blocked > 0
      ? `<div class="sub" style="margin-top:4px">${esc(
          plural(b.blocked, 'person has', 'people have')
        )} no address — it lands in the portal and stays there.</div>`
      : '';
  return (
    '<div class="msg">' +
    `<div class="mk">${esc(TO_PEOPLE)}</div>` +
    '<div>' +
    `<div class="msub">${esc(b.subject)}</div>` +
    `<div class="mprev" style="white-space:pre-wrap">${esc(flat)}</div>` +
    `<div class="sub" style="margin-top:5px">${written}</div>` +
    inPortalOnly +
    `<form method="post" style="margin-top:8px" action="/admin/${encodeURIComponent(
      slug
    )}/outbox/notes/withdraw">` +
    `<input type="hidden" name="at" value="${esc(String(b.at))}">` +
    '<button class="btn btn-sm btn-quiet" type="submit">Take it back</button></form>' +
    '</div>' +
    `<div><span class="chip s-undecided">${esc(label('message.staged', 'backstage'))}</span></div>` +
    '</div>'
  );
}

/** First pass: the arithmetic, and a button that only asks the question. */
function notesAskBand(slug: string, n: number): string {
  const send = `Send ${plural(n, 'message', 'messages')}`;
  return (
    `<form class="attn" style="margin-top:16px" method="get" action="/admin/${encodeURIComponent(
      slug
    )}/outbox">` +
    `<div class="n">${esc(num(n))}</div>` +
    '<div>' +
    `<div class="lab">${esc(send)}. Everyone on the list gets the words you have read.</div>` +
    '<div class="why">They land in the speakers’ portals at once, and real addresses get an ' +
    'email too. You cannot take it back.</div>' +
    '</div>' +
    `<input type="hidden" name="confirm_notes" value="${esc(String(n))}">` +
    `<button class="btn btn-primary go" type="submit">${esc(send)}</button>` +
    '</form>'
  );
}

/** Second pass: the same number, carried in the form and guarded on the way in. */
function notesConfirmBand(slug: string, n: number): string {
  const send = `Send ${plural(n, 'message', 'messages')}`;
  return (
    `<form class="attn" style="margin-top:16px" method="post" action="/admin/${encodeURIComponent(
      slug
    )}/outbox/notes/release">` +
    `<div class="n">${esc(num(n))}</div>` +
    '<div>' +
    `<div class="lab">${esc(send)}?</div>` +
    `<div class="why">Once this goes, ${esc(
      plural(n, 'person has it', 'people have it')
    )} and nothing here can be taken back.</div>` +
    '</div>' +
    `<input type="hidden" name="expected" value="${esc(String(n))}">` +
    '<div class="btnrow go">' +
    `<button class="btn btn-primary" type="submit">${esc(send)}</button>` +
    `<a class="btn" href="/admin/${encodeURIComponent(slug)}/outbox">Not yet</a>` +
    '</div></form>'
  );
}

function composer(slug: string): string {
  const rooms = AUDIENCES.map(
    (a) => `<option value="${esc(a.key)}">${esc(a.word)}</option>`
  ).join('');
  return (
    `<form class="card card-pad" style="margin-top:16px;max-width:44em" method="post" ` +
    `action="/admin/${encodeURIComponent(slug)}/outbox/notes">` +
    '<label class="f"><span class="f-lab">Who it goes to</span>' +
    `<select name="audience">${rooms}</select></label>` +
    '<label class="f"><span class="f-lab">Subject</span>' +
    '<input type="text" name="subject" required maxlength="120" ' +
    'placeholder="Where to send your slides"></label>' +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">What you want to say</span>' +
    '<textarea name="body" rows="5" required maxlength="2000" ' +
    'placeholder="Send them by the Friday before, and we will have them on the machine in the ' +
    'room."></textarea></label>' +
    '<div class="btnrow" style="margin-top:16px">' +
    '<button class="btn btn-primary" type="submit">Write it</button></div>' +
    '<p class="hint" style="margin-top:10px">It waits here with everything else until you send it, ' +
    'and you can take it back until then.</p>' +
    '</form>'
  );
}

function writeSection(
  ev: AdminEvent,
  notes: OutboxMessage[],
  confirmingNotes: boolean
): string {
  const slug = ev.slug;
  const n = notes.length;
  const band = n === 0 ? '' : confirmingNotes ? notesConfirmBand(slug, n) : notesAskBand(slug, n);
  const batches = noteBatches(notes)
    .map((b) => noteBatchRow(slug, ev, b))
    .join('');
  const standing =
    n === 0
      ? 'One letter to everybody at once — everyone accepted, everyone still undecided, everyone ' +
        'who owes you something.'
      : `${plural(n, 'letter is', 'letters are')} written and waiting. They go when you send them, ` +
        'and not before.';
  return (
    '<div class="sec">' +
    '<h2 class="display" style="font-size:24px">Write to people</h2>' +
    `<p class="sub" style="margin:4px 0 0">${esc(standing)}</p>` +
    band +
    batches +
    composer(slug) +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The history
 * ------------------------------------------------------------------ */

function sentBlock(ev: AdminEvent, hist: SentHistory): string {
  if (hist.total === 0) return '';
  const rows = hist.batches
    .map((b) => {
      const kind = kindWord(b.kind);
      const when = fill(label('message.delivered', 'backstage'), {
        date: esc(dShort(b.deliveredAt, ev.timezone)),
      });
      const alsoEmailed =
        b.emailed > 0
          ? `<div class="sub" style="margin-top:5px">${esc(num(b.emailed))} also emailed</div>`
          : '';
      return (
        '<div class="msg">' +
        `<div class="mk">${esc(kind)}</div>` +
        '<div>' +
        `<div class="msub">${esc(b.subject)}</div>` +
        `<div class="mprev">${esc(plural(b.count, 'letter', 'letters'))} went out at ` +
        `${esc(dTime(b.deliveredAt, ev.timezone))}.</div>` +
        alsoEmailed +
        '</div>' +
        `<div class="sub">${when}</div></div>`
      );
    })
    .join('');
  const more =
    hist.batches.length === HISTORY_LIMIT
      ? '<p class="hint">The most recent sendings. Every letter also sits on its own proposal.</p>'
      : '';
  return (
    '<div class="sec">' +
    '<h2 class="display" style="font-size:24px">Already sent</h2>' +
    `<p class="sub" style="margin:4px 0 8px">${esc(
      plural(hist.total, 'letter has', 'letters have')
    )} left this conference. Each one is in the portal it was sent to.</p>` +
    rows +
    more +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((p) => p !== '')
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '·';

function canDecide(principal: Principal, eventId: string): boolean {
  try {
    requireDecider(principal, eventId);
    return true;
  } catch {
    return false;
  }
}

type View = {
  ev: AdminEvent;
  principal: Principal;
  ob: Outbox;
  hist: SentHistory;
  /** Present when the first pass has been taken and the number is still true. */
  confirming: boolean;
  /** The same, on the messages' own number — the two never share one. */
  confirmingNotes: boolean;
  note: string;
};

function outboxPage(v: View): string {
  const { ev, ob, hist } = v;
  const slug = ev.slug;
  const decider = canDecide(v.principal, ev.id);
  const spread = breakdown(ob);
  const notes = ob.groups.find((g) => g.kind === 'note')?.messages ?? [];
  const write = writeSection(ev, notes, v.confirmingNotes);

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Outbox</h1>' +
    '<p class="counts">' +
    (ob.staged > 0
      ? `<b>${esc(label('message.staged', 'backstage'))} · ${esc(num(ob.staged))}</b>` +
        (spread ? `<span class="sep">·</span>${esc(spread)}` : '') +
        (notes.length > 0
          ? `<span class="sep">·</span>${esc(num(notes.length))} written to people`
          : '')
      : '<b>Nothing to send</b>') +
    (ev.tzLabel ? `<span class="sep">·</span>${esc(ev.tzLabel)}` : '') +
    '</p></div>' +
    (ob.staged > 0 ? lastPreparedFact(ob, ev.timezone) : '') +
    (v.note ? noteBox(v.note) : '');

  if (ob.staged === 0) {
    return page({
      title: `Outbox · ${ev.name}`,
      register: 'backstage',
      body: backstageShell({
        eventSlug: slug,
        eventName: ev.name,
        here: '/outbox',
        who: v.principal.name,
        whoInitials: initialsOf(v.principal.name),
        tzLabel: ev.tzLabel ?? ev.timezone,
        body:
          head +
          '<div class="sec state-out"><h2>Nothing to send.</h2>' +
          '<p>Decisions you make show up here before they go out, so you can read them first. ' +
          'So does anything you write to people yourself.</p>' +
          `<a class="btn btn-primary" href="/admin/${encodeURIComponent(
            slug
          )}/submissions">Go to proposals →</a></div>` +
          write +
          sentBlock(ev, hist),
      }),
    });
  }

  // The decisions band, or the plain sentence that says why there is none. It
  // says nothing at all when there are no decisions waiting: the messages
  // below have their own band and their own count.
  const band =
    ob.decisionsStaged === 0
      ? ''
      : !decider
        ? '<p class="hint" style="margin-top:18px">The decisions go out when someone who decides ' +
          'on this conference sends them. You can read every one first.</p>'
        : v.confirming
          ? confirmBand(slug, ob)
          : askBand(slug, ob);

  // Decisions first, split the way the committee decided; then anything else.
  // Messages to a room are not letters about a proposal, so they are not in
  // this run at all — they have their own section, under their own number.
  const blocks: string[] = [];
  for (const group of ob.groups) {
    if (group.kind === 'note') continue;
    if (group.kind === 'decision') {
      const seen = new Set<string>();
      const order: (SubmissionState | 'other')[] = [...STATE_ORDER];
      for (const m of group.messages) {
        const s = m.submissionState;
        const bucket: SubmissionState | 'other' =
          s && STATE_ORDER.includes(s) ? s : 'other';
        if (!order.includes(bucket)) order.push(bucket);
        seen.add(bucket);
      }
      for (const bucket of order) {
        if (!seen.has(bucket)) continue;
        const rows = group.messages.filter((m) => {
          const s = m.submissionState;
          return bucket === 'other' ? !s || !STATE_ORDER.includes(s) : s === bucket;
        });
        if (rows.length === 0) continue;
        const heading =
          bucket === 'other'
            ? word(KIND_KEY[group.kind] ?? '')
            : stateWord(bucket as SubmissionState);
        blocks.push(lettersBlock(slug, heading, rows));
      }
    } else {
      blocks.push(lettersBlock(slug, word(KIND_KEY[group.kind] ?? '') || 'Letters', group.messages));
    }
  }

  return page({
    title: `Outbox · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: slug,
      eventName: ev.name,
      here: '/outbox',
      who: v.principal.name,
      whoInitials: initialsOf(v.principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body:
        head +
        band +
        blockedBand(slug, ob) +
        blocks.join('') +
        write +
        sentBlock(ev, hist),
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// One closed set of sentences. The only things that travel in the query string
// are counts and codes from this list — free text never rides a URL.
const MOVED = 'The pile moved while you were reading. Look again, then send.';
const NOTES_MOVED = 'The outbox moved while you were reading. Look again, then send.';

/** What writing to a room can refuse, in the words this screen would use. */
const WRITE_OUTCOMES: Record<string, string> = {
  'no-audience': 'Say which room it goes to, and it will be waiting here.',
  'no-subject': 'A letter needs a subject — it is the line they read first.',
  'no-body': 'A letter needs something in it.',
  nobody: 'Nobody is in that room yet, so nothing was written.',
  gone: 'Those have already gone, so there was nothing to take back.',
  trouble: 'That did not go through, and nothing changed. Worth trying once more.',
};

// The sentence is escaped once, by noteBox, on its way onto the page.
function sentSentence(released: number, emailed: number): string {
  const gone = `${plural(released, 'letter', 'letters')} delivered.`;
  if (emailed >= released) return `${gone} ${num(emailed)} emailed as well.`;
  return `${gone} ${num(emailed)} emailed — the rest live in their portals.`;
}

const wroteSentence = (n: number): string =>
  `${plural(n, 'letter is', 'letters are')} written and waiting below. Nothing has gone out.`;

const tookBackSentence = (n: number): string =>
  `${plural(n, 'letter', 'letters')} taken back. Nothing had gone out.`;

/** A count this screen wrote itself, read back. Anything else is ignored
 *  rather than echoed. */
function counted(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function eventFor(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<AdminEvent | undefined> {
  const events = await adminEvents(db, principal);
  const ev = events.find((e) => e.slug === slug);
  // A reviewer holds the reading room and nothing else. Not the letters, and
  // not the fact that a letter exists — so the refusal is the plain one, which
  // says nothing about this conference having an outbox at all.
  return ev && reviewerOnly(principal, ev.id) ? undefined : ev;
}

/** A viewer holds the event but not the letters — say that, not "not yours". */
function refusal(principal: Principal, ev: AdminEvent | undefined, message: string): string {
  if (ev && principal.eventRoles[ev.id] === 'viewer') {
    return deniedPage('The letters are not yours to read on this conference.');
  }
  return deniedPage(message);
}

export function registerOutbox(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/outbox', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    let ev: AdminEvent | undefined;
    try {
      ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      const [ob, hist] = await Promise.all([
        outbox(c.env.DB, principal, ev.id),
        sentHistory(c.env.DB, principal, ev.id),
      ]);

      // ?sent / ?emailed are counts this screen wrote itself; anything else in
      // them is ignored rather than echoed.
      const sent = Number(c.req.query('sent') ?? '');
      const emailed = Number(c.req.query('emailed') ?? '');
      const told =
        Number.isInteger(sent) && sent > 0 && Number.isInteger(emailed) && emailed >= 0
          ? sentSentence(sent, emailed)
          : '';

      const notesStaged = ob.groups.find((g) => g.kind === 'note')?.count ?? 0;

      // The first pass hands the number back. If the pile moved in between, the
      // confirm is not shown — the number on screen is always the number now.
      const confirm = c.req.query('confirm');
      const asked = confirm !== undefined && confirm !== '';
      const confirming = asked && Number(confirm) === ob.decisionsStaged && ob.decisionsStaged > 0;

      // The same again, on the messages' own count.
      const confirmNotes = c.req.query('confirm_notes');
      const askedNotes = confirmNotes !== undefined && confirmNotes !== '';
      const confirmingNotes = askedNotes && Number(confirmNotes) === notesStaged && notesStaged > 0;

      const notesSent = counted(c.req.query('notes_sent'));
      const notesEmailed = Number(c.req.query('notes_emailed') ?? '');
      const wrote = counted(c.req.query('wrote'));
      const took = counted(c.req.query('back'));
      const code = c.req.query('note');

      const said =
        told ||
        (notesSent !== null && Number.isInteger(notesEmailed) && notesEmailed >= 0
          ? sentSentence(notesSent, notesEmailed)
          : '') ||
        (wrote !== null ? wroteSentence(wrote) : '') ||
        (took !== null ? tookBackSentence(took) : '') ||
        (code ? (WRITE_OUTCOMES[code] ?? '') : '') ||
        (asked && !confirming ? MOVED : '') ||
        (askedNotes && !confirmingNotes ? NOTES_MOVED : '');

      return c.html(
        outboxPage({
          ev,
          principal,
          ob,
          hist,
          confirming,
          confirmingNotes,
          note: said,
        })
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(refusal(principal, ev, e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/outbox/release', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    let ev: AdminEvent | undefined;
    try {
      ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      // Said here rather than left to releaseDecisions, so the refusal is a
      // sentence and not the workflow's own machinery talking.
      if (!canDecide(principal, ev.id)) {
        return c.html(deniedPage('Sending the letters is not yours on this conference.'), 403);
      }

      const form = await c.req.parseBody();
      const raw = String(form['expected'] ?? '');
      const expected = Number(raw);
      const sane = /^\d+$/.test(raw) && Number.isSafeInteger(expected);

      // A refusal re-renders the screen it came from, with its own sentence —
      // the number in front of her is always the number in the database.
      const again = async (message: string) => {
        // T612 — an agent driving this door gets a parseable refusal instead
        // of a re-rendered page: same sentence, machine shape, honest 409.
        if ((c.req.header('accept') ?? '').includes('application/json')) {
          return c.json({ ok: false, refused: message }, 409);
        }
        const [ob, hist] = await Promise.all([
          outbox(c.env.DB, principal, ev!.id),
          sentHistory(c.env.DB, principal, ev!.id),
        ]);
        return c.html(
          outboxPage({
            ev: ev!,
            principal,
            ob,
            hist,
            confirming: false,
            confirmingNotes: false,
            note: message,
          })
        );
      };

      if (!sane) return await again(MOVED);

      const res = await releaseDecisions(
        c.env.DB,
        principal,
        ev.id,
        expected,
        { binding: c.env.EMAIL, from: c.env.FROM_EMAIL },
        (p) => c.executionCtx.waitUntil(p)
      );
      if (!res.ok) return await again(res.error);

      return c.redirect(
        `/admin/${encodeURIComponent(slug)}/outbox?sent=${res.released}&emailed=${res.emailed}`,
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(refusal(principal, ev, e.message), 403);
      throw e;
    }
  });

  /* ---------- writing to a room ---------- */

  // One click, because nothing leaves: the letters sit here under their own
  // number until somebody sends them, and until then they can be taken back.
  app.post('/admin/:eventSlug/outbox/notes', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const home = `/admin/${encodeURIComponent(slug)}/outbox`;
    let ev: AdminEvent | undefined;
    try {
      ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);

      const form = await c.req.parseBody();
      const res = await stageNotes(c.env.DB, principal, ev.id, {
        audience: String(form['audience'] ?? ''),
        subject: String(form['subject'] ?? ''),
        body: String(form['body'] ?? ''),
      });
      if (!res.ok) return c.redirect(`${home}?note=${encodeURIComponent(res.code)}`, 303);
      return c.redirect(`${home}?wrote=${res.staged}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(refusal(principal, ev, e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/outbox/notes/withdraw', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const home = `/admin/${encodeURIComponent(slug)}/outbox`;
    let ev: AdminEvent | undefined;
    try {
      ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);

      const form = await c.req.parseBody();
      const at = Number(String(form['at'] ?? ''));
      if (!Number.isSafeInteger(at) || at <= 0) return c.redirect(`${home}?note=gone`, 303);

      const res = await withdrawNotes(c.env.DB, principal, ev.id, at);
      if (!res.ok) return c.redirect(`${home}?note=${encodeURIComponent(res.code)}`, 303);
      return c.redirect(`${home}?back=${res.taken}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(refusal(principal, ev, e.message), 403);
      throw e;
    }
  });

  // The second pass, on the messages' own number. releaseDecisions is not called
  // here and could not be: its cohort is decisions, and this one is not.
  app.post('/admin/:eventSlug/outbox/notes/release', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    let ev: AdminEvent | undefined;
    try {
      ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);

      const form = await c.req.parseBody();
      const raw = String(form['expected'] ?? '');
      const expected = Number(raw);
      const sane = /^\d+$/.test(raw) && Number.isSafeInteger(expected) && expected > 0;

      const again = async (message: string) => {
        // T612 — an agent driving this door gets a parseable refusal instead
        // of a re-rendered page: same sentence, machine shape, honest 409.
        if ((c.req.header('accept') ?? '').includes('application/json')) {
          return c.json({ ok: false, refused: message }, 409);
        }
        const [ob, hist] = await Promise.all([
          outbox(c.env.DB, principal, ev!.id),
          sentHistory(c.env.DB, principal, ev!.id),
        ]);
        return c.html(
          outboxPage({
            ev: ev!,
            principal,
            ob,
            hist,
            confirming: false,
            confirmingNotes: false,
            note: message,
          })
        );
      };

      if (!sane) return await again(NOTES_MOVED);

      const res = await releaseNotes(
        c.env.DB,
        principal,
        ev.id,
        expected,
        { binding: c.env.EMAIL, from: c.env.FROM_EMAIL },
        (p) => c.executionCtx.waitUntil(p)
      );
      if (!res.ok) return await again(NOTES_MOVED);

      return c.redirect(
        `/admin/${encodeURIComponent(slug)}/outbox?notes_sent=${res.released}` +
          `&notes_emailed=${res.emailed}`,
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(refusal(principal, ev, e.message), 403);
      throw e;
    }
  });
}
