// Ask — the concierge, as a page rather than a bubble in the corner.
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
import { esc, page, onstageShell, eventNav } from '../../lib/html';
import { label } from '../../lib/labels';
import { eventBySlug, type EventHome } from '../../queries/public';
import { claimAsk, clientIp } from '../../lib/ratelimit';
import { principalFromCookie } from '../../workflows/account';
import {
  answerQuestion,
  curatedAnswers,
  logQuestion,
  matchCurated,
  plainDoors,
  type AskResult,
  type CuratedAnswer,
  type Door,
  type QuestionScope,
} from '../../workflows/ask';
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
  blank: "Ask me something and I'll point you at the right door.",
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
  if (result.kind === 'unsure') {
    return (
      '<div class="cc-fs" data-ask-answer>' +
      `<p class="cc-lead">${esc(NOTES.unsure)}</p>` +
      '<p>The agenda and the speakers page hold everything that is decided so far.</p>' +
      doorRow(result.doors.length ? result.doors : plainDoors(ev, ev.agendaPublished)) +
      '</div>'
    );
  }
  const provenance =
    result.kind === 'curated'
      ? 'The organizers wrote this one.'
      : 'I put that together from the program. If I have it wrong, the organizers see the question.';
  return (
    '<div class="cc-fs" data-ask-answer>' +
    sentences(result.say) +
    doorRow(result.doors) +
    `<p class="sub" style="font-size:12.8px;margin-top:12px">${esc(provenance)}</p>` +
    '</div>'
  );
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
function starters(ev: EventHome): string[] {
  const out: string[] = [];
  if (ev.lifecycle === 'open') out.push('When does the call for speakers close?');
  if (ev.agendaPublished) {
    out.push('What should I see on the first day?');
    out.push("Which talks are good if I'm new to this?");
  } else if (ev.counts.speakers > 0) {
    out.push('Who has been announced so far?');
  }
  out.push('Where is it, and what time does each day start?');
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
  thread: string;
  note: Note | null;
}): string {
  const { ev, curated } = o;
  const action = `/${encodeURIComponent(ev.slug)}/ask`;
  const chips = starters(ev)
    .map(
      (s) => `<button class="cc-chip" type="submit" name="q" value="${esc(s)}">${esc(s)}</button>`
    )
    .join('');

  const thread = o.thread + (o.note ? noteBlock(o.note, ev) : '');

  const body =
    '<div class="wrap" style="padding-top:44px;max-width:46em">' +
    '<h1 class="display" style="font-size:clamp(28px,5vw,40px)">Ask about the program</h1>' +
    '<p class="cc-lead" style="margin-top:10px">' +
    'One question, in your own words. You get a short answer and the door it opens, ' +
    'not a wall of text.' +
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
      ? '<p class="sub" style="margin:16px 0 6px;font-size:13px">Try one of these</p>' +
        `<div class="cc-chips">${chips}</div>`
      : '') +
    '</form>' +
    faq(ev, curated) +
    '</div>';

  return page({
    title: `Ask · ${ev.name}`,
    description: `Ask about the program at ${ev.name} and get the page you were after.`,
    register: 'onstage',
    body:
      onstageShell(eventNav(ev.slug, '/ask', ev.lifecycle === 'open'), body) +
      `<script>${askIsland}</script>`,
  });
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

const back = (slug: string, note: Note): string =>
  `/${encodeURIComponent(slug)}/ask?note=${note}`;

/** An organizer of this conference asking from the public page is still asking
 *  as an organizer, and the digest they read later is better for knowing it.
 *  'speaker' stays unused from this screen — see the parcel report. */
function scopeOf(eventId: string, roles: Record<string, string> | undefined): QuestionScope {
  return roles && roles[eventId] ? 'organizer' : 'public';
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
    const curated = await curatedAnswers(c.env.DB, ev.id);
    return c.html(
      askPage({ ev, curated, thread: '', note: noteFrom(c.req.query('note')) })
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
    if (!question) return reply('blank');

    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    const curated = await curatedAnswers(c.env.DB, ev.id);
    const scope = scopeOf(ev.id, principal?.eventRoles);
    const asker = {
      ip: clientIp(c.req.header('CF-Connecting-IP')),
      personId: principal?.personId ?? null,
      nowMs: Date.now(),
    };

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
      return inPlace
        ? c.html(block)
        : c.html(askPage({ ev, curated, thread: youBubble(question) + block, note: null }));
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
    return inPlace
      ? c.html(block)
      : c.html(askPage({ ev, curated, thread: youBubble(question) + block, note: null }));
  });
}
