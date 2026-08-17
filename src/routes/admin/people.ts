// People — S-16. The backstage CRM face: everyone who has ever proposed at
// this event, one row per person, and one door deep a whole file on them —
// contact facts, what they're proposing here, what they owe, and where else
// they've spoken with us.
//
// One door deep it also asks. An ask is one click, because it is small, it is
// only on their list until they look at it, and it can be taken straight back
// from the same card it was made on (D-024). The write itself lives in
// workflows/tasks.ts — this file never re-derives who may ask or what an ask
// has to have on it.
//
// Persona pass: the judge checking whether the CRM story is real (a person
// carries a real history, not one row behind one proposal) — and Naomi,
// remembering who withdrew kindly last year, before she asks them back.
// Register: Backstage — plain speech, counts, working labels, dense but
// calm, sentence case, zero exclamation marks, zero emoji.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, type LabelKey } from '../../lib/labels';
import { principalFromCookie, type Principal } from '../../workflows/account';
import {
  adminEvents,
  requireScope,
  EDIT_ROLES,
  ScopeError,
  type AdminEvent,
  type SubmissionState,
} from '../../queries/admin';
import { eventBySlug, initialsOf, eventDayKey } from '../../queries/public';
import { reviewerOnly } from '../../queries/settings';
import {
  peopleList,
  personDetail,
  type PeopleList,
  type PersonListRow,
  type PersonDetail,
  type PersonProposal,
  type PersonTask,
  type PersonElsewhere,
} from '../../queries/people';
import { cancelTask, createTask, TASK_KINDS } from '../../workflows/tasks';
import { rosterOnlyPeople } from '../../queries/crm';
import { setLogisticsForEvent } from '../../workflows/crm';
import {
  parseSpeakersCsv,
  previewImportRows,
  writeImportedRows,
  MAX_CSV_BYTES,
  CSV_ACCEPT,
  type ParsedCsvRow,
  type PreviewRow,
} from '../../workflows/import';
import { filePart, tooLargeToRead, PHOTO_ACCEPT, PHOTO_LINE, PHOTO_MAX_BYTES } from '../../workflows/files';
import {
  createSpeaker,
  updateSpeaker,
  uploadSpeakerHeadshot,
  editTask,
  type PersonFields,
} from '../../workflows/people-admin';

/* ------------------------------------------------------------------ *
 * Shared small bits.
 * ------------------------------------------------------------------ */

const STATE_LABEL_KEY: Record<SubmissionState, LabelKey> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};

// A cancelled proposal is not a good outcome for the person even though its
// pile bucket is "accepted" (01 inv. 2) — it reads as a warning here, not a
// green chip, because it is the one state that means "was going to happen,
// then didn't."
const STATE_CHIP_CLASS: Record<SubmissionState, string> = {
  draft: 's-draft',
  submitted: 's-undecided',
  accepted: 's-accepted',
  waitlisted: 's-maybe',
  rejected: 's-declined',
  withdrawn: 's-withdrawn',
  cancelled: 'warn',
};

const ROLE_DISPLAY: Record<string, string> = {
  organizer: 'Organizer',
  owner: 'Owner',
  approver: 'Approver',
  editor: 'Editor',
  viewer: 'Viewer',
};

function whoLine(event: AdminEvent, principal: Principal): { who: string; whoInitials: string } {
  const standing = ROLE_DISPLAY[event.standing] ?? event.standing;
  return { who: `${principal.name} · ${standing}`, whoInitials: initialsOf(principal.name) };
}

const num = (n: number): string => n.toLocaleString('en-US');

/** What she calls them out loud. One word, the one on the front of their name. */
const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const manyOf = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.map((x) => (typeof x === 'string' ? x : '')).filter((x, i, self) => self.indexOf(x) === i);
};

/** Roster-only rows (no proposal yet, only a place on the list) rendered
 *  through the same PersonListRow shape the search-based rows already use —
 *  their "proposals" column is honestly empty rather than a second table. */
function rosterOnlyAsListRow(r: {
  personId: string;
  name: string;
  jobTitle: string | null;
  organisation: string | null;
  openTaskCount: number;
}): PersonListRow {
  return {
    personId: r.personId,
    name: r.name,
    stage: null,
    jobTitle: r.jobTitle,
    organisation: r.organisation,
    proposals: [],
    openTaskCount: r.openTaskCount,
  };
}

/* ------------------------------------------------------------------ *
 * What just happened. One closed set of codes in the query string, one
 * sentence each here — free text never travels through a URL.
 * ------------------------------------------------------------------ */

const OUTCOMES: Record<string, string> = {
  asked: 'Asked. It is on their portal now.',
  withdrawn: 'Withdrawn. It is off their list, and they can see that it was.',
  'not-here':
    'An ask has to go to somebody on this conference, about something of theirs. Nothing was asked.',
  'no-title': 'An ask needs a short line saying what you are asking for.',
  'no-kind': 'Say what kind of ask it is, so they know what to send back.',
  'bad-date': 'That is not a day anyone has. Give the date again and it goes on their list.',
  gone: 'That one was already off their list. Nothing changed.',
  trouble: 'That did not go through, and nothing changed. Worth trying once more.',
  saved: 'Saved.',
  'not-found': 'That record could not be found. Nothing changed.',
  // creating or editing a speaker's own file
  created: 'Added. Their file is open below.',
  'no-name': 'A name is needed.',
  'no-email': 'An email address is needed, so they have somewhere to be reached.',
  taken: 'Somebody here already has that email address.',
  // a photograph
  'photo-done': 'The photograph is saved. It shows wherever this person appears backstage.',
  'photo-nothing': 'Choose a photograph first.',
  'photo-wrong-kind': 'That is not a JPEG, PNG or WebP — try one of those.',
  'photo-too-big': 'That photograph is bigger than this takes — keep it under 2 MB.',
  'photo-moved': 'That record moved while you were looking. Nothing changed.',
  // editing an existing ask
  'task-bad-date': 'That is not a day anyone has. Give the date again and it saves.',
};

function outcomeNote(code: string | undefined): string {
  const text = code ? OUTCOMES[code] : undefined;
  if (!text) return '';
  return noteBox(text);
}

/** The same box, for a sentence this file built from validated counts rather
 *  than looked up from the OUTCOMES closed set — the import summary's own
 *  numbers, the same way outbox.ts's sentSentence() builds its own from
 *  ?sent=/?emailed= rather than echoing anything free-form from the URL. */
function noteBox(text: string): string {
  return (
    '<div class="notebox" style="margin-top:18px" role="status">' +
    `<p style="margin:0" class="serif">${esc(text)}</p></div>`
  );
}

/** The headshot placeholder: initials in a plain circle, no image request. */
function avatar(initials: string, name: string, size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    '<circle cx="20" cy="20" r="20" fill="var(--paper-deep)"/>' +
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="var(--serif)" ' +
    `font-weight="600" font-size="14" fill="var(--ink-soft)">${esc(initials)}</text></svg>`
  );
}

/** The speaker's own photograph, wherever they have sent one in — a
 *  headshot uploaded through the portal (person.headshot_file_id, served at
 *  /files/:id) was previously invisible on this side. Same circle, same
 *  size as avatar() above, so the page does not jump the moment one arrives. */
