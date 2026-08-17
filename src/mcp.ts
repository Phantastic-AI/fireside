// The same doors, for the thing typing on your behalf.
//
// Everything a person can see on the public side of Fireside — the events, an
// event's facts, the program, one talk, the speakers, the questions the call
// asks, and the act of sending a proposal — is reachable here by a machine,
// through the Model Context Protocol, at one address: POST /mcp. A second,
// narrower tier answers only when the caller carries a bearer token minted at
// /agents: it reads and writes as the person who minted it, and nothing more.
//
// The shape of the thing:
//
//   * Hand-rolled JSON-RPC 2.0 over plain HTTP. No streaming, no session, no
//     library, no new dependency. A request goes in as application/json and a
//     response comes back the same way; a notification gets 202 and no body.
//     Statelessness is the whole trick — every call carries what it needs, so
//     two calls in a row may land on two different machines and neither knows.
//   * The public read tools go through queries/public.ts, which is where the
//     rules about what a stranger may see are already written into the SQL.
//     This file adds no scope logic of its own, because the second copy of a
//     rule is the one that goes wrong.
//   * queries/portal.ts is used only once a bearer token has turned into a
//     Principal, and then only to read that same person's own portal — the
//     my_owed tool. Nothing here can read anybody else's decisions or letters
//     without one, and nothing anonymous can read them with one either.
//   * The one public writer is workflows/submit.ts's submitProposal — the same
//     function behind the call-for-speakers screen, with the same guards, the
//     same cap on how many proposals one person may send, and the same
//     refusals in the same words. A proposal sent from here is not a lesser
//     proposal; it is the same row, written the same way.
//   * The signed tools (whoami, pile_summary, my_owed, review_queue,
//     review_proposal, submit_review, step_aside, star_session, mark_task_done,
//     propose_withdraw, propose_invite, propose_decision, commit_pending) hold
//     no authorization logic
//     of their own either: pile() and requireScope (queries/admin.ts),
//     reviewEvent and queuePosition (queries/reviews.ts), and portalView
//     (queries/portal.ts) decide what a standing may see, exactly as they do for
//     the backstage screens and the reviewer's own room. submit_review's write
//     is workflows/review.ts's upsertReview and submitReviews — the same two
//     calls the reviewer's own form makes. star_session's write is the agentic
//     boundary itself (workflows/agent.ts proposeAction → setStar), the same
//     path the in-product concierge takes, so an external agent and the chat
//     bubble reach the one guarded workflow through the one validated door.
//   * Bearer handling: 'Authorization: Bearer <token>' on POST /mcp, purpose
//     'agent', minted by makeAgentToken (workflows/account.ts) at /agents and
//     good for fourteen days. No header at all is exactly today's public
//     tier — nothing below changes for a caller that never sends one. A
//     header that fails to verify is read as no header, never as a fault: it
//     neither raises a protocol error nor unlocks anything. tools/list shows
//     the signed tools only once a valid token is on the call, so an anonymous
//     client never learns a tool exists that it cannot use.
//
// Words: every state word still comes from lib/labels.ts. Formats, levels,
// roles, and the sentence a call says about itself are looked up, not typed.
// Counts come from the query DTOs.
//
// Escaping: nothing here renders HTML, so nothing here calls esc() — the
// escape on this door is JSON.stringify, applied once by c.json() and once
// more when a result is flattened into the text block. Putting HTML entities
// into a JSON string would corrupt the value, not protect it.
//
// Refusals: anything a caller can fix — an unknown event, a talk that is not
// on the published program, a proposal the committee will not take — comes
// back as a normal tool result with isError true and one plain sentence, so
// the caller reads a sentence instead of catching a protocol fault. Only the
// protocol's own faults (unreadable body, unknown method, no such tool) use
// JSON-RPC error codes.

import type { Hono } from 'hono';
import type { Env } from './index';
import { CALL_HAPPENED, FORMAT_KEY, LEVEL_KEY, label, type LabelKey } from './lib/labels';
import { verifyToken } from './lib/sign';
import {
  agenda,
  cfpQuestions,
  eventBySlug,
  eventDayKey,
  listEvents,
  sessionBySlug,
  speakerPage,
  speakersGallery,
  type AgendaSession,
  type CfpQuestion,
  type EventCard,
  type EventHome,
  type GallerySession,
  type GallerySpeaker,
} from './queries/public';
import { adminEvents, pile, ScopeError, type AdminEvent } from './queries/admin';
import { portalView } from './queries/portal';
import {
  queuePosition,
  reviewEvent,
  reviewQueue,
  type ReviewEvent,
  type Scores,
  type ScorecardKey,
} from './queries/reviews';
import {
  ABSTRACT_MAX,
  FORMATS,
  LEVELS,
  submitProposal,
  tracksOfEvent,
  type TrackOption,
} from './workflows/submit';
import { principalFromPersonId, type Principal } from './workflows/account';
import { proposeAction, commitPendingAction } from './workflows/agent';
import { submitOneReview, stepAside } from './workflows/review';
// NOTES is the reviewer form's own outcome sentences (routes/admin/reviews.ts).
// submit_review reuses them rather than restating, so "you already sent this
// in" cannot say two different things in two places.
import { NOTES } from './routes/admin/reviews';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'fireside', version: '1.0.0' };

/** Said once, on the way in, so the caller knows which door leads where. */
const INSTRUCTIONS =
  'Fireside runs calls for speakers and the programs that come out of them. ' +
  'Start with list_events to learn the short names events go by; every other tool takes one. ' +
  'event gives you an event whole — its dates, whether its call is open, and how many proposals, ' +
  'talks and speakers it has. agenda and session give you the program once it is public, speakers ' +
  'and speaker give you the people on it, cfp_questions gives you exactly what the call asks, and ' +
  'submit_proposal sends one. Nothing here is a draft: submit_proposal reaches the committee the ' +
  'moment you call it, and the address on the proposal is how the decision comes back.';

/* ------------------------------------------------------------------ *
 * Dates and times. A conference day is a local fact, so an instant is
 * rendered where the conference is, and a wall date is left where it is.
 * ------------------------------------------------------------------ */

const iso = (ms: number): string => new Date(ms).toISOString();

function dateFromKey(key: string): Date {
  const parts = key.split('-');
  return new Date(
    Date.UTC(Number(parts[0] ?? '1970'), Number(parts[1] ?? '1') - 1, Number(parts[2] ?? '1'))
  );
}

/** '2026-09-03' → '3 September'. The key is already a wall date. */
function dayWords(key: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(
    dateFromKey(key)
  );
}

/** '2026-09-03' → 'Thursday 3 September'. */
function weekdayWords(key: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(dateFromKey(key));
}

/** An instant, as the day it falls on where the conference is. */
function instantWords(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' }).format(
    new Date(ms)
  );
}

