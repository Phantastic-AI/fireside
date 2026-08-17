// Ask — the concierge that answers with doors, not paragraphs.
//
// The shape of every answer is the same: two to four short sentences, and up
// to three doors into the product. That is the whole design. A wall of text is
// a failure here even when every word in it is true, because the person asking
// is Dani, mid-hall, one thumb, deciding which room to walk into next.
//
// The order of business, and why:
//   1. A curated answer wins outright. If an organizer has written the answer
//      to this exact question, it is better than anything read off the program,
//      and it costs nothing to serve.
//   2. Otherwise the program itself is the source. Facts are composed from
//      queries/public.ts, so Ask can never see a talk the public agenda would
//      not show — no rejected proposal, no unpublished schedule, no exceptions.
//   3. The doors are a closed set built here from live paths. The model picks
//      by id and never writes a link, so a hallucinated address cannot become
//      an anchor tag. Its sentences are escaped as text by the screen.
//
// Standing widens what can be read, never what a stranger can read (D-017).
// Somebody with a role at THIS conference also gets the pile's counts and the
// backstage doors; somebody with proposals in gets those proposals, worded the
// way their own portal words them. Both reads are scoped by the event, so a
// role held at another conference earns nothing here, and neither section is
// even assembled for a visitor with no standing.
//
// Two SELECTs live in this file rather than in a query file, deliberately: the
// curated-answer read and the question write belong to Ask alone, no screen
// outside this parcel reads them, and queries/public.ts is another parcel's
// file this wave. If Ask outgrows one screen, they are the first thing to lift.

import { checkedBatch, guard, newId, now } from '../lib/db';
import { label, type LabelKey } from '../lib/labels';
import { pile, READ_ROLES, REVIEW_ROLES } from '../queries/admin';
import { portalView, type PortalTask, type VisibleState } from '../queries/portal';
import {
  agenda,
  eventDayKey,
  speakersGallery,
  type Agenda,
  type EventHome,
  type GallerySpeaker,
  type PublicSession,
} from '../queries/public';
import { FORMAT_KEY } from '../lib/labels';
import { reviewEvent, reviewQueue } from '../queries/reviews';
import type { Principal } from './account';

/* ------------------------------------------------------------------ *
 * The closed set of doors.
 * ------------------------------------------------------------------ */

export type Door = { id: string; href: string; label: string };

/**
 * What the screen renders. `say` is plain text — the screen escapes it.
 *
 * 'instant' is the fourth kind and the cheapest: a question the object graph
 * answers about itself, composed here from one read and a template, with no
 * model in the path at all. See INSTANT ANSWERS at the foot of this file.
 */
export type AskResult = {
  kind: 'curated' | 'read' | 'unsure' | 'instant' | 'house' | 'busy';
  say: string[];
  doors: Door[];
};

export type CuratedAnswer = { id: string; questionText: string; body: string };

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** How much of the program the concierge is given to read. Kept small so the
 *  answer arrives while the question is still in mind. */
const MAX_SESSIONS = 40;
const MAX_SPEAKERS = 24;
const MAX_SENTENCES = 4;
const MAX_DOORS = 3;
const MAX_SENTENCE_CHARS = 260;
/** How many of a speaker's own proposals are named before the portal takes over. */
const MAX_MINE = 8;
/** The same ceiling the agenda's own search box carries. */
const SEARCH_MAX = 80;
/** A stuck call must not hold the page. Twelve seconds, then the honest state. */
const PATIENCE_MS = 12_000;

/* ------------------------------------------------------------------ *
 * Dates, small and local. A conference day is a local fact.
 * ------------------------------------------------------------------ */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function dayFromKey(iso: string): Date {
  const p = iso.split('-');
  return new Date(Date.UTC(Number(p[0] ?? '1970'), Number(p[1] ?? '1') - 1, Number(p[2] ?? '1')));
}

/** '2026-09-03' → '3 September 2026'. */
function longDate(iso: string): string {
  const p = iso.split('-');
  return `${Number(p[2] ?? '0')} ${MONTHS[Number(p[1] ?? '0') - 1] ?? ''} ${p[0] ?? ''}`.trim();
}

/** '2026-09-03' → 'Thu 3 Sep'. */
export function shortDay(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dayFromKey(iso));
}

function instant(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' })
    .format(new Date(ms));
}

function clock(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

function dateRange(ev: EventHome): string {
  if (ev.startsOn === ev.endsOn) return longDate(ev.startsOn);
  const sameMonth = ev.startsOn.slice(0, 7) === ev.endsOn.slice(0, 7);
  const from = sameMonth ? String(Number(ev.startsOn.slice(8))) : longDate(ev.startsOn).replace(/ \d{4}$/, '');
  return `${from} – ${longDate(ev.endsOn)}`;
}

/* ------------------------------------------------------------------ *
 * Curated answers — the organizers' own words, and the only thing that
 * beats reading the program.
 * ------------------------------------------------------------------ */

/** Case-folded, punctuation-forgiving. "When does the CFP close?" and
 *  "when does the cfp close" are the same question to a person, so they are
 *  the same question here. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every answer an organizer has put in use here, newest first. One row per
 * question by construction — the schema's partial unique index allows exactly
 * one In-use answer per (event, question).
 */
export async function curatedAnswers(db: D1Database, eventId: string): Promise<CuratedAnswer[]> {
  const res = await db
    .prepare(
      `SELECT id, question_text, body
         FROM answer
        WHERE event_id = ? AND state = 'in_use'
        ORDER BY COALESCE(accepted_at, created_at) DESC, question_text`
    )
    .bind(eventId)
    .all<{ id: string; question_text: string; body: string }>();
  return res.results.map((r) => ({ id: r.id, questionText: r.question_text, body: r.body }));
}

export function matchCurated(list: CuratedAnswer[], text: string): CuratedAnswer | null {
  const key = fold(text);
  if (!key) return null;
  return list.find((a) => fold(a.questionText) === key) ?? null;
}

/* ------------------------------------------------------------------ *
 * The question row. No person_id, by design — this is program feedback,
 * not a note of who asked.
 * ------------------------------------------------------------------ */

export type QuestionScope = 'public' | 'speaker' | 'organizer';

export async function logQuestion(
  db: D1Database,
  input: {
    eventId: string;
    scope: QuestionScope;
    text: string;
    answered: boolean;
    snapshot: string | null;
  }
): Promise<string> {
  const id = newId('qq');
  await checkedBatch(
    db,
    [
      // The event has to still be there. Without this the FK failure would
      // arrive as a stack trace instead of a sentence.
      guard(db, 'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = ?)', input.eventId),
      db
        .prepare(
          `INSERT INTO question
             (id, event_id, scope, conversation_id, text, answered, answer_snapshot,
              asked_at, organizer_note, annotated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`
        )
        .bind(
          id,
          input.eventId,
          input.scope,
          input.text.slice(0, 500),
          input.answered ? 1 : 0,
          input.snapshot,
          now()
        ),
    ],
    [0, 1],
    'that conference is not here any more'
  );
  return id;
}

/* ------------------------------------------------------------------ *
 * Doors: every path in this list is a live one, and nothing reaches the
 * screen that did not come from here.
 * ------------------------------------------------------------------ */

function fixedDoors(ev: EventHome, published: boolean): Door[] {
  const out: Door[] = [
    { id: 'd1', href: `/${ev.slug}/agenda`, label: 'The agenda' },
    { id: 'd2', href: `/${ev.slug}/speakers`, label: "Who's speaking" },
    { id: 'd3', href: `/${ev.slug}`, label: 'About this conference' },
  ];
  if (ev.lifecycle === 'open') {
    out.push({ id: 'd4', href: `/${ev.slug}/cfp`, label: 'The call for speakers' });
  }
  if (published) {
    out.push({ id: 'd5', href: `/${ev.slug}/my-schedule`, label: 'My schedule' });
  }
  out.push({ id: 'd6', href: `/${ev.slug}/portal`, label: 'Your portal' });
  return out;
}

/** The doors a screen falls back to when there is nothing better to say. */
export function plainDoors(ev: EventHome, published: boolean): Door[] {
  const all = fixedDoors(ev, published);
  const pick = (id: string) => all.find((d) => d.id === id);
  return [pick('d1'), pick('d2')].filter((d): d is Door => !!d);
}

/** The three backstage ones, named once so the facts an organizer is given and
 *  the instant answer they press for cannot point at two different screens. */
function backstageDoors(ev: EventHome): Door[] {
  return [
    { id: 'd7', href: `/admin/${ev.slug}/submissions`, label: 'The proposals' },
    { id: 'd8', href: `/admin/${ev.slug}/outbox`, label: 'The letters waiting to go' },
    { id: 'd9', href: `/admin/${ev.slug}/agenda`, label: 'The agenda you are building' },
  ];
}

/* ------------------------------------------------------------------ *
 * Standing: what this one person is to this one conference, and the
 * facts that earns. Nothing here is ever assembled for somebody who
 * does not hold the standing it belongs to.
 * ------------------------------------------------------------------ */

type Standing = { lines: string[]; doors: Door[] };

/** The word this proposal wears on the speaker's own portal. The state itself
 *  arrives already told-gated from queries/portal.ts, whose VISIBLE_STATE_SQL
 *  is the only thing allowed to decide it, and the word comes from the same
 *  label the portal card reads — so a decision that has been made and not sent
 *  still says "with the committee" here, exactly as it does there. */
const STATE_WORD: Record<VisibleState, LabelKey> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};