function face(initials: string, name: string, headshotFileId: string | null, size: number): string {
  if (!headshotFileId) return avatar(initials, name, size);
  return (
    `<img class="av" src="/files/${esc(headshotFileId)}" alt="${esc(name)}" ` +
    `width="${size}" height="${size}" ` +
    `style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;` +
    'border:1px solid rgba(34,30,23,.12);flex:none">'
  );
}

/** Headshots for a page's worth of rows, one batched read keyed by the same
 *  ids the roster is about to print. Chunked the way queries/crm.ts's own
 *  ID_CHUNK keeps a bound IN-list under D1's per-statement parameter cap. */
async function headshotsFor(db: D1Database, personIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return out;
  const CHUNK = 90;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const ph = part.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT id, headshot_file_id FROM person WHERE id IN (${ph}) AND headshot_file_id IS NOT NULL`)
      .bind(...part)
      .all<{ id: string; headshot_file_id: string }>();
    for (const r of res.results) out.set(r.id, r.headshot_file_id);
  }
  return out;
}

function stateChip(state: SubmissionState): string {
  return `<span class="chip ${STATE_CHIP_CLASS[state]}">${esc(label(STATE_LABEL_KEY[state], 'backstage'))}</span>`;
}

/* ------------------------------------------------------------------ *
 * The list — GET /admin/:eventSlug/people
 * ------------------------------------------------------------------ */

/** Rows drawn at once. The counts above them are always the whole truth — the
 *  roster runs to four figures at a real conference and a page that draws every
 *  one of them is a page nobody can read. Search reaches the rest. */
const ROOM = 120;

/** The "owe you something" toggle's own address: the search carries over,
 *  and asking again just flips the one flag rather than losing it. */
function oweHref(slug: string, q: string | null, oweActive: boolean): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (!oweActive) params.set('owe', '1');
  const qs = params.toString();
  return `/admin/${esc(slug)}/people${qs ? `?${qs}` : ''}`;
}

function countsLine(
  slug: string,
  q: string | null,
  shown: number,
  owing: number,
  oweActive: boolean,
  eventName: string
): string {
  const peopleNoun = shown === 1 ? '1 speaker' : `${num(shown)} speakers`;
  const oweWord = owing > 0 ? `${num(owing)} owe you something` : 'nobody is waiting on anything';
  const owe =
    owing > 0
      ? `<a class="link" href="${oweHref(slug, q, oweActive)}">${esc(
          oweActive ? 'showing who owes you — see everyone' : oweWord
        )}</a>`
      : esc(oweWord);
  return `<p class="counts"><b>${esc(peopleNoun)}</b><span class="sep">·</span>${owe}<span class="sep">·</span>${esc(eventName)}</p>`;
}

function searchForm(slug: string, q: string | null): string {
  return (
    '<form method="get" class="searchbar">' +
    `<input type="text" name="q" placeholder="Search names and organisations" value="${esc(q ?? '')}">` +
    '<button class="btn btn-sm" type="submit">Search</button>' +
    (q ? `<a class="link" href="/admin/${esc(slug)}/people">Clear</a>` : '') +
    '</form>'
  );
}

function taskCountText(n: number): string {
  return n === 1 ? '1 open task' : `${num(n)} open tasks`;
}

function proposalChips(proposals: PersonProposal[]): string {
  if (!proposals.length) return '<span class="t-sub">Nothing here</span>';
  return proposals.map((p) => stateChip(p.state)).join(' ');
}

function personRow(slug: string, r: PersonListRow, headshots: Map<string, string>): string {
  const role = [r.jobTitle, r.organisation].filter((v): v is string => Boolean(v)).map((v) => esc(v)).join(' · ');
  const owe =
    r.openTaskCount > 0
      ? `<span style="color:var(--ink-soft)">${esc(taskCountText(r.openTaskCount))}</span>`
      : '<span class="t-sub">Nothing outstanding</span>';
  return (
    '<tr>' +
    '<td><div style="display:flex;gap:11px;align-items:center">' +
    `<span class="avwrap">${face(initialsOf(r.name), r.name, headshots.get(r.personId) ?? null, 34)}</span>` +
    `<span style="min-width:0"><span class="t-name">${esc(r.name)}</span>` +
    (role ? `<br><span class="t-sub">${role}</span>` : '') +
    '</span></div></td>' +
    `<td>${proposalChips(r.proposals)}</td>` +
    `<td>${owe}</td>` +
    `<td>${r.stage ? `<span class="chip">${esc(r.stage)}</span>` : '<span class="sub">—</span>'}</td>` +
    `<td style="text-align:right;white-space:nowrap"><a class="btn btn-sm" href="/admin/${esc(slug)}/people/${esc(r.personId)}">Open</a></td>` +
    '</tr>'
  );
}

function peopleTable(slug: string, rows: PersonListRow[], headshots: Map<string, string>): string {
  return (
    '<div class="tablewrap" style="margin-top:6px"><table class="t"><thead><tr>' +
    '<th>Speaker</th><th>Proposals here</th><th>Open tasks</th><th>Pipeline</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((r) => personRow(slug, r, headshots)).join('') +
    '</tbody></table></div>'
  );
}

function emptyPeople(event: AdminEvent, canAdd: boolean): string {
  const addLine = canAdd
    ? ` <a class="link" href="/admin/${esc(event.slug)}/people/new">Add one by hand →</a>`
    : '';
  return (
    '<div style="padding:26px 0"><h1 class="display">People</h1></div>' +
    '<div class="state-out"><h2>Nobody yet.</h2>' +
    `<p>Speakers appear here as proposals arrive, or as you bring a list in below.${addLine}</p>` +
    `<a class="btn btn-primary" href="/${esc(event.slug)}/cfp">See the call for speakers →</a></div>`
  );
}

function noSearchResults(slug: string, q: string): string {
  return (
    '<div class="state-out"><h2>Nothing found.</h2>' +
    `<p>Nobody matches “${esc(q)}” yet.</p>` +
    `<a class="btn btn-primary" href="/admin/${esc(slug)}/people">See everyone →</a></div>`
  );
}

function noOweMatches(slug: string): string {
  return (
    '<div class="state-out"><h2>Nobody owes you anything.</h2>' +
    `<a class="btn btn-primary" href="/admin/${esc(slug)}/people">See everyone →</a></div>`
  );
}

/* ------------------------------------------------------------------ *
 * Bringing in a list — SPK-03. The control lives on this page; what it
 * does is workflows/import.ts's own act, in two passes so nothing lands
 * silently: read the file, then confirm what it read.
 * ------------------------------------------------------------------ */

function importCard(slug: string): string {
  return (
    '<div class="card card-pad" style="margin-top:22px;max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:4px">Bring in a list</h2>' +
    '<p class="sub" style="margin-bottom:14px">A CSV with name, email, job title, company and bio columns. ' +
    'Anyone already here by email is left as they are — only what was blank gets filled in.</p>' +
    `<form method="post" action="/admin/${esc(slug)}/people/import" enctype="multipart/form-data" ` +
    'style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    `<input type="file" name="csv" accept="${esc(CSV_ACCEPT)}" required>` +
    '<button class="btn btn-sm" type="submit">Read the file</button>' +
    '</form></div>'
  );
}

function importedNote(imported: number, matched: number, skipped: number): string {
  const parts: string[] = [];
  if (imported > 0) parts.push(`${num(imported)} new`);
  if (matched > 0) parts.push(`${num(matched)} already here`);
  if (skipped > 0) parts.push(`${num(skipped)} skipped`);
  return parts.length ? `Brought the list in — ${parts.join(', ')}.` : 'Nothing usable was in that file.';
}

const DISPOSITION_WORD: Record<PreviewRow['disposition'], string> = {
  new: 'New',
  existing: 'Already here',
  invalid: 'Needs a name and an email',
};
const DISPOSITION_CHIP: Record<PreviewRow['disposition'], string> = {
  new: 's-accepted',
  existing: 's-undecided',
  invalid: 'warn',
};

function previewRow(i: number, r: PreviewRow): string {
  const chip = `<span class="chip ${DISPOSITION_CHIP[r.disposition]}">${esc(DISPOSITION_WORD[r.disposition])}</span>`;
  if (r.disposition === 'invalid') {
    return (
      '<tr><td></td>' +
      `<td>${esc(r.name || '—')}</td><td>${esc(r.email || '—')}</td>` +
      `<td>${chip}<div class="t-sub">${esc(r.invalid ?? '')}</div></td></tr>`
    );
  }
  return (
    '<tr>' +
    `<td><input type="checkbox" name="keep" value="${i}" checked></td>` +
    `<td>${esc(r.name)}` +
    `<input type="hidden" name="r${i}_name" value="${esc(r.name)}">` +
    `<input type="hidden" name="r${i}_email" value="${esc(r.email)}">` +
    `<input type="hidden" name="r${i}_job" value="${esc(r.jobTitle ?? '')}">` +
    `<input type="hidden" name="r${i}_org" value="${esc(r.organisation ?? '')}">` +
    `<input type="hidden" name="r${i}_bio" value="${esc(r.bio ?? '')}"></td>` +
    `<td>${esc(r.email)}</td>` +
    `<td>${chip}</td></tr>`
  );
}

function importPreviewPage(event: AdminEvent, principal: Principal, rows: PreviewRow[]): string {
  const { who, whoInitials } = whoLine(event, principal);
  const usable = rows.filter((r) => r.disposition !== 'invalid').length;
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Check the list before it lands</h1>' +
    `<p class="counts">${esc(num(usable))} of ${esc(num(rows.length))} rows are usable — untick any you do not want.</p></div>` +
    `<form method="post" action="/admin/${esc(event.slug)}/people/import/confirm" style="margin-top:16px">` +
    `<input type="hidden" name="count" value="${rows.length}">` +
    '<div class="tablewrap"><table class="t"><thead><tr>' +
    '<th></th><th>Name</th><th>Email</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((r, i) => previewRow(i, r)).join('') +
    '</tbody></table></div>' +
    '<div class="btnrow" style="margin-top:16px">' +
    `<button class="btn btn-primary" type="submit">Bring ${esc(String(usable))} in</button>` +
    `<a class="btn" href="/admin/${esc(event.slug)}/people">Not yet</a></div>` +
    '</form>';
  return page({
    title: `Check the list · ${event.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: event.slug,
      eventName: event.name,
      here: '/people',
      who,
      whoInitials,
      tzLabel: event.tzLabel ?? event.timezone,
      body,
    }),
  });
}