/** Epoch ms to 'HH:MM' on the conference's own clock. */
function clockOf(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

function datesWords(startsOn: string, endsOn: string): string {
  if (startsOn === endsOn) return dayWords(startsOn);
  const sameMonth = startsOn.slice(0, 7) === endsOn.slice(0, 7);
  const from = sameMonth ? String(Number(startsOn.slice(8))) : dayWords(startsOn);
  return `${from} – ${dayWords(endsOn)}`;
}

/* ------------------------------------------------------------------ *
 * The words. Every one of these comes out of lib/labels.ts.
 * ------------------------------------------------------------------ */

const wordFor = (map: Record<string, LabelKey>, stored: string): string => {
  const key = map[stored];
  return key ? label(key, 'onstage') : stored;
};

const formatWords = (stored: string): string => wordFor(FORMAT_KEY, stored);
const levelWords = (stored: string | null): string | null =>
  stored === null ? null : wordFor(LEVEL_KEY, stored);

const ROLE_KEY: Record<string, LabelKey> = {
  speaker: 'role.speaker',
  co_speaker: 'role.cospeaker',
  co_author: 'role.coauthor',
  panelist: 'role.panelist',
  moderator: 'role.host',
};
const roleWords = (stored: string): string => wordFor(ROLE_KEY, stored);

/** Open in the ordinary sense: opened, and not yet closed. */
function callIsOpen(ev: EventCard, nowMs: number): boolean {
  if (ev.cfpClosesAt === null || ev.cfpClosesAt <= nowMs) return false;
  return ev.cfpOpensAt === null || ev.cfpOpensAt <= nowMs;
}

/** What the call says about itself today, in the speaker's own register. */
function callSentence(ev: EventCard, nowMs: number): string {
  if (callIsOpen(ev, nowMs) && ev.cfpClosesAt !== null) {
    return label('call.open', 'onstage').replace('{date}', instantWords(ev.cfpClosesAt, ev.timezone));
  }
  if (ev.cfpOpensAt !== null && ev.cfpOpensAt > nowMs) {
    return label('call.before', 'onstage').replace('{date}', instantWords(ev.cfpOpensAt, ev.timezone));
  }
  if (ev.cfpClosesAt !== null) {
    return label('call.closed', 'onstage').replace('{date}', instantWords(ev.cfpClosesAt, ev.timezone));
  }
  return 'This call is not taking proposals.';
}

/* ------------------------------------------------------------------ *
 * Projections. The shapes a caller reads.
 * ------------------------------------------------------------------ */

function eventBrief(ev: EventCard, nowMs: number): Record<string, unknown> {
  const open = callIsOpen(ev, nowMs);
  return {
    event: ev.slug,
    name: ev.name,
    tagline: ev.tagline,
    starts_on: ev.startsOn,
    ends_on: ev.endsOn,
    dates: datesWords(ev.startsOn, ev.endsOn),
    timezone: ev.timezone,
    times_shown_as: ev.tzLabel,
    venue: ev.venueName,
    lifecycle: ev.lifecycle,
    // The one word an event that already ran says about itself.
    ...(ev.lifecycle === 'happened' ? { says: CALL_HAPPENED } : {}),
    call: {
      open,
      says: callSentence(ev, nowMs),
      opens_at: ev.cfpOpensAt === null ? null : iso(ev.cfpOpensAt),
      closes_at: ev.cfpClosesAt === null ? null : iso(ev.cfpClosesAt),
    },
    agenda_published: ev.agendaPublished,
    counts: {
      proposals: ev.counts.proposals,
      talks_on_the_program: ev.counts.accepted,
      speakers: ev.counts.speakers,
    },
    pages: {
      event: `/${ev.slug}`,
      call: open ? `/${ev.slug}/cfp` : null,
      agenda: `/${ev.slug}/agenda`,
      speakers: `/${ev.slug}/speakers`,
    },
  };
}

function agendaSession(s: AgendaSession, timezone: string, eventSlug: string): Record<string, unknown> {
  return {
    session: s.publicSlug,
    title: s.title,
    format: formatWords(s.format),
    starts_at: iso(s.startsAt),
    day: eventDayKey(s.startsAt, timezone),
    time: clockOf(s.startsAt, timezone),
    minutes: s.minutes,
    room: s.roomName,
    track: s.track ? { track: s.track.slug, name: s.track.name } : null,
    speakers: s.speakers.map((p) => ({
      person: p.personId,
      name: p.name,
      role: roleWords(p.role),
    })),
    cancelled: s.cancelled ? label('submission.cancelled', 'onstage') : null,
    recording_url: s.recordingUrl,
    page: s.publicSlug ? `/${eventSlug}/s/${s.publicSlug}` : null,
  };
}

function gallerySession(s: GallerySession, eventSlug: string): Record<string, unknown> {
  return {
    session: s.publicSlug,
    title: s.title,
    starts_at: s.startsAt === null ? null : iso(s.startsAt),
    day: s.day,
    room: s.roomName,
    track: s.track ? { track: s.track.slug, name: s.track.name } : null,
    cancelled: s.cancelled ? label('submission.cancelled', 'onstage') : null,
    page: s.publicSlug ? `/${eventSlug}/s/${s.publicSlug}` : null,
  };
}

function speakerBrief(p: GallerySpeaker, eventSlug: string): Record<string, unknown> {
  return {
    person: p.personId,
    name: p.name,
    job_title: p.jobTitle,
    organisation: p.organisation,
    pronouns: p.pronouns,
    bio: p.bio,
    links: p.links,
    talks_here: p.talkCount,
    sessions: p.sessions.map((s) => gallerySession(s, eventSlug)),
    page: `/${eventSlug}/speakers/${p.personId}`,
  };
}

/* ------------------------------------------------------------------ *
 * Tools: what one is, and what one may answer.
 * ------------------------------------------------------------------ */

type Args = Record<string, unknown>;

type ToolOutcome =
  /** A whole answer. */
  | { ok: true; value: Record<string, unknown> }
  /** Something the caller can fix, said in one sentence. */
  | { ok: false; says: string };

const answered = (value: Record<string, unknown>): ToolOutcome => ({ ok: true, value });
const refuse = (says: string): ToolOutcome => ({ ok: false, says });

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

type Tool = {
  title: string;
  description: string;
  inputSchema: JsonSchema;
  // `principal` is null on the public tier and on any call whose bearer token
  // did not verify. The eight public tools below never look at it; the signed
  // ones (see SIGNED_TOOLS) are the only entries that read it.
  run: (env: Env, args: Args, nowMs: number, principal: Principal | null) => Promise<ToolOutcome>;
};

const textArg = (args: Args, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
};

const numberArg = (args: Args, key: string): number | undefined => {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The short name every tool starts from, said once. */
const EVENT_ARG = {
  event: {
    type: 'string',
    description:
      "The event's short name, the one that appears in its web address. list_events has them all.",
  },
};

const NO_SUCH_EVENT =
  'No event here goes by that short name. Ask list_events for the ones that exist and use the short name from there.';

/** Find the event or hand back the sentence that says it is not here. */
async function eventOr(
  env: Env,
  args: Args,
  nowMs: number
): Promise<{ ok: true; ev: EventHome } | { ok: false; says: string }> {
  const slug = textArg(args, 'event');
  if (!slug) return { ok: false, says: 'Name the event first — its short name, as list_events gives it.' };
  const ev = await eventBySlug(env.DB, slug, nowMs);
  if (!ev) return { ok: false, says: NO_SUCH_EVENT };
  return { ok: true, ev };
}

/* ------------------------------------------------------------------ *
 * The signed tier: standing, and the sentences a refusal reuses.
 * ------------------------------------------------------------------ */

const NEEDS_SIGNED_IN =
  'This one needs a signed connection. Sign in at /agents and paste the command it gives you.';

const NO_SUCH_PROPOSAL =
  'No proposal here goes by that id. review_queue and pile_summary give the ids that exist.';

// The reviewer room's own sentence for "handed to somebody else, or to
// nobody" (routes/admin/reviews.ts's queuePage, non-chair branch), reused
// word for word rather than paraphrased.
const NOT_ASSIGNED = 'That proposal is not on your list this round, so there is nothing here to score.';

const noOrganizerStanding = (eventSlug: string): string =>
  `Your connection has no organizer standing at ${eventSlug}.`;
const noReviewerStanding = (eventSlug: string): string =>
  `Your connection has no reviewer standing at ${eventSlug}.`;

/** Every state word a signed tool needs, backstage or onstage — the local map
 *  every screen that touches SubmissionState/VisibleState keeps its own copy
 *  of (see routes/admin/pile.ts's STATE_KEY, workflows/ask.ts's STATE_WORD). */
const SUBMISSION_STATE_KEY: Record<string, LabelKey> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};
const submissionStateWords = (stored: string, register: 'onstage' | 'backstage'): string => {
  const key = SUBMISSION_STATE_KEY[stored];
  return key ? label(key, register) : stored;
};

/** A submission's own event, by address rather than by anybody's standing —
 *  the same kind of lookup eventOr does for a slug, the other way round.
 *  No scope decision lives here: reviewEvent and queuePosition, below, are
 *  what decide whether this connection may read or write what it names. */
async function eventSlugOfSubmission(db: D1Database, submissionId: string): Promise<string | null> {
  if (!submissionId) return null;
  const row = await db
    .prepare('SELECT e.slug AS slug FROM submission s JOIN event e ON e.id = s.event_id WHERE s.id = ?')
    .bind(submissionId)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

/** The event a reviewing call is about, or the sentence that says this
 *  connection holds no reviewer standing there. reviewEvent alone decides —
 *  this only turns its ScopeError into the tool-result refusal style. */
async function reviewEventOr(
  env: Env,
  principal: Principal,
  slug: string
): Promise<{ ok: true; ev: ReviewEvent } | { ok: false; says: string }> {
  try {
    const ev = await reviewEvent(env.DB, principal, slug);
    if (!ev) return { ok: false, says: NO_SUCH_EVENT };
    return { ok: true, ev };
  } catch (e) {
    if (e instanceof ScopeError) return { ok: false, says: noReviewerStanding(slug) };
    throw e;
  }
}

/** A submitted review is final, so its marks are checked strictly rather than
 *  coerced: an unknown key or an out-of-range value stops the whole submit with
 *  a sentence, instead of quietly dropping or rounding it. Returns the marks in
 *  the shape the writer takes when every one is clean. */
const REVIEW_NOTE_MAX = 2000;
function validateMarks(
  raw: Record<string, unknown>,
  card: ScorecardKey[],
  byKey: Map<string, ScorecardKey>
): { ok: true; scores: Scores } | { ok: false; says: string } {
  const scores: Scores = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = byKey.get(key);
    if (!k) {
      return {
        ok: false,
        says: `This round's scorecard has no mark called "${key}". review_proposal lists the keys it takes.`,
      };
    }
    if (k.kind === 'text') {
      if (typeof value !== 'string') {
        return { ok: false, says: `The mark "${key}" takes a written line, not a number.` };
      }
      const written = value.trim().slice(0, REVIEW_NOTE_MAX);
      if (written) scores[key] = written;
      continue;
    }
    if (k.kind === 'select') {
      if (typeof value !== 'string' || !k.options.includes(value)) {
        return {
          ok: false,
          says: `The mark "${key}" takes one of: ${k.options.join(', ')}.`,
        };
      }
      scores[key] = value;
      continue;
    }
    // A scale: a whole number in its range, and nothing that has to be rounded
    // to get there. 4.7 on a scale of 5 is a mistake worth naming, not fixing.
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > k.max) {
      return {
        ok: false,
        says: `The mark "${key}" takes a whole number from 1 to ${k.max}.`,
      };
    }
    scores[key] = n;
  }
  return { ok: true, scores };
}

