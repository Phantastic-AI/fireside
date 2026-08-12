// The same doors, for the thing typing on your behalf.
//
// Everything a person can see on the public side of Fireside — the events, an
// event's facts, the program, one talk, the speakers, the questions the call
// asks, and the act of sending a proposal — is reachable here by a machine,
// through the Model Context Protocol, at one address: POST /mcp.
//
// The shape of the thing:
//
//   * Hand-rolled JSON-RPC 2.0 over plain HTTP. No streaming, no session, no
//     library, no new dependency. A request goes in as application/json and a
//     response comes back the same way; a notification gets 202 and no body.
//     Statelessness is the whole trick — every call carries what it needs, so
//     two calls in a row may land on two different machines and neither knows.
//   * The read tools go through queries/public.ts, which is where the rules
//     about what a stranger may see are already written into the SQL. This
//     file adds no scope logic of its own, because the second copy of a rule
//     is the one that goes wrong.
//   * queries/portal.ts is deliberately NOT used. A speaker's portal holds
//     decisions they have been told and letters addressed to them; there is no
//     one signed in on this connection, so there is nobody to show it to. The
//     portal stays behind its sign-in and its emailed link.
//   * The one writer is workflows/submit.ts's submitProposal — the same
//     function behind the call-for-speakers screen, with the same guards, the
//     same cap on how many proposals one person may send, and the same
//     refusals in the same words. A proposal sent from here is not a lesser
//     proposal; it is the same row, written the same way.
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
import {
  ABSTRACT_MAX,
  FORMATS,
  LEVELS,
  submitProposal,
  tracksOfEvent,
  type TrackOption,
} from './workflows/submit';

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
  run: (env: Env, args: Args, nowMs: number) => Promise<ToolOutcome>;
};

const textArg = (args: Args, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
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

const TOOLS: Record<string, Tool> = {
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

async function callTool(env: Env, params: Args, nowMs: number): Promise<Record<string, unknown>> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const tool = TOOLS[name];
  if (!tool) {
    throw new RpcFault(
      INVALID_PARAMS,
      `There is no tool called ${name || 'that'} here. The ones there are: ${Object.keys(TOOLS).join(', ')}.`
    );
  }
  const args = isObject(params['arguments']) ? params['arguments'] : {};
  try {
    return toolResult(await tool.run(env, args, nowMs));
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
const METHODS: Record<string, (env: Env, params: Args, nowMs: number) => Promise<unknown>> = {
  initialize: async () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  }),

  ping: async () => ({}),

  'tools/list': async () => ({
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }),

  'tools/call': async (env, params, nowMs) => await callTool(env, params, nowMs),
};

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

    try {
      return c.json(replyWith(id, await handler(c.env, params, Date.now())), 200);
    } catch (e) {
      if (e instanceof RpcFault) return c.json(faultWith(id, e.code, e.message), 200);
      return c.json(
        faultWith(id, INVALID_REQUEST, 'That request could not be carried out. Try it again in a moment.'),
        200
      );
    }
  });
}
