// Ask — the concierge, as a whole page, and as the bubble in the corner of
// every other page that belongs to a conference (islands/concierge.js).
//
// The page is the thing; the bubble is the same thing, closer to hand. Both
// ask this file, both are answered by workflows/ask.ts, and both offer exactly
// the chips this reader has earned — chipRow() below is the one builder, so a
// chip cannot appear in one place and not the other. The bubble's first paint
// is GET ?panel=1: a greeting and that row, and nothing else.
//
// Dani is mid-hall with one thumb and about ninety seconds. She does not want
// a conversation; she wants the room number and a way to walk there. So the
// screen is one input, an answer of two to four sentences, and the doors that
// answer opens — and under it, the questions the organizers have already
// written answers to, because most of what she wants to know somebody has
// already asked.
//
// Nothing here needs an account. Nothing here is tied to a name: the question
// row carries no person_id, by design, and the spend counter beside it keeps a
// day-salted digest rather than an address (lib/ratelimit.ts).
//
// Some of what she wants nobody needs to have asked. The chips above the FAQ
// are questions the object graph answers about itself — what is on right now,
// when the call closes, what she owes and by when — so pressing one costs a
// single query and no model call at all. They are instant, they are free, and
// the organizers wrote none of them: see INSTANT ANSWERS in workflows/ask.ts.
// A question typed in the box still goes the way it always went.
//
// Signing in changes what the concierge may read, never what is written down.
// Somebody who runs this conference is also answered from the pile's counts and
// the doors behind it; somebody who has sent proposals to it is answered about
// their own, in the words their portal uses. That scoping lives in
// workflows/ask.ts, and it is per conference — a standing held somewhere else
// earns nothing here, and a visitor with no standing is answered exactly as
// they were before.
//
// It works with JavaScript switched off. The form posts, the page comes back
// with the answer on it. src/islands/ask.js only removes the reload.
//
// Register: onstage. The concierge speaks in the first person — the label map
// already gives it that voice ("I can't see that") — warm, plain, second
// person to the reader, sentence case, no exclamation marks, no emoji.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, onstageShell, eventNav, conferenceMasthead } from '../../lib/html';
import { label } from '../../lib/labels';
import { eventBySlug, sessionBySlug, agenda, type EventHome } from '../../queries/public';
import { conciergeAct, canActHere, type SessionRef, type Referent, type Undo } from '../../workflows/plan';
import { commitPendingAction, type Surface } from '../../workflows/agent';
import { portalView } from '../../queries/portal';
import { helpingAt } from '../../queries/helpers';
import { claimAsk, clientIp } from '../../lib/ratelimit';
import { principalFromCookie } from '../../workflows/account';
import {
  agentHandshake,
  answerQuestion,
  curatedAnswers,
  intentAnswer,
  intentLabel,
  intentOf,
  isAboutThePage,
  logQuestion,
  matchCurated,
  offeredIntents,
  plainDoors,
  thisTalkAnswer,
  type AskResult,
  type CuratedAnswer,
  type Door,
  type IntentChip,
  type IntentCode,
  type QuestionScope,
} from '../../workflows/ask';
import type { Principal } from '../../workflows/account';
// Hand-written browser JavaScript, deliberately outside the TypeScript program
// (tsconfig has no allowJs). Same arrangement as the call's island.
// @ts-ignore -- plain-JS island; see cfp.ts for the same note.
import askIsland from '../../islands/ask.js';

/* ------------------------------------------------------------------ *
 * The closed set of outcome codes a redirect may carry. Each one is a
 * sentence this screen owns; nothing else may appear in ?note=.
 * ------------------------------------------------------------------ */

type Note = 'blank' | 'at-the-cap' | 'busy-today' | 'unsure';

const NOTES: Record<Note, string> = {
  blank: "Ask me something and I'll point you the right way.",
  'at-the-cap':
    "That's as many questions as I can take from you today. Everything I would have said is on the agenda and the speakers page.",
  'busy-today':
    "That's as many questions as I can take today. Everything I would have said is on the agenda and the speakers page.",
  unsure: `${label('ask.unknown', 'onstage')} — not from the program, anyway.`,
};

function noteFrom(raw: string | undefined): Note | null {
  return raw && raw in NOTES ? (raw as Note) : null;
}

/* ------------------------------------------------------------------ *
 * Pieces.
 * ------------------------------------------------------------------ */