/** The organizer's own extra questions, as the call asks them. */
function questionShape(q: CfpQuestion): Record<string, unknown> {
  return {
    key: q.id,
    kind: q.kind,
    asks: q.label,
    hint: q.hint,
    required: q.required,
    options: q.options,
    only_when: q.showIf ? { answer_to: q.showIf.questionId, is: q.showIf.equals } : null,
  };
}

/** Which control a refusal is about, in the words the form uses for it. */
function fieldWords(field: string, questions: readonly CfpQuestion[]): string | null {
  const plain: Record<string, string> = {
    'f-title': 'the talk title',
    'f-abs': 'the paragraph about the talk',
    'f-name': 'the name that goes on the program',
    'f-email': 'the email address',
    'f-fmt': 'the format',
    'f-lvl': 'who the talk is for',
    'f-track': 'the track',
  };
  const known = plain[field];
  if (known) return known;
  if (field.startsWith('f-q-')) {
    const q = questions.find((x) => x.id === field.slice(4));
    if (q) return `the answer to "${q.label}"`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The tools themselves. A plain object map, name to tool.
 * ------------------------------------------------------------------ */

const PUBLIC_TOOLS: Record<string, Tool> = {
  list_events: {
    title: 'Every event here',
    description:
      'Every conference this Fireside runs, most recent first. Each one comes back with its short ' +
      'name, its dates, where it is, whether its call for speakers is open right now, whether its ' +
      'program is public yet, and how many proposals, talks and speakers it holds. Start here: the ' +
      'short name in each entry is what every other tool asks for.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(env, _args, nowMs) {
      const events = await listEvents(env.DB, nowMs);
      if (!events.length) {
        return answered({
          events: [],
          says:
            'Nothing is running here yet. The first event appears in this list the moment an ' +
            'organizer opens its call for speakers.',
        });
      }
      return answered({ events: events.map((e) => eventBrief(e, nowMs)) });
    },
  },

  event: {
    title: 'One event, whole',
    description:
      'One event as its own front page tells it: the dates, the venue, what the call for speakers ' +
      'says about itself today, when decisions go out, how many proposals one person may send, and ' +
      'the three counts the event shows in public. Ask for this before you send anything, because ' +
      'it is where you learn whether the call is still open and how long you have.',
    inputSchema: {
      type: 'object',
      properties: EVENT_ARG,
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      return answered({
        ...eventBrief(ev, nowMs),
        about_the_call: ev.cfpIntro,
        decisions_by: ev.decideBy,
        decisions_by_says: ev.decideBy ? dayWords(ev.decideBy) : null,
        proposals_per_person: ev.maxSubmissions,
        next: ['agenda', 'speakers', 'cfp_questions'],
      });
    },
  },

  agenda: {
    title: 'The published program',
    description:
      'The program as the public sees it, day by day and in order: title, time on the ' +
      "conference's own clock, how long it runs, the room, the track, and who is giving it. Ask " +
      'for one day by passing its date. Until the organizers publish, this comes back with no days ' +
      'and the same sentence the public page shows, because a program half-decided is not a ' +
      'program yet.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        day: {
          type: 'string',
          description: 'One day of the conference, as 2026-09-03. Leave it out for every day.',
        },
      },
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const ag = await agenda(env.DB, ev.id);
      if (!ag || !ag.published) {
        return answered({
          event: ev.slug,
          published: false,
          days: [],
          says:
            'The program is still being decided. ' +
            (ev.decideBy
              ? `Decisions go out by ${dayWords(ev.decideBy)}.`
              : 'Decisions are still being made.') +
            ' Speakers already confirmed are on the speakers page.',
          speakers_page: `/${ev.slug}/speakers`,
        });
      }

      const wanted = textArg(args, 'day');
      const days = ag.days
        .filter((d) => !wanted || d.day === wanted)
        .map((d) => ({
          day: d.day,
          says: weekdayWords(d.day),
          sessions: d.slots.flatMap((slot) =>
            slot.sessions.map((s) => agendaSession(s, ag.timezone, ev.slug))
          ),
        }));

      if (wanted && !days.length) {
        const running = ag.days.map((d) => dayWords(d.day));
        return answered({
          event: ev.slug,
          published: true,
          days: [],
          says: running.length
            ? `Nothing is on the program that day. This one runs on ${running.join(' and ')}.`
            : 'Nothing is on the program yet.',
          page: `/${ev.slug}/agenda`,
        });
      }

      return answered({
        event: ev.slug,
        published: true,
        timezone: ag.timezone,
        times_shown_as: ag.tzLabel,
        days,
        page: `/${ev.slug}/agenda`,
      });
    },
  },

  session: {
    title: 'One talk',
    description:
      'One talk on the published program, whole: the paragraph the speaker wrote, the format, who ' +
      'it is pitched at, when and where it happens, the track it lives in, everyone giving it, and ' +
      'the recording once there is one. Talks are named by the short name in their web address, ' +
      'which the agenda tool gives you beside each one.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        session: {
          type: 'string',
          description: "The talk's short name, as the agenda tool gives it.",
        },
      },
      required: ['event', 'session'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const wanted = textArg(args, 'session');
      if (!wanted) return refuse('Name the talk you mean — the agenda tool gives its short name.');
      const s = await sessionBySlug(env.DB, ev.id, wanted);
      if (!s) {
        return refuse(
          ev.agendaPublished
            ? 'No talk on this program goes by that name. Ask agenda for what is on it.'
            : 'This program is not public yet, so no talk on it can be read. The speakers already confirmed are on the speakers page.'
        );
      }
      return answered({
        event: ev.slug,
        session: s.publicSlug,
        title: s.title,
        abstract: s.abstract,
        format: formatWords(s.format),
        who_it_is_for: levelWords(s.level),
        minutes: s.minutes,
        starts_at: iso(s.startsAt),
        day: s.day,
        time: clockOf(s.startsAt, s.timezone),
        timezone: s.timezone,
        times_shown_as: s.tzLabel,
        room: s.roomName,
        track: s.track ? { track: s.track.slug, name: s.track.name } : null,
        cancelled: s.cancelled ? label('submission.cancelled', 'onstage') : null,
        cancel_note: s.cancelNote,
        recording_url: s.recordingUrl,
        speakers: s.speakers.map((p) => ({
          person: p.personId,
          name: p.name,
          role: roleWords(p.role),
          job_title: p.jobTitle,
          organisation: p.organisation,
          pronouns: p.pronouns,
          bio: p.bio,
          links: p.links,
          page: `/${ev.slug}/speakers/${p.personId}`,
        })),
        page: `/${ev.slug}/s/${s.publicSlug}`,
      });
    },
  },

  speakers: {
    title: 'Everyone speaking',
    description:
      'Everyone on the program at this event, in the order the gallery shows them: name, what they ' +
      'do and where, the bio they wrote, and how many talks they hold here. Titles, times and rooms ' +
      'come with them once the program is public; before that the people are named and their talks ' +
      'are not, because announcing a speaker and publishing a schedule are two different days.',
    inputSchema: {
      type: 'object',
      properties: EVENT_ARG,
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const people = await speakersGallery(env.DB, ev.id);
      if (!people.length) {
        const open = callIsOpen(ev, nowMs);
        return answered({
          event: ev.slug,
          speakers: [],
          says: open
            ? 'Nobody is on the program yet — the committee is still reading. The call is open, and cfp_questions says exactly what it asks for.'
            : 'Nobody is on the program yet. The committee is still reading what came in.',
          call_page: open ? `/${ev.slug}/cfp` : null,
        });
      }
      return answered({
        event: ev.slug,
        agenda_published: ev.agendaPublished,
        speakers: people.map((p) => speakerBrief(p, ev.slug)),
        page: `/${ev.slug}/speakers`,
      });
    },
  },

  speaker: {
    title: 'One speaker',
    description:
      'One speaker at this event: who they are, what they are giving here once the program is ' +
      'public, and where else in this Fireside they have spoken before. The history carries only ' +
      'talks that reached a published program, so nothing anyone was told in private appears in it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        person: {
          type: 'string',
          description: "The speaker's key, as the speakers tool gives it.",
        },
      },
      required: ['event', 'person'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const who = textArg(args, 'person');
      if (!who) return refuse('Name the speaker you mean — the speakers tool gives the key for each.');
      const p = await speakerPage(env.DB, ev.id, who);
      if (!p) return refuse('Nobody at this event goes by that key. Ask speakers for who is on the program.');
      return answered({
        event: ev.slug,
        person: p.person.personId,
        name: p.person.name,
        job_title: p.person.jobTitle,
        organisation: p.person.organisation,
        pronouns: p.person.pronouns,
        bio: p.person.bio,
        links: p.person.links,
        agenda_published: p.agendaPublished,
        sessions: p.sessions.map((s) => gallerySession(s, ev.slug)),
        spoken_elsewhere: p.elsewhere.map((t) => ({
          event: t.eventSlug,
          event_name: t.eventName,
          year: t.year,
          title: t.title,
          cancelled: t.state === 'cancelled' ? label('submission.cancelled', 'onstage') : null,
          page: t.publicSlug ? `/${t.eventSlug}/s/${t.publicSlug}` : `/${t.eventSlug}/agenda`,
        })),
        page: `/${ev.slug}/speakers/${p.person.personId}`,
      });
    },
  },

  cfp_questions: {
    title: 'What the call asks',
    description:
      'Exactly what this call for speakers asks for, in the order it asks: the talk title, the ' +
      'paragraph and its ceiling, the formats on offer and how long each runs, who a talk can be ' +
      'pitched at, the tracks the program is built from, the three things it asks about you, and ' +
      'any further questions these organizers wrote themselves. Read this before submit_proposal — ' +
      'the values it lists are the values that will be accepted, and some questions only appear ' +
      'once an earlier answer is given.',
    inputSchema: {
      type: 'object',
      properties: EVENT_ARG,
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const [tracks, questions] = await Promise.all([
        tracksOfEvent(env.DB, ev.id),
        cfpQuestions(env.DB, ev.id),
      ]);
      const open = callIsOpen(ev, nowMs);
      return answered({
        event: ev.slug,
        open,
        says: callSentence(ev, nowMs),
        closes_at: ev.cfpClosesAt === null ? null : iso(ev.cfpClosesAt),
        decisions_by: ev.decideBy,
        proposals_per_person: ev.maxSubmissions,
        about_the_call: ev.cfpIntro,
        asks: [
          {
            name: 'title',
            required: true,
            asks: 'Talk title',
            hint: 'The line a stranger reads on the schedule. If the talk is accepted this goes on the program word for word.',
          },
          {
            name: 'abstract',
            required: true,
            asks: 'The talk in one paragraph',
            hint: `Up to ${ABSTRACT_MAX.toLocaleString('en-US')} characters, and it goes on the program word for word.`,
            max_characters: ABSTRACT_MAX,
          },
          {
            name: 'format',
            required: true,
            asks: 'Format',
            options: FORMATS.map((f) => ({ value: f.word, minutes: f.minutes })),
          },
          {
            name: 'level',
            required: true,
            asks: 'Who is this for?',
            options: LEVELS.map((l) => ({ value: l.value, says: l.word })),
          },
          {
            name: 'track',
            required: tracks.length > 0,
            asks: 'Track',
            hint: 'Where the talk lives in the program. The committee reads by track.',
            options: tracks.map((t: TrackOption) => ({ value: t.slug, says: t.name })),
          },
          {
            name: 'name',
            required: true,
            asks: 'Your name',
            hint: 'As it should be printed on the schedule.',
          },
          {
            name: 'org',
            required: false,
            asks: 'Organisation and role',
            hint: 'Shown under the name on the public agenda.',
          },
          {
            name: 'email',
            required: true,
            asks: 'Email',
            hint: 'The decision goes here, and it is how the speaker portal opens. Nobody else sees it.',
          },
        ],
        answers: questions.map(questionShape),
        page: open ? `/${ev.slug}/cfp` : null,
      });
    },
  },

  submit_proposal: {
    title: 'Send a proposal',
    description:
      'Send one talk proposal to this call. It is the same act as pressing send on the public form: ' +
      'the committee has it the moment this returns, the address you give is the identity on it, and ' +
      'the decision and the way back into the speaker portal both go to that address. Read ' +
      'cfp_questions first, because the format, the level and the track must be values this call ' +
      'offers, and organizers may ask their own questions on top. It refuses in a sentence when the ' +
      'call has closed, when something needed is missing, or when this address already holds as many ' +
      'proposals as anyone may send.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        title: { type: 'string', description: 'The talk title, as it should appear on the program.' },
        abstract: {
          type: 'string',
          description: `The talk in one paragraph, up to ${ABSTRACT_MAX} characters.`,
        },
        format: {
          type: 'string',
          description: 'One of the formats this call offers, exactly as cfp_questions lists it.',
        },
        level: {
          type: 'string',
          description: 'Who the talk is pitched at, as one of the values cfp_questions lists.',
        },
        track: {
          type: 'string',
          description:
            'The part of the program the talk belongs in, when this call has tracks. Required when it does.',
        },
        name: { type: 'string', description: "The speaker's name, as it should be printed." },
        email: {
          type: 'string',
          description: 'Where the decision goes, and the way back into the speaker portal.',
        },
        org: { type: 'string', description: 'Organisation and role, shown under the name.' },
        answers: {
          type: 'object',
          description:
            "The organizers' own questions, keyed by the key cfp_questions gives each one. " +
            'Text answers are strings; a tick box is true or false.',
          additionalProperties: true,
        },
      },
      required: ['event', 'title', 'abstract', 'format', 'level', 'name', 'email'],
      additionalProperties: false,
    },
    async run(env, args, nowMs) {
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;

      // The screen refuses a shut call before it reads a word of the form, and
      // so does this door — otherwise the first thing missing from the form
      // answers first and the caller never hears that the call is over.
      // submitProposal re-checks this inside its own batch either way.
      if (!callIsOpen(ev, nowMs)) {
        const opensLater = ev.cfpOpensAt !== null && ev.cfpOpensAt > nowMs;
        if (opensLater && ev.cfpOpensAt !== null) {
          return refuse(
            `${label('call.before', 'onstage').replace('{date}', instantWords(ev.cfpOpensAt, ev.timezone))}, so nothing was sent.`
          );
        }
        if (ev.cfpClosesAt !== null) {
          return refuse(
            `${label('call.closed', 'onstage').replace('{date}', instantWords(ev.cfpClosesAt, ev.timezone))}, so nothing was sent.`
          );
        }
        return refuse('This call is not taking proposals.');
      }

      const questions = await cfpQuestions(env.DB, ev.id);
      const given = isObject(args['answers']) ? args['answers'] : {};
      const answers: Record<string, string | boolean> = {};
      for (const q of questions) {
        const raw = given[q.id];
        if (q.kind === 'checkbox') answers[q.id] = raw === true || raw === 'true';
        else if (typeof raw === 'string') answers[q.id] = raw;
        else if (typeof raw === 'number') answers[q.id] = String(raw);
      }

      const outcome = await submitProposal(
        env.DB,
        ev.id,
        {
          title: textArg(args, 'title'),
          abstract: textArg(args, 'abstract'),
          trackSlug: textArg(args, 'track'),
          format: textArg(args, 'format'),
          level: textArg(args, 'level'),
          name: textArg(args, 'name'),
          email: textArg(args, 'email'),
          organisation: textArg(args, 'org'),
          answers,
          questions,
        },
        nowMs
      );

      if (!outcome.ok) {
        const about = outcome.field ? fieldWords(outcome.field, questions) : null;
        return refuse(about ? `${outcome.message} This one is about ${about}.` : outcome.message);
      }

      return answered({
        sent: true,
        event: ev.slug,
        says:
          `The proposal is in, and ${outcome.email} is the address on it. The decision goes there, ` +
          'and the same address opens the speaker portal — there is no password to remember.',
        portal_page: `/${ev.slug}/portal`,
        decisions_by: ev.decideBy,
        decisions_by_says: ev.decideBy ? dayWords(ev.decideBy) : null,
        proposals_per_person: ev.maxSubmissions,
      });
    },
  },
};

