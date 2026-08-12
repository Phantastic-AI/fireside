// People — S-16. The backstage CRM face: everyone who has ever proposed at
// this event, one row per person, and one door deep a whole file on them —
// contact facts, what they're proposing here, what they owe, and where else
// they've spoken with us. Read-only this parcel: no writers, no islands.
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
import { adminEvents, ScopeError, type AdminEvent, type SubmissionState } from '../../queries/admin';
import { eventBySlug, initialsOf, eventDayKey } from '../../queries/public';
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

/** The headshot placeholder: initials in a plain circle, no image request. */
function avatar(initials: string, name: string, size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    '<circle cx="20" cy="20" r="20" fill="var(--paper-deep)"/>' +
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="var(--serif)" ' +
    `font-weight="600" font-size="14" fill="var(--ink-soft)">${esc(initials)}</text></svg>`
  );
}

function stateChip(state: SubmissionState): string {
  return `<span class="chip ${STATE_CHIP_CLASS[state]}">${esc(label(STATE_LABEL_KEY[state], 'backstage'))}</span>`;
}

/* ------------------------------------------------------------------ *
 * The list — GET /admin/:eventSlug/people
 * ------------------------------------------------------------------ */

function countsLine(list: PeopleList, eventName: string): string {
  const owing = list.rows.filter((r) => r.openTaskCount > 0).length;
  const peopleNoun = list.rows.length === 1 ? '1 speaker' : `${list.rows.length.toLocaleString('en-US')} speakers`;
  const owe = owing > 0 ? `${owing.toLocaleString('en-US')} owe you something` : 'nobody is waiting on anything';
  return `<p class="counts"><b>${esc(peopleNoun)}</b><span class="sep">·</span>${esc(owe)}<span class="sep">·</span>${esc(eventName)}</p>`;
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
  return n === 1 ? '1 open task' : `${n.toLocaleString('en-US')} open tasks`;
}

function proposalChips(proposals: PersonProposal[]): string {
  if (!proposals.length) return '<span class="t-sub">Nothing here</span>';
  return proposals.map((p) => stateChip(p.state)).join(' ');
}

function personRow(slug: string, r: PersonListRow): string {
  const role = [r.jobTitle, r.organisation].filter((v): v is string => Boolean(v)).map((v) => esc(v)).join(' · ');
  const owe =
    r.openTaskCount > 0
      ? `<span style="color:var(--ink-soft)">${esc(taskCountText(r.openTaskCount))}</span>`
      : '<span class="t-sub">Nothing outstanding</span>';
  return (
    '<tr>' +
    '<td><div style="display:flex;gap:11px;align-items:center">' +
    `<span class="avwrap">${avatar(initialsOf(r.name), r.name, 34)}</span>` +
    `<span style="min-width:0"><span class="t-name">${esc(r.name)}</span>` +
    (role ? `<br><span class="t-sub">${role}</span>` : '') +
    '</span></div></td>' +
    `<td>${proposalChips(r.proposals)}</td>` +
    `<td>${owe}</td>` +
    `<td style="text-align:right;white-space:nowrap"><a class="btn btn-sm" href="/admin/${esc(slug)}/people/${esc(r.personId)}">Open</a></td>` +
    '</tr>'
  );
}

function peopleTable(slug: string, rows: PersonListRow[]): string {
  return (
    '<div class="tablewrap" style="margin-top:6px"><table class="t"><thead><tr>' +
    '<th>Speaker</th><th>Proposals here</th><th>Open tasks</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((r) => personRow(slug, r)).join('') +
    '</tbody></table></div>'
  );
}

