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
// Two SELECTs live in this file rather than in a query file, deliberately: the
// curated-answer read and the question write belong to Ask alone, no screen
// outside this parcel reads them, and queries/public.ts is another parcel's
// file this wave. If Ask outgrows one screen, they are the first thing to lift.

import { checkedBatch, guard, newId, now } from '../lib/db';
import {
  agenda,
  speakersGallery,
  type Agenda,
  type EventHome,
  type GallerySpeaker,
} from '../queries/public';

/* ------------------------------------------------------------------ *
 * The closed set of doors.
 * ------------------------------------------------------------------ */

export type Door = { id: string; href: string; label: string };

/** What the screen renders. `say` is plain text — the screen escapes it. */
export type AskResult = {
  kind: 'curated' | 'read' | 'unsure';
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

/* ------------------------------------------------------------------ *
 * What the concierge is allowed to know: the public program, and nothing
 * behind it. Every line carries the id of the door it opens.
 * ------------------------------------------------------------------ */

type Facts = { text: string; doors: Door[] };

function buildFacts(ev: EventHome, ag: Agenda | null, speakers: GallerySpeaker[]): Facts {
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
  '- Warm, plain, second person. Sentence case. No exclamation marks. No emoji.',
  '- Name real talks, people, rooms and times from THE FACTS. Never invent one.',
  '- A talk is named by its title. The ids under DOORS belong in "doors", never in a sentence.',
  '- Never describe how you work, and never say what you are.',
  '- Never write a web address or a link. The doors do that.',
  '',
  'How you reply:',
  'Reply with JSON and nothing else, in exactly this shape:',
  '{"say":["first sentence","second sentence"],"doors":["d1","d2"]}',
  '"say" holds two to four sentences of plain text.',
  '"doors" holds up to three door ids, most useful first, taken only from the DOORS list.',
].join('\n');

type ModelSay = { say: string[]; doors: string[] };

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
  return { say, doors };
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
    out.push(clean.length > MAX_SENTENCE_CHARS ? `${clean.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…` : clean);
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
  question: string
): Promise<AskResult> {
  const [ag, speakers] = await Promise.all([agenda(db, ev.id), speakersGallery(db, ev.id)]);
  const published = ag?.published === true;
  const facts = buildFacts(ev, ag, speakers);
  const byId = new Map(facts.doors.map((d) => [d.id, d]));

  let said: ModelSay | null = null;
  try {
    said = await runModel(ai, facts, question);
  } catch (e) {
    // A model that will not answer is a state this screen already has a
    // sentence for. It is not an occasion for a stack trace — but the
    // Worker's own log still gets to know which model refused, and why.
    console.log('ask: the model did not answer', String(e));
    said = null;
  }

  const say = settle(said?.say ?? []);
  if (!say.length) {
    return { kind: 'unsure', say: [], doors: plainDoors(ev, published) };
  }

  const doors: Door[] = [];
  for (const id of said?.doors ?? []) {
    const door = byId.get(id);
    if (door && !doors.some((d) => d.href === door.href)) doors.push(door);
    if (doors.length === MAX_DOORS) break;
  }
  if (!doors.length) doors.push(...plainDoors(ev, published));

  return { kind: 'read', say, doors };
}