/* ------------------------------------------------------------------ *
 * The signed tools: standing required, read through the same queries and
 * workflows the backstage and reviewer screens read and write through.
 * Every run() below starts the same way — refuse when there is no
 * principal — because a signed tool called anonymously is refused exactly
 * like a bearer token that did not verify; the caller reads one sentence
 * either way.
 * ------------------------------------------------------------------ */

const SIGNED_TOOLS: Record<string, Tool> = {
  whoami: {
    title: 'Who this connection is',
    description:
      "This connection's own name and standing: any install-wide role, and its role at each event " +
      'by short name. No email address — an address is not a standing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(env, _args, _nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      let events: AdminEvent[] = [];
      try {
        events = await adminEvents(env.DB, principal);
      } catch (e) {
        // Nothing backstage anywhere is not a fault — a speaker with no
        // standing still gets a whole answer, just an empty one.
        if (!(e instanceof ScopeError)) throw e;
      }
      const eventStandings: Record<string, string> = {};
      for (const e of events) eventStandings[e.slug] = e.standing;
      return answered({
        name: principal.name,
        role: principal.role,
        events: eventStandings,
      });
    },
  },

  pile_summary: {
    title: 'What is waiting on the committee',
    description:
      'Organizer standing required at the named event. Counts by state, and up to twenty undecided ' +
      'proposals — id, title, format and track — from the same pile the backstage screen reads. ' +
      'Refuses in a sentence when this connection holds no organizer standing there.',
    inputSchema: {
      type: 'object',
      properties: EVENT_ARG,
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      let read;
      try {
        read = await pile(env.DB, principal, ev.id, 'undecided', { limit: 20 });
      } catch (e) {
        if (e instanceof ScopeError) return refuse(noOrganizerStanding(ev.slug));
        throw e;
      }
      return answered({
        event: ev.slug,
        counts: read.counts,
        undecided: read.rows.map((r) => ({
          id: r.id,
          title: r.title,
          format: formatWords(r.format),
          track: r.track ? { track: r.track.slug, name: r.track.name } : null,
        })),
      });
    },
  },

  my_owed: {
    title: 'What you owe, and by when',
    description:
      "This connection's own standing at one event: its proposals in their told states only, and its " +
      'open tasks with their due dates — the same read the speaker portal itself uses, so nothing ' +
      'here is ahead of what the person it belongs to has already been told.',
    inputSchema: {
      type: 'object',
      properties: EVENT_ARG,
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const view = await portalView(env.DB, ev.id, principal.personId, nowMs);
      if (!view) return answered({ event: ev.slug, proposals: [], open_tasks: [] });
      const mine = view.submissions.filter((s) => s.state !== 'draft');
      const openTasks = [...view.tasks, ...view.submissions.flatMap((s) => s.tasks)].filter(
        (t) => t.status === 'open'
      );
      return answered({
        event: ev.slug,
        proposals: mine.map((s) => ({
          id: s.id,
          title: s.title,
          state: submissionStateWords(s.state, 'onstage'),
        })),
        open_tasks: openTasks.map((t) => ({
          id: t.id,
          title: t.title,
          due_on: t.dueOn,
          overdue: t.overdue,
        })),
      });
    },
  },

  review_queue: {
    title: 'The reading list',
    description:
      "The proposals to score this round, still unsubmitted — id, title, format and track. A reviewer " +
      'gets their own assigned reading; an organizer, who can see the whole room, gets every undecided ' +
      'proposal, which is a longer list. No author name or employer either way: the round stays blind ' +
      "here exactly as it does on the reviewer's own screen. The list is paged — read `left` for how " +
      'many remain, `has_more` and `page`/`pages` to walk them, and pass `page` for the next. ' +
      'review_proposal reads one whole, submit_review sends a mark to exactly one.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        page: { type: 'number', description: 'Which page of the list, from 1. Optional; the first by default.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    async run(env, args, _nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const slug = textArg(args, 'event');
      if (!slug) return refuse('Name the event first — its short name, as list_events gives it.');
      const found = await reviewEventOr(env, principal, slug);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const pageArg = numberArg(args, 'page');
      const page = Number.isFinite(pageArg) && pageArg! >= 1 ? Math.floor(pageArg!) : 1;
      const q = await reviewQueue(env.DB, principal, ev, { page });
      const left = q.rows.filter((r) => r.mySubmittedAt === null && !r.myRecused);
      return answered({
        event: ev.slug,
        round: ev.round,
        // Whose list this is, so `left` is never read as a personal debt an
        // organizer does not owe.
        list: ev.everything ? 'the whole undecided pile' : 'your assigned reading',
        left: q.left,
        page: q.page,
        pages: q.pages,
        has_more: q.page < q.pages,
        proposals: left.map((r) => ({
          id: r.id,
          title: r.title,
          format: formatWords(r.format),
          track: r.track ? { track: r.track.slug, name: r.track.name } : null,
        })),
      });
    },
  },

  review_proposal: {
    title: 'One assigned proposal, blind',
    description:
      'One proposal on your reading list, whole: title, abstract, format, who it is pitched at, its ' +
      "track, and the round's own scorecard — the exact keys, kinds and ranges submit_review takes. " +
      'Nothing here names the author or their employer; that stays hidden the same way it stays ' +
      "hidden on the reviewer's own screen. Refuses in a sentence when the proposal is not on this " +
      "connection's list this round.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The proposal's id, as review_queue gives it." },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(env, args, _nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const id = textArg(args, 'id');
      if (!id) return refuse('Name the proposal you mean — its id, as review_queue gives it.');
      const slug = await eventSlugOfSubmission(env.DB, id);
      if (!slug) return refuse(NO_SUCH_PROPOSAL);
      const found = await reviewEventOr(env, principal, slug);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const spot = await queuePosition(env.DB, principal, ev, id);
      if (!spot) return refuse(NOT_ASSIGNED);
      const q = await reviewQueue(env.DB, principal, ev, { page: spot.page });
      const row = q.rows.find((r) => r.id === spot.submissionId);
      if (!row) return refuse(NOT_ASSIGNED);
      return answered({
        id: row.id,
        event: ev.slug,
        round: ev.round,
        title: row.title,
        abstract: row.abstract,
        format: formatWords(row.format),
        who_it_is_for: levelWords(row.level),
        track: row.track ? { track: row.track.slug, name: row.track.name } : null,
        minutes: row.minutes,
        already_submitted: row.mySubmittedAt !== null,
        my_marks: row.myScores,
        my_note: row.myNote,
        scorecard: ev.scorecard.map((k) => ({
          key: k.key,
          asks: k.label,
          kind: k.kind,
          max: k.kind === 'scale' ? k.max : null,
          options: k.kind === 'select' ? k.options : null,
        })),
      });
    },
  },

  submit_review: {
    title: 'Send one review to the committee',
    description:
      "Score one assigned proposal and send it to the committee in the same act — the round's marks " +
      '(review_proposal names the exact keys, kinds and ranges its scorecard takes) plus an optional ' +
      'note only the committee reads. A submitted review is final for this round, the same way the ' +
      "reviewer's own form's is: it cannot be changed or taken back, and it joins the average on that " +
      "proposal immediately. Refuses in a sentence when the proposal is not on this connection's " +
      'list, when it has already been decided or scored, or when the marks sent match none of the ' +
      "round's scorecard.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The proposal's id, as review_queue or review_proposal gives it." },
        scores: {
          type: 'object',
          description:
            "The round's marks, keyed by the key review_proposal's scorecard gives each one. A scale " +
            'takes a whole number in its range; a select takes one of its own options, spelled ' +
            'exactly as review_proposal lists it; a written line takes a sentence or two.',
          additionalProperties: true,
        },
        comment: { type: 'string', description: 'A note only the committee reads. Optional.' },
      },
      required: ['id', 'scores'],
      additionalProperties: false,
    },
    async run(env, args, _nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const id = textArg(args, 'id');
      if (!id) return refuse('Name the proposal you mean — its id, as review_queue gives it.');
      const slug = await eventSlugOfSubmission(env.DB, id);
      if (!slug) return refuse(NO_SUCH_PROPOSAL);
      const found = await reviewEventOr(env, principal, slug);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;

      const spot = await queuePosition(env.DB, principal, ev, id);
      if (!spot) return refuse(NOT_ASSIGNED);

      // A submitted review cannot be taken back, so a mark this tool cannot
      // place exactly as the caller meant it is refused, never quietly fixed.
      // Every key must be one the scorecard has, and every value must be in
      // range — a scale takes a whole number in its span, a select one of its
      // own words. An unknown key, or 4.7 on a scale of 5, stops the whole
      // submit with a sentence naming what was wrong.
      const rawScores = isObject(args['scores']) ? args['scores'] : {};
      const cardByKey = new Map(ev.scorecard.map((k) => [k.key, k]));
      const checked = validateMarks(rawScores, ev.scorecard, cardByKey);
      if (!checked.ok) return refuse(checked.says);
      const scores = checked.scores;
      if (Object.keys(scores).length === 0) {
        return refuse(
          "A review needs at least one mark from this round's scorecard. review_proposal lists the " +
            'keys, kinds and ranges it takes.'
        );
      }

      // The note is the committee's alone, and it is capped where the form caps
      // it — a longer one is trimmed rather than refused, because the marks are
      // the binding part and a wall of text is not worth losing them over.
      const rawComment = textArg(args, 'comment');
      const comment = rawComment ? rawComment.slice(0, REVIEW_NOTE_MAX) : '';

      // One proposal, staged and submitted in one guarded batch — never the
      // cohort. A refusal here means nothing was written.
      const outcome = await submitOneReview(
        env.DB,
        principal,
        ev.id,
        ev.round,
        spot.submissionId,
        scores,
        comment || null
      );
      if (outcome !== 'sent') return refuse(NOTES[outcome]);

      return answered({
        id: spot.submissionId,
        submitted: true,
        recorded: scores,
        note_kept: comment ? comment.length : 0,
        note_trimmed: !!rawComment && rawComment.length > REVIEW_NOTE_MAX,
        says:
          'Your review is in. It counts towards the average on this proposal now, and it is final ' +
          'for this round. Nothing else on your list was touched.',
      });
    },
  },

  // The reviewer's other act (beyond submit_review): recuse from an assigned
  // proposal. Immediate like submit_review — self-scoped and internal (it drops
  // your own marks, tells no one), so it needs no confirm surface. Same blind
  // scoping: queuePosition only resolves the caller's own assigned rows.
  step_aside: {
    title: 'Step aside from a proposal you were assigned',
    description:
      'Recuse yourself from one assigned proposal — a conflict, or you know the speaker. It comes off ' +
      'your reading list for this round and any marks you staged on it are dropped. Final for this round. ' +
      'Give the proposal id as review_queue or review_proposal gives it. Refuses when it is not on your ' +
      'list or has already been decided.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The proposal's id, as review_queue or review_proposal gives it." },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(env, args, _nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const id = textArg(args, 'id');
      if (!id) return refuse('Name the proposal — its id, as review_queue gives it.');
      const slug = await eventSlugOfSubmission(env.DB, id);
      if (!slug) return refuse(NO_SUCH_PROPOSAL);
      const found = await reviewEventOr(env, principal, slug);
      if (!found.ok) return refuse(found.says);
      const ev = found.ev;
      const spot = await queuePosition(env.DB, principal, ev, id);
      if (!spot) return refuse(NOT_ASSIGNED);
      // queuePosition's decider branch returns the whole pile, not just what was
      // handed to this reviewer — so require an ACTUAL assignment (a review row
      // this person owns this round) before recusing. Without this, an owner or
      // approver could "step aside" from a proposal never assigned to them,
      // spuriously dropping it from the committee's unassigned count (Codex).
      const assigned = await env.DB
        .prepare(`SELECT 1 FROM review WHERE submission_id = ? AND reviewer_person_id = ? AND round = ?`)
        .bind(spot.submissionId, principal.personId, ev.round)
        .first();
      if (!assigned) return refuse(NOT_ASSIGNED);
      const outcome = await stepAside(env.DB, principal, ev.id, ev.round, spot.submissionId);
      if (outcome !== 'stepped') return refuse(STEP_SAID[outcome] ?? 'That did not go through. Try once more.');
      return answered({
        id: spot.submissionId,
        stepped_aside: true,
        says: 'You have stepped aside from that one — it is off your list for this round, and any marks you staged on it were dropped.',
      });
    },
  },

  // The first agentic WRITE over MCP (D-037): an external agent, acting AS the
  // person who minted its token, adds a session to that person's own schedule
  // or takes it off. It goes through the very same trusted boundary the
  // in-product concierge uses — proposeAction validates the id against this
  // event's published agenda, checks the star capability live, and executes the
  // one guarded workflow. A direct, reversible, self-scoped act, so it runs
  // inline with no confirm; higher-stakes acts (connect, decide) stay first-
  // party until the prepare-only MCP path is built.
  star_session: {
    title: 'Star or unstar a session',
    description:
      "Add one session on this event's published agenda to your own schedule (star it), or take it " +
      'back off (unstar it) — your list alone, undoable by the same call. Give the session id the ' +
      'agenda or session tools hand you, and `on`: true to star (the default), false to unstar. ' +
      'Refuses in a sentence when the session is not on this event, or not yet on a published agenda.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        session: { type: 'string', description: "The session's id, as the agenda or session tools give it." },
        on: { type: 'boolean', description: 'true to star (default), false to unstar.' },
      },
      required: ['event', 'session'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const submissionId = textArg(args, 'session');
      if (!submissionId) return refuse('Name the session you mean — its id, as the agenda gives it.');
      // Polarity is an explicit typed arg here (unlike the natural-language
      // concierge, which must resolve it from words): the tool is "star", so a
      // missing `on` means star. `false` unstars.
      const on = typeof args['on'] === 'boolean' ? (args['on'] as boolean) : true;

      const proposed = await proposeAction(
        { DB: env.DB, FILES: env.FILES },
        principal,
        { eventId: found.ev.id, surface: 'event' },
        'star',
        { submissionId, on },
        nowMs
      );
      if (proposed.kind === 'refused') {
        return refuse(STAR_REFUSAL[proposed.reason] ?? "I couldn't do that just now. Nothing changed.");
      }
      // Direct tier: the path ran, but the workflow's own word says if it took.
      if (proposed.kind === 'executed') {
        if (proposed.outcome === 'moved') {
          return refuse('The agenda shifted while I was doing that — nothing changed. Try again.');
        }
        if (proposed.outcome !== 'done') return refuse("I couldn't do that just now. Nothing changed.");
        return answered({
          session: submissionId,
          starred: on,
          says: on
            ? `"${proposed.subject}" is on your schedule now.`
            : `Took "${proposed.subject}" off your schedule.`,
        });
      }
      // A direct act never stages; if it somehow did, say so rather than lie.
      return refuse('That one needs confirming in the app.');
    },
  },

  // A speaker (or their helper) marks a deliverable task done, or puts it back.
  // Direct + reversible, self-scoped through the portal surface; the boundary
  // resolves the actor so a helper's agent completes the deck reminder AS the
  // speaker they assist.
  mark_task_done: {
    title: 'Mark a deliverable task done (or put it back)',
    description:
      'Mark one of your own deliverable tasks done — or, with done=false, put a completed one back on ' +
      "your list. Reversible, yours alone. If you are a speaker's helper, this acts for the speaker you " +
      'assist. Give the task id from the portal (my_owed lists your own open tasks). Refuses if the task ' +
      'is not yours to touch or not on this event.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        task: { type: 'string', description: "The task's id, as my_owed or the portal gives it." },
        done: { type: 'boolean', description: 'true to mark done (default), false to put it back on your list.' },
      },
      required: ['event', 'task'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const taskId = textArg(args, 'task');
      if (!taskId) return refuse('Name the task — its id, as my_owed lists it.');
      const done = typeof args['done'] === 'boolean' ? (args['done'] as boolean) : true;
      const proposed = await proposeAction(
        { DB: env.DB, FILES: env.FILES },
        principal,
        { eventId: found.ev.id, surface: 'portal' },
        done ? 'task_done' : 'task_reopen',
        { taskId },
        nowMs
      );
      if (proposed.kind === 'refused') return refuse(TASK_REFUSAL[proposed.reason] ?? "I couldn't do that.");
      if (proposed.kind === 'executed') {
        if (proposed.outcome !== 'done') {
          return refuse(
            proposed.outcome === 'moved'
              ? 'That task had already changed — nothing to do.'
              : "I couldn't do that just now. Nothing changed."
          );
        }
        return answered({
          task: taskId,
          done,
          says: done ? `Marked "${proposed.subject}" done.` : `Put "${proposed.subject}" back on your list.`,
        });
      }
      return refuse('That one needs confirming in the app.');
    },
  },

  // A speaker withdraws their OWN proposal. Confirm-tier: withdrawn is terminal
  // (no un-withdraw) and removes the talk from the committee's list. A helper
  // cannot withdraw — the boundary binds the speaker's own identity.
  propose_withdraw: {
    title: 'Propose withdrawing a proposal',
    description:
      'Stage a withdrawal of one of YOUR proposals. Withdrawn is final — the talk leaves the committee' +
      "'s list and cannot be put back — so this returns a pending id and a manifest; call commit_pending " +
      "with the id to withdraw it. A helper cannot withdraw a speaker's talk. Refuses if the proposal is " +
      'not yours, not on this event, or already placed on a published agenda.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        proposal: { type: 'string', description: "The proposal's id, as my_owed or the portal gives it." },
      },
      required: ['event', 'proposal'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const proposed = await proposeAction(
        { DB: env.DB, FILES: env.FILES },
        principal,
        { eventId: found.ev.id, surface: 'portal' },
        'withdraw_proposal',
        { submissionId: textArg(args, 'proposal') },
        nowMs
      );
      if (proposed.kind === 'refused') return refuse(WITHDRAW_REFUSAL[proposed.reason] ?? "I couldn't stage that.");
      if (proposed.kind === 'pending') {
        return answered({
          pending_id: proposed.id,
          manifest: proposed.manifest,
          says: `${proposed.manifest} Call commit_pending with pending_id "${proposed.id}" to withdraw it.`,
        });
      }
      return refuse('That could not be staged for confirmation.');
    },
  },

  // The organizer's flagship over MCP (D-037): invite a batch of people to
  // submit to an open call — the "invite my Gmail contacts" gedanken. This is a
  // confirm-with-number act, so it is TWO calls, never one: propose_invite
  // stages the exact recipients and hands back a manifest + a pending id + the
  // count; the agent shows the person that manifest; then commit_pending sends
  // it with the count restated. So a prompt-injected abstract can neither add a
  // recipient nor change the number a human approved — the boundary froze both.
  propose_invite: {
    title: 'Propose inviting people to submit',
    description:
      "Stage an invite to a batch of people to submit to this event's OPEN call — you resolve who " +
      '(from your own contacts, wherever) and pass a name and email for each. Nothing is written to ' +
      "anyone yet: this returns a pending id, the exact list as a one-line manifest, and the count. " +
      'Show that to the organizer, then call commit_pending with the id and the number to actually ' +
      'stage the invites. Refuses in a sentence when the call is not open or you are not its organizer.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        contacts: {
          type: 'array',
          description: 'The people to invite. Each is an object with a name and an email.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: "The person's name." },
              email: { type: 'string', description: "The person's email address." },
            },
            required: ['name', 'email'],
          },
        },
      },
      required: ['event', 'contacts'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const contacts = Array.isArray(args['contacts']) ? args['contacts'] : [];
      const proposed = await proposeAction(
        { DB: env.DB, FILES: env.FILES },
        principal,
        { eventId: found.ev.id, surface: 'backstage' },
        'invite',
        { contacts },
        nowMs
      );
      if (proposed.kind === 'refused') {
        return refuse(INVITE_REFUSAL[proposed.reason] ?? "I couldn't stage that invite.");
      }
      if (proposed.kind === 'pending') {
        return answered({
          pending_id: proposed.id,
          manifest: proposed.manifest,
          count: proposed.count,
          says:
            `Staged, not sent: ${proposed.manifest} Show this to the organizer, then call commit_pending ` +
            `with pending_id "${proposed.id}" and number ${proposed.count} to write the invites. Nothing ` +
            'goes out until they release the event outbox.',
        });
      }
      // 'executed' would mean a direct tier, which invite is not — never claim a
      // send that did not follow the confirm.
      return refuse('That invite could not be staged for confirmation.');
    },
  },

  // The organizer's core act over MCP: accept / waitlist / decline a proposal.
  // Confirm-once, staged into the quiet outbox — nothing reaches the speaker
  // until the outbox is released. propose_decision stages it and returns a
  // manifest naming the proposal AND the speaker; commit_pending commits it.
  propose_decision: {
    title: 'Propose a decision on a proposal',
    description:
      'Stage an accept, waitlist, or decline on ONE proposal — the "decided but not told" model: the ' +
      'decision changes nothing the speaker can see and no letter sends until the organizer releases ' +
      'the outbox. `decision` is one of accepted, waitlisted, rejected. Returns a pending id and a ' +
      'one-line manifest naming the proposal and its speaker; call commit_pending with the id to stage ' +
      'it. Refuses when the proposal is not on this event or you lack approval power there.',
    inputSchema: {
      type: 'object',
      properties: {
        ...EVENT_ARG,
        proposal: { type: 'string', description: "The proposal's id, as review_queue or pile_summary give it." },
        decision: {
          type: 'string',
          description: 'One of: accepted, waitlisted, rejected.',
          enum: ['accepted', 'waitlisted', 'rejected'],
        },
      },
      required: ['event', 'proposal', 'decision'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const found = await eventOr(env, args, nowMs);
      if (!found.ok) return refuse(found.says);
      const proposed = await proposeAction(
        { DB: env.DB, FILES: env.FILES },
        principal,
        { eventId: found.ev.id, surface: 'backstage' },
        'decide',
        { submissionId: textArg(args, 'proposal'), decision: textArg(args, 'decision') },
        nowMs
      );
      if (proposed.kind === 'refused') return refuse(DECIDE_REFUSAL[proposed.reason] ?? "I couldn't stage that decision.");
      if (proposed.kind === 'pending') {
        return answered({
          pending_id: proposed.id,
          manifest: proposed.manifest,
          says:
            `Staged, not sent: ${proposed.manifest} Call commit_pending with pending_id "${proposed.id}" to ` +
            'stage it. It joins the outbox as a decided-but-not-told letter; nothing reaches the speaker until ' +
            'the outbox is released.',
        });
      }
      return refuse('That decision could not be staged for confirmation.');
    },
  },

  // The second half of any confirm-tier act: commit exactly the manifest that
  // was staged, by its id. For a by-the-number act the number must be restated —
  // the same "the number confirmed is the number that goes" rule the web outbox
  // enforces. The boundary re-authorizes live and executes the STORED arguments,
  // never anything sent here, so this call cannot change who or how many.
  commit_pending: {
    title: 'Commit a staged action',
    description:
      'Send a staged action — an invite from propose_invite, say — by its pending id. If it was staged ' +
      'with a count, give that exact number as `number`; a wrong or missing number is refused, nothing ' +
      'is written. Refuses in a sentence when the id is not yours, was already sent, or has expired.',
    inputSchema: {
      type: 'object',
      properties: {
        pending_id: { type: 'string', description: 'The pending id propose_invite (or another proposer) returned.' },
        number: {
          type: 'number',
          description: 'For a by-the-number action, the exact count from the proposal. Omit only for a plain confirm.',
        },
      },
      required: ['pending_id'],
      additionalProperties: false,
    },
    async run(env, args, nowMs, principal) {
      if (!principal) return refuse(NEEDS_SIGNED_IN);
      const pendingId = textArg(args, 'pending_id');
      if (!pendingId) return refuse('Name the staged action — its pending id, as propose_invite gives it.');
      const number = numberArg(args, 'number') ?? null;
      const result = await commitPendingAction(
        { DB: env.DB, FILES: env.FILES },
        principal,
        pendingId,
        number,
        nowMs,
        // commits only the confirm-tier acts proposed over MCP — never some other owned pending
        ['invite', 'decide', 'withdraw_proposal']
      );
      if (!result.ok) return refuse(COMMIT_REFUSAL[result.reason] ?? "That couldn't be committed.");
      const outcome = result.outcome;
      if (outcome === 'done') {
        // The confirmation is the committed action's own, never a borrowed one.
        const says =
          result.actionType === 'invite'
            ? 'Done — the invites are written and waiting in the event outbox. Nothing sends until you release it.'
            : result.actionType === 'decide'
              ? 'Done — the decision is staged in the event outbox. Nothing reaches the speaker until you release it.'
              : result.actionType === 'withdraw_proposal'
                ? 'Done — the proposal is withdrawn. It has left the committee’s list.'
                : 'Done — committed.';
        return answered({ committed: true, outcome, says });
      }
      if (outcome === 'partial') {
        return answered({
          committed: true,
          partial: true,
          outcome,
          says: 'Some were written, not all — a few could not be added. The rest are waiting in the event outbox.',
        });
      }
      // 'moved'/'trouble'/anything else: nothing usable was written. This is an
      // ERROR result (isError), never a quiet success through answered() (Codex).
      return refuse(
        outcome === 'moved'
          ? 'The world shifted while committing — nothing was written. Propose it again.'
          : 'That did not go through, and nothing was written.'
      );
    },
  },
};