/** The roster is longer than the page. Say so in the same breath as the way
 *  through it, and say it under the rows, where the reader runs out. */
function moreLine(total: number, shown: number): string {
  if (shown >= total) return '';
  return (
    `<p class="sub" style="margin-top:12px">Showing ${esc(num(shown))} of ${esc(num(total))} — ` +
    'search a name or an organisation to find the rest.</p>'
  );
}

function peopleBody(
  event: AdminEvent,
  list: PeopleList,
  rows: PersonListRow[],
  owing: number,
  oweActive: boolean,
  note: string,
  headshots: Map<string, string>,
  canAdd: boolean
): string {
  const addBtn = canAdd
    ? `<a class="btn btn-sm" href="/admin/${esc(event.slug)}/people/new">Add a speaker</a>`
    : '';
  const head =
    '<div style="padding:26px 0 0">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">' +
    '<h1 class="display">People</h1>' +
    addBtn +
    '</div>' +
    countsLine(event.slug, list.search, rows.length, owing, oweActive, event.name) +
    '</div>' +
    (note ? noteBox(note) : '') +
    searchForm(event.slug, list.search);
  if (rows.length === 0) {
    return head + (oweActive ? noOweMatches(event.slug) : noSearchResults(event.slug, list.search ?? ''));
  }
  const shown = rows.slice(0, ROOM);
  return head + peopleTable(event.slug, shown, headshots) + moreLine(rows.length, shown.length);
}