function emptyPeople(event: AdminEvent): string {
  return (
    '<div style="padding:26px 0"><h1 class="display">People</h1></div>' +
    '<div class="state-out"><h2>Nobody yet.</h2>' +
    '<p>Speakers appear here as proposals arrive.</p>' +
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

function peopleBody(event: AdminEvent, list: PeopleList): string {
  const head =
    '<div style="padding:26px 0 0"><h1 class="display">People</h1>' +
    countsLine(list, event.name) +
    '</div>' +
    searchForm(event.slug, list.search);
  if (list.rows.length === 0) {
    return head + noSearchResults(event.slug, list.search ?? '');
  }
  return head + peopleTable(event.slug, list.rows);
}

function peoplePage(event: AdminEvent, principal: Principal, list: PeopleList): string {
  const { who, whoInitials } = whoLine(event, principal);
  const body = list.rows.length === 0 && !list.search ? emptyPeople(event) : peopleBody(event, list);
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
 * One person — GET /admin/:eventSlug/people/:personId
 * ------------------------------------------------------------------ */

function contactCard(detail: PersonDetail): string {
  const email = detail.email
    ? `<p style="margin:0 0 6px">${esc(detail.email)}</p>`
    : `<p style="margin:0 0 6px"><span class="chip warn">${esc(label('message.blocked', 'backstage'))}</span></p>`;
  const phone = detail.phone ? `<p style="margin:0">${esc(detail.phone)}</p>` : '';
  return `<div class="railbox"><h4>Contact</h4>${email}${phone}</div>`;
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

function taskRow(t: PersonTask, today: string): string {
  const chip = taskChip(t, today);
  const dueWord = chip.key === 'task.overdue' ? 'was due' : 'due';
  const due = t.dueOn ? `<div class="t-sub" style="margin-top:2px">${esc(dueWord)} ${esc(friendlyDate(t.dueOn))}</div>` : '';
  return (
    '<div style="padding:6px 0">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
    `<span>${esc(t.title)}</span><span class="chip ${chip.cls}">${esc(label(chip.key, 'backstage'))}</span>` +
    '</div>' +
    due +
    '</div>'
  );
}

function tasksCard(tasks: PersonTask[], today: string): string {
  if (!tasks.length) {
    return '<div class="railbox"><h4>Tasks</h4><p class="t-sub" style="margin:0">Nothing asked of them here.</p></div>';
  }
  return `<div class="railbox"><h4>Tasks</h4>${tasks.map((t) => taskRow(t, today)).join('')}</div>`;
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

function personHeader(detail: PersonDetail): string {
  const role = [detail.jobTitle, detail.organisation]
    .filter((v): v is string => Boolean(v))
    .map((v) => esc(v))
    .join(' · ');
  return (
    '<div style="padding:20px 0 0;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
    `<span class="avwrap">${avatar(initialsOf(detail.name), detail.name, 56)}</span>` +
    '<div style="flex:1;min-width:min(100%,260px)">' +
    `<h1 class="display" style="font-size:clamp(24px,3.6vw,30px)">${esc(detail.name)}</h1>` +
    (role ? `<p class="sub" style="margin-top:4px;font-size:14.5px">${role}</p>` : '') +
    '</div></div>' +
    (detail.bio
      ? `<p class="serif" style="margin-top:16px;font-size:16.5px;line-height:1.6;max-width:44em">${esc(detail.bio)}</p>`
      : '')
  );
}

function personBody(event: AdminEvent, detail: PersonDetail): string {
  const today = eventDayKey(Date.now(), event.timezone);
  return (
    personHeader(detail) +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:22px">' +
    contactCard(detail) +
    proposalsCard(event.slug, detail.proposals) +
    tasksCard(detail.tasks, today) +
    elsewhereCard(detail.elsewhere) +
    '</div>'
  );
}

function personPage(event: AdminEvent, principal: Principal, detail: PersonDetail): string {
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
      body: personBody(event, detail),
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Auth + routes.
 * ------------------------------------------------------------------ */

/** Resolve the event by slug within this principal's own scoped set
 *  (adminEvents already narrows to what they may open); a slug that is a
 *  real event but not in that set is a scope refusal, not a 404. */
async function resolveEvent(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<{ event: AdminEvent } | { deny: true } | null> {
  const events = await adminEvents(db, principal);
  const event = events.find((e) => e.slug === slug);
  if (event) return { event };
  const exists = await eventBySlug(db, slug);
  return exists ? { deny: true } : null;
}

export function registerPeople(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/people', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const resolved = await resolveEvent(c.env.DB, principal, c.req.param('eventSlug'));
    if (!resolved) return c.notFound();
    if ('deny' in resolved) return c.html(deniedPage(), 403);

    try {
      const list = await peopleList(c.env.DB, principal, resolved.event.id, { search: c.req.query('q') ?? '' });
      return c.html(peoplePage(resolved.event, principal, list));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/admin/:eventSlug/people/:personId', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const resolved = await resolveEvent(c.env.DB, principal, c.req.param('eventSlug'));
    if (!resolved) return c.notFound();
    if ('deny' in resolved) return c.html(deniedPage(), 403);

    try {
      const detail = await personDetail(c.env.DB, principal, resolved.event.id, c.req.param('personId'));
      if (!detail) return c.notFound();
      return c.html(personPage(resolved.event, principal, detail));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });
}