function doorRow(doors: Door[]): string {
  if (!doors.length) return '';
  return (
    '<div class="btnrow" style="margin-top:14px">' +
    doors
      .map(
        (d, i) =>
          `<a class="btn${i === 0 ? ' btn-primary' : ''}" href="${esc(d.href)}">${esc(d.label)} →</a>`
      )
      .join('') +
    '</div>'
  );
}

function sentences(say: string[]): string {
  if (!say.length) return '';
  const [lead, ...rest] = say;
  return (
    `<p class="cc-lead">${esc(lead)}</p>` +
    rest.map((s) => `<p>${esc(s)}</p>`).join('')
  );
}

/** What the reader sees after asking. `data-ask-answer` is what the island
 *  appends; the whole block is also what a JavaScript-free page renders. */
function answerBlock(result: AskResult, ev: EventHome): string {
  if (result.kind === 'busy') {
    // The model could not be reached — a transient, not a verdict on the
    // question. Say so honestly, and point at the pages that always answer.
    return (
      '<div class="cc-fs" data-ask-answer>' +
      '<p class="cc-lead">I could not reach the program just now — that is on me, not your question. ' +
      'Try again in a moment, or the agenda and the speakers page have it.</p>' +
      doorRow(result.doors.length ? result.doors : plainDoors(ev, ev.agendaPublished)) +
      '</div>'
    );
  }
  if (result.kind === 'unsure') {
    return (
      '<div class="cc-fs" data-ask-answer>' +
      `<p class="cc-lead">${esc(NOTES.unsure)}</p>` +
      // The second clause is true by the line above this block: a question that
      // got no answer is still written down, so the organizers read it later.
      '<p>The agenda and the speakers page hold everything that is decided so far, ' +
      'and the organizers see what you asked, so somebody may write the answer here.</p>' +
      doorRow(result.doors.length ? result.doors : plainDoors(ev, ev.agendaPublished)) +
      '</div>'
    );
  }
  const provenance =
    result.kind === 'curated'
      ? 'The organizers wrote this one.'
      : result.kind === 'instant'
        ? 'Read off the program just now.'
        : result.kind === 'house'
          ? 'The same answer for everyone who asks.'
          : 'I put that together from the program. If I have it wrong, the organizers see the question.';
  return (
    '<div class="cc-fs" data-ask-answer>' +
    sentences(result.say) +
    doorRow(result.doors) +
    `<p class="sub" style="font-size:12.8px;margin-top:12px">${esc(provenance)}</p>` +
    '</div>'
  );
}

/** What the reader sees after the concierge DOES something (or asks them to
 *  clarify one). No provenance line — a provenance sentence belongs to a
 *  read off the program, not to an act the person just asked for. `extra` is
 *  an optional trailing control, e.g. the one-tap undo form. */
function actionBlock(say: string[], doors: Door[], extra = ''): string {
  return '<div class="cc-fs" data-ask-answer>' + sentences(say) + doorRow(doors) + extra + '</div>';
}

/** The confirm for a staged, "are you sure" act (withdraw a talk, send a
 *  connection). One button that commits the exact pending action the human just
 *  read — it carries only the pending id, never the arguments, so the server
 *  executes the STORED manifest. The island posts it in place; with scripts off
 *  the form posts and the page comes back with the outcome. */
function confirmForm(slug: string, pendingId: string, here: string): string {
  return (
    `<form method="post" action="/${esc(encodeURIComponent(slug))}/ask" style="margin-top:12px">` +
    (here ? `<input type="hidden" name="here" value="${esc(here)}">` : '') +
    `<button class="btn btn-primary" type="submit" name="commit" value="${esc(pendingId)}">Yes, do it</button>` +
    '</form>'
  );
}

/** The deterministic, model-free undo for a direct action: one button that posts
 *  the reverse straight to the guarded star endpoint. Not a chat round-trip, so
 *  a wrong write is undone without any chance of re-injection. */
/** What to say after the human confirmed a staged act and the server committed
 *  it. The action's own true outcome, plainly — never a borrowed line. */