const STEP_SAID: Record<string, string> = {
  already: 'That one was already finished this round, so it stays as it is.',
  gone: 'That one has been decided since — there is nothing to step aside from.',
  moved: 'It was finished while you were looking. Nothing changed.',
  trouble: 'That did not go through. Try once more.',
};

const TASK_REFUSAL: Record<string, string> = {
  'no-task': 'That task is not yours to mark, or not on this event. my_owed lists the ones that are.',
  'not-allowed': "That isn't something you can do from here.",
  'not-here': "That isn't something you can do from here.",
};

const WITHDRAW_REFUSAL: Record<string, string> = {
  'no-proposal':
    'That proposal is not yours to withdraw, is already placed on the published agenda, or is not on this event.',
  'not-allowed': "That isn't something you can do from here.",
  'not-here': "That isn't something you can do from here.",
  'too-many-pending': 'You have several actions waiting on confirmation — commit or drop those first.',
};

const DECIDE_REFUSAL: Record<string, string> = {
  'no-proposal': 'No proposal here goes by that id. review_queue or pile_summary list the ones that do.',
  'bad-decision': 'A decision is one of: accepted, waitlisted, rejected.',
  'no-event': NO_SUCH_EVENT,
  'not-allowed': 'You need approval power on that conference to decide.',
  'not-here': 'You need approval power on that conference to decide.',
  'too-many-pending': 'You have several actions waiting on confirmation — commit or drop those first.',
};

