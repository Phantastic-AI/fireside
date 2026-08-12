// S-20 — Settings. The event's own controls, in four sections, in the order a
// person actually needs them: what the conference is, what the call asks, who
// may touch it, and the one link that is handed to strangers with lanyards.
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
  EVENT_ROLES,
  type EventRole,
  type EventSettings,
  type SettingsQuestion,
} from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
import {
  saveEventFacts,
  saveQuestions,
  addToTeam,
  changeStanding,
  takeOffTeam,
  newGreenRoomLink,
  type Said,
  type QuestionDraft,
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
  organizer: 'Organizer',
};

const STANDING_POWER: Record<EventRole, string> = {
  owner: 'Everything, including who else is on this list.',
  approver: 'Decides proposals and sends the letters. Changes the event too.',
  editor: 'Changes the event, the questions and the agenda. Does not decide.',
  viewer: 'Reads the proposals and the program. Changes nothing.',
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

type Section = 'event' | 'questions' | 'team' | 'link';

const ANCHOR: Record<Section, string> = {
  event: 'the-event',
  questions: 'the-questions',
  team: 'the-team',
  link: 'the-link',
};

type Outcome = { where: Section; line: string; refused: boolean };

const SAID: Record<Said, Outcome> = {
  event_saved: { where: 'event', line: 'Saved. The public page and the call read from this.', refused: false },
  event_name_needed: { where: 'event', line: 'A conference needs a name. Nothing was changed.', refused: true },
  event_cap: {
    where: 'event',
    line: 'How many proposals per person has to be a whole number from one to ten. Nothing was changed.',
    refused: true,
  },
  event_date: {
    where: 'event',
    line: 'The decision date is written as 2026-08-27. Nothing was changed.',
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

  team_added: { where: 'team', line: 'Added. They see this conference the next time they sign in.', refused: false },
  team_role_changed: { where: 'team', line: 'Changed. It takes effect on their next screen.', refused: false },
  team_removed: { where: 'team', line: 'Taken off. They no longer see this conference.', refused: false },
  team_email_needed: { where: 'team', line: 'An email address is needed. Nothing was changed.', refused: true },
  team_no_person: {
    where: 'team',
    line: 'Nobody signs in with that address. Ask them to make an account first, then add them here.',
    refused: true,
  },
  team_already: { where: 'team', line: 'They are already on this conference. Their standing is in the list.', refused: true },
  team_gone: { where: 'team', line: 'That person is no longer on this conference. Nothing was changed.', refused: true },
  team_last_owner: {
    where: 'team',
    line: 'That would leave the conference with nobody who owns it. Make somebody else an owner first.',
    refused: true,
  },
  team_standing_unknown: { where: 'team', line: 'That is not one of the four standings. Nothing was changed.', refused: true },
  team_moved: { where: 'team', line: 'The list changed while this page was open. This is how it stands now.', refused: true },

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
  if (out.where !== here) return '';
  return (
    `<div class="notebox" style="margin:0 0 16px${out.refused ? ';border-left-color:var(--danger)' : ''}">` +
    esc(out.line) +
    '</div>'
  );
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
}): string {
  const control = o.area
    ? `<textarea name="${esc(o.name)}" rows="${o.rows ?? 4}"` +
      (o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : '') +
      `>${esc(o.value)}</textarea>`
    : `<input type="${o.type ?? 'text'}" name="${esc(o.name)}" value="${esc(o.value)}"` +
      (o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : '') +
      '>';
  return (
    '<label class="f"><span class="f-lab">' +
    esc(o.labelText) +
    (o.optional ? '<span class="opt">optional</span>' : '') +
    '</span>' +
    control +
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
    field({ name: 'name', labelText: 'What it is called', value: ev.name }) +
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
      hint: 'Once somebody reaches it, the call stops taking new ones from them and points them at their portal.',
    }) +
    field({
      name: 'decide_by',
      labelText: 'Decisions go out by',
      value: ev.decideBy ?? '',
      placeholder: '2026-08-27',
      hint: 'The date the call promises and every letter repeats. Written as 2026-08-27.',
    }) +
    '<div class="btnrow"><button class="btn btn-primary" type="submit">Save the event</button>' +
    `<a class="btn" href="/${encodeURIComponent(ev.slug)}/cfp">See the call ↗</a>` +
    `<a class="btn" href="/${encodeURIComponent(ev.slug)}">See the public page ↗</a></div>` +
    '</form></div>'
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
    '<p class="hint" style="margin-bottom:14px">Editing the words never touches an answer somebody already gave — ' +
    'answers are kept under the question they were asked, not under what it was called.</p>' +
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
 * 3 — the team (D-026)
 * ------------------------------------------------------------------ */

function teamSection(ev: EventSettings, said: Said | null, confirmOff: string | null): string {
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
        hint: 'It has to be an address that already signs in here. Nothing is sent to them and nothing is created — this page will say so if it finds nobody.',
      }) +
      `<label class="f"><span class="f-lab">What they may do</span>${standingSelect('role', 'viewer', 'What they may do')}</label>` +
      '<div class="btnrow"><button class="btn btn-primary" type="submit">Add them</button></div>' +
      '</form>'
    : '<p class="hint" style="margin-top:12px">Only an owner changes who is on this list.</p>';

  return (
    `<div class="sec" id="${ANCHOR.team}">` +
    '<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">' +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The team</h3>' +
    `<span class="t-sub" style="margin-left:auto">${esc(plural(ev.teamCount, 'person', 'people'))}` +
    `<span class="sep">·</span>${esc(plural(ev.ownerCount, 'owner', 'owners'))}</span>` +
    '</div>' +
    '<p class="hint" style="margin-bottom:14px">Everybody here signs in as themselves. A conference always keeps at least one owner.</p>' +
    saidIn('team', said) +
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
    questionsSection(ev, o.said) +
    teamSection(ev, o.said, confirmOff) +
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

const back = (slug: string, said: Said): string =>
  `/admin/${encodeURIComponent(slug)}/settings?note=${encodeURIComponent(said)}#${ANCHOR[SAID[said].where]}`;

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
      ev = await eventSettings(c.env.DB, principal, c.req.param('eventSlug'));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
    if (!ev) return c.notFound();

    const note = c.req.query('note') ?? '';
    // These screens hold email addresses and a link that needs no sign-in.
    c.header('cache-control', 'private, no-store');
    return c.html(
      settingsPage({
        ev,
        principal,
        said: isSaid(note) ? note : null,
        confirm: c.req.query('confirm') ?? null,
        who: c.req.query('who') ?? null,
        origin: new URL(c.req.url).origin,
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

  app.post('/admin/:eventSlug/settings/team/add', (c) =>
    write(c, (principal, eventId, body) => {
      const { text } = reader(body);
      return addToTeam(c.env.DB, principal, eventId, text('email'), text('role'));
    })
  );

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
}