function peoplePage(
  event: AdminEvent,
  principal: Principal,
  list: PeopleList,
  rows: PersonListRow[],
  owing: number,
  oweActive: boolean,
  note: string,
  headshots: Map<string, string>,
  canAdd: boolean
): string {
  const { who, whoInitials } = whoLine(event, principal);
  const body =
    rows.length === 0 && !list.search && !oweActive
      ? emptyPeople(event, canAdd) + importCard(event.slug)
      : peopleBody(event, list, rows, owing, oweActive, note, headshots, canAdd) + importCard(event.slug);
  return page({
    title: `People · ${event.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: event.slug,
      eventName: event.name,
      here: '/people',
      who,
      whoInitials,
      tzLabel: event.tzLabel ?? event.timezone,
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * A speaker's own file, made or changed by hand — GET/POST
 * /admin/:eventSlug/people/new and /admin/:eventSlug/people/:personId/edit.
 * The words are their own form, the photograph its own — the same split
 * SPK-08's portal profile card keeps, so fixing a typo in a job title never
 * means sending a photograph over the wire again.
 * ------------------------------------------------------------------ */

function speakerFieldLine(o: {
  id: string;
  name: string;
  labelText: string;
  value: string;
  hint?: string;
  area?: boolean;
  rows?: number;
  limit?: number;
  required?: boolean;
  optional?: boolean;
}): string {
  const attrs =
    `id="${esc(o.id)}" name="${esc(o.name)}"` +
    (o.limit ? ` maxlength="${o.limit}"` : '') +
    (o.required ? ' required' : '');
  const control = o.area
    ? `<textarea ${attrs} rows="${o.rows ?? 4}">${esc(o.value)}</textarea>`
    : `<input type="text" ${attrs} value="${esc(o.value)}">`;
  return (
    `<label class="f" for="${esc(o.id)}"><span class="f-lab">${esc(o.labelText)}` +
    (o.optional ? '<span class="opt">Optional</span>' : '') +
    '</span>' +
    control +
    (o.hint ? `<span class="hint">${esc(o.hint)}</span>` : '') +
    '</label>'
  );
}

const EMPTY_SPEAKER: PersonFields = {
  name: '',
  email: '',
  jobTitle: '',
  organisation: '',
  bio: '',
  pronouns: '',
  links: '',
};

function speakerFieldsForm(action: string, submitWord: string, v: PersonFields): string {
  return (
    `<form method="post" action="${esc(action)}">` +
    speakerFieldLine({ id: 's-name', name: 'name', labelText: 'Name', value: v.name, limit: 120, required: true }) +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px">' +
    speakerFieldLine({
      id: 's-email',
      name: 'email',
      labelText: 'Email',
      value: v.email,
      limit: 160,
      required: true,
      hint: 'How they are reached, and how their portal finds them.',
    }) +
    speakerFieldLine({ id: 's-pronouns', name: 'pronouns', labelText: 'Pronouns', value: v.pronouns, limit: 40, optional: true }) +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px">' +
    speakerFieldLine({ id: 's-title', name: 'job_title', labelText: 'What they do', value: v.jobTitle, limit: 120, optional: true }) +
    speakerFieldLine({ id: 's-org', name: 'organisation', labelText: 'Where they do it', value: v.organisation, limit: 120, optional: true }) +
    '</div>' +
    speakerFieldLine({
      id: 's-links',
      name: 'links',
      labelText: 'Links',
      value: v.links,
      limit: 600,
      optional: true,
      hint: 'A website, a talk recording, a social profile — one per line.',
    }) +
    speakerFieldLine({
      id: 's-bio',
      name: 'bio',
      labelText: 'Bio',
      value: v.bio,
      area: true,
      rows: 5,
      limit: 900,
      optional: true,
      hint: 'Printed under their name on the public agenda.',
    }) +
    `<div class="btnrow" style="margin-top:14px"><button class="btn btn-primary" type="submit">${esc(submitWord)}</button></div>` +
    '</form>'
  );
}

function newSpeakerPage(event: AdminEvent, principal: Principal, note: string | undefined): string {
  const { who, whoInitials } = whoLine(event, principal);
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Add a speaker</h1>' +
    '<p class="sub">Puts them on this event’s list straight away — a proposal is not needed first.</p></div>' +
    outcomeNote(note) +
    `<div class="card card-pad" style="margin-top:18px;max-width:44em">${speakerFieldsForm(
      `/admin/${esc(event.slug)}/people/new`,
      'Add speaker',
      EMPTY_SPEAKER
    )}</div>` +
    `<p class="sub" style="margin-top:14px"><a class="link" href="/admin/${esc(event.slug)}/people">← Back to people</a></p>`;
  return page({
    title: `Add a speaker · ${event.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: event.slug,
      eventName: event.name,
      here: '/people',
      who,
      whoInitials,
      tzLabel: event.tzLabel ?? event.timezone,
      crumb: `<a href="/admin/${esc(event.slug)}/people">People</a><span> / </span>Add a speaker`,
      body,
    }),
  });
}