function committedSay(result: Awaited<ReturnType<typeof commitPendingAction>>): string {
  if (!result.ok) {
    switch (result.reason) {
      case 'gone':
        return 'That was already taken care of — nothing more to do.';
      case 'expired':
        return 'That sat too long and expired. Ask me again and I will set it up fresh.';
      case 'not-allowed':
        return "That isn't something you can do from here anymore.";
      case 'wrong-number':
        return "That number didn't match what was staged — nothing was sent.";
      default:
        return "I couldn't finish that just now. Nothing changed.";
    }
  }
  if (result.outcome !== 'done' && result.outcome !== 'partial') {
    return result.outcome === 'moved'
      ? 'Something shifted while I was doing that — nothing changed. Ask me again.'
      : "I couldn't finish that. Nothing changed.";
  }
  switch (result.actionType) {
    case 'connect_request':
      return 'Done — your connection request is on its way.';
    case 'withdraw_proposal':
      return 'Done — your talk is withdrawn. It has left the committee list.';
    case 'decide':
      return 'Done — the decision is staged in the outbox; nothing reaches the speaker until you release it.';
    case 'invite':
      return 'Done — the invitations are written and waiting in the outbox.';
    default:
      return 'Done.';
  }
}

function undoForm(slug: string, undo: Undo): string {
  return (
    `<form method="post" action="/${esc(encodeURIComponent(slug))}/my-schedule/star" style="margin-top:12px">` +
    `<input type="hidden" name="session" value="${esc(undo.submissionId)}">` +
    `<input type="hidden" name="on" value="${undo.on ? '1' : '0'}">` +
    `<button class="btn" type="submit">${esc(undo.label)}</button>` +
    '</form>'
  );
}

/** The published, placed sessions as {id,title} for the planner to resolve
 *  names against — never a name-match on the server, only ids the model picks
 *  from this list. Empty until the agenda is published, which is exactly when
 *  a star could not land anyway. */
function starrableSessions(ag: Awaited<ReturnType<typeof agenda>>): SessionRef[] {
  if (!ag || !ag.published) return [];
  const out: SessionRef[] = [];
  for (const day of ag.days) {
    for (const slot of day.slots) {
      for (const s of slot.sessions) out.push({ id: s.id, title: s.title, kind: 'session' });
    }
  }
  return out;
}

/** The speaker's own tasks and proposals, as the reference list the portal
 *  concierge resolves against — their tasks (to mark done / put back) and their
 *  proposals (to withdraw). The boundary re-validates every id, so this list is
 *  only for the model to pick from. */
async function portalRefs(db: D1Database, eventId: string, principal: Principal): Promise<Referent[]> {
  // Whose portal to act on: the person's own — or, if they stand on no talk here
  // but help someone who does, the speaker they help. This is the exact
  // substitution the portal page makes (helpingAt), so a helper's bubble resolves
  // against the same tasks and proposals their page shows.
  let view = await portalView(db, eventId, principal.personId);
  if (view && view.submissions.length === 0) {
    const helping = await helpingAt(db, eventId, principal.personId);
    const first = helping[0];
    if (first) {
      const helped = await portalView(db, eventId, first.speakerPersonId);
      if (helped) view = helped;
    }
  }
  if (!view) return [];
  const refs: Referent[] = [];
  for (const s of view.submissions) refs.push({ id: s.id, title: s.title, kind: 'proposal' });
  const tasks = [...view.submissions.flatMap((s) => s.tasks), ...view.tasks];
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
    refs.push({ id: t.id, title: t.title, kind: 'task' });
  }
  return refs;
}

/** The reviewer's own live assignments this round, as the reference list the
 *  reviews-page bubble resolves against (to step aside). Titles are shown to
 *  reviewers under blind review — only author names are hidden — and only their
 *  OWN review rows are read, so the list can never reach another reviewer's
 *  queue. The boundary re-checks the assignment before it recuses. */
async function reviewerRefs(db: D1Database, eventId: string, principal: Principal): Promise<Referent[]> {
  const rows = await db
    .prepare(
      `SELECT s.id, s.title FROM review r
         JOIN submission s ON s.id = r.submission_id
         JOIN event e ON e.id = s.event_id
        WHERE r.reviewer_person_id = ? AND s.event_id = ?
          AND r.submitted_at IS NULL AND r.round = e.current_round
        LIMIT 60`
    )
    .bind(principal.personId, eventId)
    .all<{ id: string; title: string }>();
  return rows.results.map((r) => ({ id: r.id, title: r.title, kind: 'queue' as const }));
}

