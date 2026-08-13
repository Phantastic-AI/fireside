// The speaker database — 07. Everything the organizer knows about a
// speaker or a prospect that lives ABOVE any one event: the persistent
// directory, notes, a tag or a custom detail, a sourcing board for people
// who have not proposed anything yet, saved searches, and the numbers.
//
// Reachable at organization level, not nested under one event's own nav —
// requireOrg (queries/crm.ts) is what makes that true rather than aspirational:
// only the install-wide organizer standing opens this file's screens, the
// same standing that already sees every event on /admin. An editor on one
// conference keeps seeing that conference's own People page and nothing wider.
//
// This file borrows backstageShell's visual language (the same classes
// backstage.css already defines) without reusing the function itself: that
// shell is built around one event at a time, and every one of these screens
// is about none in particular — crmShell below is this file's own small
// chrome, not a second version of the real one.
//
// Register: backstage. Plain speech, counts, working labels, sentence case,
// zero exclamation marks — and this file's own words for what SessionBoard
// calls "segments" and "pipeline": a saved search and a sourcing board,
// because those are the plain English for what an organizer actually does
// with them, and the words this build's own taste rules already forbid.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, brand, deniedPage, NAME } from '../../lib/html';
import { label } from '../../lib/labels';
import { adminEvents, ScopeError, type AdminEvent, type SubmissionState } from '../../queries/admin';
import { initialsOf } from '../../queries/public';
import { principalFromCookie, type Principal } from '../../workflows/account';
import {
  crmDirectory,
  contactDetail,
  crmDashboard,
  listSegments,
  segmentDetail,
  pipelineBoard,
  cardDetail,
  directoryOptsFromQuery,
  directoryQueryString,
  PIPELINE_STAGES,
  type ContactRow,
  type ContactDetail,
  type DerivedStatus,
  type DirectoryOpts,
  type PipelineCard,
} from '../../queries/crm';
import {
  addManualContact,
  addContactNote,
  setSpeakerType,
  addTag,
  setLogistics,
  saveSegment,
  enrollInPipeline,
  moveCardStage,
  addCardNote,
  addToEvent,
  inviteToSubmit,
  crmBulkEmail,
  previewBulkTemplate,
  mergeContacts,
  type SpeakerType,
} from '../../workflows/crm';

/* ------------------------------------------------------------------ *
 * Words this file owns
 * ------------------------------------------------------------------ */

const STATUS_WORD: Record<DerivedStatus, string> = {
  prospect: 'Not yet invited',
  invited: 'Invited',
  proposed: 'Proposed a talk',
  confirmed: 'Confirmed',
  onboarded: 'Onboarded',
};
const STATUS_CHIP: Record<DerivedStatus, string> = {
  prospect: 'plain',
  invited: 's-undecided',
  proposed: 's-undecided',
  confirmed: 's-accepted',
  onboarded: 's-accepted',
};

const STATE_LABEL_KEY: Record<SubmissionState, Parameters<typeof label>[0]> = {
  draft: 'submission.draft',
  submitted: 'submission.submitted',
  accepted: 'submission.accepted',
  waitlisted: 'submission.waitlisted',
  rejected: 'submission.rejected',
  withdrawn: 'submission.withdrawn',
  cancelled: 'submission.cancelled',
};

const num = (n: number): string => n.toLocaleString('en-US');
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const manyOf = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.map((x) => (typeof x === 'string' ? x : '')).filter(Boolean);
};
const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

function statusChip(s: DerivedStatus): string {
  return `<span class="chip ${STATUS_CHIP[s]}">${esc(STATUS_WORD[s])}</span>`;
}

function avatar(initials: string, name: string, size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    '<circle cx="20" cy="20" r="20" fill="var(--paper-deep)"/>' +
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="var(--serif)" ' +
    `font-weight="600" font-size="14" fill="var(--ink-soft)">${esc(initials)}</text></svg>`
  );
}

/* ------------------------------------------------------------------ *
 * The chrome
 * ------------------------------------------------------------------ */

function crmShell(o: { here: string; who: string; whoInitials: string; crumb?: string; body: string }): string {
  const entries: [string, string][] = [
    ['', 'Speaker database'],
    ['/pipeline', 'Sourcing'],
    ['/searches', 'Saved searches'],
    ['/overview', 'Overview'],
  ];
  const nav = entries
    .map(([p, lab]) =>
      p === o.here ? `<span aria-current="page">${esc(lab)}</span>` : `<a href="/admin/crm${p}">${esc(lab)}</a>`
    )
    .join('');
  return (
    '<div class="stage backstage">' +
    `<div class="bs-top"><div class="wrap wrap-wide bs-top-in">${brand()}` +
    `<a class="evt-switch" href="/admin">Your events <span style="opacity:.6">⌄</span></a>` +
    `<div class="bs-me"><span style="width:26px;height:26px;border-radius:50%;display:inline-grid;place-items:center;` +
    `background:var(--ember-wash);color:var(--ember);font-size:11px;font-weight:700">${esc(o.whoInitials)}</span>` +
    `<span>${esc(o.who)}</span>` +
    `<a href="/sign-out" style="color:#CFC5B6;text-decoration:underline;text-underline-offset:2px">${esc(
      label('auth.sign_out', 'backstage')
    )}</a></div>` +
    '</div></div>' +
    `<div class="bs-nav"><div class="wrap wrap-wide bs-nav-in">${nav}</div></div>` +
    `<main><div class="wrap wrap-wide">${o.crumb ? `<div class="crumb">${o.crumb}</div>` : ''}${o.body}</div></main>` +
    `<footer class="foot"><div class="wrap wrap-wide foot-in"><span class="fname">${esc(NAME)}</span>` +
    '<span style="margin-left:auto"><a class="link" href="/admin">Back to your events →</a></span>' +
    '</div></footer></div>'
  );
}