function editSpeakerPage(
  event: AdminEvent,
  principal: Principal,
  personId: string,
  v: PersonFields,
  headshotFileId: string | null,
  note: string | undefined
): string {
  const { who, whoInitials } = whoLine(event, principal);
  const photo =
    '<div class="card card-pad" style="margin-top:18px;max-width:44em">' +
    '<h2 class="display" style="font-size:18px;margin-bottom:10px">Photograph</h2>' +
    '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
    `<span class="avwrap">${face(initialsOf(v.name || '?'), v.name || 'Speaker', headshotFileId, 72)}</span>` +
    '<div style="flex:1 1 16em;min-width:14em">' +
    `<form method="post" enctype="multipart/form-data" action="/admin/${esc(event.slug)}/people/${esc(
      personId
    )}/photo">` +
    `<input type="file" name="photo" accept="${esc(PHOTO_ACCEPT)}" required aria-label="Photograph">` +
    `<p class="hint" style="margin-top:6px">${esc(PHOTO_LINE)} Shows wherever this person appears backstage.</p>` +
    `<div class="btnrow" style="margin-top:8px"><button class="btn btn-sm" type="submit">${
      headshotFileId ? 'Use this one instead' : 'Save photograph'
    }</button></div>` +
    '</form></div></div></div>';
  const words =
    `<div class="card card-pad" style="margin-top:18px;max-width:44em">${speakerFieldsForm(
      `/admin/${esc(event.slug)}/people/${esc(personId)}/edit`,
      'Save',
      v
    )}</div>`;
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Edit speaker</h1></div>' +
    outcomeNote(note) +
    words +
    photo +
    `<p class="sub" style="margin-top:14px"><a class="link" href="/admin/${esc(event.slug)}/people/${esc(
      personId
    )}">← Back to their file</a></p>`;
  return page({
    title: `Edit ${v.name || 'speaker'} · ${event.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: event.slug,
      eventName: event.name,
      here: '/people',
      who,
      whoInitials,
      tzLabel: event.tzLabel ?? event.timezone,
      crumb: `<a href="/admin/${esc(event.slug)}/people">People</a><span> / </span>Edit`,
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Editing an ask already on somebody's list — GET/POST
 * /admin/:eventSlug/people/:personId/tasks/:taskId/edit. Previously the only
 * control on an open ask was withdrawing it, so changing a due date meant
 * deleting one and asking again from scratch.
 * ------------------------------------------------------------------ */

type TaskEditRow = { id: string; title: string; dueOn: string | null; instructions: string | null };

function taskEditPage(
  event: AdminEvent,
  principal: Principal,
  personId: string,
  personName: string,
  t: TaskEditRow,
  note: string | undefined
): string {
  const { who, whoInitials } = whoLine(event, principal);
  const body =
    `<div style="padding:26px 0 0"><h1 class="display">Edit the ask</h1>` +
    `<p class="sub">For ${esc(personName)}.</p></div>` +
    outcomeNote(note) +
    '<div class="card card-pad" style="margin-top:18px;max-width:40em">' +
    `<form method="post" action="/admin/${esc(event.slug)}/people/${esc(personId)}/tasks/${esc(t.id)}/edit">` +
    '<label class="f"><span class="f-lab">What are you asking for?</span>' +
    `<input type="text" name="title" required maxlength="140" value="${esc(t.title)}"></label>` +
    '<label class="f" style="margin-top:14px"><span class="f-lab">Due by</span>' +
    `<input type="date" name="due" required value="${esc(t.dueOn ?? '')}" ${DATE_FIELD}></label>` +
    '<label class="f" style="margin-top:14px"><span class="f-lab">Instructions <span class="opt">Optional</span></span>' +
    `<textarea name="instructions" rows="4" maxlength="2000">${esc(t.instructions ?? '')}</textarea></label>` +
    '<div class="btnrow" style="margin-top:16px"><button class="btn btn-primary" type="submit">Save</button></div>' +
    '</form></div>' +
    `<p class="sub" style="margin-top:14px"><a class="link" href="/admin/${esc(event.slug)}/people/${esc(
      personId
    )}#tasks">← Back</a></p>`;
  return page({
    title: `Edit the ask · ${event.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: event.slug,
      eventName: event.name,
      here: '/people',
      who,
      whoInitials,
      tzLabel: event.tzLabel ?? event.timezone,
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * One person — GET /admin/:eventSlug/people/:personId
 * ------------------------------------------------------------------ */

function contactCard(detail: PersonDetail): string {
  const email = detail.email
    ? `<p style="margin:0 0 6px">${esc(detail.email)}</p>`
    : `<p style="margin:0 0 6px"><span class="chip warn">${esc(label('message.blocked', 'backstage'))}</span></p>`;
  const phone = detail.phone ? `<p style="margin:0">${esc(detail.phone)}</p>` : '';
  return `<div class="railbox" id="contact"><h4>Contact</h4>${email}${phone}</div>`;
}

/** Travel preferences, dietary notes, anything logistics — SPK-15. Free text
 *  on the person, so it means the same thing wherever they turn up again. */
function logisticsCard(slug: string, personId: string, value: string | null): string {
  return (
    '<div class="railbox"><h4>Travel and logistics</h4>' +
    `<form method="post" action="/admin/${esc(slug)}/people/${esc(personId)}/logistics">` +
    `<textarea name="logistics" rows="3" maxlength="600" placeholder="Arrival day, seating, dietary notes">${esc(
      value ?? ''
    )}</textarea>` +
    '<div class="btnrow" style="margin-top:8px"><button class="btn btn-sm" type="submit">Save</button></div>' +
    '</form></div>'
  );
}

function proposalsCard(slug: string, proposals: PersonProposal[]): string {
  const body = proposals.length
    ? proposals
        .map(
          (p) =>
            `<p style="margin:0 0 8px"><a class="link" href="/admin/${esc(slug)}/submissions/${esc(p.id)}">${esc(p.title)}</a><br>${stateChip(p.state)}</p>`
        )
        .join('')
    : '<p class="t-sub" style="margin:0">Nothing at this event.</p>';
  return `<div class="railbox"><h4>Their proposals</h4>${body}</div>`;
}

type TaskChip = { key: LabelKey; cls: string };

function taskChip(t: PersonTask, today: string): TaskChip {
  if (t.completedAt && t.cancelledAt) return { key: 'task.done_cancelled', cls: 'plain' };
  if (t.completedAt) return { key: 'task.done', cls: 's-accepted' };
  if (t.cancelledAt) return { key: 'task.cancelled', cls: 's-declined' };
  if (t.dueOn && t.dueOn < today) return { key: 'task.overdue', cls: 'warn' };
  return { key: 'task.open', cls: 's-undecided' };
}

/** due_on is a plain calendar date (no time, no zone) — format it in UTC so
 *  the day printed is always the day stored, never shifted by a reader's
 *  offset. */
function friendlyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/** Withdrawing is one click and no confirm: only this room has seen the ask,
 *  and the speaker's own word for what happens is "not needed anymore". */
function withdrawForm(slug: string, personId: string, taskId: string): string {
  return (
    `<form method="post" style="margin-top:4px;display:inline" action="/admin/${esc(slug)}/people/${esc(personId)}` +
    `/tasks/${esc(taskId)}/withdraw">` +
    '<button class="btn btn-sm btn-quiet" type="submit">Withdraw the ask</button></form>'
  );
}

/** Fixing a due date used to mean withdrawing the ask and asking again from
 *  scratch. This is the other half of an open ask's own row now: withdraw it,
 *  or change it — never both at once, so neither can be mistaken for the
 *  other. */
function taskRow(t: PersonTask, today: string, slug: string, personId: string): string {
  const chip = taskChip(t, today);
  const dueWord = chip.key === 'task.overdue' ? 'was due' : 'due';
  const due = t.dueOn ? `<div class="t-sub" style="margin-top:2px">${esc(dueWord)} ${esc(friendlyDate(t.dueOn))}</div>` : '';
  const open = t.completedAt === null && t.cancelledAt === null;
  const actions = open
    ? '<div style="margin-top:4px;display:flex;gap:14px;align-items:center">' +
      `<a class="link" style="font-size:13.5px" href="/admin/${esc(slug)}/people/${esc(personId)}` +
      `/tasks/${esc(t.id)}/edit">Edit</a>` +
      withdrawForm(slug, personId, t.id) +
      '</div>'
    : '';
  return (
    '<div style="padding:6px 0">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
    `<span>${esc(t.title)}</span><span class="chip ${chip.cls}">${esc(label(chip.key, 'backstage'))}</span>` +
    '</div>' +
    due +
    actions +
    '</div>'
  );
}

function tasksCard(
  tasks: PersonTask[],
  today: string,
  slug: string,
  personId: string,
  mayAsk: boolean
): string {
  if (!tasks.length) {
    return (
      '<div class="railbox" id="tasks"><h4>Tasks</h4>' +
      '<p class="t-sub" style="margin:0">Nothing asked of them here.' +
      (mayAsk ? ' Ask below and it lands on their portal.' : '') +
      '</p></div>'
    );
  }
  return (
    '<div class="railbox" id="tasks"><h4>Tasks</h4>' +
    tasks.map((t) => taskRow(t, today, slug, personId)).join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * Asking for something — the one act this screen performs
 * ------------------------------------------------------------------ */

// input[type=date] is outside the field rule in shared.css (which names text,
// email, tel, textarea and select), so it carries that rule's own skin inline
// rather than standing in the card looking like a browser's idea of a date.
const DATE_FIELD =
  'style="width:100%;font:inherit;font-size:15.5px;color:var(--ink);background:var(--card);' +
  'border:1px solid var(--field-line);border-radius:var(--r-sm);padding:10px 12px"';

function askCard(event: AdminEvent, detail: PersonDetail): string {
  const first = firstNameOf(detail.name);
  const kinds = TASK_KINDS.map(
    (k) => `<option value="${esc(k.value)}">${esc(k.word)}</option>`
  ).join('');
  const about = detail.proposals.length
    ? '<label class="f" style="margin-bottom:0">' +
      '<span class="f-lab">About one of their proposals <span class="opt">Optional</span></span>' +
      '<select name="about"><option value="">Nothing in particular</option>' +
      detail.proposals.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('') +
      '</select></label>'
    : '';

  return (
    '<div class="card card-pad" id="ask" style="margin-top:22px;max-width:44em">' +
    `<h2 class="display" style="font-size:22px;margin-bottom:4px">Ask ${esc(first)} for something</h2>` +
    '<p class="sub" style="margin-bottom:16px">It lands on their portal with the day it is due, ' +
    'and they mark it done from there. Nothing is emailed.</p>' +
    `<form method="post" action="/admin/${esc(event.slug)}/people/${esc(detail.personId)}/ask">` +
    '<label class="f"><span class="f-lab">What are you asking for?</span>' +
    '<input type="text" name="title" required maxlength="140" ' +
    'placeholder="Send your slides"></label>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:18px">' +
    `<label class="f"><span class="f-lab">What kind of ask</span><select name="kind">${kinds}</select></label>` +
    '<label class="f"><span class="f-lab">Due by</span>' +
    `<input type="date" name="due" required ${DATE_FIELD}></label>` +
    '</div>' +
    about +
    `<div class="btnrow" style="margin-top:18px"><button class="btn btn-primary" type="submit">Ask ${esc(
      first
    )}</button></div>` +
    '</form></div>'
  );
}

function elsewhereCard(elsewhere: PersonElsewhere[]): string {
  if (!elsewhere.length) {
    return '<div class="railbox"><h4>Elsewhere</h4><p class="t-sub" style="margin:0">This is their only event with us.</p></div>';
  }
  const rows = elsewhere
    .map(
      (e) =>
        `<p style="margin:0 0 8px">${esc(e.eventName)}<br><span class="t-sub">${esc(e.title)} · ${esc(label(STATE_LABEL_KEY[e.state], 'backstage'))}</span></p>`
    )
    .join('');
  return `<div class="railbox"><h4>Elsewhere</h4>${rows}</div>`;
}

function personHeader(event: AdminEvent, detail: PersonDetail, headshotFileId: string | null, mayEdit: boolean): string {
  const role = [detail.jobTitle, detail.organisation]
    .filter((v): v is string => Boolean(v))
    .map((v) => esc(v))
    .join(' · ');
  const editLink = mayEdit
    ? `<a class="link" style="margin-left:auto;font-size:14px" href="/admin/${esc(event.slug)}/people/${esc(
        detail.personId
      )}/edit">Edit their file →</a>`
    : '';
  return (
    '<div style="padding:20px 0 0;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
    `<span class="avwrap">${face(initialsOf(detail.name), detail.name, headshotFileId, 56)}</span>` +
    '<div style="flex:1;min-width:min(100%,260px)">' +
    `<h1 class="display" style="font-size:clamp(24px,3.6vw,30px)">${esc(detail.name)}</h1>` +
    (role ? `<p class="sub" style="margin-top:4px;font-size:14.5px">${role}</p>` : '') +
    '</div>' +
    editLink +
    '</div>' +
    (detail.bio
      ? `<p class="serif" style="margin-top:16px;font-size:16.5px;line-height:1.6;max-width:44em">${esc(detail.bio)}</p>`
      : '')
  );
}

function personBody(
  event: AdminEvent,
  detail: PersonDetail,
  mayAsk: boolean,
  outcome: string | undefined,
  logistics: string | null,
  headshotFileId: string | null,
  mayEdit: boolean,
  hasStandingHere: boolean
): string {
  const today = eventDayKey(Date.now(), event.timezone);
  return (
    personHeader(event, detail, headshotFileId, mayEdit) +
    outcomeNote(outcome) +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:22px">' +
    contactCard(detail) +
    proposalsCard(event.slug, detail.proposals) +
    tasksCard(detail.tasks, today, event.slug, detail.personId, mayAsk && hasStandingHere) +
    elsewhereCard(detail.elsewhere) +
    logisticsCard(event.slug, detail.personId, logistics) +
    '</div>' +
    (mayAsk && hasStandingHere ? askCard(event, detail) : '') +
    `<p class="sub" style="margin-top:18px"><a class="link" href="/admin/crm/${esc(
      detail.personId
    )}">See their whole history across every event →</a></p>`
  );
}

function personPage(
  event: AdminEvent,
  principal: Principal,
  detail: PersonDetail,
  mayAsk: boolean,
  outcome: string | undefined,
  logistics: string | null,
  headshotFileId: string | null,
  mayEdit: boolean,
  hasStandingHere: boolean
): string {
  const { who, whoInitials } = whoLine(event, principal);
  const crumb = `<a href="/admin/${esc(event.slug)}/people">People</a><span> / </span>${esc(detail.name)}`;
  return page({
    title: `${detail.name} · People · ${event.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: event.slug,
      eventName: event.name,
      here: '/people',
      who,
      whoInitials,
      tzLabel: event.tzLabel ?? event.timezone,
      crumb,
      body: personBody(event, detail, mayAsk, outcome, logistics, headshotFileId, mayEdit, hasStandingHere),
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Auth + routes.
 * ------------------------------------------------------------------ */

/** Resolve the event by slug within this principal's own scoped set
 *  (adminEvents already narrows to what they may open); a slug that is a
 *  real event but not in that set is a scope refusal, not a 404.
 *
 *  A signed-in stranger — somebody with an account and no standing anywhere —
 *  makes adminEvents refuse the whole set rather than hand back an empty one,
 *  and that refusal is this screen's 403 in its own words. Caught here because
 *  this is where it is thrown: outside the routes' own try, it used to leave
 *  the page with nothing to say. */
async function resolveEvent(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<{ event: AdminEvent } | { deny: true; message?: string } | null> {
  let events: AdminEvent[];
  try {
    events = await adminEvents(db, principal);
  } catch (e) {
    if (e instanceof ScopeError) return { deny: true, message: e.message };
    throw e;
  }
  const event = events.find((e) => e.slug === slug);
  // A reviewer holds the reading room and nothing else, and this screen carries
  // names, phone numbers and what everyone still owes. Same refusal a stranger
  // gets, in the same words — this file has no trimmed version of itself.
  if (event) return reviewerOnly(principal, event.id) ? { deny: true } : { event };
  const exists = await eventBySlug(db, slug);
  return exists ? { deny: true } : null;
}

/** May this principal ask anything of anyone here? The rule lives in
 *  workflows/tasks.ts; this only asks it, so the card and the write can never
 *  disagree about who holds it. The same EDIT_ROLES also gates every write
 *  this file adds below (create/edit a speaker, edit an ask) — one
 *  permission, everywhere it is asked. */
function canAsk(principal: Principal, eventId: string): boolean {
  try {
    requireScope(principal, eventId, EDIT_ROLES);
    return true;
  } catch {
    return false;
  }
}

/**
 * A person on this event's roster with no proposal here yet — brought in by
 * a CSV import, pushed from the CRM, or added by hand below — is invisible
 * to queries/people.ts's personDetail() by design: that reader's whole point
 * is "reached through a real proposal" (its own header comment says so).
 * Previously that meant clicking through from the People list 404'd. This
 * builds the same PersonDetail shape from the roster fact (schema/0008's
 * roster_entry) instead, so a roster-only person's file always resolves.
 * Their "proposals" here are honestly empty — there are none — but their
 * tasks and their standing at other events read exactly as personDetail's
 * own queries would.
 */
async function rosterOnlyPersonDetail(
  db: D1Database,
  eventId: string,
  personId: string
): Promise<PersonDetail | null> {
  const person = await db
    .prepare(
      `SELECT pe.id, pe.name, pe.email, pe.phone, pe.job_title, pe.organisation, pe.bio
         FROM person pe
         JOIN roster_entry r ON r.person_id = pe.id AND r.event_id = ?
        WHERE pe.id = ? AND pe.merged_into_id IS NULL`
    )
    .bind(eventId, personId)
    .first<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      job_title: string | null;
      organisation: string | null;
      bio: string | null;
    }>();
  if (!person) return null;

  const [taskRes, elseRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT id, kind, title, due_on, completed_at, cancelled_at, cancel_reason
           FROM task WHERE person_id = ? AND event_id = ?
          ORDER BY (completed_at IS NULL AND cancelled_at IS NULL) DESC, due_on IS NULL, due_on, title`
      )
      .bind(personId, eventId),
    db
      .prepare(
        `SELECT s.id AS submission_id, e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
                s.title, s.state
           FROM participation pa
           JOIN submission s ON s.id = pa.submission_id
           JOIN event e ON e.id = s.event_id
          WHERE pa.person_id = ? AND s.event_id <> ? AND s.state <> 'draft'
          ORDER BY e.starts_on DESC, s.title`
      )
      .bind(personId, eventId),
  ]);

  return {
    personId: person.id,
    name: person.name,
    email: person.email,
    phone: person.phone,
    jobTitle: person.job_title,
    organisation: person.organisation,
    bio: person.bio,
    proposals: [],
    tasks: (
      (taskRes?.results ?? []) as unknown as {
        id: string;
        kind: string;
        title: string;
        due_on: string | null;
        completed_at: number | null;
        cancelled_at: number | null;
        cancel_reason: string | null;
      }[]
    ).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      dueOn: t.due_on,
      completedAt: t.completed_at,
      cancelledAt: t.cancelled_at,
      cancelReason: t.cancel_reason,
    })),
    elsewhere: (
      (elseRes?.results ?? []) as unknown as {
        submission_id: string;
        event_id: string;
        event_slug: string;
        event_name: string;
        title: string;
        state: SubmissionState;
      }[]
    ).map((e) => ({
      submissionId: e.submission_id,
      eventId: e.event_id,
      eventSlug: e.event_slug,
      eventName: e.event_name,
      title: e.title,
      state: e.state,
    })),
  };
}