function noteBlock(note: Note, ev: EventHome): string {
  return (
    '<div class="cc-fs" data-ask-note>' +
    `<p class="cc-lead">${esc(NOTES[note])}</p>` +
    (note === 'blank' ? '' : doorRow(plainDoors(ev, ev.agendaPublished))) +
    '</div>'
  );
}

function youBubble(text: string): string {
  return `<div class="cc-you">${esc(text)}</div>`;
}

/* ------------------------------------------------------------------ *
 * Starters. Three questions the program can actually answer, chosen from
 * what is true about this conference today — no reading required, so the
 * calm page stays one read.
 * ------------------------------------------------------------------ *
 * They are written here rather than lifted from what people have really
 * asked: the question table holds whatever a stranger typed, and a public
 * page is not the place to repeat that back unread. Curated answers, which
 * an organizer has approved, are the part of it that belongs on the page.
 */
/** How many chips the row may carry, instant ones included. */
const MOST_CHIPS = 6;

/**
 * The chips this reader is offered, in one builder — the page draws it under
 * the box, the bubble draws it under its greeting, and neither can drift from
 * the other. Same button, same shape, one letter apart: `i` is a question this
 * file answers from the database on the spot, `q` is one for the concierge.
 * The instant ones come first because they come back first, and the row is
 * held to six however much standing somebody has — a wall of chips is a menu,
 * and this is not a menu.
 */
function chipRow(ev: EventHome, intents: IntentChip[], lead?: string, act?: string): string {
  // An action chip comes first and reads as a deed, not a question — the
  // concierge offering to DO the thing you are looking at, in one tap.
  const actChip = act
    ? `<button class="cc-chip cc-chip-act" type="submit" name="q" value="${esc(act)}">${esc(act)}</button>`
    : '';
  const leadChip = lead
    ? `<button class="cc-chip" type="submit" name="q" value="${esc(lead)}">${esc(lead)}</button>`
    : '';
  const room = Math.max(1, MOST_CHIPS - intents.length - (lead ? 1 : 0) - (act ? 1 : 0));
  const chips =
    actChip +
    leadChip +
    intents
      .map(
        (i) =>
          `<button class="cc-chip" type="submit" name="i" value="${esc(i.code)}">${esc(i.label)}</button>`
      )
      .join('') +
    starters(ev)
      .slice(0, room)
      .map(
        (s) => `<button class="cc-chip" type="submit" name="q" value="${esc(s)}">${esc(s)}</button>`
      )
      .join('');
  return chips ? `<div class="cc-chips">${chips}</div>` : '';
}

// Three strong, situational prompts, not a wall of pills (Luna's review): each
// is a real thing a person would ask, and one the concierge answers off the
// program. The instant chips beside them already carry the standing-scoped ones.
function starters(ev: EventHome): string[] {
  const out: string[] = [];
  if (ev.lifecycle === 'open') out.push('When does the call for speakers close?');
  if (ev.agendaPublished) {
    out.push('What should I see on the first day?');
    out.push('A practical session right after lunch?');
    out.push("Good talks if I'm new to this?");
  } else if (ev.counts.speakers > 0) {
    out.push('Who has been announced so far?');
  }
  out.push('Where is it, and when does each day start?');
  return out.slice(0, 3);
}

/* ------------------------------------------------------------------ *
 * The FAQ: what the organizers have already answered in their own words.
 * ------------------------------------------------------------------ */

function paragraphs(body: string): string {
  return body
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 8px">${esc(p)}</p>`)
    .join('');
}