function whoLine(principal: Principal): { who: string; whoInitials: string } {
  return { who: `${principal.name} · Organizer`, whoInitials: initialsOf(principal.name) };
}

function noteBox(text: string): string {
  return (
    '<div class="notebox" style="margin-top:18px" role="status">' +
    `<p style="margin:0" class="serif">${esc(text)}</p></div>`
  );
}

/* ------------------------------------------------------------------ *
 * The directory — CRM-01, CRM-02, CRM-05 (import lands here from
 * routes/admin/people.ts — same `person` table, nothing more to build)
 * ------------------------------------------------------------------ */

function filterForm(opts: DirectoryOpts): string {
  const any = opts.search || opts.company || opts.jobTitle || opts.tag;
  return (
    '<form method="get" class="searchbar" action="/admin/crm">' +
    `<input type="text" name="q" placeholder="Search names, emails, organisations" value="${esc(opts.search ?? '')}">` +
    `<input type="text" name="company" placeholder="Company" value="${esc(
      opts.company ?? ''
    )}" style="max-width:160px">` +
    `<input type="text" name="title" placeholder="Job title" value="${esc(
      opts.jobTitle ?? ''
    )}" style="max-width:160px">` +
    `<input type="text" name="tag" placeholder="Tag" value="${esc(opts.tag ?? '')}" style="max-width:120px">` +
    '<button class="btn btn-sm" type="submit">Search</button>' +
    (any ? '<a class="link" href="/admin/crm">Clear</a>' : '') +
    '</form>'
  );
}

function saveSearchForm(opts: DirectoryOpts): string {
  const qs = directoryQueryString(opts);
  if (!qs) return '';
  return (
    `<form method="post" action="/admin/crm/searches" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">` +
    Object.entries(Object.fromEntries(new URLSearchParams(qs)))
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('') +
    '<input type="text" name="name" required maxlength="60" placeholder="Name this search" style="max-width:220px">' +
    '<label style="display:flex;gap:5px;align-items:center;font-size:13px;color:var(--muted)">' +
    '<input type="radio" name="kind" value="dynamic" checked> Live — keeps matching new contacts</label>' +
    '<label style="display:flex;gap:5px;align-items:center;font-size:13px;color:var(--muted)">' +
    '<input type="radio" name="kind" value="curated"> Fixed — exactly these contacts</label>' +
    '<button class="btn btn-sm" type="submit">Save this search</button>' +
    '</form>'
  );
}

function contactRow(r: ContactRow, dupNames: Set<string>): string {
  const role = [r.jobTitle, r.organisation].filter((v): v is string => Boolean(v)).map((v) => esc(v)).join(' · ');
  const tags = r.tags.length ? r.tags.map((t) => `<span class="chip plain">${esc(t)}</span>`).join(' ') : '';
  const dup = dupNames.has(r.name.trim().toLowerCase())
    ? `<div class="t-sub" style="color:var(--ember);margin-top:2px">Possible duplicate — <a class="link" href="/admin/crm/${esc(
        r.personId
      )}">open the record to merge</a></div>`
    : '';
  return (
    '<tr>' +
    `<td><input class="pick" type="checkbox" name="pid" value="${esc(r.personId)}"></td>` +
    '<td><div style="display:flex;gap:11px;align-items:center">' +
    `<span class="avwrap">${avatar(initialsOf(r.name), r.name, 34)}</span>` +
    `<span style="min-width:0"><span class="t-name">${esc(r.name)}</span>` +
    (role ? `<br><span class="t-sub">${role}</span>` : '') +
    dup +
    '</span></div></td>' +
    `<td>${esc(r.email ?? '—')}</td>` +
    `<td>${statusChip(r.status)}</td>` +
    `<td>${tags || '<span class="t-sub">—</span>'}</td>` +
    `<td style="text-align:right;white-space:nowrap"><a class="btn btn-sm" href="/admin/crm/${esc(
      r.personId
    )}">Open</a></td>` +
    '</tr>'
  );
}