/** The counts band's own read (routes/admin/home.ts), not a second way of
 *  counting the same pile. One row rather than none: only `counts` is wanted,
 *  and pile() reads a limit of 0 as no limit at all. */
async function organizerFacts(
  db: D1Database,
  ev: EventHome,
  principal: Principal
): Promise<Standing> {
  const { counts } = await pile(db, principal, ev.id, 'all', { limit: 1 });
  const doors = backstageDoors(ev);
  const lines = [
    '',
    'ORGANIZER FACTS — this person runs this conference, so these are theirs to see',
    `Still undecided: ${counts.undecided} [d7]`,
    `Decided and not told yet: ${counts.decidedNotTold} [d8]`,
    `Accepted: ${counts.accepted}, and ${ev.counts.speakers} speakers with them [d9]`,
  ];
  if (ev.cfpClosesAt) {
    lines.push(
      `The call ${ev.lifecycle === 'open' ? 'closes' : 'closed'} ` +
        `${instant(ev.cfpClosesAt, ev.timezone)}`
    );
  }
  return { lines, doors };
}

/** Their own proposals and nothing else — portalView is already scoped to one
 *  person, and a draft is not a proposal until it has been sent. Their portal
 *  is d6, already in the closed set, so it is pointed at rather than repeated. */
async function speakerFacts(
  db: D1Database,
  ev: EventHome,
  principal: Principal
): Promise<Standing | null> {
  const view = await portalView(db, ev.id, principal.personId);
  const mine = (view?.submissions ?? []).filter((s) => s.state !== 'draft');
  if (!mine.length) return null;
  const lines = [
    '',
    'YOUR PROPOSALS — what this person has sent this conference, and only theirs',
  ];
  for (const s of mine.slice(0, MAX_MINE)) {
    lines.push(`[d6] "${s.title}" — ${label(STATE_WORD[s.state], 'onstage')}`);
  }
  if (mine.length > MAX_MINE) lines.push(`…and ${mine.length - MAX_MINE} more in their portal [d6]`);
  return { lines, doors: [] };
}

/** Standing is per conference. A role on another event is not a role here, so
 *  the only key that counts is this event's own. */
async function standingFacts(
  db: D1Database,
  ev: EventHome,
  principal: Principal | null
): Promise<Standing | null> {
  if (!principal) return null;
  if (principal.eventRoles[ev.id] !== undefined) return await organizerFacts(db, ev, principal);
  return await speakerFacts(db, ev, principal);
}

/* ------------------------------------------------------------------ *
 * Narrowing the agenda. Its filters compose in the address — day, track,
 * format, room and a search — so the concierge can hand back a program
 * already cut down to the answer. It never writes that address: it names
 * values from the list below, and this file builds the door.
 * ------------------------------------------------------------------ */

type Narrowing = { days: string[]; tracks: string[]; formats: string[]; rooms: string[] };

/** The two transforms routes/public/agenda.ts applies when it writes a chip's
 *  href. They have to agree, or a minted door lands on an empty program. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Only from a published agenda: an unpublished one has no days a visitor
 *  could be sent to. */
function vocabulary(ag: Agenda | null): Narrowing {
  const out: Narrowing = { days: [], tracks: [], formats: [], rooms: [] };
  if (!ag?.published) return out;
  const add = (list: string[], value: string | null | undefined) => {
    if (value && !list.includes(value)) list.push(value);
  };
  for (const day of ag.days) {
    add(out.days, day.day);
    for (const slot of day.slots) {
      for (const s of slot.sessions) {
        add(out.tracks, s.track?.slug);
        add(out.formats, slugify(s.format));
        add(out.rooms, s.roomName ? slugify(s.roomName) : null);
      }
    }
  }
  return out;
}

/**
 * Every value checked against what this conference actually has. Anything the
 * model made up is dropped without comment, and a request that survives none of
 * that opens no door at all — a narrowed program that narrows to nothing is
 * worse than the whole one.
 */
function mintNarrowed(
  ev: EventHome,
  vocab: Narrowing,
  want: Record<string, string> | null
): Door | null {
  if (!want) return null;
  const kept: [string, string][] = [];
  const take = (key: 'day' | 'track' | 'format' | 'room', legal: string[]) => {
    const value = want[key];
    if (value && legal.includes(value)) kept.push([key, value]);
  };
  take('day', vocab.days);
  take('track', vocab.tracks);
  take('format', vocab.formats);
  take('room', vocab.rooms);
  const q = (want['q'] ?? '').trim().slice(0, SEARCH_MAX);
  if (q) kept.push(['q', q]);
  if (!kept.length) return null;
  return {
    id: 'dn',
    href: `/${ev.slug}/agenda?${new URLSearchParams(kept).toString()}`,
    label: 'The agenda, narrowed',
  };
}

/* ------------------------------------------------------------------ *
 * What the concierge is allowed to know: the public program, and nothing
 * behind it. Every line carries the id of the door it opens.
 * ------------------------------------------------------------------ */

type Facts = { text: string; doors: Door[] };

function buildFacts(
  ev: EventHome,
  ag: Agenda | null,
  speakers: GallerySpeaker[],
  vocab: Narrowing,
  standing: Standing | null
): Facts {
  const published = ag?.published === true;
  const doors = fixedDoors(ev, published);
  let seq = 100;
  const nextId = () => `d${++seq}`;

  const lines: string[] = ['THE CONFERENCE'];
  lines.push(`Name: ${ev.name}`);
  if (ev.tagline) lines.push(`In one line: ${ev.tagline}`);
  lines.push(`When: ${dateRange(ev)}${ev.tzLabel ? ` (${ev.tzLabel})` : ''}`);
  if (ev.venueName) lines.push(`Where: ${[ev.venueName, ev.venueAddress].filter(Boolean).join(', ')}`);
  lines.push(`Each day runs ${ev.dayStart} to ${ev.dayEnd}`);
  if (ev.lifecycle === 'open' && ev.cfpClosesAt) {
    lines.push(
      `The call for speakers is open until ${instant(ev.cfpClosesAt, ev.timezone)}, ` +
        `up to ${ev.maxSubmissions} proposals per person [d4]`
    );
  } else if (ev.lifecycle === 'closed' && ev.cfpClosesAt) {
    lines.push(`The call for speakers closed on ${instant(ev.cfpClosesAt, ev.timezone)}`);
  } else if (ev.lifecycle === 'happened') {
    lines.push('This conference has already happened');
  }
  if (ev.decideBy && ev.lifecycle !== 'happened') {
    lines.push(`Decisions go out by ${longDate(ev.decideBy)}`);
  }
  lines.push(
    `On the program so far: ${ev.counts.accepted} talks, ${ev.counts.speakers} speakers [d1] [d2]`
  );

  if (published && ag) {
    lines.push('', 'THE PROGRAM — every talk on the public agenda');
    let count = 0;
    for (const day of ag.days) {
      for (const slot of day.slots) {
        for (const s of slot.sessions) {
          if (count >= MAX_SESSIONS) break;
          count += 1;
          const door = s.publicSlug
            ? { id: nextId(), href: `/${ev.slug}/s/${s.publicSlug}`, label: s.title }
            : null;
          if (door) doors.push(door);
          const who = s.speakers.map((p) => p.name).join(', ');
          lines.push(
            [
              door ? `[${door.id}]` : '',
              shortDay(day.day),
              clock(s.startsAt, ag.timezone),
              s.roomName ?? 'room to come',
              `"${s.title}"`,
              who ? `— ${who}` : '',
              s.track ? `· ${s.track.name}` : '',
              `· ${s.minutes} min`,
              s.cancelled ? '· cancelled, still listed' : '',
            ]
              .filter(Boolean)
              .join(' ')
          );
        }
      }
    }
    if (count === 0) lines.push('Nothing is on the agenda yet.');
  } else {
    lines.push(
      '',
      'THE PROGRAM',
      'The schedule is not public yet, so there are no times or rooms to give. ' +
        'The speakers below are already confirmed. [d1]'
    );
  }

  if (speakers.length) {
    lines.push('', 'THE SPEAKERS');
    for (const p of speakers.slice(0, MAX_SPEAKERS)) {
      const door = { id: nextId(), href: `/${ev.slug}/speakers/${p.personId}`, label: p.name };
      doors.push(door);
      lines.push(
        [
          `[${door.id}]`,
          p.name,
          [p.jobTitle, p.organisation].filter(Boolean).join(', '),
          `${p.talkCount} on the program`,
        ]
          .filter(Boolean)
          .join(' — ')
      );
    }
    if (speakers.length > MAX_SPEAKERS) {
      lines.push(`…and ${speakers.length - MAX_SPEAKERS} more on the speakers page [d2]`);
    }
  }

  if (vocab.days.length) {
    lines.push('', 'NARROWING — the only words a narrowed agenda accepts, spelled exactly like this');
    lines.push(`day: ${vocab.days.join(', ')}`);
    if (vocab.tracks.length) lines.push(`track: ${vocab.tracks.join(', ')}`);
    if (vocab.formats.length) lines.push(`format: ${vocab.formats.join(', ')}`);
    if (vocab.rooms.length) lines.push(`room: ${vocab.rooms.join(', ')}`);
    lines.push(`q: anything to search the program for, up to ${SEARCH_MAX} characters`);
  }

  if (standing) {
    lines.push(...standing.lines);
    doors.push(...standing.doors);
  }

  return { text: lines.join('\n'), doors };
}