const INVITE_REFUSAL: Record<string, string> = {
  'no-recipients': 'Give me at least one person to invite — a name and an email for each.',
  'too-many': 'That is too many for a single invite (100 at most). Split it, or use the outbox for a campaign.',
  'not-open': "That conference's call is not open, so there is nothing to invite anyone to yet.",
  'no-event': NO_SUCH_EVENT,
  'not-allowed': 'You are not an organizer of that conference.',
  'not-here': 'You are not an organizer of that conference.',
  'too-many-pending': 'You have several actions waiting on confirmation — commit or drop those first.',
};

const COMMIT_REFUSAL: Record<string, string> = {
  'not-yours': 'That staged action is not yours to confirm.',
  gone: 'That one is no longer open — it was already committed, dropped, or never staged.',
  expired: 'That staged action sat too long and expired. Propose it again.',
  'not-allowed': 'You are no longer allowed to do that.',
  'wrong-number': 'That number does not match what was staged. Read the count in the proposal and send exactly that.',
  'unknown-action': "I don't recognise that staged action.",
  'not-committable': 'That kind of staged action cannot be committed over MCP — finish it in the app.',
};

const STAR_REFUSAL: Record<string, string> = {
  'no-session':
    "That session is not on this event's published agenda, so it cannot be starred. Ask the agenda tool for the ones that can.",
  'not-allowed': 'You cannot do that here.',
  'not-here': 'You cannot do that here.',
  'too-many-pending': 'You have several actions waiting on confirmation — clear those first, then ask again.',
};