function directoryTable(rows: ContactRow[]): string {
  const names = new Map<string, number>();
  for (const r of rows) {
    const k = r.name.trim().toLowerCase();
    names.set(k, (names.get(k) ?? 0) + 1);
  }
  const dupNames = new Set([...names.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  return (
    '<form method="get" action="/admin/crm/bulk-email">' +
    '<div class="tablewrap" style="margin-top:6px"><table class="t"><thead><tr>' +
    '<th></th><th>Contact</th><th>Email</th><th>Where they stand</th><th>Tags</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((r) => contactRow(r, dupNames)).join('') +
    '</tbody></table></div>' +
    '<div class="btnrow" style="margin-top:12px">' +
    '<button class="btn btn-sm" type="submit">Write to the ones you picked</button></div>' +
    '</form>'
  );
}

function addContactForm(): string {
  return (
    '<div class="card card-pad" style="margin-top:22px;max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:12px">Add a contact by hand</h2>' +
    '<form method="post" action="/admin/crm/contacts">' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">' +
    '<label class="f"><span class="f-lab">Name</span><input type="text" name="name" required maxlength="120"></label>' +
    '<label class="f"><span class="f-lab">Email</span><input type="email" name="email" required maxlength="160"></label>' +
    '<label class="f"><span class="f-lab">Job title <span class="opt">Optional</span></span><input type="text" name="jobTitle" maxlength="120"></label>' +
    '<label class="f"><span class="f-lab">Company <span class="opt">Optional</span></span><input type="text" name="organisation" maxlength="120"></label>' +
    '</div>' +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">Bio <span class="opt">Optional</span></span>' +
    '<textarea name="bio" rows="3" maxlength="1200"></textarea></label>' +
    '<div class="btnrow" style="margin-top:14px"><button class="btn btn-primary" type="submit">Add them</button></div>' +
    '</form></div>'
  );
}

const DIRECTORY_NOTES: Record<string, string> = {
  'no-name': 'A name is needed — it is how you will find them again.',
  'no-email': 'A working email address is needed.',
  taken: 'Somebody with that address is already here — open their record instead of adding a second one.',
  trouble: 'That did not go through, and nothing changed. Worth trying once more.',
  added: 'Added.',
  noted: 'Saved.',
  tagged: 'Tagged.',
  typed: 'Saved.',
  invited: 'Written. Send it from that event’s outbox whenever you are ready.',
  pushed: 'Added to that event’s list.',
  merged: 'Merged. One record remains.',
  'merge-not-found': 'One of those records could not be found. Nothing changed.',
  'merge-same': 'Those are the same record.',
  'merge-trouble': 'That did not go through, and nothing changed. Worth trying once more.',
  'no-tag': 'Type a word for the tag first.',
  enrolled: 'On the board.',
  'already-enrolled': 'They are on the board already — move their card instead of enrolling them twice.',
  'search-saved': 'Saved.',
  'no-search-name': 'Name the search before saving it.',
};

function directoryPage(principal: Principal, opts: DirectoryOpts, rows: ContactRow[], totalAll: number, note: string): string {
  const { who, whoInitials } = whoLine(principal);
  const shown = rows.length === totalAll ? `${num(totalAll)} contacts` : `${num(rows.length)} of ${num(totalAll)} contacts`;
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Speaker database</h1>' +
    `<p class="counts"><b>${esc(shown)}</b><span class="sep">·</span>every conference, one list</p></div>` +
    (note ? noteBox(note) : '') +
    filterForm(opts) +
    saveSearchForm(opts) +
    (rows.length
      ? directoryTable(rows)
      : '<div class="state-out"><h2>Nobody found.</h2><p>Try a different search, or add somebody by hand below.</p></div>') +
    addContactForm();
  return page({
    title: `Speaker database · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '', who, whoInitials, body }),
  });
}

/* ------------------------------------------------------------------ *
 * One contact — CRM-03, CRM-04, CRM-06, CRM-10, and the invite gesture
 * ------------------------------------------------------------------ */

function tagsCard(personId: string, tags: string[]): string {
  const chips = tags.length ? tags.map((t) => `<span class="chip plain">${esc(t)}</span>`).join(' ') : '<span class="t-sub">None yet.</span>';
  return (
    '<div class="railbox"><h4>Tags</h4>' +
    `<p style="margin:0 0 10px">${chips}</p>` +
    `<form method="post" action="/admin/crm/${esc(personId)}/tags" style="display:flex;gap:8px">` +
    '<input type="text" name="tag" maxlength="40" placeholder="Add a tag" style="flex:1">' +
    '<button class="btn btn-sm" type="submit">Add</button></form></div>'
  );
}

function speakerTypeCard(personId: string, value: SpeakerType | null): string {
  const opt = (v: SpeakerType, word: string) =>
    `<option value="${v}"${value === v ? ' selected' : ''}>${word}</option>`;
  return (
    '<div class="railbox"><h4>Speaker type</h4>' +
    `<form method="post" action="/admin/crm/${esc(personId)}/type" style="display:flex;gap:8px">` +
    `<select name="value"><option value=""${value ? '' : ' selected'}>Not set</option>${opt('internal', 'Internal')}${opt(
      'external',
      'External'
    )}</select>` +
    '<button class="btn btn-sm" type="submit">Save</button></form></div>'
  );
}

function logisticsCard(personId: string, value: string | null): string {
  return (
    '<div class="railbox"><h4>Travel and logistics</h4>' +
    `<form method="post" action="/admin/crm/${esc(personId)}/logistics">` +
    `<textarea name="logistics" rows="3" maxlength="600" placeholder="Arrival day, dietary notes, anything they need">${esc(
      value ?? ''
    )}</textarea>` +
    '<div class="btnrow" style="margin-top:8px"><button class="btn btn-sm" type="submit">Save</button></div>' +
    '</form></div>'
  );
}

function eventsCard(events: ContactDetail['events']): string {
  if (!events.length) {
    return '<div class="railbox"><h4>Where they have spoken</h4><p class="t-sub" style="margin:0">Nowhere yet.</p></div>';
  }
  const rows = events
    .map((e) => {
      const line = e.submissionTitle
        ? `${esc(e.submissionTitle)}<br><span class="t-sub">${esc(
            label(STATE_LABEL_KEY[e.state as SubmissionState], 'backstage')
          )}</span>`
        : '<span class="t-sub">On the list — no proposal yet</span>';
      return (
        `<p style="margin:0 0 8px"><a class="link" href="/admin/${esc(e.eventSlug)}/people">${esc(
          e.eventName
        )}</a><br>${line}</p>`
      );
    })
    .join('');
  return `<div class="railbox"><h4>Where they have spoken</h4>${rows}</div>`;
}

function notesCard(personId: string, notes: ContactDetail['notes']): string {
  const rows = notes.length
    ? notes
        .map(
          (n) =>
            `<div style="padding:8px 0;border-top:1px solid var(--line)"><p class="serif" style="margin:0">${esc(
              n.body
            )}</p><p class="t-sub" style="margin:4px 0 0">${esc(n.authorName)}</p></div>`
        )
        .join('')
    : '<p class="t-sub" style="margin:0">Nothing written yet.</p>';
  return (
    '<div class="railbox" style="grid-column:1/-1"><h4>Notes</h4>' +
    rows +
    `<form method="post" action="/admin/crm/${esc(personId)}/notes" style="margin-top:12px">` +
    '<textarea name="body" rows="2" maxlength="1000" required placeholder="Met at DevFlow 2026 — strong on CI topics."></textarea>' +
    '<div class="btnrow" style="margin-top:8px"><button class="btn btn-sm" type="submit">Add note</button></div>' +
    '</form></div>'
  );
}

function duplicateBanner(personId: string, dups: ContactDetail['possibleDuplicates']): string {
  if (!dups.length) return '';
  const d = dups[0]!;
  return (
    '<div class="notebox" style="margin-top:16px;border-color:var(--ember)" role="status">' +
    `<p style="margin:0" class="serif">This name is also on <b>${esc(d.email ?? d.name)}</b> — the same person, ` +
    `twice? <a class="link" href="/admin/crm/merge?a=${esc(personId)}&b=${esc(d.personId)}">Compare and merge →</a></p>` +
    '</div>'
  );
}

function pushToEventForm(personId: string, events: AdminEvent[]): string {
  if (!events.length) return '';
  const options = events.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  return (
    '<div class="card card-pad" style="margin-top:22px;max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:4px">Add them to an event</h2>' +
    '<p class="sub" style="margin-bottom:14px">Their name, email, company and bio come with them — nothing to re-type.</p>' +
    `<form method="post" action="/admin/crm/${esc(personId)}/event" style="display:flex;gap:8px">` +
    `<select name="eventId">${options}</select>` +
    '<button class="btn btn-sm" type="submit">Add to event</button></form></div>'
  );
}

function inviteForm(personId: string, events: AdminEvent[]): string {
  const open = events.filter((e) => e.lifecycle === 'open');
  const pool = open.length ? open : events;
  if (!pool.length) return '';
  const options = pool.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  return (
    '<div class="card card-pad" style="margin-top:16px;max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:4px">Invite them to submit</h2>' +
    '<p class="sub" style="margin-bottom:14px">Writes them a personal note with a link to the call for speakers. ' +
    'It waits in that event’s outbox until you send it.</p>' +
    `<form method="post" action="/admin/crm/${esc(personId)}/invite" style="display:flex;gap:8px">` +
    `<select name="eventId">${options}</select>` +
    '<button class="btn btn-sm btn-primary" type="submit">Write the invitation</button></form></div>'
  );
}

function pipelineCard(personId: string, card: ContactDetail['card']): string {
  if (card) {
    return (
      '<div class="card card-pad" style="margin-top:16px;max-width:44em">' +
      '<h2 class="display" style="font-size:20px;margin-bottom:8px">On the sourcing board</h2>' +
      `<p class="sub">Open their card to move it or add a note. <a class="link" href="/admin/crm/pipeline/${esc(
        card.id
      )}">Open the card →</a></p></div>`
    );
  }
  return (
    '<div class="card card-pad" style="margin-top:16px;max-width:44em">' +
    '<h2 class="display" style="font-size:20px;margin-bottom:4px">Not being sourced yet</h2>' +
    `<form method="post" action="/admin/crm/${esc(personId)}/pipeline" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">` +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">Fit, out of 100 <span class="opt">Optional</span></span>' +
    '<input type="number" name="score" min="0" max="100" style="width:90px"></label>' +
    '<label class="f" style="margin-bottom:0;flex:1;min-width:200px"><span class="f-lab">Why <span class="opt">Optional</span></span>' +
    '<input type="text" name="rationale" maxlength="300"></label>' +
    '<button class="btn btn-sm" type="submit">Add to the board</button>' +
    '</form></div>'
  );
}