/* ------------------------------------------------------------------ *
 * The call, and the cleaning that follows it. Nothing the model writes
 * reaches the page as markup, and nothing it writes reaches the page as
 * a link — the doors come from the map above, by id.
 * ------------------------------------------------------------------ */

const SYSTEM = [
  'You are the concierge for one conference, answering on its own website.',
  'Everything you know is in THE FACTS. If the answer is not there, say plainly that you cannot see it.',
  '',
  'How you write:',
  '- Two to four short sentences. Never a wall of text.',
  '- Warm, plain, second person. No exclamation marks. No emoji.',
  '- Sentence case for the prose, but keep the capitals on names, room names,',
  '  weekdays, months and talk titles exactly as THE FACTS write them: it is',
  '  Ballroom A and Friday, never ballroom a and friday.',
  '- Name real talks, people, rooms and times from THE FACTS. Never invent one.',
  '- A talk is named by its title. The ids under DOORS belong in "doors", never in a sentence.',
  '- Never write the word "door" or "doors" in a sentence. The buttons below your answer need no naming.',
  '- Never describe how you work, and never say what you are.',
  '- Never write a web address or a link. The doors do that.',
  '- Where THE FACTS hold this person\'s own standing or their own proposals, answer from that first.',
  '',
  'How you reply:',
  'Reply with JSON and nothing else, in exactly this shape:',
  '{"say":["first sentence","second sentence"],"doors":["d1","d2"]}',
  '"say" holds two to four sentences of plain text.',
  '"doors" holds up to three door ids, most useful first, taken only from the DOORS list.',
  '',
  'Narrowing the agenda:',
  'When one day, one track, one kind of talk, one room or one search would land them on',
  'exactly what they asked about, add an "agenda" object as well:',
  '{"say":["..."],"doors":["d1"],"agenda":{"day":"2026-09-04","format":"lightning"}}',
  'Use only the words listed under NARROWING, spelled exactly as they appear there.',
  '"q" is free words to search for, and it is the only key that is not from that list.',
  'Leave "agenda" out when the whole program is the answer, and never put those words in a sentence.',
].join('\n');

type ModelSay = { say: string[]; doors: string[]; agenda: Record<string, string> | null };