const ALL_TOOLS: Record<string, Tool> = { ...PUBLIC_TOOLS, ...SIGNED_TOOLS };

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0, by hand.
 * ------------------------------------------------------------------ */

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type RpcId = string | number | null;

class RpcFault extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = 'RpcFault';
  }
}

const replyWith = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const faultWith = (id: RpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** A tool result, in the shape tools/call promises. */
function toolResult(outcome: ToolOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    return { content: [{ type: 'text', text: outcome.says }], isError: true };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.value, null, 2) }],
    structuredContent: outcome.value,
  };
}

async function callTool(
  env: Env,
  params: Args,
  nowMs: number,
  principal: Principal | null
): Promise<Record<string, unknown>> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const tool = ALL_TOOLS[name];
  if (!tool) {
    const known = Object.keys(principal ? ALL_TOOLS : PUBLIC_TOOLS);
    throw new RpcFault(
      INVALID_PARAMS,
      `There is no tool called ${name || 'that'} here. The ones there are: ${known.join(', ')}.`
    );
  }
  const args = isObject(params['arguments']) ? params['arguments'] : {};
  try {
    return toolResult(await tool.run(env, args, nowMs, principal));
  } catch {
    // A tool that fell over is still a sentence, not a stack trace. The
    // caller can act on this one: try it again.
    return toolResult(
      refuse('Fireside could not read that just now. Try the same request again in a moment.')
    );
  }
}

