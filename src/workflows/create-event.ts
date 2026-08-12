// Starting a conference. Whoever creates one owns it (event_role 'owner') —
// the door the whole backstage assumes but nothing built until now. One
// guarded batch: the event, the ownership, the rooms, the tracks.
import { checkedBatch, guard, newId, now } from '../lib/db';
import type { Principal } from './account';

export type CreateEventInput = {
  name: string;
  slug?: string;
  startsOn: string; // YYYY-MM-DD, the event's own local days
  endsOn: string;
  timezone: string;
  tzLabel?: string;
  venueName?: string;
  callOpen: boolean; // open the call for speakers immediately
  cfpClosesOn?: string; // YYYY-MM-DD; required when callOpen
  decideBy?: string; // YYYY-MM-DD
  cfpIntro?: string;
  rooms: string[]; // one per line from the form; defaulted if empty
  tracks: string[];
};

export type CreateEventResult = { ok: true; slug: string } | { ok: false; error: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The track wheel — the same family the seed paints with. */
const TRACK_COLOURS = ['#B14D14', '#2F5D50', '#8B3A62', '#3E5C76', '#7A5C2E'];

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function createEvent(
  db: D1Database,
  principal: Principal,
  input: CreateEventInput
): Promise<CreateEventResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'The conference needs a name.' };
  if (!DAY.test(input.startsOn) || !DAY.test(input.endsOn)) {
    return { ok: false, error: 'The dates need to be real days.' };
  }
  if (input.endsOn < input.startsOn) {
    return { ok: false, error: 'A conference cannot end before it starts.' };
  }
  if (!validTimezone(input.timezone)) {
    return { ok: false, error: 'That timezone is not one the calendar knows. Try the Region/City form, like America/New_York.' };
  }
  if (input.callOpen && !DAY.test(input.cfpClosesOn ?? '')) {
    return { ok: false, error: 'An open call needs a closing date.' };
  }
  if (input.decideBy !== undefined && input.decideBy !== '' && !DAY.test(input.decideBy)) {
    return { ok: false, error: 'The decisions date needs to be a real day.' };
  }

  const slug = slugify(input.slug?.trim() || name);
  if (!slug) return { ok: false, error: 'The name needs at least one letter or digit for its address.' };

  const t = now();
  const id = newId('ev');
  // The closing instant is the end of the chosen day, taken in UTC — within a
  // day of the organizer's intent everywhere on earth. Timezone-exact close
  // is a settings refinement, not a creation-time question.
  const closesAt = input.callOpen ? Date.parse(`${input.cfpClosesOn}T23:59:59Z`) : null;
  const rooms = (input.rooms.length > 0 ? input.rooms : ['Main stage']).slice(0, 12);
  const tracks = input.tracks.slice(0, TRACK_COLOURS.length * 2);

  const statements = [
    guard(db, 'SELECT 1 FROM event WHERE slug = ?1', slug),
    db
      .prepare(
        `INSERT INTO event (id, slug, name, starts_on, ends_on, timezone, tz_label, venue_name,
           cfp_opens_at, cfp_closes_at, cfp_intro, decide_by, questions, green_room_nonce, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id,
        slug,
        name,
        input.startsOn,
        input.endsOn,
        input.timezone,
        input.tzLabel?.trim() || null,
        input.venueName?.trim() || null,
        input.callOpen ? t : null,
        closesAt,
        input.cfpIntro?.trim() || null,
        input.decideBy?.trim() || null,
        '[]',
        newId('grn'),
        t
      ),
    db
      .prepare('INSERT INTO event_role (person_id, event_id, role, granted_at, granted_by) VALUES (?,?,?,?,?)')
      .bind(principal.personId, id, 'owner', t, principal.personId),
    ...rooms.map((r, i) =>
      db.prepare('INSERT INTO room (id, event_id, name, position) VALUES (?,?,?,?)').bind(newId('room'), id, r, i)
    ),
    ...tracks.map((tr, i) =>
      db
        .prepare('INSERT INTO track (id, event_id, name, slug, colour, position) VALUES (?,?,?,?,?,?)')
        .bind(newId('trk'), id, tr, slugify(tr) || `track-${i + 1}`, TRACK_COLOURS[i % TRACK_COLOURS.length], i)
    ),
  ];
  const expect: (number | 'any')[] = [0, 1, 1, ...rooms.map(() => 1), ...tracks.map(() => 1)];

  try {
    await checkedBatch(db, statements, expect, 'That address is taken by another conference. Pick a different one.');
  } catch (e) {
    if (e instanceof Error && (e.name === 'StaleStateError' || e.name === 'ChangesMismatchError')) {
      return { ok: false, error: 'That address is taken by another conference. Pick a different one.' };
    }
    throw e;
  }
  return { ok: true, slug };
}
