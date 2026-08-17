// S-20 — Settings. The event's own controls, in the order a person actually
// needs them: what the conference is, where its sessions happen, what the call
// asks, what the committee marks by, who may touch any of it, and the one link
// that is handed to strangers with lanyards.
//
// Hat (11-hats.md, the organizer register, worn as Marcus Delacroix — eleven
// years of DevOps Days Charlotte on volunteer time): careful with other
// people's access. Every control here changes something somebody else will
// feel, so every control says what that is before it is pressed, in plain
// speech, with the count in it. Nothing on this page is a preference.
//
// The two-pass rule (D-024) is applied where it is owed and nowhere else:
// saving copy, moving a question, changing a standing you can change straight
// back — one press. Taking a person off the conference, and rotating the link
// the crew is holding — two, with the fact carried in the form and guarded in
// the batch.
//
// Dates and the time zone are shown as facts and cannot be edited here: moving
// them moves every session already placed. That is a different act, and it is
// named as one rather than left as a disabled input.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label } from '../../lib/labels';
import { ScopeError } from '../../queries/admin';
import { initialsOf } from '../../queries/public';
import {
  eventSettings,
  eventIdBySlug,
  reviewerOnly,
  EVENT_ROLES,
  type EventRole,
  type EventSettings,
  type SettingsQuestion,
  type SettingsRoom,
  type SettingsTrack,
} from '../../queries/settings';
import {
  MOST_CRITERIA,
  type ScorecardKey,
  type ScorecardKind,
} from '../../queries/reviews';
import {
  principalFromCookie,
  makeMagicLink,
  isRealAddress,
  type Principal,
} from '../../workflows/account';
import {
  saveEventFacts,
  saveQuestions,
  addToTeam,
  changeStanding,
  takeOffTeam,
  newGreenRoomLink,
  addRoom,
  renameRoom,
  addTrack,
  renameTrack,
  saveScorecard,
  type Said,
  type QuestionDraft,
  type CriterionDraft,
} from '../../workflows/settings';

/* ------------------------------------------------------------------ *
 * Words this screen owns
 * ------------------------------------------------------------------ */

// GAP, for the doc owner: 02 §6 has no row for the four backstage standings
// (D-026 event_role tiers), so lib/labels.ts holds no key for them and label()
// would rather throw than guess. These are the words the screen says until §6
// gets its row; when it does, they move there and this map goes away.
const STANDING_WORD: Record<string, string> = {
  owner: 'Owner',
  approver: 'Approver',
  editor: 'Editor',
  viewer: 'Viewer',
  reviewer: 'Reviewer',
  organizer: 'Organizer',
};

const STANDING_POWER: Record<EventRole, string> = {
  owner: 'Everything, including who else is on this list.',
  approver: 'Decides proposals and sends the letters. Changes the event too.',
  editor: 'Changes the event, the questions and the agenda. Does not decide.',
  viewer: 'Reads the proposals and the program. Changes nothing.',
  reviewer: 'Reads and scores the proposals handed to them, with the names hidden. Sees nothing else here.',
};

const word = (standing: string): string => STANDING_WORD[standing] ?? STANDING_WORD['viewer'] ?? '';

/* ------------------------------------------------------------------ *
 * Dates, the way the rest of the product writes them
 * ------------------------------------------------------------------ */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function dayOf(iso: string): string {
  const parts = iso.split('-');
  const month = MONTHS[Number(parts[1] ?? '0') - 1] ?? '';
  return `${Number(parts[2] ?? '0')} ${month}`.trim();
}

function dayLongOf(iso: string): string {
  return `${dayOf(iso)} ${iso.slice(0, 4)}`.trim();
}

function instantOf(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' })
    .format(new Date(ms));
}

/** The same instant with its year, for a standing granted seasons ago. */
function instantYearOf(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(ms));
}

function datesOf(ev: EventSettings): string {
  const year = ev.startsOn.slice(0, 4);
  if (ev.startsOn === ev.endsOn) return `${dayOf(ev.startsOn)} ${year}`;
  const sameMonth = ev.startsOn.slice(0, 7) === ev.endsOn.slice(0, 7);
  const from = sameMonth ? String(Number(ev.startsOn.slice(8))) : dayOf(ev.startsOn);
  return `${from} – ${dayOf(ev.endsOn)} ${year}`;
}

const num = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string =>
  `${num(n)} ${n === 1 ? one : many}`;

/** An instant back as the day the settings form would have typed (UTC day —
 *  the same within-a-day convention the writer uses going the other way). */