function faq(ev: EventHome, curated: CuratedAnswer[]): string {
  const head =
    '<h2 class="display" style="font-size:24px;margin-bottom:6px">Asked and answered</h2>';
  if (!curated.length) {
    return (
      '<div class="sec" style="max-width:46em">' +
      head +
      '<div class="state-out" style="margin-top:12px">' +
      '<h2>Nothing written down yet.</h2>' +
      '<p>Ask above and I will read the program for you. When the organizers write an answer of their own, it lands here for everyone.</p>' +
      `<a class="btn btn-primary" href="/${esc(ev.slug)}/agenda">The agenda →</a>` +
      '</div></div>'
    );
  }
  return (
    '<div class="sec" style="max-width:46em">' +
    head +
    '<p class="sub" style="margin-bottom:14px">Written by the organizers, not by me.</p>' +
    curated
      .map(
        (a) =>
          '<details class="task">' +
          `<summary><span class="tname">${esc(a.questionText)}</span></summary>` +
          `<div class="tbody">${paragraphs(a.body)}</div>` +
          '</details>'
      )
      .join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The page.
 * ------------------------------------------------------------------ */

function askPage(o: {
  ev: EventHome;
  curated: CuratedAnswer[];
  intents: IntentChip[];
  thread: string;
  note: Note | null;
}): string {
  const { ev, curated } = o;
  const action = `/${encodeURIComponent(ev.slug)}/ask`;
  const chips = chipRow(ev, o.intents);

  const thread = o.thread + (o.note ? noteBlock(o.note, ev) : '');

  const body =
    '<div class="wrap" style="padding-top:44px;max-width:46em">' +
    '<h1 class="display" style="font-size:clamp(28px,5vw,40px)">Ask about the program</h1>' +
    '<p class="cc-lead" style="margin-top:10px">' +
    'One question at a time, please — a short answer, and a link straight to the rest.' +
    '</p>' +
    (thread
      ? `<div class="cc-body" data-ask-thread style="padding:20px 0 4px">${thread}</div>`
      : '<div class="cc-body" data-ask-thread style="padding:12px 0 0"></div>') +
    `<form class="sec" method="post" action="${esc(action)}" data-ask style="margin-top:18px">` +
    '<div class="cc-ask">' +
    '<input type="text" name="q" data-ask-input autocomplete="off" ' +
    `placeholder="Ask about the program" aria-label="Ask about the program">` +
    `<button type="submit">${esc(label('screen.ask', 'onstage'))}</button>` +
    '</div>' +
    `<p class="hint">Nobody has to sign in, and nothing you type is kept against your name.</p>` +
    (chips
      ? '<p class="sub" style="margin:16px 0 6px;font-size:13px">Try one of these</p>' + chips
      : '') +
    '</form>' +
    faq(ev, curated) +
    '</div>';

  return page({
    title: `Ask · ${ev.name}`,
    description: `Ask about the program at ${ev.name} and get the page you were after.`,
    register: 'onstage',
    body:
      // No bubble on this screen: it is the concierge, at full size — and it
      // opens with the conference's own band, so you always know which
      // program you are asking about.
      onstageShell(eventNav(ev.slug, '/ask', ev.lifecycle === 'open'), conferenceMasthead(ev) + body, null) +
      `<script>${askIsland}</script>`,
  });
}

/* ------------------------------------------------------------------ *
 * The bubble's first paint — GET /:event/ask?panel=1
 * ------------------------------------------------------------------ */

/**
 * What the concierge opens with. Role-aware without a query of its own: what
 * somebody was offered is what somebody is, so the chips already read decide
 * the sentence above them.
 */
function greeting(intents: IntentChip[], canAct: boolean): string {
  const has = (code: IntentCode): boolean => intents.some((i) => i.code === code);
  if (has('pile-now')) {
    return 'I can read the pile, the program and the call. Ask, and I will take you to whatever needs you.';
  }
  if (has('my-owed')) {
    return 'I know where your proposals stand and what is still owed. Ask, and I will take you to it.';
  }
  if (has('my-queue')) {
    return 'I know what is left in your reading, and everything the program says. Ask me about either.';
  }
  // A signed-in attendee can also tell me to DO things — say so, because a
  // concierge that only answers hides half of what it is.
  if (canAct) {
    return 'I know this conference — and I can act for you. Ask me anything, or just tell me to add a talk to your schedule and I will.';
  }
  return 'I know this conference — the program, the call, and where everything is. Ask me anything about it.';
}

/** The greeting and the chips, and nothing else: no page, no FAQ, no shell.
 *  The island appends it to an empty thread and keeps it for the visit.
 *  data-cc-who is the identity mark the island keys the kept thread to, so a
 *  conversation held for one person is never painted for the next one on the
 *  same tab. It is a hash, not a name: what lingers in a shared browser's
 *  sessionStorage should not say who was here. Empty means a stranger. */
function panelFragment(
  ev: EventHome,
  intents: IntentChip[],
  who: string,
  canAct: boolean,
  context?: { lead: string; greeting: string; act?: string }
): string {
  return (
    `<div class="cc-fs" data-cc-who="${esc(who)}">` +
    `<p class="cc-lead">${esc(context ? context.greeting : greeting(intents, canAct))}</p>` +
    chipRow(ev, intents, context?.lead, context?.act) +
    '</div>'
  );
}

async function whoMark(personId: string | null): Promise<string> {
  if (!personId) return '';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`fireside-cc:${personId}`)
  );
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

const back = (slug: string, note: Note): string =>
  `/${encodeURIComponent(slug)}/ask?note=${note}`;

/** An organizer of this conference asking from the public page is still asking
 *  as an organizer, and the digest they read later is better for knowing it.
 *  'speaker' arrives with the chip that only a speaker is offered: somebody
 *  asking what they owe is asking as one, whatever else they are. */
function scopeOf(
  eventId: string,
  principal: Principal | null,
  intent: IntentCode | null = null
): QuestionScope {
  if (!principal) return 'public';
  // Install-wide standing is standing everywhere, which is exactly why the
  // backstage chips are offered to it as well.
  if (principal.role === 'organizer' || principal.eventRoles[eventId]) return 'organizer';
  if (intent === 'my-owed') return 'speaker';
  return 'public';
}

/**
 * Writing the question down is for the organizers; answering it is for the
 * person who asked. If the first fails, the second still happens — losing a
 * line of feedback is a smaller thing than losing somebody's answer, and the
 * failure is visible in the Worker's own log either way.
 */
async function remember(
  db: D1Database,
  input: { eventId: string; scope: QuestionScope; text: string; answered: boolean; snapshot: string | null }
): Promise<void> {
  try {
    await logQuestion(db, input);
  } catch (e) {
    console.log('ask: the question was not written down', String(e));
  }
}

export function registerAsk(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/ask', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    // Which chips this reader has earned is a fact about them, so the principal
    // is read here as well as on the way in. A stranger costs no extra query.
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    // The bubble asking what to open with. One read, no FAQ, no page — and
    // never held in a shared cache, because which chips come back is a fact
    // about the person asking.
    if (c.req.query('panel')) {
      const offered = await offeredIntents(c.env.DB, ev, principal);
      c.header('cache-control', 'private, no-store');
      // Whether this reader can DO things here, not only ask — a signed-in
      // attendee can star, so the concierge should say so and offer the act.
      const canAct = !!principal && canActHere(principal, ev.id, 'event');
      // If the bubble opened on a talk's page, it opens with that talk: a chip
      // to ask about it, and — for someone who can act — a one-tap chip to add it
      // to their schedule, right where they are looking at it.
      const hereQ = String(c.req.query('here') ?? '').trim();
      let context: { lead: string; greeting: string; act?: string } | undefined;
      if (hereQ.startsWith('s:')) {
        const session = await sessionBySlug(c.env.DB, ev.id, hereQ.slice(2));
        if (session) {
          const starrable = canAct && ev.agendaPublished && session.startsAt != null;
          context = {
            lead: 'What is this talk about?',
            greeting: starrable
              ? `You are looking at “${session.title}”. I can add it to your schedule, or answer anything about the program.`
              : `You are looking at “${session.title}”. Ask me about it, or anything else on the program.`,
            act: starrable ? `Add “${session.title}” to my schedule` : undefined,
          };
        }
      }
      return c.html(
        panelFragment(ev, offered, await whoMark(principal?.personId ?? null), canAct, context)
      );
    }
    const [curated, intents] = await Promise.all([
      curatedAnswers(c.env.DB, ev.id),
      offeredIntents(c.env.DB, ev, principal),
    ]);
    return c.html(
      askPage({ ev, curated, intents, thread: '', note: noteFrom(c.req.query('note')) })
    );
  });

  app.post('/:event/ask', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();

    // The island asks for the answer alone; a form asks for the page.
    const inPlace = c.req.header('x-ask') === 'in-place';
    const reply = (note: Note) =>
      inPlace
        ? c.html(noteBlock(note, ev))
        : c.redirect(back(ev.slug, note), 303);

    const form = await c.req.parseBody();
    const question = String(form['q'] ?? '').trim().slice(0, 500);
    // A chip posts a code rather than words. One we do not have is nothing at
    // all — the same sentence an empty box gets.
    const pressed = String(form['i'] ?? '').trim();
    const intent = pressed ? intentOf(pressed) : null;
    if (pressed && !intent) return reply('blank');
    if (!intent && !question) return reply('blank');

    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    const asker = {
      ip: clientIp(c.req.header('CF-Connecting-IP')),
      personId: principal?.personId ?? null,
      nowMs: Date.now(),
    };
    /** The whole screen again, with the answer on it — the JavaScript-free path. */
    const wholePage = async (curated: CuratedAnswer[], thread: string) =>
      c.html(
        askPage({
          ev,
          curated,
          intents: await offeredIntents(c.env.DB, ev, principal),
          thread,
          note: null,
        })
      );

    // A confirm from the bubble: the human just approved a staged act, so commit
    // exactly that pending row — never the planner again. The arguments are
    // frozen server-side, so this only says "yes" to the manifest they read.
    const commitId = String(form['commit'] ?? '').trim();
    if (commitId) {
      if (!principal) return reply('blank');
      const result = await commitPendingAction({ DB: c.env.DB, FILES: c.env.FILES }, principal, commitId);
      const block = actionBlock([committedSay(result)], [], '');
      c.header('cache-control', 'no-store');
      if (inPlace) return c.html(block);
      return await wholePage(await curatedAnswers(c.env.DB, ev.id), youBubble('Yes, do it') + block);
    }

    // An instant answer is one read and a template. Nothing is spent on it,
    // because nothing costs anything: the budget is read rather than claimed,
    // and only to keep a pressed-all-afternoon chip out of the digest. The
    // standing behind the chip is checked inside the answer, so a code posted
    // by hand is refused by the same rule that would never have offered it.
    if (intent) {
      const asked = intentLabel(intent, ev, asker.nowMs);
      const result = await intentAnswer(c.env.DB, ev, intent, principal, asker.nowMs);
      // Nothing to say is not an answer: a chip this reader has not earned, and
      // a read that came back empty, get the same sentence an empty box gets.
      if (!result || !result.say.length) return reply('blank');
      const budget = await claimAsk(c.env.DB, { ...asker, spend: false });
      if (budget.ok) {
        await remember(c.env.DB, {
          eventId: ev.id,
          scope: scopeOf(ev.id, principal, intent),
          text: asked,
          // Answered, and true when it was written: the snapshot is what this
          // reader was actually told, so the digest shows demand as it landed.
          answered: true,
          snapshot: result.say.length ? result.say.join(' ') : null,
        });
      }
      const block = answerBlock(result, ev);
      c.header('cache-control', 'no-store');
      if (inPlace) return c.html(block);
      const curated = await curatedAnswers(c.env.DB, ev.id);
      return await wholePage(curated, youBubble(asked) + block);
    }

    const curated = await curatedAnswers(c.env.DB, ev.id);
    const scope = scopeOf(ev.id, principal);

    // ACT FIRST — semantics before determinism (Operator's Law; Codex #1). For a
    // principal who can DO something here, the planner decides act-vs-question
    // BEFORE any deterministic shortcut (the this-talk read, a curated hit) can
    // answer, so a shortcut can never silently eat an action like "star this".
    // Only a real action / clarify / refusal / transient-miss is handled here; a
    // confident QUESTION falls straight through to the read path below, unchanged.
    // An anon or a read-only visitor is never here (canActHere is false) and pays
    // for no planner call.
    //
    // Budget (Codex #6): the planner is a model call, so it claims one unit of its
    // own. A question that falls through and reaches answerQuestion claims a second
    // — honest per-call accounting. The law-compliant efficiency win is CACHING the
    // route decision, not a brittle pre-filter; deferred, not lost.
    // The portal bubble asks as a speaker (surface 'portal', its own tasks and
    // proposals as the reference list); everywhere else is the public event
    // surface (star a session). The surface decides both what the person may DO
    // and which list the planner resolves ids against.
    const here = String(form['here'] ?? '').trim();
    const surface: Surface = here === 'portal' ? 'portal' : here === 'reviews' ? 'reviews' : 'event';
    if (principal && canActHere(principal, ev.id, surface)) {
      const planClaim = await claimAsk(c.env.DB, asker);
      if (!planClaim.ok) return reply(planClaim.who === 'everyone' ? 'busy-today' : 'at-the-cap');
      const refs =
        surface === 'portal'
          ? await portalRefs(c.env.DB, ev.id, principal)
          : surface === 'reviews'
            ? await reviewerRefs(c.env.DB, ev.id, principal)
            : starrableSessions(await agenda(c.env.DB, ev.id));
      const act = await conciergeAct(
        { DB: c.env.DB, FILES: c.env.FILES, AI: c.env.AI },
        principal,
        { eventId: ev.id, surface },
        question,
        refs
      );
      if (act.kind !== 'not-an-action') {
        const say = act.kind === 'staged' ? [act.manifest, act.say] : [act.say];
        // A clarify (a question back) and a staged confirm keep the reader here;
        // everything else offers the agenda/speakers to walk to.
        const doors = act.kind === 'clarify' || act.kind === 'staged' ? [] : plainDoors(ev, ev.agendaPublished);
        // A staged act carries a Confirm button (commit the exact pending row);
        // a completed direct act carries its one-tap undo.
        const extra =
          act.kind === 'staged'
            ? confirmForm(ev.slug, act.pendingId, here)
            : act.kind === 'acted' && act.undo
              ? undoForm(ev.slug, act.undo)
              : '';
        const block = actionBlock(say, doors, extra);
        c.header('cache-control', 'no-store');
        if (inPlace) return c.html(block);
        return await wholePage(curated, youBubble(question) + block);
      }
    }

    // The talk on the page, when the reader asks about it. The bubble sent
    // which page it is on; "what's up with this talk" is read off that one row,
    // no model and nothing spent, before the program-wide path is even tried.
    if (question && here.startsWith('s:') && isAboutThePage(question)) {
      const session = await sessionBySlug(c.env.DB, ev.id, here.slice(2));
      if (session) {
        const result = thisTalkAnswer(ev, session);
        const budget = await claimAsk(c.env.DB, { ...asker, spend: false });
        if (budget.ok) {
          await remember(c.env.DB, {
            eventId: ev.id,
            scope,
            text: question,
            answered: true,
            snapshot: result.say.join(' '),
          });
        }
        const block = answerBlock(result, ev);
        c.header('cache-control', 'no-store');
        if (inPlace) return c.html(block);
        return await wholePage(curated, youBubble(question) + block);
      }
    }

    // Asked and not taken: whether there is any budget left, before anything
    // is spent. A curated answer is always free to give, but past the cap it
    // stops being written down, so nobody can fill the organizers' digest by
    // asking the same known question all afternoon.
    const budget = await claimAsk(c.env.DB, { ...asker, spend: false });

    // A question the organizers have already answered beats anything read off
    // the program, and costs nothing — so it is answered before the budget is
    // touched at all.
    const hit = matchCurated(curated, question);
    if (hit) {
      const result: AskResult = {
        kind: 'curated',
        say: hit.body.split('\n').map((p) => p.trim()).filter(Boolean),
        doors: plainDoors(ev, ev.agendaPublished),
      };
      if (budget.ok) {
        await remember(c.env.DB, {
          eventId: ev.id, scope, text: question, answered: true, snapshot: hit.body,
        });
      }
      const block = answerBlock(result, ev);
      c.header('cache-control', 'no-store');
      if (inPlace) return c.html(block);
      return await wholePage(curated, youBubble(question) + block);
    }

    // Somebody asking how to bring their agent gets the actual steps, not a
    // model's paraphrase of them. Free like a curated answer, and written down
    // the same way, so the organizers see the demand.
    const handshake = agentHandshake(question, !!principal);
    if (handshake) {
      if (budget.ok) {
        await remember(c.env.DB, {
          eventId: ev.id,
          scope,
          text: question,
          answered: true,
          snapshot: handshake.say.join(' '),
        });
      }
      const block = answerBlock(handshake, ev);
      c.header('cache-control', 'no-store');
      if (inPlace) return c.html(block);
      return await wholePage(curated, youBubble(question) + block);
    }

    if (!budget.ok) return reply(budget.who === 'everyone' ? 'busy-today' : 'at-the-cap');
    const claim = await claimAsk(c.env.DB, asker);
    if (!claim.ok) return reply(claim.who === 'everyone' ? 'busy-today' : 'at-the-cap');

    const result = await answerQuestion(c.env.DB, c.env.AI, ev, question, principal);
    await remember(c.env.DB, {
      eventId: ev.id,
      scope,
      text: question,
      // Answered stays off until an organizer writes one of their own: what
      // the concierge read off the program is a reply, not a settled answer.
      answered: false,
      snapshot: result.say.length ? result.say.join(' ') : null,
    });

    const block = answerBlock(result, ev);
    c.header('cache-control', 'no-store');
    if (inPlace) return c.html(block);
    return await wholePage(curated, youBubble(question) + block);
  });
}