function contactPage(principal: Principal, detail: ContactDetail, events: AdminEvent[], note: string): string {
  const { who, whoInitials } = whoLine(principal);
  const role = [detail.jobTitle, detail.organisation].filter((v): v is string => Boolean(v)).map((v) => esc(v)).join(' · ');
  const crumb = `<a href="/admin/crm">Speaker database</a><span> / </span>${esc(detail.name)}`;
  const body =
    '<div style="padding:20px 0 0;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
    `<span class="avwrap">${avatar(initialsOf(detail.name), detail.name, 56)}</span>` +
    '<div style="flex:1;min-width:min(100%,260px)">' +
    `<h1 class="display" style="font-size:clamp(24px,3.6vw,30px)">${esc(detail.name)}</h1>` +
    (role ? `<p class="sub" style="margin-top:4px;font-size:14.5px">${role}</p>` : '') +
    `<p style="margin-top:6px">${statusChip(detail.status)}</p>` +
    '</div></div>' +
    (detail.bio ? `<p class="serif" style="margin-top:16px;font-size:16.5px;line-height:1.6;max-width:44em">${esc(detail.bio)}</p>` : '') +
    (note ? noteBox(note) : '') +
    duplicateBanner(detail.personId, detail.possibleDuplicates) +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:22px">' +
    `<div class="railbox"><h4>Contact</h4><p style="margin:0">${esc(detail.email ?? '—')}</p>${
      detail.phone ? `<p style="margin:6px 0 0">${esc(detail.phone)}</p>` : ''
    }</div>` +
    eventsCard(detail.events) +
    speakerTypeCard(detail.personId, detail.speakerType) +
    tagsCard(detail.personId, detail.tags) +
    notesCard(detail.personId, detail.notes) +
    '</div>' +
    logisticsCard(detail.personId, detail.logistics) +
    pipelineCard(detail.personId, detail.card) +
    pushToEventForm(detail.personId, events) +
    inviteForm(detail.personId, events);
  return page({
    title: `${detail.name} · Speaker database`,
    register: 'backstage',
    body: crmShell({ here: '', who, whoInitials, crumb, body }),
  });
}

/* ------------------------------------------------------------------ *
 * The sourcing board — CRM-07, CRM-08
 * ------------------------------------------------------------------ */

function boardCard(c: PipelineCard): string {
  return (
    `<a class="card card-pad" href="/admin/crm/pipeline/${esc(c.cardId)}" ` +
    'style="display:block;margin-bottom:10px;text-decoration:none;color:inherit">' +
    `<div class="t-name" style="font-size:14.5px">${esc(c.name)}</div>` +
    (c.organisation ? `<div class="t-sub">${esc(c.organisation)}</div>` : '') +
    (c.score !== null ? `<div class="t-sub" style="margin-top:4px">Fit ${esc(String(c.score))} / 100</div>` : '') +
    '</a>'
  );
}