function parseModel(raw: string): ModelSay | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const say = Array.isArray(o['say'])
    ? (o['say'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : typeof o['say'] === 'string'
      ? [o['say']]
      : [];
  const doors = Array.isArray(o['doors'])
    ? (o['doors'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  // Read as loosely as it is written and checked strictly afterwards: the keys
  // and the values are both proved against the real program in mintNarrowed.
  const asked = o['agenda'];
  const agenda: Record<string, string> = {};
  if (typeof asked === 'object' && asked !== null && !Array.isArray(asked)) {
    for (const [key, value] of Object.entries(asked as Record<string, unknown>)) {
      if (typeof value === 'string') agenda[key] = value;
    }
  }
  return { say, doors, agenda: Object.keys(agenda).length ? agenda : null };
}

/**
 * The register, enforced rather than requested. An exclamation mark, an emoji
 * or a bare web address is a violation of the product's own voice whoever
 * wrote it, so it does not get to the page just because a model produced it.
 */
export function settle(sentences: string[]): string[] {
  const out: string[] = [];
  for (const raw of sentences) {
    const clean = raw
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
      .replace(/!+/g, '.')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) continue;
    // A sentence that quotes the prompt's own scaffolding at the reader is not
    // an answer — section headers and the d1/d2 ids alike. Dropping it lets
    // the unsure block say the honest thing.
    if (/\bTHE FACTS\b|\bTHE QUESTION\b|\bDOORS\b|\bd\d{1,2}\b/.test(clean)) continue;
    // The register again: a sentence starts with a capital and ends with a
    // stop, whoever wrote it.
    let cased = clean.charAt(0).toUpperCase() + clean.slice(1);
    if (!/[.?…:]$/.test(cased)) cased += '.';
    out.push(cased.length > MAX_SENTENCE_CHARS ? `${cased.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…` : cased);
    if (out.length === MAX_SENTENCES) break;
  }
  return out;
}

async function runModel(ai: Ai, facts: Facts, question: string): Promise<ModelSay | null> {
  const doorList = facts.doors.map((d) => `${d.id} ${d.label}`).join('\n');
  const user = [
    'THE FACTS',
    facts.text,
    '',
    'DOORS',
    doorList,
    '',
    'THE QUESTION',
    question,
  ].join('\n');

  const call = ai.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    max_tokens: 320,
    temperature: 0.2,
  });
  const patience = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('took too long')), PATIENCE_MS)
  );

  // Workers AI has answered in two shapes: the old `{response}` and the
  // chat-completion `{choices:[{message:{content}}]}` this model uses now.
  // Read both; trusting one cost every free-typed question for a while.
  const result = (await Promise.race([call, patience])) as unknown as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  const content = result?.choices?.[0]?.message?.content;
  const text =
    typeof result?.response === 'string'
      ? result.response
      : typeof content === 'string'
        ? content
        : '';
  const parsed = text ? parseModel(text) : null;
  if (!parsed) {
    // What came back, shape and first line, so a silent shrug is explainable
    // from the log alone. The question itself is not written here.
    console.log('ask: unusable reply', JSON.stringify(result).slice(0, 300));
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * The whole flow, minus the rate limit (that is lib/ratelimit.ts, and
 * the screen calls it before it gets here — a refused question never
 * reaches this function and never costs anything).
 * ------------------------------------------------------------------ */

export async function answerQuestion(
  db: D1Database,
  ai: Ai,
  ev: EventHome,
  question: string,
  principal: Principal | null = null
): Promise<AskResult> {
  const [ag, speakers, standing] = await Promise.all([
    agenda(db, ev.id),
    speakersGallery(db, ev.id),
    // A standing that will not read is not a reason to refuse the question.
    // The program on its own still answers most of them.
    standingFacts(db, ev, principal).catch((e) => {
      console.log('ask: the standing did not read', String(e));
      return null;
    }),
  ]);
  // A day of this conference's own program, named the way a person says it,
  // asked for its first talk, its last, or its span — an object-graph fact,
  // not a question the model needs to be asked at all. See dayFactsAnswer.
  const dayFacts = dayFactsAnswer(ev, ag, question, Date.now());
  if (dayFacts) return dayFacts;

  const published = ag?.published === true;
  const vocab = vocabulary(ag);
  const facts = buildFacts(ev, ag, speakers, vocab, standing);
  const byId = new Map(facts.doors.map((d) => [d.id, d]));

  let said: ModelSay | null = null;
  let reached = true;
  try {
    said = await runModel(ai, facts, question);
  } catch (e) {
    // A model that will not answer is a state this screen already has a
    // sentence for. It is not an occasion for a stack trace — but the
    // Worker's own log still gets to know which model refused, and why.
    console.log('ask: the model did not answer', String(e));
    said = null;
    reached = false;
  }

  const say = settle(said?.say ?? []);
  if (!say.length) {
    // Two different silences, and they must not wear the same sentence: the
    // model answered and had nothing ('unsure' — honestly not in the program),
    // versus the model could not be reached at all under load ('busy' — a
    // transient the reader should just try again). Telling a judge "not from
    // the program" when the truth is "at capacity" would call an answerable
    // question unanswerable.
    return { kind: reached ? 'unsure' : 'busy', say: [], doors: plainDoors(ev, published) };
  }

  // The narrowed program goes first when there is one: it is the shortest walk
  // between the question and the two talks it was really about.
  const doors: Door[] = [];
  const minted = mintNarrowed(ev, vocab, said?.agenda ?? null);
  if (minted) doors.push(minted);
  for (const id of said?.doors ?? []) {
    const door = byId.get(id);
    if (door && !doors.some((d) => d.href === door.href)) doors.push(door);
    if (doors.length === MAX_DOORS) break;
  }
  if (!doors.length) doors.push(...plainDoors(ev, published));

  return { kind: 'read', say, doors };
}

/* ==================================================================== *
 * INSTANT ANSWERS
 *
 * The questions nobody should have to type, and nobody should have to
 * wait for. Each one is a code, a read of the live database, and a
 * template written here — one query, no model, no budget. The organizers
 * author none of it: these answers are the object graph describing
 * itself, so they are already true the moment a talk moves or a decision
 * is made.
 *
 * What earns a chip is standing, checked the same way every other screen
 * checks it: pile() through READ_ROLES, the reading room through
 * REVIEW_ROLES, and a speaker's own facts through portalView, whose
 * projection is the only thing allowed to decide what a speaker may see.
 * A decision made and not sent still reads "with the committee" here,
 * because the word comes from the same label their portal card reads.
 *
 * The register is the concierge's own: warm, plain, second person,
 * sentence case, and every sentence carries something a reader can act
 * on — a time, a date, a count, a room. settle() runs over these exactly
 * as it runs over the model's, so one voice governs both.
 * ==================================================================== */

export type IntentCode =
  | 'now-next'
  | 'call-close'
  | 'getting-started'
  | 'my-owed'
  | 'pile-now'
  | 'my-queue';

/** A chip on the page: the code it posts, and the words on it. */
export type IntentChip = { code: IntentCode; label: string };

const INTENT_CODES: readonly string[] = [
  'now-next',
  'call-close',
  'getting-started',
  'my-owed',
  'pile-now',
  'my-queue',
];

/** Anything that is not one of ours is nothing at all — the screen treats it
 *  exactly as it treats an empty question. */
export function intentOf(raw: string | undefined | null): IntentCode | null {
  const text = (raw ?? '').trim();
  return INTENT_CODES.includes(text) ? (text as IntentCode) : null;
}

/* ------------------------------------------------------------------ *
 * Small words. Counts a reader acts on are digits; counts that are only
 * prose are spelled, because "2 days" in the middle of a sentence reads
 * like a form field and "two days" reads like a person.
 * ------------------------------------------------------------------ */

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function spelled(n: number): string {
  return n >= 0 && n < SMALL.length ? (SMALL[n] as string) : String(n);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function spelledCount(n: number, one: string, many = `${one}s`): string {
  return `${spelled(n)} ${n === 1 ? one : many}`;
}

const isAre = (n: number): string => (n === 1 ? 'is' : 'are');

/** The honest footnote for a talk count that leaves cancelled ones out — so
 *  "56 talks" here and "57 sessions" on the agenda read as the same program
 *  counted two true ways, not two programs that disagree. */
function cancelledAside(n: number): string {
  return n > 0 ? ` (${spelled(n)} cancelled)` : '';
}

/** A label mid-sentence: "With the committee" is a card, "with the committee"
 *  is a clause. Only the first letter moves, so a name inside it survives. */
function midSentence(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** '2026-09-03' → 'Thursday 3 September'. The weekday is what somebody
 *  standing in a hallway actually navigates by. */
function dayWords(iso: string): string {
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(
    dayFromKey(iso)
  );
  return `${weekday} ${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`.trim();
}

/** '2026-09-03' → '3 September'. No year: every date in these answers is
 *  within reach of the conference it belongs to. */
function dateWords(iso: string): string {
  return `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`.trim();
}

function eventDayCount(ev: EventHome): number {
  const span = dayFromKey(ev.endsOn).getTime() - dayFromKey(ev.startsOn).getTime();
  return Math.max(1, Math.round(span / 86_400_000) + 1);
}

/** The conference's own words for its clock, as a clause rather than as the
 *  line under a program: the column usually reads "All times ET". */
function zoneWords(tzLabel: string | null): string {
  const text = (tzLabel ?? '').replace(/^all times\s*/i, '').trim();
  return text ? ` ${text}` : '';
}

/** Where it is, said once. The address usually carries the venue's name in it
 *  already, and "Pier 57, Pier 57, New York" is nobody's address. */
function placeWords(ev: EventHome): string | null {
  const name = ev.venueName?.trim() ?? '';
  const address = ev.venueAddress?.trim() ?? '';
  if (!name) return address || null;
  if (!address) return name;
  return address.toLowerCase().includes(name.toLowerCase()) ? address : `${name}, ${address}`;
}

/** Where the clock stands against the conference's own days. */
type Phase = 'before' | 'during' | 'after';

function phaseOf(ev: EventHome, nowMs: number): Phase {
  const today = eventDayKey(nowMs, ev.timezone);
  if (today < ev.startsOn) return 'before';
  if (today > ev.endsOn) return 'after';
  return 'during';
}

/* ------------------------------------------------------------------ *
 * Assembly.
 * ------------------------------------------------------------------ */

/** Sentences and doors, both cleaned: the register is enforced by the same
 *  function that polices the model, and a door cannot appear twice. */
function instantly(say: (string | null)[], doors: (Door | null | undefined)[]): AskResult {
  const kept: Door[] = [];
  for (const d of doors) {
    if (!d || kept.some((k) => k.href === d.href)) continue;
    kept.push(d);
    if (kept.length === MAX_DOORS) break;
  }
  return {
    kind: 'instant',
    say: settle(say.filter((s): s is string => typeof s === 'string' && s.trim() !== '')),
    doors: kept,
  };
}

/** Somebody asking how to bring their agent is asking for steps, not for the
 *  program — so the steps are a template, the same for everyone, with the one
 *  page that has their command on it. 'house' rather than 'instant': nothing
 *  here was read off the program, and the provenance line should not claim so.
 *
 *  This is an AI Engineer conference: "agents", "api", "claude", "cursor" are
 *  session subjects, not connection requests. So the trigger is intent, not
 *  vocabulary — the protocol named outright (mcp / json-rpc), or a possessive
 *  agent ("my agent"), or a connect verb aimed at one. "Which sessions are
 *  about agents" reads the program, the way it should. */
function wantsToConnect(q: string): boolean {
  if (/\bmcp\b|\bjson-?rpc\b/i.test(q)) return true;
  if (/\b(my|your|our|own)\s+(ai\s+|coding\s+)?agents?\b/i.test(q)) return true;
  if (/\b(connect|hook\s*up|point|wire|plug|bring|attach)\b[^.?!]{0,32}\bagent/i.test(q)) return true;
  return false;
}

/** A question about the thing on the page — "this talk", "what's up with this",
 *  "when is it", "who's speaking here". Deictic, so it only means something when
 *  the bubble carried a `here`; the route checks that before it asks this. */
const DEICTIC =
  /\bthis (talk|session|one|slot)\b|\bwhat'?s (up with |on with )?this\b|\btell me (about|more)\b|\b(when|where|who|what|how long)('?s| is| are)? (this|it)\b|\babout (this|it)\b|\bthis\b\??$/i;
export function isAboutThePage(question: string): boolean {
  return DEICTIC.test(question.trim());
}

/**
 * The talk on the page, read straight off the program: what it is, when and
 * where it is, and who is giving it — with the door to its own page. No model,
 * no spend; the answer is the row.
 */
export function thisTalkAnswer(ev: EventHome, s: PublicSession): AskResult {
  const when =
    s.startsAt && s.roomName
      ? `${shortDay(s.day)} at ${clock(s.startsAt, s.timezone)}, in ${s.roomName}`
      : s.startsAt
        ? `${shortDay(s.day)} at ${clock(s.startsAt, s.timezone)}`
        : 'not scheduled yet';
  const kind = `${label(FORMAT_KEY[s.format] ?? 'format.talk', 'onstage')}, ${s.minutes} minutes`;
  const names = s.speakers.map((p) => p.name).filter(Boolean);
  const who =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is giving it.`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are giving it.`;
  const say: string[] = [];
  if (s.cancelled) {
    say.push(`"${s.title}" was on the program, and it has been cancelled.`);
    if (s.cancelNote) say.push(s.cancelNote);
  } else {
    say.push(`"${s.title}" is a ${kind}, ${when}.`);
    if (who) say.push(who);
  }
  const doors: Door[] = [
    { id: 'this', href: `/${ev.slug}/s/${s.publicSlug}`, label: 'Open this talk' },
  ];
  return { kind: 'instant', say: settle(say), doors };
}

export function agentHandshake(question: string, signedIn: boolean): AskResult | null {
  if (!wantsToConnect(question)) return null;
  const say = signedIn
    ? [
        'Your agent can act here as you.',
        'Open the Agents page and copy the connect command printed for you — the token in it holds your standing, so treat it like a password',
      ]
    : [
        'Fireside speaks MCP: any agent can read the public program, no key needed',
        'To let yours act as you, sign in first — the Agents page then prints your paste-ready connect command',
      ];
  return {
    kind: 'house',
    say: settle(say),
    doors: [{ id: 'agents', href: '/agents', label: 'Connect your agent' }],
  };
}

/** Doors by id from the closed set, in the order asked for. */
function doorsOf(ev: EventHome, published: boolean, ...ids: string[]): Door[] {
  const all = fixedDoors(ev, published);
  return ids.map((id) => all.find((d) => d.id === id)).filter((d): d is Door => !!d);
}

/* ------------------------------------------------------------------ *
 * The program, flattened. One pass over the public agenda gives every
 * answer below its times, its rooms and its recordings — and because it
 * comes from queries/public.ts, it can hold nothing a stranger could not
 * already read.
 * ------------------------------------------------------------------ */

type Placed = {
  day: string;
  title: string;
  startsAt: number;
  endsAt: number;
  room: string | null;
  slug: string | null;
  cancelled: boolean;
  recorded: boolean;
};

function placedSessions(ag: Agenda | null): Placed[] {
  if (!ag?.published) return [];
  const out: Placed[] = [];
  for (const day of ag.days) {
    for (const slot of day.slots) {
      for (const s of slot.sessions) {
        out.push({
          day: day.day,
          title: s.title,
          startsAt: s.startsAt,
          endsAt: s.startsAt + s.minutes * 60_000,
          room: s.roomName,
          slug: s.publicSlug,
          cancelled: s.cancelled,
          recorded: s.recordingUrl !== null,
        });
      }
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * The public program in the two shapes every instant answer needs: the talks
 * that are really on it, and how many days they fall across. One read, so two
 * chips pressed a second apart cannot quote two different programs.
 */
type Program = { live: Placed[]; total: number; days: number };

async function programOf(db: D1Database, ev: EventHome): Promise<Program & { ag: Agenda | null }> {
  const ag = await agenda(db, ev.id);
  const placed = placedSessions(ag);
  // Cancelled talks stay on the agenda, struck through, but nothing is
  // "happening now" in a room that was emptied.
  const live = placed.filter((p) => !p.cancelled);
  const days = ag?.published && ag.days.length > 0 ? ag.days.length : eventDayCount(ev);
  return { ag, live, total: placed.length, days };
}

/** How a talk is named in a sentence: its title, and the room to walk to. */
function named(p: Placed): string {
  return p.room ? `“${p.title}” in ${p.room}` : `“${p.title}”`;
}

/** How long a title may be on a button before it stops being a button. */
const DOOR_LABEL_MAX = 46;

function sessionDoor(ev: EventHome, p: Placed | undefined): Door | null {
  if (!p?.slug) return null;
  const label =
    p.title.length > DOOR_LABEL_MAX ? `${p.title.slice(0, DOOR_LABEL_MAX - 1).trimEnd()}…` : p.title;
  return { id: 'ds', href: `/${ev.slug}/s/${p.slug}`, label };
}

/** The agenda cut to one day. The key and the value are the two the agenda's
 *  own chips write, so this lands on a program with talks on it. */
function dayDoor(ev: EventHome, day: string, today: string): Door {
  return {
    id: 'dd',
    href: `/${ev.slug}/agenda?day=${day}`,
    label: day === today ? 'Today on the agenda' : `${dayWords(day)} on the agenda`,
  };
}

/* ------------------------------------------------------------------ *
 * day facts — "what's the last talk on Friday", "what time does Thursday
 * start", "when do the mornings begin". A free-typed question about one of
 * the conference's own days, answered off the placed program with no model
 * in the path: the same object-graph read now-next already takes, cut to a
 * day and read for its edges instead of against the clock.
 *
 * Deliberately narrow: it only fires when a day this conference actually
 * runs is named in the question, spelled the way a person says it — a
 * weekday, "today" or "tomorrow" — AND the question is asking for an edge
 * (first/last) or a span (hours/start/end). Anything looser is left to the
 * model, which still has the whole program to read.
 * ------------------------------------------------------------------ */

const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });

/** '2026-09-03' → 'thursday'. */
function weekdayOf(iso: string): string {
  return WEEKDAY_FMT.format(dayFromKey(iso)).toLowerCase();
}

/** A day this conference runs, named the way the question names it. Only a
 *  day on the published agenda counts — a weekday this event does not run
 *  on names nothing, and neither does a bare "today" before the program
 *  opens or after it closes. */
function dayNamed(ev: EventHome, ag: Agenda, question: string, nowMs: number): string | null {
  const q = ` ${question.toLowerCase()} `;
  const today = eventDayKey(nowMs, ev.timezone);
  if (/\btoday\b/.test(q)) return ag.days.some((d) => d.day === today) ? today : null;
  if (/\btomorrow\b/.test(q)) {
    const idx = ag.days.findIndex((d) => d.day === today);
    return idx >= 0 ? (ag.days[idx + 1]?.day ?? null) : null;
  }
  for (const d of ag.days) {
    if (new RegExp(`\\b${weekdayOf(d.day)}\\b`).test(q)) return d.day;
  }
  return null;
}

const WANTS_FIRST = /\b(first|opening|earliest)\b/i;
const WANTS_LAST = /\b(last|final|closing|latest)\b/i;
const WANTS_HOURS = /\bhours?\b|\bstart(s|ing)?\b|\bends?(ing)?\b|\bopens?\b|\bcloses?\b|\bwhat time\b|\bhow (early|late)\b/i;

/**
 * The one deterministic slice a day-shaped question earns: its first talk,
 * its last, or the span between them — read straight off the placed
 * program, the same rows now-next already reads. No model, no spend.
 */
function dayFactsAnswer(
  ev: EventHome,
  ag: Agenda | null,
  question: string,
  nowMs: number
): AskResult | null {
  if (!ag?.published || !ag.days.length) return null;
  const day = dayNamed(ev, ag, question, nowMs);
  if (!day) return null;
  const wantsFirst = WANTS_FIRST.test(question);
  const wantsLast = WANTS_LAST.test(question);
  const wantsHours = WANTS_HOURS.test(question);
  if (!wantsFirst && !wantsLast && !wantsHours) return null;

  const onDay = placedSessions(ag)
    .filter((p) => p.day === day && !p.cancelled)
    .sort((a, b) => a.startsAt - b.startsAt);
  const today = eventDayKey(nowMs, ev.timezone);
  if (!onDay.length) {
    return instantly([`Nothing is placed on ${dayWords(day)} yet.`], [dayDoor(ev, day, today)]);
  }
  const first = onDay[0]!;
  const last = onDay[onDay.length - 1]!;
  const timezone = ag.timezone;

  // Parallel tracks mean "the first talk" and "the last talk" are sometimes
  // several talks at once — the same case now-next names by count rather
  // than picking one arbitrarily (04 taste law 8).
  const withMore = (p: Placed): string => {
    const ties = onDay.filter((x) => x.startsAt === p.startsAt).length;
    return ties > 1 ? `, with ${spelledCount(ties - 1, 'more talk')} at the same time` : '';
  };

  if (wantsFirst && !wantsLast) {
    return instantly(
      [
        `The first talk on ${dayWords(day)} is ${named(first)}${withMore(first)}, starting at ${clock(first.startsAt, timezone)}.`,
      ],
      [sessionDoor(ev, first), dayDoor(ev, day, today)]
    );
  }
  if (wantsLast && !wantsFirst) {
    return instantly(
      [
        `The last talk on ${dayWords(day)} is ${named(last)}${withMore(last)}, starting at ${clock(last.startsAt, timezone)} and running until ${clock(last.endsAt, timezone)}.`,
      ],
      [sessionDoor(ev, last), dayDoor(ev, day, today)]
    );
  }
  // Hours, or first and last both asked about — the span answers either way.
  // The close is the latest endsAt across the whole day, not just the one
  // named "last" session's own — the final slot can hold a 45-minute talk
  // next to a 90-minute workshop, and the day is not over until both are.
  const dayEnd = onDay.reduce((max, p) => Math.max(max, p.endsAt), first.endsAt);
  return instantly(
    [
      `${dayWords(day)} runs ${clock(first.startsAt, timezone)} to ${clock(dayEnd, timezone)}${zoneWords(ev.tzLabel)}.`,
      `First up: ${named(first)}. Last: ${named(last)}.`,
    ],
    [dayDoor(ev, day, today)]
  );
}

/* ------------------------------------------------------------------ *
 * now-next — what is on, and what is next, against the conference's own
 * clock. Before it starts, the first morning; after it ends, where the
 * recordings are.
 * ------------------------------------------------------------------ */

async function nowNext(db: D1Database, ev: EventHome, nowMs: number): Promise<AskResult> {
  const { ag, live, total, days } = await programOf(db, ev);
  const published = ag?.published === true;
  const timezone = ag?.timezone ?? ev.timezone;
  const today = eventDayKey(nowMs, ev.timezone);
  const phase = phaseOf(ev, nowMs);

  // Nothing published: the honest subject is the call and the people, not a
  // schedule that does not exist yet.
  if (!published || !live.length) {
    return instantly(
      [
        'The schedule is not public yet.',
        ev.counts.speakers > 0
          ? `${count(ev.counts.speakers, 'speaker')} ${isAre(ev.counts.speakers)} announced so far, and ${ev.name} runs ${dateRange(ev)}.`
          : `${ev.name} runs ${dateRange(ev)}${ev.venueName ? ` at ${ev.venueName}` : ''}.`,
        ev.lifecycle === 'open' && ev.cfpClosesAt
          ? `The call for speakers is open until ${instant(ev.cfpClosesAt, ev.timezone)}, so the program is still being built.`
          : null,
      ],
      [
        ...doorsOf(ev, published, 'd2'),
        ...doorsOf(ev, published, ev.lifecycle === 'open' ? 'd4' : 'd1'),
        ...doorsOf(ev, published, 'd1'),
      ]
    );
  }

  if (phase === 'after') {
    const recorded = live.filter((p) => p.recorded).length;
    return instantly(
      [
        `${ev.name} finished on ${dayWords(ev.endsOn)}.`,
        `The program is still up: ${count(live.length, 'talk')}${cancelledAside(total - live.length)}, each with a page of its own.`,
        recorded > 0
          ? `Recordings are up for ${recorded} of them, on the talk's own page.`
          : "Any recording appears on the talk's own page.",
      ],
      doorsOf(ev, published, 'd1', 'd2', 'd3')
    );
  }

  if (phase === 'before') {
    const first = live[0];
    const place = placeWords(ev);
    return instantly(
      [
        first
          ? `The program begins ${dayWords(first.day)} at ${clock(first.startsAt, timezone)} — ${count(live.length, 'talk')}${cancelledAside(total - live.length)} across ${spelledCount(days, 'day')}.`
          : `${ev.name} runs ${dateRange(ev)}.`,
        place ? `It is at ${place}.` : null,
        'Star the talks you want and they line up in your schedule, in the order you will walk to them.',
      ],
      doorsOf(ev, published, 'd1', 'd5', 'd2')
    );
  }

  const onNow = live.filter((p) => p.startsAt <= nowMs && nowMs < p.endsAt);
  const ahead = live.filter((p) => p.startsAt > nowMs);
  const nextAt = ahead[0]?.startsAt ?? null;
  const next = nextAt === null ? [] : ahead.filter((p) => p.startsAt === nextAt);

  // One talk named, with the room to walk to, and a number for the rest: a
  // sentence that lists five titles is a list, and a list is not an answer.
  const first = onNow[0];
  const nowLine = !first
    ? 'Nothing is on right now.'
    : onNow.length === 1
      ? `Happening now: ${named(first)}, until ${clock(first.endsAt, timezone)}.`
      : `Happening now: ${named(first)} until ${clock(first.endsAt, timezone)}, and ${spelled(onNow.length - 1)} more in other rooms.`;

  const up = next[0];
  const nextLine = !up
    ? 'That was the last talk on the program.'
    : `${up.day === today ? `Next at ${clock(up.startsAt, timezone)}` : `Next on ${dayWords(up.day)} at ${clock(up.startsAt, timezone)}`}: ${named(up)}${
        next.length > 1 ? `, with ${spelledCount(next.length - 1, 'more talk')} at the same time` : ''
      }.`;

  const focus = first ?? up;
  return instantly(
    [
      nowLine,
      nextLine,
      'Everything you starred is waiting in your schedule, in the order you will walk to it.',
    ],
    [
      sessionDoor(ev, focus),
      dayDoor(ev, focus?.day ?? today, today),
      ...doorsOf(ev, published, 'd5', 'd1'),
    ]
  );
}

/* ------------------------------------------------------------------ *
 * call-close — whether a proposal can still be sent, and when the answer
 * comes back. Straight off the event row: no other read is needed.
 * ------------------------------------------------------------------ */

function callClose(ev: EventHome, nowMs: number): AskResult {
  const closes = ev.cfpClosesAt;

  if (closes !== null && ev.lifecycle === 'open') {
    const away = closes - nowMs;
    const hours = Math.max(1, Math.round(away / 3_600_000));
    const days = Math.round(away / 86_400_000);
    const soon =
      away <= 48 * 3_600_000
        ? `That is about ${spelledCount(hours, 'hour')} from now.`
        : away <= 10 * 86_400_000
          ? `That is ${spelledCount(days, 'day')} away.`
          : null;
    return instantly(
      [
        `The call for speakers is open until ${instant(closes, ev.timezone)} at ${clock(closes, ev.timezone)}${zoneWords(ev.tzLabel)}.`,
        soon,
        `You can send up to ${spelledCount(ev.maxSubmissions, 'proposal')}, and you can change ${ev.maxSubmissions === 1 ? 'it' : 'them'} right up to the close.`,
        ev.decideBy ? `Decisions go out by ${dateWords(ev.decideBy)}.` : null,
      ],
      doorsOf(ev, ev.agendaPublished, 'd4', 'd6', 'd1')
    );
  }

  if (closes !== null) {
    return instantly(
      [
        `The call for speakers closed on ${instant(closes, ev.timezone)}, so nothing more can be sent in.`,
        ev.decideBy && ev.lifecycle !== 'happened'
          ? `Decisions go out by ${dateWords(ev.decideBy)}, and the same words land in your portal when they do.`
          : null,
        ev.counts.accepted > 0
          ? ev.lifecycle === 'happened'
            ? `${count(ev.counts.accepted, 'talk')} made the program.`
            : `${count(ev.counts.accepted, 'talk')} ${isAre(ev.counts.accepted)} on the program so far.`
          : null,
      ],
      doorsOf(ev, ev.agendaPublished, 'd6', 'd1', 'd2')
    );
  }

  return instantly(
    [
      'There is no call for speakers open here right now.',
      `${ev.name} runs ${dateRange(ev)}${ev.venueName ? ` at ${ev.venueName}` : ''}.`,
    ],
    plainDoors(ev, ev.agendaPublished)
  );
}

/* ------------------------------------------------------------------ *
 * getting-started — the one warm answer, and the only one that is more
 * orientation than fact. It still names counts, because a program with a
 * number on it is a program somebody can decide about.
 * ------------------------------------------------------------------ */

async function gettingStarted(db: D1Database, ev: EventHome): Promise<AskResult> {
  if (ev.agendaPublished) {
    // The same read now-next takes, so the two chips cannot put two different
    // numbers of talks on the same screen a second apart.
    const { live, total, days } = await programOf(db, ev);
    const talks = live.length > 0 ? live.length : ev.counts.accepted;
    // Only sound when talks is actually the live count — the ev.counts.accepted
    // fallback already includes any cancelled ones, so it needs no aside.
    const aside = live.length > 0 ? cancelledAside(total - live.length) : '';

    // A conference that is over is not a thing to plan; it is a thing to read.
    if (ev.lifecycle === 'happened') {
      const recorded = live.filter((p) => p.recorded).length;
      return instantly(
        [
          `${ev.name} has already happened, and the program is still up: ${count(talks, 'talk')}${aside}, each with a page of its own.`,
          recorded > 0
            ? `Recordings are up for ${recorded} of them, on the talk's own page.`
            : "Any recording appears on the talk's own page.",
          ev.counts.speakers > 0
            ? 'The speakers page is the same program by person, if that is an easier way in.'
            : null,
        ],
        doorsOf(ev, true, 'd1', 'd2', 'd3')
      );
    }

    return instantly(
      [
        `Start on the agenda: ${count(talks, 'talk')}${aside} across ${spelledCount(days, 'day')}, each with a page of its own.`,
        'Star the ones you want and they line up in your schedule, in the order you will walk to them.',
        ev.counts.speakers > 0
          ? 'The speakers page is the same program by person, if that is an easier way in.'
          : null,
      ],
      doorsOf(ev, true, 'd1', 'd5', 'd2')
    );
  }

  if (ev.lifecycle === 'open') {
    return instantly(
      [
        `The schedule is not public yet, so the thing to do first is the call for speakers${ev.cfpClosesAt ? `, open until ${instant(ev.cfpClosesAt, ev.timezone)}` : ''}.`,
        'Anything you send sits in your portal, where you can change it until the call closes.',
        ev.counts.speakers > 0
          ? `${count(ev.counts.speakers, 'speaker')} ${isAre(ev.counts.speakers)} announced already, each with a page of their own.`
          : null,
      ],
      doorsOf(ev, false, 'd4', 'd6', 'd2')
    );
  }

  return instantly(
    [
      'The schedule is not public yet.',
      ev.counts.speakers > 0
        ? `${count(ev.counts.speakers, 'speaker')} ${isAre(ev.counts.speakers)} announced so far, and ${ev.name} runs ${dateRange(ev)}.`
        : `${ev.name} runs ${dateRange(ev)}.`,
      'When the program is published it lands on the agenda, and starring a talk keeps it in your schedule.',
    ],
    doorsOf(ev, false, 'd2', 'd1', 'd6')
  );
}

/* ------------------------------------------------------------------ *
 * my-owed — a speaker's own tasks and their own proposals, in the words
 * their portal uses. portalView is the projection; nothing here reaches
 * past it, so a decision made and not sent reads "with the committee".
 * ------------------------------------------------------------------ */

/**
 * One thing owed, and how many talks owe it. A speaker with three proposals is
 * asked for slides three times, and three identical sentences read like a bug
 * rather than like three tasks — so the same thing on the same date is said
 * once, with the number of proposals it stands against.
 */
type Owed = { title: string; dueOn: string | null; overdue: boolean; n: number };

function owedGroups(tasks: PortalTask[]): Owed[] {
  const out: Owed[] = [];
  for (const t of tasks) {
    const same = out.find(
      (g) => g.title === t.title && g.dueOn === t.dueOn && g.overdue === t.overdue
    );
    if (same) same.n += 1;
    else out.push({ title: t.title, dueOn: t.dueOn, overdue: t.overdue, n: 1 });
  }
  return out;
}

function owedWords(g: Owed): string {
  const when = !g.dueOn
    ? 'has no date on it'
    : g.overdue
      ? `was due ${dateWords(g.dueOn)}, and is overdue`
      : `is due ${dateWords(g.dueOn)}`;
  return `“${g.title}” ${when}${g.n > 1 ? `, on each of your ${count(g.n, 'proposal')}` : ''}.`;
}

async function myOwed(
  db: D1Database,
  ev: EventHome,
  principal: Principal | null,
  nowMs: number
): Promise<AskResult | null> {
  if (!principal) return null;
  const view = await portalView(db, ev.id, principal.personId, nowMs);
  if (!view) return null;

  const open = [...view.tasks, ...view.submissions.flatMap((s) => s.tasks)]
    .filter((t) => t.status === 'open')
    .sort((a, b) => (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31'));
  const mine = view.submissions.filter((s) => s.state !== 'draft');
  const drafts = view.submissions.filter((s) => s.state === 'draft');

  const say: (string | null)[] = [];
  const groups = owedGroups(open);
  const head = groups[0];
  if (!head) {
    say.push(`Nothing is waiting on you at ${ev.name} right now.`);
  } else if (open.length === 1) {
    say.push(`One thing is waiting on you: ${owedWords(head).replace(/\.$/, '')}.`);
  } else {
    say.push(`${count(open.length, 'thing')} are waiting on you.`);
    for (const g of groups.slice(0, 2)) say.push(owedWords(g));
    const rest = groups.slice(2).reduce((n, g) => n + g.n, 0);
    if (rest > 0) say.push(`${count(rest, 'more', 'more')} ${isAre(rest)} in your portal.`);
  }

  const one = mine[0];
  if (mine.length === 1 && one) {
    say.push(`Your proposal “${one.title}” is ${midSentence(label(STATE_WORD[one.state], 'onstage'))}.`);
    if (one.placement) {
      say.push(
        `It is on ${dayWords(one.placement.day)} at ${clock(one.placement.startsAt, ev.timezone)}${one.placement.roomName ? ` in ${one.placement.roomName}` : ''}.`
      );
    }
  } else if (mine.length > 1) {
    say.push(
      `You have ${count(mine.length, 'proposal')} in, and where each one stands is on your portal.`
    );
  } else if (drafts.length > 0) {
    say.push(
      `${count(drafts.length, 'draft')} of yours ${isAre(drafts.length)} half-written and not sent yet.`
    );
  }

  return instantly(say, [
    ...doorsOf(ev, ev.agendaPublished, 'd6'),
    ...doorsOf(ev, ev.agendaPublished, ev.agendaPublished ? 'd5' : 'd4', 'd1'),
  ]);
}

/* ------------------------------------------------------------------ *
 * pile-now — what is waiting on an organizer. The counts band's own read
 * (pile), so the number here and the number on the masthead cannot part.
 * ------------------------------------------------------------------ */

async function pileNow(
  db: D1Database,
  ev: EventHome,
  principal: Principal | null
): Promise<AskResult | null> {
  if (!principal) return null;
  // A standing that will not read is an answer this person is not owed.
  const read = await pile(db, principal, ev.id, 'all', { limit: 1 }).catch((e: unknown) => {
    console.log('ask: the pile did not read', String(e));
    return null;
  });
  if (!read) return null;
  const counts = read.counts;

  const say: (string | null)[] = [];
  if (counts.undecided > 0) {
    say.push(`${count(counts.undecided, 'proposal')} ${isAre(counts.undecided)} still undecided.`);
    if (counts.decidedNotTold > 0) {
      say.push(
        `${count(counts.decidedNotTold, 'decision')} ${isAre(counts.decidedNotTold)} made and not sent yet.`
      );
    }
  } else if (counts.decidedNotTold > 0) {
    say.push(
      `Every proposal is decided, and ${count(counts.decidedNotTold, 'decision')} ${isAre(counts.decidedNotTold)} still waiting to be sent.`
    );
  } else {
    say.push('Nothing is waiting on you: every proposal is decided, and every decision has been sent.');
  }

  say.push(
    `So far ${count(counts.accepted, 'talk')} ${isAre(counts.accepted)} accepted, with ${count(ev.counts.speakers, 'speaker')} behind them.`
  );
  if (ev.cfpClosesAt) {
    say.push(
      `The call ${ev.lifecycle === 'open' ? 'closes' : 'closed'} on ${instant(ev.cfpClosesAt, ev.timezone)}.`
    );
  }

  const [proposals, outbox, building] = backstageDoors(ev);
  const doors =
    counts.undecided > 0
      ? [proposals, outbox, building]
      : counts.decidedNotTold > 0
        ? [outbox, proposals, building]
        : [building, proposals, outbox];
  return instantly(say, doors);
}

/* ------------------------------------------------------------------ *
 * my-queue — a reviewer's own round. Counts only: a blind read stays
 * blind, so no title of a proposal appears in it.
 * ------------------------------------------------------------------ */

async function myQueue(
  db: D1Database,
  ev: EventHome,
  principal: Principal | null
): Promise<AskResult | null> {
  if (!principal) return null;
  const room = await reviewEvent(db, principal, ev.slug).catch((e: unknown) => {
    console.log('ask: the reading room did not read', String(e));
    return null;
  });
  if (!room) return null;
  const round = room.round;
  const q = await reviewQueue(db, principal, room);

  // Their own numbers whichever view they read in: `assigned` counts the review
  // rows that are theirs, and stepping aside finishes a proposal as surely as
  // marking it does, so both come out of what is left.
  const left = Math.max(0, q.assigned - q.submitted - q.recused);
  const door: Door = { id: 'dr', href: `/admin/${ev.slug}/reviews`, label: 'Your reviews' };

  if (q.mine === 0) {
    return instantly(
      [
        `Nothing has been handed to you for round ${round} yet.`,
        'When something is, it appears on your reviews page, and your marks stay yours until you send them.',
      ],
      [door]
    );
  }

  if (left === 0) {
    return instantly(
      [
        `Round ${round} is clear on your side: nothing is left for you to score.`,
        q.mineDone > 0
          ? `${count(q.mineDone, 'review')} of yours ${isAre(q.mineDone)} in${q.recused > 0 ? `, and you stepped aside on ${spelled(q.recused)}` : ''}.`
          : // Handed out, then decided before she got to them: an empty list and
            // a finished evening are two different silences.
            `The ${count(q.mine, 'proposal')} handed to you ${isAre(q.mine)} all decided already.`,
      ],
      [door]
    );
  }

  return instantly(
    [
      `${count(left, 'proposal')} ${isAre(left)} left for you to score in round ${round}.`,
      `Of the ${count(q.mine, 'proposal')} handed to you this round, you have sent ${spelled(q.mineDone)}${q.recused > 0 ? `, and stepped aside on ${spelled(q.recused)}` : ''}.`,
      q.staged > 0
        ? `Marks are already in ${spelled(q.staged)} of the ones left, waiting to be sent.`
        : null,
    ],
    [door]
  );
}

/* ------------------------------------------------------------------ *
 * Which chips this person has earned, and what they say.
 * ------------------------------------------------------------------ */

/** The words on a chip, and the question written into the organizers' log when
 *  it is pressed. Time-aware, so the chip asks what a reader would actually ask
 *  standing where they are standing. */
export function intentLabel(code: IntentCode, ev: EventHome, nowMs: number): string {
  switch (code) {
    case 'now-next': {
      const phase = phaseOf(ev, nowMs);
      return phase === 'before'
        ? 'When does the program start?'
        : phase === 'during'
          ? 'What is on right now?'
          : 'What was on?';
    }
    case 'call-close':
      return ev.lifecycle === 'open'
        ? 'Can I still send a talk?'
        : 'When do decisions go out?';
    case 'getting-started':
      return 'What should I do first?';
    case 'my-owed':
      return 'What do I owe, and by when?';
    case 'pile-now':
      return 'What needs deciding?';
    case 'my-queue':
      return 'What is left for me to score?';
  }
}

type Held = { proposals: number; openTasks: number; reviews: number };

/**
 * What this person holds at this conference, in one row: whether they have sent
 * anything, whether anything is owed by them, and whether this round handed them
 * any reading. It exists to decide which chips to draw without running the three
 * answers behind them on every page view.
 *
 * It is a read of counts only — no title, no state, no name — so it can be run
 * before any of the standing checks that gate the answers themselves.
 */
async function heldHere(db: D1Database, ev: EventHome, personId: string): Promise<Held> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM submission s
            JOIN participation pa ON pa.submission_id = s.id
           WHERE s.event_id = ?1 AND pa.person_id = ?2 AND s.state <> 'draft') AS proposals,
         (SELECT COUNT(*) FROM task
           WHERE event_id = ?1 AND person_id = ?2
             AND completed_at IS NULL AND cancelled_at IS NULL) AS open_tasks,
         (SELECT COUNT(*) FROM review rv
            JOIN submission s2 ON s2.id = rv.submission_id
           WHERE s2.event_id = ?1 AND rv.reviewer_person_id = ?2
             AND rv.round = (SELECT current_round FROM event WHERE id = ?1)) AS reviews`
    )
    .bind(ev.id, personId)
    .first<{ proposals: number; open_tasks: number; reviews: number }>();
  return {
    proposals: row?.proposals ?? 0,
    openTasks: row?.open_tasks ?? 0,
    reviews: row?.reviews ?? 0,
  };
}

/**
 * The chips this page offers, in the order it offers them: the three anybody
 * may press, then the ones a standing at THIS conference earns. A role held
 * somewhere else earns nothing here, exactly as it earns nothing in the facts
 * the model is given.
 *
 * Anonymous visitors cost no query at all; a signed-in person costs one.
 */
export async function offeredIntents(
  db: D1Database,
  ev: EventHome,
  principal: Principal | null,
  nowMs: number = Date.now()
): Promise<IntentChip[]> {
  const chip = (code: IntentCode, label?: string): IntentChip => ({
    code,
    label: label ?? intentLabel(code, ev, nowMs),
  });
  // The three anybody may press. A closed call at a conference that has
  // already happened is nobody's question; an open one, or one whose
  // decisions are still coming, is. Nothing is started at a conference that
  // is over — "what was on" is the whole of what a reader wants there.
  const anybody: IntentChip[] = [chip('now-next')];
  if (ev.cfpClosesAt !== null && ev.lifecycle !== 'happened') anybody.push(chip('call-close'));
  if (ev.lifecycle !== 'happened') anybody.push(chip('getting-started'));
  if (!principal) return anybody;

  const role = principal.eventRoles[ev.id];
  const backstage =
    principal.role === 'organizer' || (role !== undefined && READ_ROLES.includes(role));
  const readingRoom =
    principal.role === 'organizer' ||
    principal.role === 'reviewer' ||
    (role !== undefined && REVIEW_ROLES.includes(role));

  let held: Held = { proposals: 0, openTasks: 0, reviews: 0 };
  try {
    held = await heldHere(db, ev, principal.personId);
  } catch (e) {
    // A chip that cannot be decided on is a chip that is not drawn. The page
    // still answers everything a stranger could ask.
    console.log('ask: the standing chips did not read', String(e));
    return anybody;
  }

  // A standing leads with its own work — the organizer's first chip is her
  // pile, a reviewer's is their queue, a speaker's is what they owe — and the
  // universal questions follow. The same person on a conference where they
  // hold nothing reads exactly as a visitor does.
  const out: IntentChip[] = [];
  if (held.proposals > 0 || held.openTasks > 0) out.push(chip('my-owed'));
  if (readingRoom && held.reviews > 0) out.push(chip('my-queue'));
  if (backstage) out.push(chip('pile-now'));
  for (const c of anybody) {
    // Backstage readers run the call and the doors; "What should I do first?"
    // is visitor onboarding, and "Can I still send a talk?" is a visitor's
    // wording for a date the organizer still wants — ask it as the date.
    if (backstage && c.code === 'getting-started') continue;
    if (backstage && c.code === 'call-close' && ev.lifecycle === 'open') {
      out.push(chip('call-close', 'When does the call close?'));
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * The answer behind a chip. One read, one template, no model and no spend.
 *
 * Null means "not yours to see, or not a question we have" — the screen treats
 * that exactly as it treats a blank box. The standing checks live in the answers
 * themselves rather than in the chip that offers them, so a code posted by hand
 * is refused by the same rule that would refuse the screen.
 */
export async function intentAnswer(
  db: D1Database,
  ev: EventHome,
  code: IntentCode,
  principal: Principal | null = null,
  nowMs: number = Date.now()
): Promise<AskResult | null> {
  // A read that fails is not a stack trace on somebody's screen: the page has
  // a sentence for a question it cannot answer, and the Worker's log keeps why.
  return await runIntent(db, ev, code, principal, nowMs).catch((e: unknown) => {
    console.log('ask: the instant answer did not read', String(e));
    return null;
  });
}

async function runIntent(
  db: D1Database,
  ev: EventHome,
  code: IntentCode,
  principal: Principal | null,
  nowMs: number
): Promise<AskResult | null> {
  switch (code) {
    case 'now-next':
      return await nowNext(db, ev, nowMs);
    case 'call-close':
      return callClose(ev, nowMs);
    case 'getting-started':
      return await gettingStarted(db, ev);
    case 'my-owed':
      return await myOwed(db, ev, principal, nowMs);
    case 'pile-now':
      return await pileNow(db, ev, principal);
    case 'my-queue':
      return await myQueue(db, ev, principal);
  }
}