/**
 * The dispatcher. A plain map from method name to what it answers — adding a
 * method is adding a line here, and everything not on it is -32601.
 */
const METHODS: Record<
  string,
  (env: Env, params: Args, nowMs: number, principal: Principal | null) => Promise<unknown>
> = {
  initialize: async (_env, _params, _nowMs, principal) => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: principal ? `${INSTRUCTIONS} This connection acts as ${principal.name}.` : INSTRUCTIONS,
  }),

  ping: async () => ({}),

  'tools/list': async (_env, _params, _nowMs, principal) => ({
    tools: Object.entries(principal ? ALL_TOOLS : PUBLIC_TOOLS).map(([name, t]) => ({
      name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }),

  'tools/call': async (env, params, nowMs, principal) => await callTool(env, params, nowMs, principal),
};

/**
 * The bearer half of the door. 'Authorization: Bearer <token>', purpose
 * 'agent', turned into the Principal it names — or null for anything that is
 * not exactly that: no header, a header that is not Bearer, a token that
 * does not verify, the wrong purpose, an expired one, or a person who no
 * longer exists. Every one of those reads as "no header" to the rest of this
 * file. Nothing here throws — a bearer that does not check out neither
 * crashes the call nor unlocks anything.
 */
async function principalFromBearer(env: Env, header: string | undefined): Promise<Principal | null> {
  const m = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
  if (!m?.[1]) return null;
  const payload = await verifyToken(env.SESSION_SECRET, m[1]);
  if (!payload || payload.purpose !== 'agent') return null;
  return await principalFromPersonId(env.DB, payload.subjectId);
}

export function registerMcp(app: Hono<{ Bindings: Env }>): void {
  // One address, one method. There is no stream to open and no session to
  // resume, so a GET has nothing to hand back but the way in.
  app.on(['GET', 'DELETE'], '/mcp', (c) => {
    c.header('allow', 'POST');
    return c.json(
      { fireside: 'This door speaks the Model Context Protocol. Post a JSON-RPC 2.0 request here.' },
      405
    );
  });

  app.post('/mcp', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(faultWith(null, PARSE_ERROR, 'That body could not be read as JSON.'), 400);
    }

    if (Array.isArray(body)) {
      // Batching left the protocol in 2025-06-18; one message per request.
      return c.json(
        faultWith(null, INVALID_REQUEST, 'Send one request at a time — this door takes no batches.'),
        400
      );
    }
    if (!isObject(body)) {
      return c.json(faultWith(null, INVALID_REQUEST, 'A request is an object with a method.'), 400);
    }

    const method = typeof body['method'] === 'string' ? body['method'] : '';
    const params = isObject(body['params']) ? body['params'] : {};
    const rawId = body['id'];
    const isNotification = !('id' in body) || rawId === undefined;
    const id: RpcId =
      typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

    if (isNotification) {
      // notifications/initialized is the handshake's last word, and this door
      // keeps nothing between calls, so there is nothing to write down. Every
      // notification is taken and answered with the only honest answer to
      // something that asked no question: 202, and no body.
      return c.body(null, 202);
    }

    if (!method) {
      return c.json(faultWith(id, INVALID_REQUEST, 'A request needs a method.'), 400);
    }

    const handler = METHODS[method];
    if (!handler) {
      return c.json(faultWith(id, METHOD_NOT_FOUND, `This door has no method called ${method}.`), 200);
    }

    // Read once per request, whatever the method: tools/list needs it to
    // decide which tools exist, tools/call needs it to run one, and
    // initialize needs it for the one added sentence. A caller that sent no
    // header pays no extra read at all — the regex fails before anything
    // touches the database.
    const principal = await principalFromBearer(c.env, c.req.header('authorization'));

    try {
      return c.json(replyWith(id, await handler(c.env, params, Date.now(), principal)), 200);
    } catch (e) {
      if (e instanceof RpcFault) return c.json(faultWith(id, e.code, e.message), 200);
      return c.json(
        faultWith(id, INVALID_REQUEST, 'That request could not be carried out. Try it again in a moment.'),
        200
      );
    }
  });
}