function boardPage(principal: Principal, board: Awaited<ReturnType<typeof pipelineBoard>>, note: string): string {
  const { who, whoInitials } = whoLine(principal);
  const cols = board.stages
    .map(
      (s) =>
        `<div style="min-width:220px;flex:1"><h3 style="font-size:13px;letter-spacing:.05em;text-transform:uppercase;` +
        `color:var(--muted);margin-bottom:10px">${esc(s.word)} · ${esc(String(s.cards.length))}</h3>` +
        (s.cards.length ? s.cards.map(boardCard).join('') : '<p class="t-sub">Nobody here.</p>') +
        '</div>'
    )
    .join('');
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Sourcing</h1>' +
    '<p class="counts">Tracking somebody before they have a proposal — enroll them from their record in the ' +
    '<a class="link" href="/admin/crm">speaker database</a>.</p></div>' +
    (note ? noteBox(note) : '') +
    `<div style="display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;margin-top:16px">${cols}</div>`;
  return page({
    title: `Sourcing · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '/pipeline', who, whoInitials, body }),
  });
}

function cardPage(principal: Principal, card: Awaited<ReturnType<typeof cardDetail>>, note: string): string {
  if (!card) return deniedPage('That card is not here.');
  const { who, whoInitials } = whoLine(principal);
  const stageOptions = PIPELINE_STAGES.filter((s) => s.value !== card.stage)
    .map((s) => `<option value="${esc(s.value)}">${esc(s.word)}</option>`)
    .join('');
  const history = card.history.length
    ? card.history
        .map((h) => {
          const from = h.fromStage ? PIPELINE_STAGES.find((s) => s.value === h.fromStage)?.word ?? h.fromStage : 'Enrolled';
          const to = PIPELINE_STAGES.find((s) => s.value === h.toStage)?.word ?? h.toStage;
          const when = new Date(h.createdAt).toISOString().replace('T', ' ').slice(0, 16);
          return `<p style="margin:0 0 6px" class="t-sub">${esc(when)} — ${esc(from)} → ${esc(to)}</p>`;
        })
        .join('')
    : '<p class="t-sub" style="margin:0">Nothing moved yet.</p>';
  const notes = card.notes.length
    ? card.notes
        .map(
          (n) =>
            `<div style="padding:8px 0;border-top:1px solid var(--line)"><p class="serif" style="margin:0">${esc(
              n.body
            )}</p><p class="t-sub" style="margin:4px 0 0">${esc(n.authorName)}</p></div>`
        )
        .join('')
    : '<p class="t-sub" style="margin:0">Nothing written yet.</p>';

  const crumb = `<a href="/admin/crm/pipeline">Sourcing</a><span> / </span>${esc(card.name)}`;
  const body =
    '<div style="padding:20px 0 0"><h1 class="display" style="font-size:clamp(24px,3.6vw,30px)">' +
    `${esc(card.name)}</h1>` +
    (card.organisation ? `<p class="sub" style="margin-top:4px">${esc(card.organisation)}</p>` : '') +
    `<p style="margin-top:8px"><span class="chip s-undecided">${esc(
      PIPELINE_STAGES.find((s) => s.value === card.stage)?.word ?? card.stage
    )}</span></p></div>` +
    (note ? noteBox(note) : '') +
    (card.rationale ? `<p class="serif" style="margin-top:12px;max-width:44em">${esc(card.rationale)}</p>` : '') +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:22px">' +
    `<div class="railbox"><h4>Move to another stage</h4>` +
    `<form method="post" action="/admin/crm/pipeline/${esc(card.cardId)}/move" style="display:flex;gap:8px">` +
    `<input type="hidden" name="from" value="${esc(card.stage)}">` +
    `<select name="to">${stageOptions}</select>` +
    '<button class="btn btn-sm" type="submit">Move</button></form></div>' +
    `<div class="railbox"><h4>Stage history</h4>${history}</div>` +
    `<div class="railbox" style="grid-column:1/-1"><h4>Notes</h4>${notes}` +
    `<form method="post" action="/admin/crm/pipeline/${esc(card.cardId)}/notes" style="margin-top:12px">` +
    '<textarea name="body" rows="2" maxlength="1000" required placeholder="Left a voicemail — follow up next week."></textarea>' +
    '<div class="btnrow" style="margin-top:8px"><button class="btn btn-sm" type="submit">Add note</button></div>' +
    '</form></div>' +
    '</div>' +
    `<p class="sub" style="margin-top:18px"><a class="link" href="/admin/crm/${esc(
      card.personId
    )}">Open their record in the speaker database →</a></p>`;
  return page({
    title: `${card.name} · Sourcing · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '/pipeline', who, whoInitials, crumb, body }),
  });
}

/* ------------------------------------------------------------------ *
 * Saved searches — CRM-09
 * ------------------------------------------------------------------ */

function searchesPage(principal: Principal, segments: Awaited<ReturnType<typeof listSegments>>, note: string): string {
  const { who, whoInitials } = whoLine(principal);
  const rows = segments.length
    ? segments
        .map(
          (s) =>
            `<p style="margin:0 0 10px"><a class="link" href="/admin/crm/searches/${esc(s.id)}">${esc(
              s.name
            )}</a> <span class="t-sub">— ${esc(s.kind === 'dynamic' ? 'live' : 'fixed')} · ${esc(
              String(s.memberCount)
            )} contacts</span></p>`
        )
        .join('')
    : '<div class="state-out"><h2>Nothing saved yet.</h2><p>Search or filter the speaker database, then save it.</p></div>';
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Saved searches</h1>' +
    '<p class="counts">A search you have already built, ready without typing it again.</p></div>' +
    (note ? noteBox(note) : '') +
    rows;
  return page({
    title: `Saved searches · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '/searches', who, whoInitials, body }),
  });
}