function callDayOf(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** The call's own state, in the organizer's register. */
function callSentence(ev: EventSettings, nowMs: number): string {
  if (ev.cfpOpensAt !== null && ev.cfpOpensAt > nowMs) {
    return label('call.before', 'backstage').replace('{date}', instantOf(ev.cfpOpensAt, ev.timezone));
  }
  if (ev.cfpClosesAt !== null && ev.cfpClosesAt > nowMs) {
    const days = Math.max(0, Math.ceil((ev.cfpClosesAt - nowMs) / 86_400_000));
    return label('call.open', 'backstage').replace('{n} days', days === 1 ? 'a day' : `${num(days)} days`);
  }
  if (ev.cfpClosesAt !== null) {
    return label('call.closed', 'backstage').replace('{date}', instantOf(ev.cfpClosesAt, ev.timezone));
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * What the last press did — one closed set, one sentence each
 * ------------------------------------------------------------------ */

type Section = 'event' | 'rooms' | 'questions' | 'scorecard' | 'team' | 'link';

const ANCHOR: Record<Section, string> = {
  event: 'the-event',
  rooms: 'the-rooms-and-the-tracks',
  questions: 'the-questions',
  scorecard: 'the-scorecard',
  team: 'the-team',
  link: 'the-link',
};

/** `field` names the one input the sentence is about. An outcome that names a
 *  field says its piece beside that field and nowhere else — a refusal about a
 *  date read at the top of the section, next to the name, is a refusal about
 *  nothing. */
type Outcome = { where: Section; line: string; refused: boolean; field?: string };

const SAID: Record<Said, Outcome> = {
  event_saved: { where: 'event', line: 'Saved. The public page and the call read from this.', refused: false },
  event_name_needed: {
    where: 'event',
    field: 'name',
    line: 'A conference needs a name. Nothing was changed.',
    refused: true,
  },
  event_cap: {
    where: 'event',
    field: 'cap',
    line: 'How many proposals per person has to be a whole number from one to ten. Nothing was changed.',
    refused: true,
  },
  event_date: {
    where: 'event',
    field: 'decide_by',
    line: 'The decision date is written as 2026-08-27. Nothing was changed.',
    refused: true,
  },
  event_opens_date: {
    where: 'event',
    field: 'call_opens',
    line: 'The day the call opens is written as 2026-08-01. Nothing was changed.',
    refused: true,
  },
  event_closes_date: {
    where: 'event',
    field: 'call_closes',
    line: 'The day the call closes is written as 2026-08-27. Nothing was changed.',
    refused: true,
  },
  event_closes_first: {
    where: 'event',
    field: 'call_closes',
    line: 'The call cannot close before it opens — this day falls earlier than the day above. Nothing was changed.',
    refused: true,
  },
  event_moved: { where: 'event', line: 'This conference moved while the page was open. Nothing was changed.', refused: true },

  questions_saved: {
    where: 'questions',
    line: 'Saved. Every answer already given is exactly where it was.',
    refused: false,
  },
  questions_words_needed: {
    where: 'questions',
    line: 'A question needs its words. To take one off the call, tick Turn it off instead. Nothing was changed.',
    refused: true,
  },
  questions_kind: {
    where: 'questions',
    line: 'That is not one of the four ways to answer. Nothing was changed.',
    refused: true,
  },
  questions_choices_needed: {
    where: 'questions',
    line: 'Pick one needs at least two choices to pick from. Nothing was changed.',
    refused: true,
  },
  questions_show_if: {
    where: 'questions',
    line: 'A question can only follow one asked before it, and it needs the answer that brings it out. Nothing was changed.',
    refused: true,
  },
  questions_moved: {
    where: 'questions',
    line: 'Somebody else changed the questions while this page was open. These are the ones on the call now.',
    refused: true,
  },

  scorecard_saved: {
    where: 'scorecard',
    line: 'Saved. Every mark already given still counts for what it counted for.',
    refused: false,
  },
  scorecard_words_needed: {
    where: 'scorecard',
    line: 'A line needs its words. To take one off, press Take it off instead. Nothing was changed.',
    refused: true,
  },
  scorecard_kind: {
    where: 'scorecard',
    line: 'That is not one of the three ways to answer a line. Nothing was changed.',
    refused: true,
  },
  scorecard_choices_needed: {
    where: 'scorecard',
    line: 'Pick one needs at least two choices to pick from. Nothing was changed.',
    refused: true,
  },
  scorecard_weight: {
    where: 'scorecard',
    line: 'A line counts light, normal or heavy. Nothing was changed.',
    refused: true,
  },
  scorecard_last: {
    where: 'scorecard',
    line: 'A round keeps at least one line to mark by. Nothing was changed.',
    refused: true,
  },
  scorecard_too_many: {
    where: 'scorecard',
    line: 'A scorecard holds twelve lines at the most. Nothing was changed.',
    refused: true,
  },
  scorecard_scored: {
    where: 'scorecard',
    line: 'Reviews have come in on this round, so nothing comes off the card until the next round opens. Nothing was changed.',
    refused: true,
  },
  scorecard_moved: {
    where: 'scorecard',
    line: 'The scorecard or the round moved while this page was open. This is how it stands now.',
    refused: true,
  },

  team_added: { where: 'team', line: 'Added. They see this conference the next time they sign in.', refused: false },
  // The sentence stops at what is certainly true. The link below carries its
  // own heading, so a sentence promising one is a sentence that can be wrong.
  team_invited: {
    where: 'team',
    line: 'Added, and an account was made for them — they have no password yet.',
    refused: false,
  },
  team_role_changed: { where: 'team', line: 'Changed. It takes effect on their next screen.', refused: false },
  team_removed: { where: 'team', line: 'Taken off. They no longer see this conference.', refused: false },
  team_email_needed: {
    where: 'team',
    field: 'email',
    line: 'An address they could sign in with is needed — one @, and a domain after it. Nothing was changed.',
    refused: true,
  },
  team_already: { where: 'team', line: 'They are already on this conference. Their standing is in the list.', refused: true },
  team_gone: { where: 'team', line: 'That person is no longer on this conference. Nothing was changed.', refused: true },
  team_last_owner: {
    where: 'team',
    line: 'That would leave the conference with nobody who owns it. Make somebody else an owner first.',
    refused: true,
  },
  team_standing_unknown: { where: 'team', line: 'That is not one of the five standings. Nothing was changed.', refused: true },
  team_moved: { where: 'team', line: 'The list changed while this page was open. This is how it stands now.', refused: true },

  room_added: { where: 'rooms', line: 'Added. It is ready to hold a session.', refused: false },
  room_name_needed: { where: 'rooms', line: 'A room needs a name. Nothing was changed.', refused: true },
  room_name_taken: {
    where: 'rooms',
    line: 'Another room on this conference already has that name. Nothing was changed.',
    refused: true,
  },
  room_renamed: {
    where: 'rooms',
    line: 'Renamed. Every session already placed on it moved with the name.',
    refused: false,
  },
  room_moved: { where: 'rooms', line: 'This conference moved while the page was open. Nothing was changed.', refused: true },
  room_gone: { where: 'rooms', line: 'That room is no longer on this conference. Nothing was changed.', refused: true },

  track_added: { where: 'rooms', line: 'Added. It is ready to sort a proposal onto.', refused: false },
  track_name_needed: { where: 'rooms', line: 'A track needs a name. Nothing was changed.', refused: true },
  track_renamed: {
    where: 'rooms',
    line: 'Renamed. Every proposal already sorted onto it moved with the name.',
    refused: false,
  },
  track_moved: { where: 'rooms', line: 'This conference moved while the page was open. Nothing was changed.', refused: true },
  track_gone: { where: 'rooms', line: 'That track is no longer on this conference. Nothing was changed.', refused: true },

  link_made: { where: 'link', line: 'The link is live. Give it to the crew.', refused: false },
  link_rotated: { where: 'link', line: 'The link is new. The old one stopped working the moment you pressed it.', refused: false },
  link_moved: {
    where: 'link',
    line: 'The link had already been rotated. This is the one that works — nothing was changed again.',
    refused: true,
  },

  nothing_sent: { where: 'team', line: 'That arrived without saying who. Nothing was changed.', refused: true },
};

function isSaid(value: string): value is Said {
  return Object.prototype.hasOwnProperty.call(SAID, value);
}

function saidIn(here: Section, said: Said | null): string {
  if (said === null) return '';
  const out = SAID[said];
  // An outcome that names a field says its piece there instead — never twice.
  if (out.where !== here || out.field !== undefined) return '';
  return (
    `<div class="notebox" style="margin:0 0 16px${out.refused ? ';border-left-color:var(--danger)' : ''}">` +
    esc(out.line) +
    '</div>'
  );
}

/** The sentence for one input, when the last press was about that input. */
function saidAt(name: string, said: Said | null): string | undefined {
  if (said === null) return undefined;
  const out = SAID[said];
  return out.field === name ? out.line : undefined;
}

/* ------------------------------------------------------------------ *
 * Small builders
 * ------------------------------------------------------------------ */

function field(o: {
  name: string;
  labelText: string;
  value: string;
  optional?: boolean;
  hint?: string;
  area?: boolean;
  rows?: number;
  placeholder?: string;
  type?: string;
  /** Set only where a refusal has to be able to scroll to this input; ids on
   *  this page have to stay unique, and the repeated cards reuse names. */
  anchored?: boolean;
  /** What was wrong with what arrived, said here rather than at the top. */
  wrong?: string;
}): string {
  const bad = o.wrong !== undefined ? ' aria-invalid="true"' : '';
  const control = o.area
    ? `<textarea name="${esc(o.name)}" rows="${o.rows ?? 4}"${bad}` +
      (o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : '') +
      `>${esc(o.value)}</textarea>`
    : `<input type="${o.type ?? 'text'}" name="${esc(o.name)}" value="${esc(o.value)}"${bad}` +
      (o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : '') +
      '>';
  return (
    `<label class="f"${o.anchored ? ` id="f-${esc(o.name)}"` : ''}><span class="f-lab">` +
    esc(o.labelText) +
    (o.optional ? '<span class="opt">optional</span>' : '') +
    '</span>' +
    control +
    (o.wrong !== undefined
      ? `<span class="hint" style="color:var(--danger)">${esc(o.wrong)}</span>`
      : '') +
    (o.hint ? `<span class="hint">${esc(o.hint)}</span>` : '') +
    '</label>'
  );
}

function tick(o: { name: string; on: boolean; name_: string; sub: string }): string {
  return (
    `<label class="f radio${o.on ? ' on' : ''}">` +
    `<input type="checkbox" name="${esc(o.name)}" value="on"${o.on ? ' checked' : ''}>` +
    `<span><span class="rname">${esc(o.name_)}</span><span class="rsub">${esc(o.sub)}</span></span>` +
    '</label>'
  );
}

const KIND_LABEL: Record<SettingsQuestion['kind'], string> = {
  short: label('question.kind.short', 'backstage'),
  long: label('question.kind.long', 'backstage'),
  select: label('question.kind.select', 'backstage'),
  checkbox: label('question.kind.checkbox', 'backstage'),
};

function kindSelect(name: string, chosen: string): string {
  const options = (Object.keys(KIND_LABEL) as SettingsQuestion['kind'][])
    .map(
      (k) =>
        `<option value="${esc(k)}"${k === chosen ? ' selected' : ''}>${esc(KIND_LABEL[k])}</option>`
    )
    .join('');
  return `<select name="${esc(name)}">${options}</select>`;
}

function standingSelect(name: string, chosen: string, described: string): string {
  const options = EVENT_ROLES.map(
    (r) => `<option value="${esc(r)}"${r === chosen ? ' selected' : ''}>${esc(word(r))}</option>`
  ).join('');
  return `<select name="${esc(name)}" aria-label="${esc(described)}">${options}</select>`;
}

/* ------------------------------------------------------------------ *
 * 1 — the event
 * ------------------------------------------------------------------ */

function eventSection(ev: EventSettings, said: Said | null, nowMs: number): string {
  const call = callSentence(ev, nowMs);
  const decide =
    ev.decideBy !== null
      ? `Decisions go out by ${dayLongOf(ev.decideBy)}.`
      : 'No date is set for decisions yet.';
  return (
    `<div class="sec card card-pad" style="max-width:46em" id="${ANCHOR.event}">` +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The event</h3>' +
    `<p class="sub" style="margin:6px 0 14px">${call ? esc(`${call}. `) : ''}${esc(decide)}</p>` +
    saidIn('event', said) +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/settings/event">` +
    field({
      name: 'name',
      labelText: 'What it is called',
      value: ev.name,
      anchored: true,
      wrong: saidAt('name', said),
    }) +
    field({
      name: 'tagline',
      labelText: 'The line under the name',
      value: ev.tagline ?? '',
      optional: true,
      hint: 'One sentence. It sits under the name on the public page and at the top of the call.',
    }) +
    field({ name: 'venue', labelText: 'Where it happens', value: ev.venueName ?? '', optional: true }) +
    field({
      name: 'address',
      labelText: 'The address',
      value: ev.venueAddress ?? '',
      optional: true,
      hint: 'What a speaker would put into a map on the morning.',
    }) +
    '<div class="standing">' +
    `<b>${esc(datesOf(ev))}</b> · ${esc(ev.tzLabel ?? ev.timezone)} · ${esc(ev.timezone)}` +
    '</div>' +
    '<p class="hint" style="margin-bottom:22px">The days and the time zone are set when the conference is made. ' +
    'Moving them moves every session already on the agenda, so it is not something this page does on its own.</p>' +
    field({
      name: 'intro',
      labelText: 'What the call says',
      value: ev.cfpIntro ?? '',
      area: true,
      rows: 5,
      hint: 'Your own words, in your own voice, at the top of the public form. Leave it blank and the page collapses to one line rather than showing a hole.',
    }) +
    field({
      name: 'cap',
      labelText: 'How many proposals per person',
      value: String(ev.maxSubmissions),
      anchored: true,
      wrong: saidAt('cap', said),
      hint: 'Once somebody reaches it, the call stops taking new ones from them and points them at their portal.',
    }) +
    field({
      name: 'call_opens',
      labelText: 'The call opens',
      value: callDayOf(ev.cfpOpensAt),
      optional: true,
      placeholder: '2026-08-01',
      anchored: true,
      wrong: saidAt('call_opens', said),
      hint: 'Written as 2026-08-01. Leave both dates blank and the call is shut.',
    }) +
    field({
      name: 'call_closes',
      labelText: 'The call closes',
      value: callDayOf(ev.cfpClosesAt),
      optional: true,
      placeholder: '2026-08-27',
      anchored: true,
      wrong: saidAt('call_closes', said),
      hint: 'Proposals can be sent and edited until the end of this day.',
    }) +
    field({
      name: 'decide_by',
      labelText: 'Decisions go out by',
      value: ev.decideBy ?? '',
      placeholder: '2026-08-27',
      anchored: true,
      wrong: saidAt('decide_by', said),
      hint: 'The date the call promises and every letter repeats. Written as 2026-08-27.',
    }) +
    '<label class="radio" style="margin:4px 0 14px;align-items:flex-start">' +
    `<input type="checkbox" name="reminders" value="on"${ev.autoReminders ? ' checked' : ''}>` +
    '<span>Remind speakers about due deliverables automatically — once a day, only when ' +
    'something is due within three days or overdue, in one letter per person. Turn it off ' +
    'and only your own reminders go out.</span></label>' +
    '<div class="btnrow"><button class="btn btn-primary" type="submit">Save the event</button>' +
    `<a class="btn" href="/${encodeURIComponent(ev.slug)}/cfp">See the call ↗</a>` +
    `<a class="btn" href="/${encodeURIComponent(ev.slug)}">See the public page ↗</a></div>` +
    '</form></div>'
  );
}

/* ------------------------------------------------------------------ *
 * 1b — the rooms and the tracks (AIA-02)
 * ------------------------------------------------------------------ */

function roomRow(r: SettingsRoom, settings: string): string {
  return (
    '<tr><td>' +
    `<form method="post" action="${settings}/rooms/rename" style="display:flex;gap:8px;align-items:center">` +
    `<input type="hidden" name="id" value="${esc(r.id)}">` +
    `<input type="text" name="name" value="${esc(r.name)}" aria-label="Rename ${esc(r.name)}" style="max-width:20em">` +
    '<button class="btn btn-sm" type="submit">Save</button>' +
    '</form></td>' +
    `<td class="t-sub">${r.capacity !== null ? esc(String(r.capacity)) : 'No capacity on file'}</td></tr>`
  );
}

function trackRow(t: SettingsTrack, settings: string): string {
  const dot =
    `<span aria-hidden="true" style="display:inline-block;width:11px;height:11px;border-radius:50%;` +
    `background:${/^#[0-9a-fA-F]{6}$/.test(t.colour) ? esc(t.colour) : 'transparent'};margin-right:9px;` +
    'vertical-align:middle;flex:none"></span>';
  return (
    '<tr><td>' +
    `<form method="post" action="${settings}/tracks/rename" style="display:flex;gap:8px;align-items:center">` +
    dot +
    `<input type="hidden" name="id" value="${esc(t.id)}">` +
    `<input type="text" name="name" value="${esc(t.name)}" aria-label="Rename ${esc(t.name)}" style="max-width:20em">` +
    '<button class="btn btn-sm" type="submit">Save</button>' +
    '</form></td></tr>'
  );
}

function roomsTracksSection(ev: EventSettings, said: Said | null): string {
  const settings = `/admin/${encodeURIComponent(ev.slug)}/settings`;

  const roomsTable = ev.rooms.length
    ? '<div class="tablewrap" style="margin-top:10px"><table class="t">' +
      '<thead><tr><th>Room</th><th>Capacity</th></tr></thead>' +
      `<tbody>${ev.rooms.map((r) => roomRow(r, settings)).join('')}</tbody></table></div>`
    : '<div class="state-out"><p>No rooms yet. Add the stage the first session goes on.</p></div>';

  const tracksTable = ev.tracks.length
    ? '<div class="tablewrap" style="margin-top:10px"><table class="t">' +
      '<thead><tr><th>Track</th></tr></thead>' +
      `<tbody>${ev.tracks.map((t) => trackRow(t, settings)).join('')}</tbody></table></div>`
    : '<div class="state-out"><p>No tracks yet. A proposal sorts fine without one.</p></div>';

  const addRoomForm =
    `<form method="post" action="${settings}/rooms/add" ` +
    'style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px">' +
    '<input type="text" name="name" placeholder="Room 2" aria-label="New room name" maxlength="120" required>' +
    '<button class="btn btn-sm" type="submit">Add a room</button></form>';

  const addTrackForm =
    `<form method="post" action="${settings}/tracks/add" ` +
    'style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px">' +
    '<input type="text" name="name" placeholder="Platform" aria-label="New track name" maxlength="120" required>' +
    '<button class="btn btn-sm" type="submit">Add a track</button></form>';

  return (
    `<div class="sec card card-pad" style="max-width:46em" id="${ANCHOR.rooms}">` +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The rooms and the tracks</h3>' +
    '<p class="sub" style="margin:6px 0 14px">Neither comes off this list. Add one, or rename one.</p>' +
    saidIn('rooms', said) +
    '<h4 class="serif" style="font-size:15.5px;font-weight:600">Rooms</h4>' +
    roomsTable +
    addRoomForm +
    '<h4 class="serif" style="font-size:15.5px;font-weight:600;margin-top:24px">Tracks</h4>' +
    tracksTable +
    addTrackForm +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * 2 — the call's questions (R-10)
 * ------------------------------------------------------------------ */

function questionCard(q: SettingsQuestion, i: number, last: number, earlier: SettingsQuestion[]): string {
  const n = `q:${i}`;
  const moves =
    (i > 0
      ? `<button class="btn btn-sm" type="submit" name="move" value="up:${i}">${esc(label('question.up', 'backstage'))}</button>`
      : '') +
    (i < last
      ? `<button class="btn btn-sm" type="submit" name="move" value="down:${i}">${esc(label('question.down', 'backstage'))}</button>`
      : '');

  const parents =
    `<option value=""${q.showIf === null ? ' selected' : ''}>Ask it every time</option>` +
    earlier
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${q.showIf?.questionId === p.id ? ' selected' : ''}>${esc(p.label)}</option>`
      )
      .join('');

  const showsWhen =
    q.showIf !== null
      ? '<p class="hint">' +
        esc(
          label('question.show_if', 'backstage')
            .replace('{question}', earlier.find((p) => p.id === q.showIf?.questionId)?.label ?? '')
            .replace('{answer}', q.showIf.equals)
        ) +
        '</p>'
      : '';

  return (
    '<div class="card card-pad" style="margin-bottom:14px">' +
    `<input type="hidden" name="${n}:id" value="${esc(q.id)}">` +
    '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    `<span class="t-sub">Question ${num(i + 1)}</span>` +
    `<span class="t-sub">${esc(
      q.answered === 0
        ? 'Nobody has answered this yet'
        : `Answered on ${plural(q.answered, 'proposal', 'proposals')}`
    )}</span>` +
    `<span class="btnrow" style="margin-left:auto">${moves}</span>` +
    '</div>' +
    field({ name: `${n}:label`, labelText: 'What you ask', value: q.label }) +
    field({
      name: `${n}:hint`,
      labelText: 'The line underneath',
      value: q.hint ?? '',
      optional: true,
      hint: 'Where the good answers come from. Say what a strong one looks like.',
    }) +
    `<label class="f"><span class="f-lab">How it is answered</span>${kindSelect(`${n}:kind`, q.kind)}</label>` +
    field({
      name: `${n}:options`,
      labelText: 'The choices',
      value: (q.options ?? []).join('\n'),
      area: true,
      rows: 3,
      optional: true,
      hint: `One per line. Only used by ${KIND_LABEL.select}.`,
    }) +
    `<label class="f"><span class="f-lab">When to ask it</span>` +
    `<select name="${n}:when">${parents}</select></label>` +
    field({
      name: `${n}:is`,
      labelText: 'The answer that brings it out',
      value: q.showIf?.equals ?? '',
      optional: true,
      hint: 'For a tick box, that answer is the word true.',
    }) +
    showsWhen +
    tick({
      name: `${n}:required`,
      on: q.required,
      name_: 'An answer is needed',
      sub: 'The call will not send without it. A question that only some people can answer should not be one of these.',
    }) +
    tick({
      name: `${n}:off`,
      on: false,
      name_: label('question.off', 'backstage'),
      sub:
        q.answered === 0
          ? 'It comes off the call when you save. Nothing has been answered under it, so nothing moves.'
          : `It comes off the call when you save. The ${plural(q.answered, 'answer', 'answers')} already given stay exactly where they are.`,
    }) +
    '</div>'
  );
}

function addQuestionCard(): string {
  return (
    '<div class="card card-pad">' +
    `<h4 class="serif" style="font-size:18px;font-weight:600;margin-bottom:12px">${esc(label('question.add', 'backstage'))}</h4>` +
    field({
      name: 'new:label',
      labelText: 'What you ask',
      value: '',
      placeholder: 'What will people leave with?',
      hint: 'Fill this in and save. It joins the end of the call, and you can move it from there.',
    }) +
    field({ name: 'new:hint', labelText: 'The line underneath', value: '', optional: true }) +
    `<label class="f"><span class="f-lab">How it is answered</span>${kindSelect('new:kind', 'short')}</label>` +
    field({
      name: 'new:options',
      labelText: 'The choices',
      value: '',
      area: true,
      rows: 3,
      optional: true,
      hint: `One per line. Only used by ${KIND_LABEL.select}.`,
    }) +
    tick({
      name: 'new:required',
      on: false,
      name_: 'An answer is needed',
      sub: 'The call will not send without it.',
    }) +
    '</div>'
  );
}

function questionsSection(ev: EventSettings, said: Said | null): string {
  const cards = ev.questions
    .map((q, i) => questionCard(q, i, ev.questions.length - 1, ev.questions.slice(0, i)))
    .join('');

  const empty =
    '<div class="state-out" style="margin-bottom:14px">' +
    '<p>Everyone is asked for a title, an abstract, a format and who is speaking. Beyond that, this call asks nothing.</p>' +
    '<p class="hint">Add the question you always end up asking by email afterwards.</p>' +
    '</div>';

  const unreadable =
    ev.unreadable > 0
      ? `<div class="notebox" style="margin:0 0 16px;border-left-color:var(--danger)">${esc(
          `${plural(ev.unreadable, 'question is', 'questions are')} stored in a shape the call cannot read, so ${
            ev.unreadable === 1 ? 'it is' : 'they are'
          } not shown here and saving would drop ${ev.unreadable === 1 ? 'it' : 'them'}.`
        )}</div>`
      : '';

  return (
    `<div class="sec" id="${ANCHOR.questions}">` +
    '<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">' +
    `<h3 class="serif" style="font-size:21px;font-weight:600">The call's ${esc(label('question.section', 'backstage').toLowerCase())}</h3>` +
    `<span class="t-sub" style="margin-left:auto">${esc(plural(ev.questionCount, 'question on the call', 'questions on the call'))}` +
    `<span class="sep">·</span>${esc(plural(ev.proposalCount, 'proposal', 'proposals'))} already in</span>` +
    '</div>' +
    '<p class="hint" style="margin-bottom:14px">Editing the words never touches an answer somebody already gave.</p>' +
    saidIn('questions', said) +
    unreadable +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/settings/questions">` +
    // Enter inside a field must save, never move a question: the browser
    // presses the first submit button in the form, so this is it.
    '<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>' +
    `<input type="hidden" name="q:count" value="${esc(String(ev.questions.length))}">` +
    `<input type="hidden" name="seen" value="${esc(ev.questionsRaw)}">` +
    (ev.questionCount === 0 ? empty : cards) +
    addQuestionCard() +
    '<div class="btnrow" style="margin-top:16px"><button class="btn btn-primary" type="submit">Save the questions</button>' +
    `<a class="btn" href="/${encodeURIComponent(ev.slug)}/cfp">See the call ↗</a></div>` +
    '<p class="hint">Moving a question saves the rest of your changes with it.</p>' +
    '</form></div>'
  );
}

/* ------------------------------------------------------------------ *
 * 2b — the round's scorecard (R-11)
 * ------------------------------------------------------------------ */

// GAP, same shelf as STANDING_WORD above: 02 §6 has rows for the four ways a
// call question is answered, and none for the three ways a scorecard line is.
// Until it does, these are the words this screen says. §1.23 owns the review
// register, so they go there when the doc pass reaches it.
const CRITERION_KIND_WORD: Record<ScorecardKind, string> = {
  scale: 'A mark out of five',
  select: 'One word from a list',
  text: 'A line or two',
};

const WEIGHT_WORD: Record<string, string> = {
  '1': 'Light',
  '2': 'Normal',
  '3': 'Heavy',
};

function criterionKindSelect(name: string, chosen: string): string {
  const options = (Object.keys(CRITERION_KIND_WORD) as ScorecardKind[])
    .map(
      (k) =>
        `<option value="${esc(k)}"${k === chosen ? ' selected' : ''}>` +
        `${esc(CRITERION_KIND_WORD[k])}</option>`
    )
    .join('');
  return `<select name="${esc(name)}">${options}</select>`;
}

function weightSelect(name: string, chosen: number): string {
  const options = Object.keys(WEIGHT_WORD)
    .map(
      (w) =>
        `<option value="${esc(w)}"${Number(w) === chosen ? ' selected' : ''}>` +
        `${esc(WEIGHT_WORD[w] ?? '')}</option>`
    )
    .join('');
  return `<select name="${esc(name)}">${options}</select>`;
}

/** One line of the card, with its two ways to move and its one way to leave. */
function criterionCard(k: ScorecardKey, i: number, last: number, silent: boolean): string {
  const n = `c:${i}`;
  const moves =
    (i > 0
      ? `<button class="btn btn-sm" type="submit" name="move" value="up:${i}">${esc(label('question.up', 'backstage'))}</button>`
      : '') +
    (i < last
      ? `<button class="btn btn-sm" type="submit" name="move" value="down:${i}">${esc(label('question.down', 'backstage'))}</button>`
      : '');

  // Taking a line off is one press, because it is backstage, private and put
  // back by adding it again — but only while the round has heard nothing. Once
  // marks are in under this key, the button is not there and the sentence in
  // the section header says why, rather than a control that refuses on press.
  const off =
    silent && last > 0
      ? `<button class="btn btn-sm btn-danger" type="submit" name="remove" value="${esc(k.key)}">Take it off</button>`
      : '';

  return (
    '<div class="card card-pad" style="margin-bottom:14px">' +
    `<input type="hidden" name="${n}:key" value="${esc(k.key)}">` +
    '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    `<span class="t-sub">Line ${num(i + 1)}</span>` +
    `<span class="btnrow" style="margin-left:auto">${moves}${off}</span>` +
    '</div>' +
    field({ name: `${n}:label`, labelText: 'What the committee marks', value: k.label }) +
    `<label class="f"><span class="f-lab">How it is answered</span>` +
    `${criterionKindSelect(`${n}:kind`, k.kind)}</label>` +
    field({
      name: `${n}:options`,
      labelText: 'The choices',
      value: k.options.join('\n'),
      area: true,
      rows: 3,
      optional: true,
      hint: `One per line. Only used by ${CRITERION_KIND_WORD.select.toLowerCase()}.`,
    }) +
    `<label class="f" style="margin-bottom:0"><span class="f-lab">How much it counts` +
    '<span class="opt">a heavy line counts three times as much as a light one</span></span>' +
    `${weightSelect(`${n}:weight`, k.weight)}</label>` +
    '</div>'
  );
}

function addCriterionCard(): string {
  return (
    '<div class="card card-pad">' +
    '<h4 class="serif" style="font-size:18px;font-weight:600;margin-bottom:12px">Add a line</h4>' +
    field({
      name: 'new:label',
      labelText: 'What the committee marks',
      value: '',
      placeholder: 'Would this room learn something?',
      hint: 'Fill this in and save. It joins the end of the card, and you can move it from there.',
    }) +
    `<label class="f"><span class="f-lab">How it is answered</span>` +
    `${criterionKindSelect('new:kind', 'scale')}</label>` +
    field({
      name: 'new:options',
      labelText: 'The choices',
      value: '',
      area: true,
      rows: 3,
      optional: true,
      hint: `One per line. Only used by ${CRITERION_KIND_WORD.select.toLowerCase()}.`,
    }) +
    `<label class="f" style="margin-bottom:0"><span class="f-lab">How much it counts</span>` +
    `${weightSelect('new:weight', 2)}</label>` +
    '</div>'
  );
}

function scorecardSection(ev: EventSettings, said: Said | null): string {
  const round = label('review.round', 'backstage').replace('{n}', num(ev.currentRound));
  const silent = ev.scoredThisRound === 0;
  const cards = ev.scorecard
    .map((k, i) => criterionCard(k, i, ev.scorecard.length - 1, silent))
    .join('');

  // Two different silences, and they are not the same news: a round nobody has
  // read yet is a card that can still be rearranged freely, and a round with
  // marks in it is a card whose lines are load-bearing.
  const standing = silent
    ? `<p class="hint" style="margin-bottom:14px">Nothing has been marked in ${esc(round.toLowerCase())} yet, ` +
      'so the card is yours to rearrange. Once reviews start coming in, lines stop coming off it.</p>'
    : `<div class="standing" style="margin-bottom:14px">${esc(
        `${plural(ev.scoredThisRound, 'review is', 'reviews are')} in on ${round.toLowerCase()}` +
          (ev.steppedThisRound > 0
            ? `, and ${plural(ev.steppedThisRound, 'reader', 'readers')} stepped aside`
            : '') +
          '. Words and weights can still change; lines stay until the next round opens.'
      )}</div>`;

  const weightNote =
    ev.scoredThisRound > 0
      ? '<p class="hint" style="margin-bottom:14px">Changing what a line counts for changes every ' +
        'average drawn from the marks already given, including the ones on screens somebody is ' +
        'reading right now.</p>'
      : '';

  return (
    `<div class="sec" id="${ANCHOR.scorecard}">` +
    '<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">' +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The scorecard</h3>' +
    `<span class="t-sub" style="margin-left:auto">${esc(round)}` +
    `<span class="sep">·</span>${esc(plural(ev.scorecard.length, 'line', 'lines'))}</span>` +
    '</div>' +
    '<p class="hint" style="margin-bottom:14px">What every reader is asked about a proposal. ' +
    'Renaming a line never moves a mark already given.</p>' +
    saidIn('scorecard', said) +
    standing +
    weightNote +
    `<form method="post" action="/admin/${encodeURIComponent(ev.slug)}/settings/scorecard">` +
    // Enter inside a field must save, never move or remove a line: the browser
    // presses the first submit button in the form, so this is it.
    '<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>' +
    `<input type="hidden" name="c:count" value="${esc(String(ev.scorecard.length))}">` +
    `<input type="hidden" name="round" value="${esc(String(ev.currentRound))}">` +
    `<input type="hidden" name="seen" value="${esc(ev.scorecardRaw)}">` +
    cards +
    (ev.scorecard.length < MOST_CRITERIA
      ? addCriterionCard()
      : `<p class="hint">A scorecard holds ${esc(num(MOST_CRITERIA))} lines at the most. ` +
        'Take one off before adding another.</p>') +
    '<div class="btnrow" style="margin-top:16px">' +
    '<button class="btn btn-primary" type="submit">Save the scorecard</button>' +
    `<a class="btn" href="/admin/${encodeURIComponent(ev.slug)}/reviews">See the reading room</a></div>` +
    '<p class="hint">Moving a line saves the rest of your changes with it.</p>' +
    '</form></div>'
  );
}

/* ------------------------------------------------------------------ *
 * 3 — the team (D-026)
 * ------------------------------------------------------------------ */

function teamSection(
  ev: EventSettings,
  said: Said | null,
  confirmOff: string | null,
  /** The way in for somebody the last press made an account for. */
  invite: { link: string; emailed: boolean } | null
): string {
  const settings = `/admin/${encodeURIComponent(ev.slug)}/settings`;

  const rows = ev.team
    .map((m) => {
      const standing = ev.mayTouchTeam
        ? `<form method="post" action="${settings}/team/standing" style="display:flex;gap:8px;align-items:center">` +
          `<input type="hidden" name="who" value="${esc(m.personId)}">` +
          standingSelect('role', m.role, `What ${m.name} may do`) +
          '<button class="btn btn-sm" type="submit">Save</button></form>' +
          // Own-standing warning: lowering yourself out of the owners takes
          // this page with it, and only somebody else can hand it back.
          (m.isYou
            ? '<div class="hint">Changing your own standing can take this page away from you.</div>'
            : '')
        : esc(word(m.role));

      const off = ev.mayTouchTeam
        ? `<a class="btn btn-sm btn-danger" href="${settings}?confirm=off&amp;who=${encodeURIComponent(m.personId)}#${ANCHOR.team}">Take them off</a>`
        : '';

      const row =
        '<tr>' +
        `<td><div class="t-name">${esc(m.name)}${m.isYou ? ' <span class="t-sub">(you)</span>' : ''}</div>` +
        `<div class="t-sub">${esc(m.email ?? 'No address on file')}</div></td>` +
        `<td>${standing}</td>` +
        `<td class="t-sub">Since ${esc(instantYearOf(m.grantedAt, ev.timezone))}</td>` +
        `<td style="text-align:right">${off}</td>` +
        '</tr>';

      if (confirmOff !== m.personId) return row;

      // Second pass. The person is carried in the form; the batch checks the
      // row still exists and that this is not the last owner.
      return (
        row +
        '<tr><td colspan="4">' +
        '<div class="notebox" style="border-left-color:var(--danger)">' +
        `<b>Take ${esc(m.name)} off ${esc(ev.name)}?</b>` +
        `<p style="margin:6px 0 0">${esc(
          m.isYou
            ? 'You lose this conference the moment you press it — proposals, speakers, phone numbers, all of it. Somebody else with a standing here would have to put you back.'
            : `They lose this conference the moment you press it — proposals, speakers, phone numbers, all of it. Their ${word(m.role).toLowerCase()} standing goes with it.`
        )}</p>` +
        `<form method="post" action="${settings}/team/off" class="btnrow" style="margin-top:12px">` +
        `<input type="hidden" name="who" value="${esc(m.personId)}">` +
        `<button class="btn btn-danger" type="submit">Take ${esc(m.name)} off</button>` +
        `<a class="btn btn-quiet" href="${settings}#${ANCHOR.team}">Leave it</a>` +
        '</form></div></td></tr>'
      );
    })
    .join('');

  const table =
    '<div class="tablewrap" style="margin-top:10px"><table class="t">' +
    '<thead><tr><th>Who</th><th>What they may do</th><th>Since</th><th></th></tr></thead>' +
    `<tbody>${rows}</tbody></table></div>`;

  const empty =
    '<div class="state-out">' +
    '<p>Nobody holds a standing on this conference yet — you are here because you run Fireside itself.</p>' +
    '<p class="hint">Add the person who runs the program, make them the owner, and the list stops depending on you.</p>' +
    '</div>';

  const powers =
    '<p class="hint" style="margin-top:12px">' +
    EVENT_ROLES.map((r) => `<b>${esc(word(r))}</b> — ${esc(STANDING_POWER[r])}`).join('<br>') +
    '</p>';

  const add = ev.mayTouchTeam
    ? `<form method="post" action="${settings}/team/add" class="card card-pad" style="max-width:46em;margin-top:18px">` +
      '<h4 class="serif" style="font-size:18px;font-weight:600;margin-bottom:12px">Add somebody</h4>' +
      field({
        name: 'email',
        labelText: 'The address they sign in with',
        value: '',
        type: 'email',
        placeholder: 'name@example.org',
        anchored: true,
        wrong: saidAt('email', said),
        hint: 'If nobody signs in with it yet, this makes their account and hands you a sign-in link for them.',
      }) +
      field({
        name: 'name',
        labelText: 'Their name',
        value: '',
        optional: true,
        placeholder: 'Sam Okonkwo',
        hint: 'Only used if the account is new. Leave it blank and the address stands in until they change it.',
      }) +
      `<label class="f"><span class="f-lab">What they may do</span>${standingSelect('role', 'viewer', 'What they may do')}</label>` +
      '<div class="btnrow"><button class="btn btn-primary" type="submit">Add them</button></div>' +
      '</form>'
    : '<p class="hint" style="margin-top:12px">Only an owner changes who is on this list.</p>';

  // A new account has no password and no history, so the link is the whole of
  // their way in. It is shown here whether or not it also went by email: an
  // address that cannot receive mail would otherwise be an invitation to
  // nowhere.
  const way =
    invite === null
      ? ''
      : '<div class="card card-pad" style="max-width:46em;margin-bottom:14px">' +
        '<label class="f" style="margin-bottom:0"><span class="f-lab">Their sign-in link</span>' +
        `<input type="text" readonly value="${esc(invite.link)}">` +
        `<span class="hint">${esc(
          (invite.emailed ? 'Sent to them as well. ' : 'Pass it on however you reach them. ') +
            'It works for the next two hours, and after that they can ask for a fresh one from the sign-in page.'
        )}</span></label></div>`;

  return (
    `<div class="sec" id="${ANCHOR.team}">` +
    '<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">' +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The team</h3>' +
    `<span class="t-sub" style="margin-left:auto">${esc(plural(ev.teamCount, 'person', 'people'))}` +
    `<span class="sep">·</span>${esc(plural(ev.ownerCount, 'owner', 'owners'))}</span>` +
    '</div>' +
    '<p class="hint" style="margin-bottom:14px">Everybody here signs in as themselves. A conference always keeps at least one owner.</p>' +
    saidIn('team', said) +
    way +
    (ev.teamCount === 0 ? empty : table) +
    powers +
    add +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * 4 — the green room link (R-4)
 * ------------------------------------------------------------------ */

function linkSection(ev: EventSettings, said: Said | null, origin: string, confirmLink: boolean): string {
  const settings = `/admin/${encodeURIComponent(ev.slug)}/settings`;
  const held = ev.greenRoomNonce;

  const body =
    held === null
      ? '<p class="sub" style="margin:6px 0 14px">There is no link yet, so nobody outside this list can see the run of show.</p>' +
        `<form method="post" action="${settings}/green-room-link" class="btnrow">` +
        '<input type="hidden" name="seen" value="">' +
        '<button class="btn btn-primary" type="submit">Make the link</button></form>'
      : '<p class="sub" style="margin:6px 0 14px">Anybody holding this sees the day, the rooms, who is on next and the speakers’ phone numbers. No sign-in, on purpose — a volunteer should never hold yours.</p>' +
        '<label class="f"><span class="f-lab">The link</span>' +
        `<input type="text" readonly value="${esc(`${origin}/gr/${held}`)}">` +
        '<span class="hint">Send it to the crew the morning of. It works until you rotate it.</span></label>' +
        (confirmLink
          ? '<div class="notebox" style="border-left-color:var(--danger)">' +
            '<b>Rotate the link — everyone holding the old one loses it.</b>' +
            '<p style="margin:6px 0 0">Volunteers, stage managers, the booth. The new one works the moment you press this and the old one stops the same moment, so somebody has to send the new one round.</p>' +
            `<form method="post" action="${settings}/green-room-link" class="btnrow" style="margin-top:12px">` +
            `<input type="hidden" name="seen" value="${esc(held)}">` +
            '<button class="btn btn-danger" type="submit">Rotate the link</button>' +
            `<a class="btn btn-quiet" href="${settings}#${ANCHOR.link}">Leave it alone</a>` +
            '</form></div>'
          : '<div class="btnrow">' +
            `<a class="btn btn-danger" href="${settings}?confirm=link#${ANCHOR.link}">Rotate the link</a>` +
            `<a class="btn" href="/admin/${encodeURIComponent(ev.slug)}/green-room">Open the run of show</a>` +
            '</div>');

  return (
    `<div class="sec card card-pad" style="max-width:46em" id="${ANCHOR.link}">` +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The green room link</h3>' +
    saidIn('link', said) +
    body +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

function settingsPage(o: {
  ev: EventSettings;
  principal: Principal;
  said: Said | null;
  confirm: string | null;
  who: string | null;
  invite: { link: string; emailed: boolean } | null;
  origin: string;
  nowMs: number;
}): string {
  const { ev } = o;
  const confirmOff = o.confirm === 'off' && o.who ? o.who : null;

  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Settings</h1>' +
    `<p class="counts">${esc(ev.name)}<span class="sep">·</span>${esc(datesOf(ev))}` +
    `<span class="sep">·</span>${esc(ev.tzLabel ?? ev.timezone)}</p></div>` +
    eventSection(ev, o.said, o.nowMs) +
    roomsTracksSection(ev, o.said) +
    questionsSection(ev, o.said) +
    scorecardSection(ev, o.said) +
    teamSection(ev, o.said, confirmOff, o.invite) +
    linkSection(ev, o.said, o.origin, o.confirm === 'link');

  return page({
    title: `Settings · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: ev.slug,
      eventName: ev.name,
      here: '/settings',
      who: `${o.principal.name} · ${word(ev.standing)}`,
      whoInitials: initialsOf(o.principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** Back to the screen, landed on the thing the sentence is about: the field
 *  when the outcome names one, otherwise the section it belongs to. */
const back = (slug: string, said: Said): string => {
  const out = SAID[said];
  const at = out.field !== undefined ? `f-${out.field}` : ANCHOR[out.where];
  return `/admin/${encodeURIComponent(slug)}/settings?note=${encodeURIComponent(said)}#${at}`;
};

export function registerSettings(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/settings', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    let ev: EventSettings | null;
    try {
      // eventSettings reads behind EDIT_ROLES, which no reviewer holds, so a
      // reviewer arrives at the same refusal as somebody with no standing.
      ev = await eventSettings(c.env.DB, principal, c.req.param('eventSlug'));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
    if (!ev) return c.notFound();

    const note = c.req.query('note') ?? '';
    // The link this screen wrote itself one redirect ago, and nothing else:
    // anything not addressed at this origin is somebody else's idea.
    const key = c.req.query('key') ?? '';
    const origin = new URL(c.req.url).origin;
    const invite =
      note === 'team_invited' && key.startsWith(`${origin}/sign-in/magic?t=`)
        ? { link: key, emailed: c.req.query('sent') === '1' }
        : null;

    // These screens hold email addresses and a link that needs no sign-in.
    c.header('cache-control', 'private, no-store');
    return c.html(
      settingsPage({
        ev,
        principal,
        said: isSaid(note) ? note : null,
        confirm: c.req.query('confirm') ?? null,
        who: c.req.query('who') ?? null,
        invite,
        origin,
        nowMs: Date.now(),
      })
    );
  });

  /** Every write: signed in, a real conference, then the workflow's own scope check. */
  async function write(
    c: Context<{ Bindings: Env }>,
    run: (principal: Principal, eventId: string, body: Record<string, string | File>) => Promise<Said>,
    /** Somewhere other than this screen to land, when this screen is now shut. */
    landing?: (said: Said, principal: Principal, body: Record<string, string | File>) => string | null
  ): Promise<Response> {
    const slug = c.req.param('eventSlug') ?? '';
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const eventId = await eventIdBySlug(c.env.DB, slug);
    if (!eventId) return c.notFound();
    // A reviewer holds the reading room and nothing else. Every workflow below
    // asks for EDIT_ROLES or TEAM_ROLES and would refuse anyway; saying it here
    // keeps the wall standing whichever way those sets move.
    if (reviewerOnly(principal, eventId)) return c.html(deniedPage(), 403);
    const body = await c.req.parseBody();
    try {
      const said = await run(principal, eventId, body);
      return c.redirect(landing?.(said, principal, body) ?? back(slug, said), 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  }

  const reader = (body: Record<string, string | File>) => ({
    text: (k: string): string => {
      const v = body[k];
      return typeof v === 'string' ? v : '';
    },
    on: (k: string): boolean => body[k] !== undefined,
  });

  app.post('/admin/:eventSlug/settings/event', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return saveEventFacts(c.env.DB, principal, eventId, {
        name: text('name'),
        tagline: text('tagline'),
        venueName: text('venue'),
        venueAddress: text('address'),
        cfpIntro: text('intro'),
        decideBy: text('decide_by'),
        maxSubmissions: text('cap'),
        callOpensOn: text('call_opens'),
        callClosesOn: text('call_closes'),
        autoReminders: body['reminders'] === 'on',
      });
    })
  );

  app.post('/admin/:eventSlug/settings/questions', (c) =>
    write(c, (principal, eventId, body) => {
      const { text, on } = reader(body);
      const count = Math.min(Math.max(0, Math.floor(Number(text('q:count')) || 0)), 60);
      const drafts: QuestionDraft[] = [];
      for (let i = 0; i < count; i++) {
        drafts.push({
          id: text(`q:${i}:id`),
          label: text(`q:${i}:label`),
          hint: text(`q:${i}:hint`),
          kind: text(`q:${i}:kind`),
          required: on(`q:${i}:required`),
          options: text(`q:${i}:options`).split('\n'),
          when: text(`q:${i}:when`),
          is: text(`q:${i}:is`),
          off: on(`q:${i}:off`),
        });
      }

      // Move up / move down are submits on the same form, so a move carries
      // every pending edit with it — one press, one saved order.
      const move = /^(up|down):(\d+)$/.exec(text('move'));
      if (move) {
        const i = Number(move[2]);
        const j = move[1] === 'up' ? i - 1 : i + 1;
        const a = drafts[i];
        const b = drafts[j];
        if (a && b) {
          drafts[i] = b;
          drafts[j] = a;
        }
      }

      drafts.push({
        id: '',
        label: text('new:label'),
        hint: text('new:hint'),
        kind: text('new:kind'),
        required: on('new:required'),
        options: text('new:options').split('\n'),
        when: '',
        is: '',
        off: false,
      });

      return saveQuestions(c.env.DB, principal, eventId, text('seen'), drafts);
    })
  );

  app.post('/admin/:eventSlug/settings/scorecard', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      const count = Math.min(Math.max(0, Math.floor(Number(text('c:count')) || 0)), MOST_CRITERIA);
      const drafts: CriterionDraft[] = [];
      for (let i = 0; i < count; i++) {
        drafts.push({
          key: text(`c:${i}:key`),
          label: text(`c:${i}:label`),
          kind: text(`c:${i}:kind`),
          options: text(`c:${i}:options`).split('\n'),
          weight: text(`c:${i}:weight`),
        });
      }

      // Move up / move down are submits on the same form, exactly as they are
      // for the questions — so a move carries every pending edit with it.
      const move = /^(up|down):(\d+)$/.exec(text('move'));
      if (move) {
        const i = Number(move[2]);
        const j = move[1] === 'up' ? i - 1 : i + 1;
        const a = drafts[i];
        const b = drafts[j];
        if (a && b) {
          drafts[i] = b;
          drafts[j] = a;
        }
      }

      drafts.push({
        key: '',
        label: text('new:label'),
        kind: text('new:kind'),
        options: text('new:options').split('\n'),
        weight: text('new:weight') || '2',
      });

      const round = Math.floor(Number(text('round')) || 0);
      return saveScorecard(
        c.env.DB,
        principal,
        eventId,
        round,
        text('seen'),
        drafts,
        text('remove')
      );
    })
  );

  // Adding somebody who has never signed in makes their account, so this one
  // write has a second half: they need a door. The link is minted here, sent
  // where mail can reach, and handed back on the screen either way — an
  // invitation nobody can act on is not an invitation.
  app.post('/admin/:eventSlug/settings/team/add', (c) => {
    let landed: string | null = null;
    return write(
      c,
      async (principal, eventId, body) => {
        const { text } = reader(body);
        const res = await addToTeam(
          c.env.DB,
          principal,
          eventId,
          text('email'),
          text('name'),
          text('role')
        );
        if (res.invited === null) return res.said;

        const origin = new URL(c.req.url).origin;
        const link = await makeMagicLink(c.env.SESSION_SECRET, origin, res.invited.personId);
        let emailed = false;
        if (isRealAddress(res.invited.email)) {
          // Mail that will not go is not a reason to lose the person who was
          // just added: the link comes back on the screen either way, and the
          // sentence beside it only claims a send that happened.
          try {
            await c.env.EMAIL.send({
              to: res.invited.email,
              from: { email: c.env.FROM_EMAIL, name: 'Fireside' },
              subject: 'Your sign-in link',
              text:
                `Hello ${res.invited.name},\n\n${principal.name} has put you on the team for a ` +
                `conference on Fireside. Here is your sign-in link:\n\n${link}\n\n` +
                'It works for the next two hours. Ask for a fresh one from the sign-in page any time after that.',
            });
            emailed = true;
          } catch {
            emailed = false;
          }
        }
        landed =
          `/admin/${encodeURIComponent(c.req.param('eventSlug') ?? '')}/settings` +
          `?note=${encodeURIComponent(res.said)}&key=${encodeURIComponent(link)}` +
          (emailed ? '&sent=1' : '') +
          `#${ANCHOR.team}`;
        return res.said;
      },
      () => landed
    );
  });

  app.post('/admin/:eventSlug/settings/team/standing', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return changeStanding(c.env.DB, principal, eventId, text('who'), text('role'));
    })
  );

  app.post('/admin/:eventSlug/settings/team/off', (c) =>
    write(
      c,
      (principal, eventId, body) => {
        const { text } = reader(body);
        return takeOffTeam(c.env.DB, principal, eventId, text('who'));
      },
      // Somebody who has just taken themselves off has no screen to come back
      // to, so they land on their own list of conferences rather than a refusal.
      (said, principal, body) =>
        said === 'team_removed' && body['who'] === principal.personId ? '/admin' : null
    )
  );

  app.post('/admin/:eventSlug/settings/green-room-link', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return newGreenRoomLink(c.env.DB, principal, eventId, text('seen'));
    })
  );

  app.post('/admin/:eventSlug/settings/rooms/add', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return addRoom(c.env.DB, principal, eventId, text('name'));
    })
  );

  app.post('/admin/:eventSlug/settings/rooms/rename', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return renameRoom(c.env.DB, principal, eventId, text('id'), text('name'));
    })
  );

  app.post('/admin/:eventSlug/settings/tracks/add', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return addTrack(c.env.DB, principal, eventId, text('name'));
    })
  );

  app.post('/admin/:eventSlug/settings/tracks/rename', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return renameTrack(c.env.DB, principal, eventId, text('id'), text('name'));
    })
  );
}