export function registerPeople(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/people', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    try {
      const resolved = await resolveEvent(c.env.DB, principal, c.req.param('eventSlug'));
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);

      const q = c.req.query('q') ?? '';
      const list = await peopleList(c.env.DB, principal, resolved.event.id, { search: q });
      const rosterOnly = await rosterOnlyPeople(c.env.DB, principal, resolved.event.id);
      const needle = q.trim().toLowerCase();
      const matches = (r: { name: string; organisation: string | null }): boolean =>
        !needle ||
        r.name.toLowerCase().includes(needle) ||
        (r.organisation ?? '').toLowerCase().includes(needle);
      const combined = [...list.rows, ...rosterOnly.filter(matches).map(rosterOnlyAsListRow)].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      const owing = combined.filter((r) => r.openTaskCount > 0).length;
      const oweActive = c.req.query('owe') === '1';
      const rows = oweActive ? combined.filter((r) => r.openTaskCount > 0) : combined;

      // ?imported=/?matched=/?skipped= are counts this screen wrote itself
      // after a CSV landed — validated as plain integers, then folded into a
      // sentence this file owns, never echoed as free text.
      const ic = c.req.query('imported');
      const mc = c.req.query('matched');
      const sc = c.req.query('skipped');
      const digits = /^\d+$/;
      const importNote =
        ic !== undefined && digits.test(ic) && digits.test(mc ?? '0') && digits.test(sc ?? '0')
          ? importedNote(Number(ic), Number(mc ?? '0'), Number(sc ?? '0'))
          : '';

      const shown = rows.slice(0, ROOM);
      const headshots = await headshotsFor(c.env.DB, shown.map((r) => r.personId));
      const canAdd = canAsk(principal, resolved.event.id);

      return c.html(peoplePage(resolved.event, principal, list, rows, owing, oweActive, importNote, headshots, canAdd));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- a speaker's own file, made by hand ---------- */

  app.get('/admin/:eventSlug/people/new', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    try {
      const resolved = await resolveEvent(c.env.DB, principal, c.req.param('eventSlug'));
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Adding a speaker is held by this event’s organizers.'), 403);
      }
      return c.html(newSpeakerPage(resolved.event, principal, c.req.query('note')));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/people/new', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const home = `/admin/${encodeURIComponent(slug)}/people/new`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Adding a speaker is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const result = await createSpeaker(c.env.DB, principal, resolved.event.id, {
        name: text(form['name']),
        email: text(form['email']),
        jobTitle: text(form['job_title']),
        organisation: text(form['organisation']),
        bio: text(form['bio']),
        pronouns: text(form['pronouns']),
        links: text(form['links']),
      });
      if (!result.ok) return c.redirect(`${home}?note=${encodeURIComponent(result.code)}`, 303);
      return c.redirect(
        `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(result.personId)}?note=created`,
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/admin/:eventSlug/people/:personId/edit', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Editing a speaker’s file is held by this event’s organizers.'), 403);
      }

      const row = await c.env.DB.prepare(
        `SELECT name, email, job_title, organisation, bio, pronouns, links, headshot_file_id
           FROM person WHERE id = ? AND merged_into_id IS NULL`
      )
        .bind(personId)
        .first<{
          name: string;
          email: string | null;
          job_title: string | null;
          organisation: string | null;
          bio: string | null;
          pronouns: string | null;
          links: string | null;
          headshot_file_id: string | null;
        }>();
      if (!row) return c.notFound();
      // Only somebody this event actually knows — through a real proposal or
      // the roster — is this screen's to change; a stray id from another
      // event's directory reads as not-found here, the same as anywhere else
      // on this page.
      const onEvent = await c.env.DB.prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM roster_entry WHERE event_id = ? AND person_id = ?)
            OR EXISTS (SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
                        WHERE pa.person_id = ? AND s.event_id = ? AND s.state <> 'draft')`
      )
        .bind(resolved.event.id, personId, personId, resolved.event.id)
        .first();
      if (!onEvent) return c.notFound();

      return c.html(
        editSpeakerPage(
          resolved.event,
          principal,
          personId,
          {
            name: row.name,
            email: row.email ?? '',
            jobTitle: row.job_title ?? '',
            organisation: row.organisation ?? '',
            bio: row.bio ?? '',
            pronouns: row.pronouns ?? '',
            links: row.links ?? '',
          },
          row.headshot_file_id,
          c.req.query('note')
        )
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/people/:personId/edit', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const home = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}`;
    const editHome = `${home}/edit`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Editing a speaker’s file is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const result = await updateSpeaker(c.env.DB, principal, resolved.event.id, personId, {
        name: text(form['name']),
        email: text(form['email']),
        jobTitle: text(form['job_title']),
        organisation: text(form['organisation']),
        bio: text(form['bio']),
        pronouns: text(form['pronouns']),
        links: text(form['links']),
      });
      if (!result.ok) {
        const code = result.code === 'not-found' ? 'not-found' : result.code;
        return c.redirect(`${editHome}?note=${encodeURIComponent(code)}`, 303);
      }
      return c.redirect(`${home}?note=saved`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- the photograph half of the same file ---------- */

  app.post('/admin/:eventSlug/people/:personId/photo', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const editHome = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}/edit`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Editing a speaker’s file is held by this event’s organizers.'), 403);
      }

      if (tooLargeToRead(c.req.header('content-length'), PHOTO_MAX_BYTES)) {
        return c.redirect(`${editHome}?note=${encodeURIComponent('photo-too-big')}`, 303);
      }
      const form = await c.req.parseBody();
      const photo = filePart(form['photo']);
      if (!photo) return c.redirect(`${editHome}?note=${encodeURIComponent('photo-nothing')}`, 303);

      const outcome = await uploadSpeakerHeadshot(c.env.DB, c.env.FILES, principal, resolved.event.id, personId, photo);
      const code =
        outcome === 'done'
          ? 'photo-done'
          : outcome === 'too-big'
            ? 'photo-too-big'
            : outcome === 'wrong-kind'
              ? 'photo-wrong-kind'
              : outcome === 'moved'
                ? 'photo-moved'
                : outcome === 'not-here'
                  ? 'not-found'
                  : 'trouble';
      return c.redirect(`${editHome}?note=${encodeURIComponent(code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- editing an ask already on somebody's list ---------- */

  app.get('/admin/:eventSlug/people/:personId/tasks/:taskId/edit', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const taskId = c.req.param('taskId');
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Editing an ask is held by this event’s organizers.'), 403);
      }

      const row = await c.env.DB.prepare(
        `SELECT t.id, t.title, t.due_on, t.instructions, pe.name AS person_name
           FROM task t JOIN person pe ON pe.id = t.person_id
          WHERE t.id = ? AND t.event_id = ? AND t.person_id = ?
            AND t.completed_at IS NULL AND t.cancelled_at IS NULL`
      )
        .bind(taskId, resolved.event.id, personId)
        .first<{ id: string; title: string; due_on: string | null; instructions: string | null; person_name: string }>();
      if (!row) return c.notFound();

      return c.html(
        taskEditPage(
          resolved.event,
          principal,
          personId,
          row.person_name,
          { id: row.id, title: row.title, dueOn: row.due_on, instructions: row.instructions },
          c.req.query('note')
        )
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/people/:personId/tasks/:taskId/edit', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const taskId = c.req.param('taskId');
    const editHome = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}/tasks/${encodeURIComponent(taskId)}/edit`;
    const personHome = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Editing an ask is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const result = await editTask(c.env.DB, principal, resolved.event.id, taskId, {
        title: String(form['title'] ?? ''),
        dueOn: String(form['due'] ?? ''),
        instructions: String(form['instructions'] ?? ''),
      });
      if (!result.ok) {
        const code = result.code === 'bad-date' ? 'task-bad-date' : result.code;
        return c.redirect(`${editHome}?note=${encodeURIComponent(code)}`, 303);
      }
      return c.redirect(`${personHome}?note=saved#tasks`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/admin/:eventSlug/people/:personId', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    try {
      const resolved = await resolveEvent(c.env.DB, principal, c.req.param('eventSlug'));
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);

      const personId = c.req.param('personId');
      let detail = await personDetail(c.env.DB, principal, resolved.event.id, personId);
      // Reached through a real proposal, or — the defect this closes — reached
      // only through the roster: a CSV import, a CRM push, or a speaker added
      // by hand below, none of which personDetail() alone ever finds.
      const hasStandingHere = detail !== null;
      if (!detail) {
        detail = await rosterOnlyPersonDetail(c.env.DB, resolved.event.id, personId);
      }
      if (!detail) return c.notFound();

      const extra = await c.env.DB.prepare('SELECT logistics, headshot_file_id FROM person WHERE id = ?')
        .bind(detail.personId)
        .first<{ logistics: string | null; headshot_file_id: string | null }>();
      // One organizer's private reading of one person's file.
      c.header('cache-control', 'private, no-store');
      return c.html(
        personPage(
          resolved.event,
          principal,
          detail,
          canAsk(principal, resolved.event.id),
          c.req.query('note'),
          extra?.logistics ?? null,
          extra?.headshot_file_id ?? null,
          canAsk(principal, resolved.event.id),
          hasStandingHere
        )
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  // Asking. One click, because the ask is undoable from the card it lands in.
  app.post('/admin/:eventSlug/people/:personId/ask', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const home = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}`;
    const back = (code: string, anchor: string): string =>
      `${home}?note=${encodeURIComponent(code)}${anchor}`;

    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      // Said here in this screen's words rather than letting the workflow's
      // refusal become a heading.
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Asking people for things is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const result = await createTask(c.env.DB, principal, resolved.event.id, {
        personId,
        submissionId: String(form['about'] ?? '') || null,
        kind: String(form['kind'] ?? ''),
        title: String(form['title'] ?? ''),
        dueOn: String(form['due'] ?? ''),
      });
      if (!result.ok) return c.redirect(back(result.code, '#ask'), 303);
      return c.redirect(back('asked', '#tasks'), 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/people/:personId/tasks/:taskId/withdraw', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const home = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}`;

    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Asking people for things is held by this event’s organizers.'), 403);
      }

      const result = await cancelTask(c.env.DB, principal, resolved.event.id, c.req.param('taskId'));
      const code = result.ok ? 'withdrawn' : result.code;
      return c.redirect(`${home}?note=${encodeURIComponent(code)}#tasks`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- bringing in a list — SPK-03 ---------- */

  app.post('/admin/:eventSlug/people/import', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const home = `/admin/${encodeURIComponent(slug)}/people`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Bringing in a list is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const file = filePart(form['csv']);
      if (!file) return c.redirect(`${home}?note=${encodeURIComponent('Choose a CSV file first.')}`, 303);
      if (file.size > MAX_CSV_BYTES) {
        return c.redirect(`${home}?note=${encodeURIComponent('That file is bigger than this brings in — keep it under 512 KB.')}`, 303);
      }
      const parsed = parseSpeakersCsv(await file.text());
      if (!parsed.ok) {
        const said =
          parsed.code === 'no-header'
            ? 'The file needs a name column and an email column.'
            : parsed.code === 'too-many'
              ? 'That is more rows than one file can bring in at once.'
              : 'That file had nothing in it.';
        return c.redirect(`${home}?note=${encodeURIComponent(said)}`, 303);
      }
      const preview = await previewImportRows(c.env.DB, parsed.rows);
      return c.html(importPreviewPage(resolved.event, principal, preview));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/people/import/confirm', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const home = `/admin/${encodeURIComponent(slug)}/people`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Bringing in a list is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody({ all: true });
      const keep = new Set(manyOf(form['keep']));
      const count = Math.min(Number(text(form['count'])) || 0, 500);
      const rows: ParsedCsvRow[] = [];
      for (let i = 0; i < count; i++) {
        if (!keep.has(String(i))) continue;
        const name = text(form[`r${i}_name`]);
        const email = text(form[`r${i}_email`]);
        if (!name || !email) continue;
        rows.push({
          line: i + 2,
          name,
          email,
          jobTitle: text(form[`r${i}_job`]) || null,
          organisation: text(form[`r${i}_org`]) || null,
          bio: text(form[`r${i}_bio`]) || null,
          invalid: null,
        });
      }

      const result = await writeImportedRows(c.env.DB, principal, resolved.event.id, rows);
      return c.redirect(
        `${home}?imported=${result.imported}&matched=${result.matched}&skipped=${result.skipped}`,
        303
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- travel and logistics — SPK-15 ---------- */

  app.post('/admin/:eventSlug/people/:personId/logistics', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    const personId = c.req.param('personId');
    const home = `/admin/${encodeURIComponent(slug)}/people/${encodeURIComponent(personId)}`;
    try {
      const resolved = await resolveEvent(c.env.DB, principal, slug);
      if (!resolved) return c.notFound();
      if ('deny' in resolved) return c.html(deniedPage(resolved.message), 403);
      if (!canAsk(principal, resolved.event.id)) {
        return c.html(deniedPage('Editing a speaker’s record is held by this event’s organizers.'), 403);
      }

      const form = await c.req.parseBody();
      const res = await setLogisticsForEvent(c.env.DB, principal, resolved.event.id, personId, text(form['logistics']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'saved' : 'not-found')}#contact`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });
}