function segmentPage(principal: Principal, seg: Awaited<ReturnType<typeof segmentDetail>>): string {
  if (!seg) return deniedPage('That search is not here.');
  const { who, whoInitials } = whoLine(principal);
  const crumb = `<a href="/admin/crm/searches">Saved searches</a><span> / </span>${esc(seg.name)}`;
  const body =
    '<div style="padding:20px 0 0"><h1 class="display">' +
    `${esc(seg.name)}</h1><p class="sub" style="margin-top:4px">${esc(
      seg.kind === 'dynamic' ? 'Live — matches new contacts as they arrive.' : 'Fixed — exactly the contacts saved at the time.'
    )}</p></div>` +
    (seg.rows.length
      ? directoryTable(seg.rows)
      : '<div class="state-out"><h2>Nobody matches right now.</h2></div>');
  return page({
    title: `${seg.name} · Saved searches · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '/searches', who, whoInitials, crumb, body }),
  });
}

/* ------------------------------------------------------------------ *
 * The overview — CRM-12
 * ------------------------------------------------------------------ */

function overviewPage(principal: Principal, d: Awaited<ReturnType<typeof crmDashboard>>): string {
  const { who, whoInitials } = whoLine(principal);
  const tile = (n: number, lab: string) =>
    `<div class="railbox" style="text-align:center"><div style="font-family:var(--serif);font-size:34px;font-weight:600">${esc(
      num(n)
    )}</div><div class="t-sub" style="margin-top:4px">${esc(lab)}</div></div>`;
  const companies = d.topCompanies.length
    ? d.topCompanies
        .map(
          (c) =>
            `<p style="margin:0 0 8px"><a class="link" href="/admin/crm?company=${encodeURIComponent(
              c.organisation
            )}">${esc(c.organisation)}</a> <span class="t-sub">· ${esc(String(c.count))}</span></p>`
        )
        .join('')
    : '<p class="t-sub" style="margin:0">Nobody has a company on file yet.</p>';
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Overview</h1>' +
    '<p class="counts">The speaker database, at a glance.</p></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:16px">' +
    tile(d.totalContacts, 'contacts') +
    tile(d.totalEvents, 'events') +
    tile(d.returningSpeakers, 'have spoken more than once') +
    '</div>' +
    '<div class="railbox" style="margin-top:22px"><h4>Where people work</h4>' +
    companies +
    '</div>';
  return page({
    title: `Overview · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '/overview', who, whoInitials, body }),
  });
}

/* ------------------------------------------------------------------ *
 * Merging a duplicate — CRM-06
 * ------------------------------------------------------------------ */

function mergePage(principal: Principal, a: ContactDetail, b: ContactDetail, note: string): string {
  const { who, whoInitials } = whoLine(principal);
  const side = (c: ContactDetail) =>
    `<div class="railbox"><h4>${esc(c.name)}</h4>` +
    `<p style="margin:0">${esc(c.email ?? '—')}</p>` +
    (c.jobTitle || c.organisation
      ? `<p class="t-sub" style="margin:6px 0 0">${esc([c.jobTitle, c.organisation].filter(Boolean).join(' · '))}</p>`
      : '') +
    (c.bio ? `<p class="serif" style="margin:10px 0 0">${esc(c.bio)}</p>` : '') +
    '</div>';
  const body =
    '<div style="padding:26px 0 0"><h1 class="display">Merge two records</h1>' +
    '<p class="counts">Pick the one that survives. The other folds into it — its proposals, tasks and notes ' +
    'move over, and it stops appearing in the database on its own. This cannot be undone.</p></div>' +
    (note ? noteBox(note) : '') +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:16px">' +
    side(a) +
    side(b) +
    '</div>' +
    '<form method="post" action="/admin/crm/merge" style="margin-top:18px">' +
    `<input type="hidden" name="a" value="${esc(a.personId)}">` +
    `<input type="hidden" name="b" value="${esc(b.personId)}">` +
    '<label style="display:block;margin-bottom:8px"><input type="radio" name="primary" value="a" checked> ' +
    `Keep <b>${esc(a.name)}</b>, fold the other in</label>` +
    '<label style="display:block;margin-bottom:14px"><input type="radio" name="primary" value="b"> ' +
    `Keep <b>${esc(b.name)}</b>, fold the other in</label>` +
    '<div class="btnrow"><button class="btn btn-primary" type="submit">Merge</button>' +
    '<a class="btn" href="/admin/crm">Not yet</a></div>' +
    '</form>';
  return page({
    title: `Merge records · ${NAME}`,
    register: 'backstage',
    body: crmShell({ here: '', who, whoInitials, body }),
  });
}

/* ------------------------------------------------------------------ *
 * Writing to more than one contact — CRM-11
 * ------------------------------------------------------------------ */

function composeForm(ids: string[], names: string[], events: AdminEvent[]): string {
  const who = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${num(names.length - 3)} more`;
  const eventOptions = events.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  return (
    '<div style="padding:26px 0 0"><h1 class="display">Write to the speakers you picked</h1>' +
    `<p class="counts">${esc(who || 'Nobody')}</p></div>` +
    '<form class="card card-pad" style="margin-top:16px;max-width:44em" method="post" action="/admin/crm/bulk-email/preview">' +
    ids.map((id) => `<input type="hidden" name="pid" value="${esc(id)}">`).join('') +
    '<label class="f"><span class="f-lab">Which event this is about</span>' +
    `<select name="eventId">${eventOptions}</select></label>` +
    '<label class="f"><span class="f-lab">Subject</span>' +
    '<input type="text" name="subject" required maxlength="120" placeholder="Speak at DevFlow Conf 2027?"></label>' +
    '<label class="f" style="margin-bottom:0"><span class="f-lab">What you want to say</span>' +
    '<textarea name="body" rows="6" required maxlength="2000" placeholder="{{first_name}}, we would love to have you at {{event}}. Would you send a proposal?"></textarea></label>' +
    '<p class="hint" style="margin-top:8px">Use {{first_name}} and {{event}} — each person gets their own words.</p>' +
    '<div class="btnrow" style="margin-top:14px"><button class="btn btn-primary" type="submit">See how it reads</button></div>' +
    '</form>'
  );
}

function previewPage(ids: string[], subject: string, body: string, eventId: string, rows: ReturnType<typeof previewBulkTemplate>): string {
  const cards = rows
    .map(
      (r) =>
        `<div class="msg"><div class="mk">${esc(r.name)}</div><div>` +
        `<div class="msub">${esc(subject)}</div>` +
        `<div class="mprev" style="white-space:pre-wrap">${esc(r.resolvedBody)}</div></div></div>`
    )
    .join('');
  return (
    '<div style="padding:26px 0 0"><h1 class="display">How it reads, per person</h1>' +
    `<p class="counts">${esc(plural(rows.length, 'letter', 'letters'))}, each with their own name filled in.</p></div>` +
    `<div class="sec">${cards}</div>` +
    '<form method="post" action="/admin/crm/bulk-email/send" style="margin-top:16px">' +
    ids.map((id) => `<input type="hidden" name="pid" value="${esc(id)}">`).join('') +
    `<input type="hidden" name="eventId" value="${esc(eventId)}">` +
    `<input type="hidden" name="subject" value="${esc(subject)}">` +
    `<input type="hidden" name="body" value="${esc(body)}">` +
    `<div class="btnrow"><button class="btn btn-primary" type="submit">Write ${esc(
      plural(rows.length, 'letter', 'letters')
    )}</button><a class="btn" href="/admin/crm">Not yet</a></div>` +
    '</form>'
  );
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${num(n)} ${many}`);

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function currentPrincipal(c: {
  env: Env;
  req: { header: (n: string) => string | undefined };
}): Promise<Principal | null> {
  return principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
}

export function registerCrm(app: Hono<{ Bindings: Env }>): void {
  /* ---------- the directory ---------- */

  app.get('/admin/crm', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const opts: DirectoryOpts = {
        search: c.req.query('q') ?? undefined,
        company: c.req.query('company') ?? undefined,
        jobTitle: c.req.query('title') ?? undefined,
        tag: c.req.query('tag') ?? undefined,
      };
      const d = await crmDirectory(c.env.DB, principal, opts);
      const code = c.req.query('note');
      return c.html(directoryPage(principal, opts, d.rows, d.totalAll, code ? DIRECTORY_NOTES[code] ?? '' : ''));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/contacts', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    try {
      const form = await c.req.parseBody();
      const res = await addManualContact(c.env.DB, principal, {
        name: text(form['name']),
        email: text(form['email']),
        jobTitle: text(form['jobTitle']),
        organisation: text(form['organisation']),
        bio: text(form['bio']),
      });
      if (!res.ok) return c.redirect(`/admin/crm?note=${encodeURIComponent(res.code)}`, 303);
      return c.redirect(`/admin/crm/${encodeURIComponent(res.personId)}?note=added`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- saved searches (before /:personId, so the literal wins) ---------- */

  app.get('/admin/crm/searches', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const segs = await listSegments(c.env.DB, principal);
      const code = c.req.query('note');
      return c.html(searchesPage(principal, segs, code ? DIRECTORY_NOTES[code] ?? '' : ''));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/searches', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    try {
      const form = await c.req.parseBody();
      const name = text(form['name']);
      const kindRaw = text(form['kind']);
      const kind = kindRaw === 'curated' ? 'curated' : 'dynamic';
      const opts: DirectoryOpts = {
        search: text(form['q']) || undefined,
        company: text(form['company']) || undefined,
        jobTitle: text(form['title']) || undefined,
        tag: text(form['tag']) || undefined,
      };
      const res = await saveSegment(c.env.DB, principal, { name, kind, opts });
      const back = `/admin/crm${directoryQueryString(opts) ? `?${directoryQueryString(opts)}` : ''}`;
      if (!res.ok) {
        const sep = back.includes('?') ? '&' : '?';
        return c.redirect(`${back}${sep}note=${res.code === 'no-name' ? 'no-search-name' : 'trouble'}`, 303);
      }
      return c.redirect(`/admin/crm/searches/${encodeURIComponent(res.id)}?note=search-saved`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/admin/crm/searches/:id', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const seg = await segmentDetail(c.env.DB, principal, c.req.param('id'));
      if (!seg) return c.notFound();
      return c.html(segmentPage(principal, seg));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- the overview ---------- */

  app.get('/admin/crm/overview', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const d = await crmDashboard(c.env.DB, principal);
      return c.html(overviewPage(principal, d));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- the sourcing board ---------- */

  app.get('/admin/crm/pipeline', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const board = await pipelineBoard(c.env.DB, principal);
      const code = c.req.query('note');
      return c.html(boardPage(principal, board, code ? DIRECTORY_NOTES[code] ?? '' : ''));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/admin/crm/pipeline/:cardId', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const card = await cardDetail(c.env.DB, principal, c.req.param('cardId'));
      const code = c.req.query('note');
      return c.html(cardPage(principal, card, code ? DIRECTORY_NOTES[code] ?? '' : ''));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/pipeline/:cardId/move', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const cardId = c.req.param('cardId');
    const home = `/admin/crm/pipeline/${encodeURIComponent(cardId)}`;
    try {
      const form = await c.req.parseBody();
      const res = await moveCardStage(c.env.DB, principal, cardId, text(form['from']), text(form['to']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'enrolled' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/pipeline/:cardId/notes', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const cardId = c.req.param('cardId');
    const home = `/admin/crm/pipeline/${encodeURIComponent(cardId)}`;
    try {
      const form = await c.req.parseBody();
      const res = await addCardNote(c.env.DB, principal, cardId, text(form['body']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'noted' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- merging a duplicate ---------- */

  app.get('/admin/crm/merge', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const aId = c.req.query('a') ?? '';
      const bId = c.req.query('b') ?? '';
      const [a, b] = await Promise.all([
        contactDetail(c.env.DB, principal, aId),
        contactDetail(c.env.DB, principal, bId),
      ]);
      if (!a || !b) return c.notFound();
      return c.html(mergePage(principal, a, b, ''));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/merge', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    try {
      const form = await c.req.parseBody();
      const aId = text(form['a']);
      const bId = text(form['b']);
      const primaryPick = text(form['primary']);
      const primaryId = primaryPick === 'b' ? bId : aId;
      const secondaryId = primaryPick === 'b' ? aId : bId;
      const res = await mergeContacts(c.env.DB, principal, primaryId, secondaryId);
      if (!res.ok) {
        return c.redirect(`/admin/crm/merge?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`, 303);
      }
      return c.redirect(`/admin/crm/${encodeURIComponent(primaryId)}?note=merged`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- writing to more than one contact ---------- */

  app.get('/admin/crm/bulk-email', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const ids = c.req.queries('pid') ?? [];
      if (ids.length === 0) return c.redirect('/admin/crm');
      const placeholders = ids.map(() => '?').join(',');
      const [rows, events] = await Promise.all([
        c.env.DB.prepare(`SELECT id, name FROM person WHERE id IN (${placeholders})`)
          .bind(...ids)
          .all<{ id: string; name: string }>(),
        adminEvents(c.env.DB, principal),
      ]);
      const names = rows.results.map((r) => r.name);
      return c.html(composeForm(ids, names, events));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/bulk-email/preview', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    try {
      const form = await c.req.parseBody({ all: true });
      const ids = manyOf(form['pid']);
      const eventId = text(form['eventId']);
      const subject = text(form['subject']);
      const body = text(form['body']);
      if (ids.length === 0) return c.redirect('/admin/crm');

      const [rows, events] = await Promise.all([
        c.env.DB.prepare(`SELECT id, name FROM person WHERE id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids)
          .all<{ id: string; name: string }>(),
        adminEvents(c.env.DB, principal),
      ]);
      const event = events.find((e) => e.id === eventId);
      const eventName = event?.name ?? 'the event';
      const contacts = rows.results.map((r) => ({ personId: r.id, name: r.name }));
      const preview = previewBulkTemplate(contacts, body, eventName);
      return c.html(previewPage(ids, subject, body, eventId, preview));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/bulk-email/send', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    try {
      const form = await c.req.parseBody({ all: true });
      const ids = manyOf(form['pid']);
      const eventId = text(form['eventId']);
      const subject = text(form['subject']);
      const body = text(form['body']);

      const [rows, events] = await Promise.all([
        ids.length
          ? c.env.DB.prepare(`SELECT id, name FROM person WHERE id IN (${ids.map(() => '?').join(',')})`)
              .bind(...ids)
              .all<{ id: string; name: string }>()
          : Promise.resolve({ results: [] as { id: string; name: string }[] }),
        adminEvents(c.env.DB, principal),
      ]);
      const event = events.find((e) => e.id === eventId);
      if (!event) return c.redirect('/admin/crm?note=trouble', 303);
      const contacts = rows.results.map((r) => ({ personId: r.id, name: r.name }));
      const res = await crmBulkEmail(c.env.DB, principal, { id: event.id, name: event.name }, contacts, subject, body);
      if (!res.ok) return c.redirect('/admin/crm?note=trouble', 303);
      return c.redirect(`/admin/${encodeURIComponent(event.slug)}/outbox`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------- one contact (the literal routes above all win first) ---------- */

  app.get('/admin/crm/:personId', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in');
    try {
      const personId = c.req.param('personId');
      const [detail, events] = await Promise.all([
        contactDetail(c.env.DB, principal, personId),
        adminEvents(c.env.DB, principal),
      ]);
      if (!detail) return c.notFound();
      const code = c.req.query('note');
      c.header('cache-control', 'private, no-store');
      return c.html(contactPage(principal, detail, events, code ? DIRECTORY_NOTES[code] ?? '' : ''));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/notes', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const res = await addContactNote(c.env.DB, principal, personId, text(form['body']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'noted' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/tags', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const res = await addTag(c.env.DB, principal, personId, text(form['tag']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'tagged' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/type', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const raw = text(form['value']);
      const value = raw === 'internal' || raw === 'external' ? raw : null;
      const res = await setSpeakerType(c.env.DB, principal, personId, value);
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'typed' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/logistics', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const res = await setLogistics(c.env.DB, principal, personId, text(form['logistics']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'typed' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/pipeline', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const scoreRaw = text(form['score']);
      const score = scoreRaw === '' ? null : Number(scoreRaw);
      const res = await enrollInPipeline(c.env.DB, principal, personId, {
        score,
        rationale: text(form['rationale']),
      });
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'enrolled' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/event', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const res = await addToEvent(c.env.DB, principal, personId, text(form['eventId']));
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'pushed' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/crm/:personId/invite', async (c) => {
    const principal = await currentPrincipal(c);
    if (!principal) return c.redirect('/sign-in', 303);
    const personId = c.req.param('personId');
    const home = `/admin/crm/${encodeURIComponent(personId)}`;
    try {
      const form = await c.req.parseBody();
      const eventId = text(form['eventId']);
      const events = await adminEvents(c.env.DB, principal);
      const event = events.find((e) => e.id === eventId);
      if (!event) return c.redirect(`${home}?note=trouble`, 303);
      const origin = new URL(c.req.url).origin;
      const cfpUrl = `${origin}/${event.slug}/cfp`;
      const res = await inviteToSubmit(c.env.DB, principal, { id: event.id, name: event.name }, personId, cfpUrl);
      return c.redirect(`${home}?note=${encodeURIComponent(res.ok ? 'invited' : res.code)}`, 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });
}


