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
// one local query for the history of what has already gone. The write is
// workflows/release.ts `releaseDecisions()` and nothing else — the guard, the
// cohort and the email pass all live there, so this file never re-derives what
// "staged" means or who may send.

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
import { principalFromCookie, type Principal } from '../../workflows/account';
import { requireDecider } from '../../workflows/decide';
import { releaseDecisions } from '../../workflows/release';

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
  const kind = word(KIND_KEY[m.kind] ?? '');
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
 * The history
 * ------------------------------------------------------------------ */

function sentBlock(ev: AdminEvent, hist: SentHistory): string {
  if (hist.total === 0) return '';
  const rows = hist.batches
    .map((b) => {
      const kind = word(KIND_KEY[b.kind] ?? '');
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
  note: string;
};

function outboxPage(v: View): string {
  const { ev, ob, hist } = v;
  const slug = ev.slug;
  const decider = canDecide(v.principal, ev.id);
  const spread = breakdown(ob);

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Outbox</h1>' +
    '<p class="counts">' +
    (ob.staged > 0
      ? `<b>${esc(label('message.staged', 'backstage'))} · ${esc(num(ob.staged))}</b>` +
        (spread ? `<span class="sep">·</span>${esc(spread)}` : '')
      : '<b>Nothing to send</b>') +
    (ev.tzLabel ? `<span class="sep">·</span>${esc(ev.tzLabel)}` : '') +
    '</p></div>' +
    '<div class="sec standing">Messages land in each speaker’s portal. Real addresses get real ' +
    'email too.</div>' +
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
          '<p>Decisions you make show up here before they go out, so you can read them first.</p>' +
          `<a class="btn btn-primary" href="/admin/${encodeURIComponent(
            slug
          )}/submissions">Go to proposals →</a></div>` +
          sentBlock(ev, hist),
      }),
    });
  }

  // The band, or the plain sentence that says why there is no band.
  const band = !decider
    ? '<p class="hint" style="margin-top:18px">These go out when someone who decides on this ' +
      'conference sends them. You can read every one first.</p>'
    : ob.decisionsStaged === 0
      ? '<p class="hint" style="margin-top:18px">These are written and waiting. Only decisions ' +
        'go out from this screen.</p>'
      : v.confirming
        ? confirmBand(slug, ob)
        : askBand(slug, ob);

  // Decisions first, split the way the committee decided; then anything else.
  const blocks: string[] = [];
  for (const group of ob.groups) {
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
      body: head + band + blockedBand(slug, ob) + blocks.join('') + sentBlock(ev, hist),
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// One closed set of sentences. The only things that travel in the query string
// are two counts and, on a refusal, nothing at all — free text never rides a URL.
const MOVED = 'The pile moved while you were reading. Look again, then send.';

// The sentence is escaped once, by noteBox, on its way onto the page.
function sentSentence(released: number, emailed: number): string {
  const gone = `${plural(released, 'letter', 'letters')} delivered.`;
  if (emailed >= released) return `${gone} ${num(emailed)} emailed as well.`;
  return `${gone} ${num(emailed)} emailed — the rest live in their portals.`;
}

async function eventFor(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<AdminEvent | undefined> {
  const events = await adminEvents(db, principal);
  return events.find((e) => e.slug === slug);
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

      // The first pass hands the number back. If the pile moved in between, the
      // confirm is not shown — the number on screen is always the number now.
      const confirm = c.req.query('confirm');
      const asked = confirm !== undefined && confirm !== '';
      const confirming = asked && Number(confirm) === ob.decisionsStaged && ob.decisionsStaged > 0;

      return c.html(
        outboxPage({
          ev,
          principal,
          ob,
          hist,
          confirming,
          note: told || (asked && !confirming ? MOVED : ''),
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
        const [ob, hist] = await Promise.all([
          outbox(c.env.DB, principal, ev!.id),
          sentHistory(c.env.DB, principal, ev!.id),
        ]);
        return c.html(
          outboxPage({ ev: ev!, principal, ob, hist, confirming: false, note: message })
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
}
