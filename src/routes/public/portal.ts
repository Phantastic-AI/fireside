// S-5 — the speaker portal. Priya's screen: eleven minutes on a sofa, on a
// phone, at 21:40, asking one question — "where do things stand with my talk?"
// Every lane answers it in the first line, with a date rather than a status.
//
// Two register laws hold every sentence here:
//   D-025 — every heading parses cold to a stranger.
//   D-027 — the product never narrates its own construction. Nothing on this
//           page knows it is new.
//
// The read is queries/portal.ts and nothing else. That query owns the not-told
// invariant (a decision that has been made but not sent is invisible here), so
// this file never re-derives it: it renders view.submissions[].state as given.
// The writes are workflows/portal-actions.ts, which return an outcome word;
// the sentences for those outcomes live here, because they are the screen's.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, eventNav, onstageShell, conferenceMasthead } from '../../lib/html';
import { label, type LabelKey } from '../../lib/labels';
import { eventBySlug, type EventHome } from '../../queries/public';
import {
  portalView,
  type PortalMessage,
  type PortalSubmission,
  type PortalTask,
  type PortalView,
} from '../../queries/portal';
import { principalFromCookie } from '../../workflows/account';
import { completeTask, withdrawProposal, type WriteOutcome } from '../../workflows/portal-actions';
// Who else is on a talk. The read lives beside the writer that keeps it true
// (workflows/submit.ts), the same way the call's own tracks do; queries/portal.ts
// is its tidier long-term home.
import { peopleOnTalks } from '../../workflows/submit';
import {
  saveHeadshot,
  saveDeck,
  saveProfile,
  decksForTasks,
  deckVersionsForTasks,
  filePart,
  tooLargeToRead,
  BIO_MAX,
  DECK_ACCEPT,
  DECK_LINE,
  DECK_MAX_BYTES,
  PHOTO_ACCEPT,
  PHOTO_LINE,
  PHOTO_MAX_BYTES,
  type FileOutcome,
  type StoredFile,
  type FileVersion,
} from '../../workflows/files';
import { commentsForTasks, type FileComment } from '../../queries/comments';
import { postCommentAsSpeaker, COMMENT_MAX } from '../../workflows/comments';
// Δ helper — someone who helps a speaker with their logistics without being
// on the program. helpersOfSpeaker/helpingAt/taskActorId are reads
// (queries/helpers.ts); addHelper/removeHelper are the speaker's own two
// writes (workflows/helpers.ts). Task completion and deck upload still go
// through completeTask/saveDeck exactly as they do for a speaker acting on
// their own behalf — taskActorId only resolves *whose* row that call is
// allowed to touch.
import { helpersOfSpeaker, helpingAt, taskActorId, type Helper, type Helping } from '../../queries/helpers';
import { addHelper, removeHelper, type HelperOutcome } from '../../workflows/helpers';

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/**
 * A label that may be missing. Formats and levels arrive from the database as
 * stored values, and a value with no row in 02 §6 must not print raw and must
 * not take the page down with it — it simply says nothing.
 */
function word(key: string): string {
  try {
    return label(key as LabelKey, 'onstage');
  } catch {
    return '';
  }
}

// Stored value → label key. The words still live in one place; this only says
// which row to read. (The seeded world stores formats as 'Talk' / 'Workshop' /
// 'Lightning talk' and levels as 'intro' / 'practitioner' / 'deep'.)
const FORMAT_KEYS: Record<string, string> = {
  talk: 'format.talk',
  workshop: 'format.workshop',
  panel: 'format.panel',
  lightning: 'format.lightning',
  'lightning talk': 'format.lightning',
};
const formatWord = (v: string): string => word(FORMAT_KEYS[v.trim().toLowerCase()] ?? '');

/** Fill a label's {tokens}. Values arrive already escaped; the replacer is a
 *  function so a '$' inside a room name stays a '$'. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');
}

/* ------------------------------------------------------------------ *
 * Dates and durations — the portal's whole vocabulary of reassurance
 * ------------------------------------------------------------------ */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec'];

type Parts = { y: number; m: number; d: number; hh: number; mi: number; dow: number };

/** An instant, read on the event's own clock. Intl supplies the numbers and
 *  the month names come from the arrays above, so the words are the
 *  prototype's exactly and cannot drift with a runtime's locale tables. */
function partsOf(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(f.find((p) => p.type === t)?.value ?? '0');
  const y = n('year');
  const m = n('month');
  const d = n('day');
  return { y, m, d, hh: n('hour') % 24, mi: n('minute'), dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** A calendar day ('2026-08-28') is a date, not an instant: no timezone applies. */
function partsOfIso(iso: string): Parts {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return { y, m, d, hh: 0, mi: 0, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** "20 August" */
const long = (p: Parts): string => `${p.d} ${MONTHS[p.m - 1]}`;
/** "4 Aug" */
const short = (p: Parts): string => `${p.d} ${MONTHS_SHORT[p.m - 1]}`;
/** "Friday 4 Sep" */
const dayLong = (p: Parts): string => `${DAYS[p.dow]} ${p.d} ${MONTHS_SHORT[p.m - 1]}`;
/** "10:30", on the event's own clock. */
const clock = (p: Parts): string => `${pad(p.hh)}:${pad(p.mi)}`;

const dLong = (ms: number, tz: string): string => long(partsOf(ms, tz));
const dShort = (ms: number, tz: string): string => short(partsOf(ms, tz));
const dDayLong = (ms: number, tz: string): string => dayLong(partsOf(ms, tz));
const dTime = (ms: number, tz: string): string => clock(partsOf(ms, tz));
/** CNT: "4 Aug, 21:40" — a version or a comment is not always the day's only
 *  one, so unlike every other stamp on this page, these two always carry the
 *  clock: a date alone gives nobody a way to order two saves on one day. */
const dShortTime = (ms: number, tz: string): string => `${dShort(ms, tz)}, ${dTime(ms, tz)}`;
const isoLong = (iso: string): string => long(partsOfIso(iso));
const isoDayLong = (iso: string): string => dayLong(partsOfIso(iso));

/** The prototype's own rendering of a length. */
const mins = (m: number): string => (m >= 90 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`);

/* ------------------------------------------------------------------ *
 * Small pieces of markup
 * ------------------------------------------------------------------ */

const AVPAL: [string, string][] = [
  ['#F3DDC6', '#8A4E1C'],
  ['#DDE8E4', '#1F5B4E'],
  ['#EEDCE4', '#7B3352'],
  ['#E3E1EF', '#3F3A72'],
  ['#EFE6C9', '#6B5A15'],
  ['#E0EAEF', '#1E5468'],
  ['#F0DFD8', '#8C3B2B'],
  ['#DFE9D6', '#3E5C26'],
];

function hashOf(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

/** The prototype's generated portrait: tinted ground, one warm light, initials
 *  in the serif face. No image request leaves the page. */
function avatar(name: string, initials: string, size: number): string {
  const pair = AVPAL[hashOf(name) % AVPAL.length] ?? AVPAL[0]!;
  const seed = hashOf(`${name}·`);
  const ax = (26 + (seed % 9)) / 40;
  const ay = (8 + ((seed >> 3) % 9)) / 40;
  return (
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    `<defs><radialGradient id="g${seed}" cx="${ax}" cy="${ay}" r="1">` +
    `<stop offset="0" stop-color="#fff" stop-opacity=".72"/>` +
    `<stop offset=".55" stop-color="${pair[0]}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="20" cy="20" r="20" fill="${pair[0]}"/>` +
    `<circle cx="20" cy="20" r="20" fill="url(#g${seed})"/>` +
    `<text x="20" y="21" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="Iowan Old Style,Palatino,Georgia,serif" font-size="15" font-weight="600" ` +
    `fill="${pair[1]}">${esc(initials)}</text>` +
    `<circle cx="20" cy="20" r="19.4" fill="none" stroke="rgba(34,30,23,.12)" stroke-width="1.2"/></svg>`
  );
}

/** The speaker's own face: their photograph once they have sent one, and the
 *  generated portrait until then. Same circle, same size, so the page does not
 *  jump the moment a photograph arrives. */
function face(p: { name: string; initials: string; headshotFileId: string | null }, size: number): string {
  if (!p.headshotFileId) return avatar(p.name, p.initials, size);
  return (
    `<img class="av" src="/files/${esc(p.headshotFileId)}" alt="${esc(p.name)}" ` +
    `width="${size}" height="${size}" ` +
    `style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;` +
    'border:1px solid rgba(34,30,23,.12);flex:none">'
  );
}

/** The committee's own words, kept in their own box and never paraphrased. */
function committeeNote(text: string): string {
  return (
    '<div class="notebox" style="margin-top:12px">' +
    '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">From the committee</b>' +
    `<p style="margin:6px 0 0" class="serif">${esc(text)}</p></div>`
  );
}

/* ------------------------------------------------------------------ *
 * What just happened. One closed set of codes in the URL, one sentence
 * each here — no free text ever travels through a query string.
 * ------------------------------------------------------------------ */

const NOTES: Record<string, string> = {
  edited: 'Saved. Those are the words on it now.',
  withdrawn: 'That one is withdrawn. It has left the committee’s list.',
  'task-done': 'Marked done. Your list is one shorter.',
  saved: 'Saved. That is how you appear on the program now.',
  photo: 'That is your photograph now. It goes wherever your name does.',
  deck: 'Your slides are in. The organizers can see them from here on.',
  commented: 'Added. It is on the thread now, and the organizers can read it.',
  'no-comment': 'Nothing was written, so nothing was added.',
  'too-big': 'That one is over the size we can take, so nothing changed. The size is written ' +
    'beside the picker.',
  'wrong-kind': 'We cannot take that kind, so nothing changed. The kinds we can take are ' +
    'written beside the picker.',
  nothing: 'Nothing came through. Choose a file and send it again.',
  moved: 'That had already moved before this page opened. What you see now is where it stands.',
  // Sent here by the edit form when the words are no longer the speaker's to
  // change. It says what is true of every proposal the committee is holding,
  // and nothing that is true of only some of them — read the page it comes
  // from (routes/public/edit.ts, inHandPage) before changing a word of it.
  'in-hand': 'The committee has this talk in hand. While they read, the words stay as you sent them.',
  refused: 'The committee has moved this talk on, so it can no longer be withdrawn here.',
  trouble: 'That did not go through, and nothing has changed. Worth trying once more.',
  // Δ helper — the words live in lib/labels.ts (helper.*, alongside the rest
  // of the feature's copy); these entries only wire them into the one
  // code→sentence door this page already has for everything else.
  'helper-added': label('helper.added', 'onstage'),
  'helper-removed': label('helper.removed', 'onstage'),
  'helper-no-name': label('helper.no_name', 'onstage'),
  'helper-no-email': label('helper.no_email', 'onstage'),
  'helper-self': label('helper.self', 'onstage'),
};

function noteLine(code: string | undefined): string {
  const text = code ? NOTES[code] : undefined;
  if (!text) return '';
  return (
    '<div class="notebox" style="margin-top:18px" role="status">' +
    `<p style="margin:0" class="serif">${esc(text)}</p></div>`
  );
}

/* ------------------------------------------------------------------ *
 * The signed-out door
 * ------------------------------------------------------------------ */

function signedOutPage(ev: EventHome): string {
  const body =
    '<div class="wrap" style="padding-top:44px">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    '<div class="sec state-out" style="max-width:40em">' +
    '<h2>Sign in to see where your talk stands.</h2>' +
    '<p>Every letter we send carries a link straight back in. Open the most recent one, or sign ' +
    'in with the address on your proposal and we will send a fresh one.</p>' +
    '<div class="btnrow">' +
    `<a class="btn btn-primary btn-lg" href="/sign-in">${esc(label('auth.sign_in', 'onstage'))}</a>` +
    (ev.lifecycle === 'open'
      ? `<a class="btn btn-lg" href="/${esc(ev.slug)}/cfp">Send a proposal</a>`
      : `<a class="btn btn-lg" href="/${esc(ev.slug)}/agenda">See the program</a>`) +
    '</div>' +
    '<p class="aside">Nothing in here is public.</p>' +
    '</div></div>';

  return page({
    title: `Your portal · ${ev.name}`,
    register: 'onstage',
    body: onstageShell(eventNav(ev.slug, '/portal', ev.lifecycle === 'open'), body, ev.slug),
  });
}

/* ------------------------------------------------------------------ *
 * One proposal, one card
 * ------------------------------------------------------------------ */

type Lane = { cls: string; colour: string; head: string; body: string; bot: string };

/** May this speaker still pull it back? Mirrors WITHDRAWABLE in
 *  workflows/portal-actions.ts: with the committee, a maybe, or an acceptance
 *  the public has not been shown. `placement` is non-null only once told and
 *  published, so its absence is exactly "not on a public agenda". */
const withdrawable = (s: PortalSubmission): boolean =>
  s.state === 'submitted' || s.state === 'waitlisted' || (s.state === 'accepted' && !s.placement);

/**
 * May they still change the words? Only while the call is open, and only while
 * the committee has not acted — the two facts the DTO already carries, read and
 * not re-derived. The route behind the door checks the same window again.
 */
const editable = (view: PortalView, s: PortalSubmission): boolean =>
  view.event.lifecycle === 'open' && (s.state === 'draft' || s.state === 'submitted');

const editLink = (slug: string, s: PortalSubmission): string =>
  `<a class="btn" href="/${esc(slug)}/cfp/edit/${esc(s.id)}">Edit this proposal →</a>`;

function withdrawBlock(slug: string, s: PortalSubmission): string {
  return (
    `<details class="task" style="flex:1 1 100%;margin-bottom:0">` +
    '<summary><span class="tname">Withdraw this proposal</span></summary>' +
    '<div class="tbody">' +
    '<p>It leaves the committee’s list, and you cannot put it back.</p>' +
    `<form method="post" action="/${esc(slug)}/portal/withdraw" style="margin-top:10px">` +
    `<input type="hidden" name="proposal" value="${esc(s.id)}">` +
    '<button class="btn btn-danger btn-sm" type="submit">Withdraw it</button>' +
    '</form></div></details>'
  );
}

function whenLine(s: PortalSubmission, tz: string): string {
  if (!s.placement) return '';
  const shape = label('placement.published', 'onstage');
  const trimmed = s.placement.roomName ? shape : shape.replace(/,?\s*\{room\}/, '');
  return `<p class="bigwhen">${fill(trimmed, {
    day: esc(dDayLong(s.placement.startsAt, tz)),
    time: esc(dTime(s.placement.startsAt, tz)),
    room: esc(s.placement.roomName ?? ''),
  })}</p>`;
}

function metaLine(s: PortalSubmission, tzLabel: string | null): string {
  // The zone rides along with the hour: a speaker reading 10:30 on a phone in
  // another country should not have to work out whose morning that is.
  const bits = [formatWord(s.format), mins(s.minutes), s.track ? s.track.name : '', tzLabel ?? '']
    .filter((b) => b !== '')
    .map((b) => esc(b));
  return bits.length ? `<p class="sub" style="margin-top:4px">${bits.join(' · ')}</p>` : '';
}

/** "Ana Ruiz and Tom Beckett" — a list a person would say out loud. */
function saidList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Everybody else on the talk, under its title. A speaker who is on a talk
 *  with two other people should see both of them here, whichever of the three
 *  of them sent it — so this names people, not standings. */
function withLine(names: readonly string[]): string {
  if (!names.length) return '';
  return `<p class="sub" style="margin-top:4px">With ${esc(saidList(names))}.</p>`;
}

/**
 * `canManage` is false in helper-scoped mode (routes/public/portal.ts's
 * helperOf branch): a helper may see everything below but never withdraw a
 * talk, edit its words, or start another one — those stay the speaker's own,
 * so the controls simply do not render rather than rendering and refusing.
 */
function laneOf(view: PortalView, s: PortalSubmission, others: readonly string[], canManage: boolean): Lane {
  const ev = view.event;
  const tz = ev.timezone;
  const title = `<h3>${esc(s.title)}</h3>` + withLine(others);
  const note = s.decision?.note ? committeeNote(s.decision.note) : '';
  const seeProgram = `<a class="btn" href="/${esc(ev.slug)}/agenda">See the program →</a>`;
  const withdraw = canManage ? withdrawBlock(ev.slug, s) : '';
  const edit = canManage && editable(view, s) ? editLink(ev.slug, s) : '';

  switch (s.state) {
    case 'accepted': {
      const placed = whenLine(s, tz);
      const waiting = s.scheduledNotPublic
        ? '<p class="sub" style="margin-top:8px">Your time and room are set. They go up when the ' +
          'rest of the program does.</p>'
        : `<p class="bigwhen" style="color:var(--muted)">${esc(label('placement.none', 'onstage'))}</p>` +
          '<p class="sub" style="margin-top:4px">We will write the moment they are settled.</p>';
      return {
        cls: 'accepted',
        colour: 'var(--go)',
        head: 'You are on the program.',
        body: title + (placed ? placed + metaLine(s, ev.tzLabel) : waiting) + note,
        bot:
          (s.placement && s.publicSlug
            ? `<a class="btn" href="/${esc(ev.slug)}/s/${esc(s.publicSlug)}">See it on the agenda →</a>`
            : '') + (withdrawable(s) ? withdraw : ''),
      };
    }
    case 'waitlisted':
      return {
        cls: 'undecided',
        colour: 'var(--ember)',
        head: `${label('submission.waitlisted', 'onstage')}.`,
        body:
          title +
          '<p class="sub" style="margin-top:6px">If a room opens up, this is the list they come ' +
          'back to.</p>' +
          note,
        bot: withdraw,
      };
    case 'rejected':
      return {
        cls: 'declined',
        colour: 'var(--muted)',
        head: `${label('submission.rejected', 'onstage')}.`,
        body:
          title +
          `<p class="sub" style="margin-top:6px">The committee did not choose this talk for the ` +
          `${esc(ev.startsOn.slice(0, 4))} program.</p>` +
          note,
        bot: seeProgram,
      };
    case 'cancelled':
      return {
        cls: 'declined',
        colour: 'var(--muted)',
        head: `${label('submission.cancelled', 'onstage')}.`,
        body:
          title +
          '<p class="sub" style="margin-top:6px">This one has come off the program.</p>' +
          (s.cancelled?.note ? committeeNote(s.cancelled.note) : note),
        bot: ev.agendaPublished ? seeProgram : '',
      };
    case 'withdrawn':
      return {
        cls: 'declined',
        colour: 'var(--muted)',
        head: `${label('submission.withdrawn', 'onstage')}.`,
        body:
          title +
          '<p class="sub" style="margin-top:6px">You pulled this talk back, and the committee no ' +
          'longer has it.</p>',
        bot:
          canManage && ev.lifecycle === 'open' && ev.submissionsLeft > 0
            ? `<a class="btn" href="/${esc(ev.slug)}/cfp">Send another proposal</a>`
            : '',
      };
    case 'draft':
      return {
        cls: 'undecided',
        colour: 'var(--muted)',
        head: `${label('submission.draft', 'onstage')}.`,
        body:
          title +
          '<p class="sub" style="margin-top:6px">You started this talk and have not sent it. ' +
          'Nobody on the committee can see it yet.</p>',
        bot: edit,
      };
    default: {
      const sent = s.submittedAt
        ? `You sent this on ${esc(dLong(s.submittedAt, tz))}. `
        : '';
      const by = ev.decideBy
        ? `Decisions go out by <b>${esc(isoLong(ev.decideBy))}</b>.`
        : 'We will write the moment there is news.';
      return {
        cls: 'undecided',
        colour: 'var(--ember)',
        head: `${label('submission.submitted', 'onstage')}.`,
        body: title + `<p class="sub" style="margin-top:6px">${sent}${by}</p>`,
        bot: edit + withdraw,
      };
    }
  }
}

function proposalCard(
  view: PortalView,
  s: PortalSubmission,
  others: readonly string[],
  canManage: boolean
): string {
  const lane = laneOf(view, s, others, canManage);
  return (
    `<div class="pcard ${lane.cls}"><div class="top">` +
    `<p style="margin:0;color:${lane.colour};font-weight:640">${esc(lane.head)}</p>` +
    lane.body +
    '</div>' +
    (lane.bot ? `<div class="bot">${lane.bot}</div>` : '') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * To do
 * ------------------------------------------------------------------ */

const CHIPS: Record<string, string> = {
  open: 'chip s-undecided',
  overdue: 'chip warn',
  done: 'chip s-accepted',
  cancelled: 'chip s-declined',
  done_cancelled: 'chip plain',
};

/* ------------------------------------------------------------------ *
 * Handing something over
 *
 * CNT-06: what a door takes is said in one quiet line right beside the
 * control — and said in the same words the door itself believes, because
 * both the sentence and the check come from workflows/files.ts. A page
 * that promises what the server will refuse has wasted somebody's evening
 * and their last bar of hotel wifi.
 * ------------------------------------------------------------------ */

const KB = 1024;

/** A size a person can feel: "1.4 MB", "820 KB". */
function weight(bytes: number): string {
  return bytes >= KB * KB
    ? `${(bytes / (KB * KB)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / KB))} KB`;
}

function picker(o: {
  id: string;
  name: string;
  labelText: string;
  accept: string;
  line: string;
  button: string;
  action: string;
  hidden?: [string, string];
}): string {
  return (
    `<form method="post" action="${o.action}" enctype="multipart/form-data" style="margin-top:10px">` +
    (o.hidden
      ? `<input type="hidden" name="${esc(o.hidden[0])}" value="${esc(o.hidden[1])}">`
      : '') +
    `<label class="f" for="${esc(o.id)}" style="margin-bottom:10px">` +
    `<span class="f-lab">${esc(o.labelText)}</span>` +
    `<input type="file" id="${esc(o.id)}" name="${esc(o.name)}" accept="${esc(o.accept)}" required` +
    ' style="font:inherit;font-size:14px;max-width:100%;color:var(--ink-soft)">' +
    `<span class="hint">${esc(o.line)}</span></label>` +
    `<button class="btn btn-primary btn-sm" type="submit">${esc(o.button)}</button></form>`
  );
}

/**
 * CNT-04 — every version, current first, each individually open-able. Only
 * drawn once there is more than one: a first upload has nothing to compare
 * itself against yet.
 */
function versionList(versions: FileVersion[], tz: string): string {
  if (versions.length < 2) return '';
  const n = versions.length;
  const [current, ...earlier] = versions;
  if (!current) return '';
  const earlierText = earlier
    .map(
      (v, i) =>
        `<a class="link" href="/files/${esc(v.id)}">v${n - 1 - i}</a> · ${esc(dShortTime(v.uploadedAt, tz))}`
    )
    .join(', ');
  return (
    `<p class="t-sub" style="margin-top:2px">${esc(current.filename)}, ` +
    `<a class="link" href="/files/${esc(current.id)}">v${n}</a> · current · uploaded ` +
    `${esc(dShortTime(current.uploadedAt, tz))}<br>earlier: ${earlierText}</p>`
  );
}

/** CNT-05 — the thread underneath one deliverable, and the form that adds to
 *  it. Every comment carries its author's name and a timestamp — the time as
 *  well as the day, so two comments left the same afternoon still read in
 *  order; nothing here is emailed (SessionBoard itself sends none for a
 *  comment either). */
/** `canReply` is false in helper-scoped mode: a comment posts as its author
 *  (workflows/comments.ts's postCommentAsSpeaker writes personId straight
 *  into author_person_id), and a helper has no row of their own to post
 *  as — the thread stays readable, the reply box just does not render. */
function commentThread(
  slug: string,
  taskId: string,
  comments: FileComment[],
  tz: string,
  canReply: boolean
): string {
  const rows = comments
    .map(
      (c) =>
        '<div style="padding:6px 0;border-top:1px solid var(--line-soft)">' +
        `<div><b style="font-size:14px">${esc(c.authorName)}</b> ` +
        `<span class="sub">${esc(dShortTime(c.createdAt, tz))}</span></div>` +
        `<p style="margin:2px 0 0">${esc(c.body)}</p></div>`
    )
    .join('');
  const reply = canReply
    ? `<form method="post" action="/${esc(slug)}/portal/comment" style="margin-top:8px">` +
      `<input type="hidden" name="task" value="${esc(taskId)}">` +
      `<textarea name="body" rows="2" maxlength="${COMMENT_MAX}" ` +
      'placeholder="Say something about this file" aria-label="Add a comment"></textarea>' +
      '<button class="btn btn-sm" type="submit" style="margin-top:6px">Add a comment</button></form>'
    : '';
  return (
    '<div style="margin-top:12px">' +
    '<b style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">Comments</b>' +
    rows +
    reply +
    '</div>'
  );
}

function taskRow(
  slug: string,
  t: PortalTask,
  tz: string,
  forTitle: string | null,
  deck: StoredFile | null,
  versions: FileVersion[],
  comments: FileComment[],
  canManage: boolean = true
): string {
  const key = t.status === 'open' && t.overdue ? 'overdue' : t.status;
  const stateWord = label(`task.${key}` as LabelKey, 'onstage');
  const open = t.status === 'open';
  // A request for a file is finished by sending the file, so that is the only
  // way out of this panel — one act, not a picker beside a button that claims
  // the same thing without the bytes.
  const wantsAFile = t.kind === 'file_request' && t.status !== 'cancelled';
  const due =
    open && t.dueOn
      ? `<span class="sub">${t.overdue ? 'Was due ' : 'Due '}${esc(isoDayLong(t.dueOn))}</span>`
      : '';
  const done =
    t.completedAt !== null
      ? deck
        ? `<p>It came in on ${esc(dLong(t.completedAt, tz))}: ` +
          `<a class="link" href="/files/${esc(deck.id)}">${esc(deck.filename)}</a> · ` +
          `${esc(weight(deck.sizeBytes))}</p>${versionList(versions, tz)}`
        : `<p>You marked this done on ${esc(dLong(t.completedAt, tz))}.</p>`
      : deck
        ? `<p>We have <a class="link" href="/files/${esc(deck.id)}">${esc(deck.filename)}</a> · ` +
          `${esc(weight(deck.sizeBytes))}</p>${versionList(versions, tz)}`
        : '';
  const dropped =
    t.status === 'cancelled' ? '<p>The committee no longer needs it.</p>' : '';
  const action = wantsAFile
    ? picker({
        id: `f-deck-${t.id}`,
        name: 'deck',
        labelText: deck ? 'Send a newer one' : 'Your slides',
        accept: DECK_ACCEPT,
        line: DECK_LINE,
        button: deck ? 'Send this one instead' : 'Send my slides',
        action: `/${esc(slug)}/portal/slides`,
        hidden: ['task', t.id],
      })
    : open
      ? `<form method="post" action="/${esc(slug)}/portal/done" style="margin-top:10px">` +
        `<input type="hidden" name="task" value="${esc(t.id)}">` +
        '<button class="btn btn-primary btn-sm" type="submit">Mark this done</button></form>'
      : '';
  return (
    `<details class="task${t.completedAt !== null ? ' done' : ''}" id="task-${esc(t.id)}"${open ? ' open' : ''}>` +
    '<summary>' +
    `<span class="tname">${esc(t.title)}</span>` +
    `<span class="${CHIPS[key] ?? 'chip plain'}">${esc(stateWord)}</span>` +
    due +
    '</summary><div class="tbody">' +
    (forTitle ? `<p class="sub" style="margin-bottom:6px">For “${esc(forTitle)}”.</p>` : '') +
    (t.instructions ? `<p>${esc(t.instructions)}</p>` : '') +
    done +
    dropped +
    action +
    (wantsAFile && (canManage || comments.length > 0)
      ? commentThread(slug, t.id, comments, tz, canManage)
      : '') +
    '</div></details>'
  );
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

const MESSAGE_KEYS: Record<string, string> = {
  received: 'message.kind.received',
  decision: 'message.kind.decision',
  task: 'message.kind.task',
  reminder: 'message.kind.task',
  schedule: 'message.kind.schedule',
};

function messageRow(m: PortalMessage, tz: string): string {
  const kind = word(MESSAGE_KEYS[m.kind] ?? '');
  const when = fill(label('message.delivered', 'onstage'), {
    date: esc(dShort(m.deliveredAt, tz)),
  });
  return (
    '<div class="msg">' +
    `<div class="mk">${esc(kind)}</div>` +
    `<div><div class="msub">${esc(m.subject)}</div><div class="mprev">${esc(m.body)}</div></div>` +
    `<div class="sub">${when}</div></div>`
  );
}

/* ------------------------------------------------------------------ *
 * The profile card
 * ------------------------------------------------------------------ */

/** One field, in the shared form clothes. The call's own field() has a
 *  teaching apparatus — model answers, counters, an island watching it — that
 *  belongs to a stranger writing a proposal for the first time. This is the
 *  same person a year later, correcting one line. Nothing should get in the
 *  way of that. */
function line(o: {
  id: string;
  name: string;
  labelText: string;
  value: string | null;
  hint?: string;
  area?: boolean;
  rows?: number;
  limit?: number;
  optional?: boolean;
  required?: boolean;
}): string {
  const attrs =
    `id="${esc(o.id)}" name="${esc(o.name)}"` +
    (o.limit ? ` maxlength="${o.limit}"` : '') +
    (o.required ? ' required' : '');
  const control = o.area
    ? `<textarea ${attrs} rows="${o.rows ?? 4}">${esc(o.value ?? '')}</textarea>`
    : `<input type="text" ${attrs} value="${esc(o.value ?? '')}">`;
  return (
    `<label class="f" for="${esc(o.id)}"><span class="f-lab">${esc(o.labelText)}` +
    (o.optional ? '<span class="opt">optional</span>' : '') +
    '</span>' +
    control +
    (o.hint ? `<span class="hint">${esc(o.hint)}</span>` : '') +
    '</label>'
  );
}

/**
 * SPK-08 — the block that used to show a speaker how they appear, now the
 * block where they say it. Two forms, deliberately: a photograph travels as
 * bytes and the words travel as words, and putting them in one form would
 * mean re-sending a two-megabyte photograph to fix a typo in a job title.
 */
function profileCard(view: PortalView, onTheProgram: boolean): string {
  const p = view.profile;
  const slug = esc(view.event.slug);
  const photo =
    '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
    face(p, 72) +
    '<div style="flex:1 1 16em;min-width:14em">' +
    picker({
      id: 'f-photo',
      name: 'photo',
      labelText: p.headshotFileId ? 'A different photograph' : 'Your photograph',
      accept: PHOTO_ACCEPT,
      line: `${PHOTO_LINE} It sits beside your name on the program.`,
      button: p.headshotFileId ? 'Use this one instead' : 'Use this photograph',
      action: `/${slug}/portal/photo`,
    }) +
    '</div></div>';

  const words =
    `<form method="post" action="/${slug}/portal/profile">` +
    line({
      id: 'f-pname',
      name: 'name',
      labelText: 'Your name',
      value: p.name,
      hint: 'As you would like it printed on the schedule.',
      limit: 120,
      required: true,
    }) +
    line({
      id: 'f-ptitle',
      name: 'job_title',
      labelText: 'What you do',
      value: p.jobTitle,
      hint: 'Your role, in your own words.',
      limit: 120,
      optional: true,
    }) +
    line({
      id: 'f-porg',
      name: 'organisation',
      labelText: 'Where you do it',
      value: p.organisation,
      hint: 'Shown under your name on the public agenda.',
      limit: 120,
      optional: true,
    }) +
    line({
      id: 'f-ppronouns',
      name: 'pronouns',
      labelText: 'Pronouns',
      value: p.pronouns,
      hint: 'Printed as you write them.',
      limit: 40,
      optional: true,
    }) +
    line({
      id: 'f-pbio',
      name: 'bio',
      labelText: 'A short life',
      value: p.bio,
      hint: `A paragraph a stranger reads before you walk on. Up to ${BIO_MAX} characters.`,
      area: true,
      rows: 5,
      limit: BIO_MAX,
      optional: true,
    }) +
    line({
      id: 'f-plinks',
      name: 'links',
      labelText: 'Where to find you',
      value: p.links,
      hint: 'One address per line.',
      area: true,
      rows: 3,
      limit: 600,
      optional: true,
    }) +
    '<div class="btnrow"><button class="btn btn-primary" type="submit">Save how I appear</button>' +
    (onTheProgram
      ? `<a class="btn" href="/${slug}/speakers/${esc(p.personId)}">See your speaker page →</a>`
      : '') +
    '</div></form>';

  return (
    '<div class="card card-pad sec" style="max-width:46em">' +
    '<h2 class="display" style="font-size:22px;margin-bottom:4px">How you appear on the program</h2>' +
    '<p class="sub" style="margin-bottom:14px">These are the words that go on the printed program ' +
    'and on your speaker page. Change them whenever you like.</p>' +
    photo +
    '<hr class="rule">' +
    words +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * Δ helper — someone who helps with the logistics, not on the program
 * ------------------------------------------------------------------ */

/** One helper, and the one act a speaker takes on them: letting them go. */
function helperRow(slug: string, h: Helper): string {
  return (
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;' +
    'padding:8px 0;border-top:1px solid var(--line-soft)">' +
    `<div><b style="font-size:14px">${esc(h.name)}</b>` +
    (h.email ? ` <span class="sub">${esc(h.email)}</span>` : '') +
    '</div>' +
    `<form method="post" action="/${esc(slug)}/portal/helpers/remove" style="margin:0">` +
    `<input type="hidden" name="helper" value="${esc(h.id)}">` +
    `<button class="btn btn-sm" type="submit">${esc(label('helper.remove', 'onstage'))}</button>` +
    '</form></div>'
  );
}

/**
 * SPK's own gap on the other side: nowhere to say who helps you. A name and
 * an email are all this asks for — the same two facts a co-presenter is
 * added by (workflows/submit.ts's planCoPresenters) — because the address is
 * the whole of how they get in: workflows/helpers.ts finds or makes their
 * person row, and from there they sign in exactly the way every speaker
 * already does.
 */
function helperSection(slug: string, helpers: Helper[]): string {
  const list = helpers.length
    ? helpers.map((h) => helperRow(slug, h)).join('')
    : `<p class="sub" style="margin-top:2px">${esc(label('helper.empty', 'onstage'))}</p>`;
  const form =
    `<form method="post" action="/${esc(slug)}/portal/helpers/add" style="margin-top:14px">` +
    line({
      id: 'f-hname',
      name: 'name',
      labelText: label('helper.name_label', 'onstage'),
      value: null,
      limit: 120,
      required: true,
    }) +
    line({
      id: 'f-hemail',
      name: 'email',
      labelText: label('helper.email_label', 'onstage'),
      value: null,
      limit: 200,
      required: true,
    }) +
    '<div class="btnrow" style="margin-top:6px">' +
    `<button class="btn btn-primary btn-sm" type="submit">${esc(label('helper.add_button', 'onstage'))}</button>` +
    '</div></form>';

  return (
    '<div class="card card-pad sec" style="max-width:46em">' +
    `<h2 class="display" style="font-size:22px;margin-bottom:4px">${esc(label('helper.section', 'onstage'))}</h2>` +
    `<p class="sub" style="margin-bottom:10px">${esc(label('helper.blurb', 'onstage'))}</p>` +
    list +
    form +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

function portalPage(
  view: PortalView,
  note: string | undefined,
  decks: Map<string, StoredFile>,
  versions: Map<string, FileVersion[]>,
  comments: Map<string, FileComment[]>,
  /** Everyone else on each talk, by submission — names only, in program order. */
  others: Map<string, string[]>,
  /** This speaker's own helpers — read (and rendered) only in their own
   *  portal; empty and unused in helper-scoped mode. */
  helpers: Helper[],
  /** Set only when the signed-in person is not this portal's own speaker but
   *  someone helping them — routes/public/portal.ts's fallback when
   *  queries/portal.ts's own view comes back null. Every control that would
   *  touch the talk's words or standing, or the speaker's own identity,
   *  reads this and does not render. */
  helperOf: Helping | null = null
): string {
  const ev = view.event;
  const tz = ev.timezone;
  const slug = esc(ev.slug);
  const canManage = helperOf === null;
  const speakerName = esc(view.profile.name);
  const title = helperOf ? `Helping ${view.profile.name} · ${ev.name}` : `Your portal · ${ev.name}`;

  // Who you are, where you are, and the way out — one line, because a signed-in
  // page with no name on it and no way to leave is a page you get lost on.
  // In helper-scoped mode "you" is deliberately ambiguous here — the face and
  // the name are the speaker's, because this is a reading of their standing,
  // not the helper's own.
  const heading = helperOf ? fill(label('helper.banner', 'onstage'), { name: speakerName }) : 'Your portal';
  const scopeNote = helperOf
    ? `<p class="sub" style="margin-top:4px">${fill(label('helper.scope_note', 'onstage'), { name: speakerName })}</p>`
    : '';
  const head =
    '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
    face(view.profile, 56) +
    `<div><h1 class="display" style="font-size:32px">${heading}</h1>` +
    `<p class="sub">${speakerName} · ${esc(ev.name)} · ` +
    `<a class="link" href="/sign-out">${esc(label('auth.sign_out', 'onstage'))}</a></p>` +
    scopeNote +
    '</div></div>' +
    noteLine(note);

  // Nothing sent yet: one card that names the next thing, not three empty ones.
  if (view.submissions.length === 0 && view.tasks.length === 0 && view.messages.length === 0) {
    const door = !canManage
      ? `<a class="btn btn-primary btn-lg" href="/${slug}/agenda">See the program →</a>`
      : ev.lifecycle === 'open'
        ? `<a class="btn btn-primary btn-lg" href="/${slug}/cfp">Send a proposal →</a>`
        : `<a class="btn btn-primary btn-lg" href="/${slug}/agenda">See the program →</a>`;
    const heading2 = !canManage
      ? `Nothing here yet for ${speakerName}.`
      : `You have not sent a proposal to ${esc(ev.name)} yet.`;
    const why = !canManage
      ? 'When there is something to do, it turns up here with a date on it.'
      : ev.lifecycle === 'open'
        ? 'The call is open. Send one and this page fills up: where it stands, what the ' +
          'committee said, and anything they need from you.'
        : 'The call has closed. When it opens again, everything you send lands here — where ' +
          'it stands, what the committee said, and anything they need from you.';
    return page({
      title,
      register: 'onstage',
      body: onstageShell(
        eventNav(ev.slug, '/portal', ev.lifecycle === 'open'),
        conferenceMasthead(ev) +
          '<div class="wrap" style="padding-top:44px">' +
          head +
          `<div class="sec state-out" style="max-width:40em"><h2>${heading2}</h2>` +
          `<p>${why}</p><div class="btnrow">${door}</div></div></div>`,
        ev.slug
      ),
    });
  }

  const cards = view.submissions
    .map((s) => proposalCard(view, s, others.get(s.id) ?? [], canManage))
    .join('');

  // Everything owed, in one list — the answer to "what do I owe" in one glance.
  const titles = new Map(view.submissions.map((s) => [s.id, s.title]));
  const manyTalks = view.submissions.length > 1;
  const tasks = [...view.submissions.flatMap((s) => s.tasks), ...view.tasks].sort((a, b) => {
    const openness = Number(a.status !== 'open') - Number(b.status !== 'open');
    if (openness !== 0) return openness;
    return (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31');
  });

  const onTheProgram = view.submissions.some(
    (s) => s.state === 'accepted' || s.state === 'cancelled'
  );
  const mine = view.submissions.find((s) => s.placement && s.publicSlug);
  const todoDoor = mine
    ? `<a class="btn btn-primary" href="/${slug}/s/${esc(mine.publicSlug ?? '')}">See your talk on the program →</a>`
    : `<a class="btn btn-primary" href="/${slug}/agenda">See the program →</a>`;

  const todo = tasks.length
    ? tasks
        .map((t) =>
          taskRow(
            ev.slug,
            t,
            tz,
            manyTalks && t.submissionId ? (titles.get(t.submissionId) ?? null) : null,
            decks.get(t.id) ?? null,
            versions.get(t.id) ?? [],
            comments.get(t.id) ?? [],
            canManage
          )
        )
        .join('')
    : '<div class="state-out"><h2>Nothing to do right now.</h2>' +
      '<p>When the committee needs something from you, it turns up here with a date on it.</p>' +
      `<div class="btnrow">${todoDoor}</div></div>`;

  const letters = [...view.submissions.flatMap((s) => s.messages), ...view.messages].sort(
    (a, b) => b.deliveredAt - a.deliveredAt
  );
  const messages = letters.length
    ? letters.map((m) => messageRow(m, tz)).join('')
    : '<div class="state-out"><h2>Nothing from the committee yet.</h2>' +
      '<p>Every letter they send you lands here and stays here, so you can read it twice.</p>' +
      `<div class="btnrow">${todoDoor}</div></div>`;

  const another =
    canManage && ev.lifecycle === 'open' && ev.submissionsLeft > 0
      ? '<p class="hint" style="margin-top:14px">The call is still open — you have room for ' +
        `${esc(String(ev.submissionsLeft))} more. ` +
        `<a class="link" href="/${slug}/cfp">Send another proposal →</a></p>`
      : '';

  const talksSection = `<div class="sec" style="max-width:46em">${cards}${another}</div>`;
  const todoSection =
    '<div class="sec" style="max-width:46em">' +
    '<h2 class="display" style="font-size:26px;margin-bottom:14px">To do</h2>' +
    todo +
    '</div>';
  // Owed before standing. A speaker with something due should read the date
  // before anything else; a speaker with nothing due should not open on an
  // empty list, so the talks lead instead.
  const owes = tasks.some((t) => t.status === 'open');

  const body =
    conferenceMasthead(ev) +
    '<div class="wrap" style="padding-top:44px">' +
    head +
    (owes ? todoSection + talksSection : talksSection + todoSection) +
    '<div class="sec" style="max-width:46em">' +
    '<h2 class="display" style="font-size:26px;margin-bottom:6px">Messages</h2>' +
    '<p class="sub" style="margin-bottom:8px">Everything the committee has sent you, newest first.</p>' +
    messages +
    '</div>' +
    (canManage ? profileCard(view, onTheProgram) + helperSection(ev.slug, helpers) : '') +
    '</div>';

  return page({
    title,
    register: 'onstage',
    body: onstageShell(eventNav(ev.slug, '/portal', ev.lifecycle === 'open'), body, ev.slug),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const back = (slug: string, code: string): string =>
  `/${encodeURIComponent(slug)}/portal?note=${encodeURIComponent(code)}`;

const noteFor = (outcome: WriteOutcome, done: string): string =>
  outcome === 'done' ? done : outcome;

/** The same shape for the file outcomes: every word in FileOutcome but 'done'
 *  is itself a key in NOTES, so the closed set stays closed. */
const fileNote = (outcome: FileOutcome, done: string): string =>
  outcome === 'done' ? done : outcome;

/** 'moved' and 'trouble' are the same two generic sentences every other
 *  outcome type on this page already shares; the three validation words
 *  (no-name, no-email, self) get their own 'helper-' entries because they
 *  are this feature's own — see NOTES above. */
const helperNote = (outcome: HelperOutcome, done: string): string => {
  if (outcome === 'done') return done;
  if (outcome === 'moved' || outcome === 'trouble') return outcome;
  return `helper-${outcome}`;
};

export function registerPortal(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/portal', async (c) => {
    const slug = c.req.param('event');
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    // The door says the same thing it always said, and now says it in the
    // status line as well: nobody is signed in, so nothing was shown.
    if (!principal) return c.html(signedOutPage(ev), 401);

    let view = await portalView(c.env.DB, ev.id, principal.personId);
    if (!view) return c.html(signedOutPage(ev), 401);

    // Δ helper — portalView returns non-null for any signed-in person at any
    // real event (it only checks the event and person rows exist, not that
    // the person actually stands on a talk here — 02 inv. reads "told", not
    // "present"), so an empty submissions list, not a null view, is this
    // page's real signal that the principal is nobody's own participant.
    // Someone in exactly that position may still be helping one who is: the
    // same magic-link door, a different reason to be standing at it.
    // helpingAt is the one query this branch adds; the view itself is
    // queries/portal.ts's own portalView, read again for the speaker being
    // helped rather than for the principal — the helper-scoped render is the
    // one page every table already answers, not a second one built to answer
    // a narrower question.
    let helperOf: Helping | null = null;
    if (view.submissions.length === 0) {
      const helping = await helpingAt(c.env.DB, ev.id, principal.personId);
      const first = helping[0];
      if (first) {
        const helperView = await portalView(c.env.DB, ev.id, first.speakerPersonId);
        if (helperView) {
          helperOf = first;
          view = helperView;
        }
      }
    }

    // Whose name goes on a comment's byline and whose co-presenters get
    // filtered out below — the speaker being read, not always the principal.
    const viewerPersonId = helperOf ? helperOf.speakerPersonId : principal.personId;

    const asked = [...view.submissions.flatMap((s) => s.tasks), ...view.tasks]
      .filter((t) => t.kind === 'file_request')
      .map((t) => t.id);
    const [decks, versions, comments, people, helpers] = await Promise.all([
      decksForTasks(c.env.DB, asked),
      deckVersionsForTasks(c.env.DB, asked),
      commentsForTasks(c.env.DB, asked),
      peopleOnTalks(c.env.DB, view.submissions.map((s) => s.id)),
      helperOf ? Promise.resolve([]) : helpersOfSpeaker(c.env.DB, ev.id, viewerPersonId),
    ]);
    // Everyone on each talk but the person reading it: the co-presenters they
    // added, and — when they are the co-presenter — whoever sent it.
    const others = new Map<string, string[]>();
    for (const [submissionId, on] of people) {
      others.set(
        submissionId,
        on.filter((p) => p.personId !== viewerPersonId).map((p) => p.name)
      );
    }

    // One speaker's own page: never held in a shared cache anywhere.
    c.header('cache-control', 'private, no-store');
    // A saved edit arrives under its own flag; its sentence still lives in
    // NOTES with the others, so there is one closed set and not two.
    const note = c.req.query('edited') === '1' ? 'edited' : c.req.query('note');
    return c.html(portalPage(view, note, decks, versions, comments, others, helpers, helperOf));
  });

  // -- CNT-05: a comment on a deliverable ---------------------------------
  app.post('/:event/portal/comment', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const taskId = String(form['task'] ?? '');
    const anchor = taskId ? `#task-${encodeURIComponent(taskId)}` : '';
    if (!taskId) return c.redirect(`${back(slug, 'moved')}${anchor}`, 303);
    const outcome = await postCommentAsSpeaker(c.env.DB, principal.personId, taskId, String(form['body'] ?? ''));
    const code = outcome === 'done' ? 'commented' : outcome === 'empty' ? 'no-comment' : outcome;
    return c.redirect(`${back(slug, code)}${anchor}`, 303);
  });

  app.post('/:event/portal/done', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const taskId = String(form['task'] ?? '');
    if (!taskId) return c.redirect(back(slug, 'moved'), 303);
    // Δ helper — completeTask still only ever touches its own owner's row
    // (workflows/portal-actions.ts's MY_OPEN_TASK); taskActorId is what may
    // resolve that owner to the speaker being helped rather than the
    // principal themselves. Neither id is trusted from the form.
    const actorId = await taskActorId(c.env.DB, taskId, principal.personId);
    if (!actorId) return c.redirect(back(slug, 'moved'), 303);
    const outcome = await completeTask(c.env.DB, actorId, taskId);
    return c.redirect(back(slug, noteFor(outcome, 'task-done')), 303);
  });

  app.post('/:event/portal/withdraw', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const proposalId = String(form['proposal'] ?? '');
    if (!proposalId) return c.redirect(back(slug, 'moved'), 303);
    const outcome = await withdrawProposal(c.env.DB, principal.personId, proposalId);
    return c.redirect(back(slug, noteFor(outcome, 'withdrawn')), 303);
  });

  // -- SPK-08: the words on the program ---------------------------------
  app.post('/:event/portal/profile', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const said = (k: string): string => String(form[k] ?? '');
    const outcome = await saveProfile(c.env.DB, principal.personId, {
      name: said('name'),
      jobTitle: said('job_title'),
      organisation: said('organisation'),
      bio: said('bio'),
      pronouns: said('pronouns'),
      links: said('links'),
    });
    return c.redirect(back(slug, fileNote(outcome, 'saved')), 303);
  });

  // -- SPK-08: the photograph -------------------------------------------
  // The header is read before the body is: a phone that picked a nine-megabyte
  // camera original gets its answer without either side carrying the bytes.
  app.post('/:event/portal/photo', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    if (tooLargeToRead(c.req.header('content-length'), PHOTO_MAX_BYTES)) {
      return c.redirect(back(slug, 'too-big'), 303);
    }
    const form = await c.req.parseBody();
    const photo = filePart(form['photo']);
    if (!photo) return c.redirect(back(slug, 'nothing'), 303);
    const outcome = await saveHeadshot(c.env.DB, c.env.FILES, principal.personId, photo);
    return c.redirect(back(slug, fileNote(outcome, 'photo')), 303);
  });

  // -- CNT-02: the deck --------------------------------------------------
  app.post('/:event/portal/slides', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    if (tooLargeToRead(c.req.header('content-length'), DECK_MAX_BYTES)) {
      return c.redirect(back(slug, 'too-big'), 303);
    }
    const form = await c.req.parseBody();
    const taskId = String(form['task'] ?? '');
    const deck = filePart(form['deck']);
    if (!taskId) return c.redirect(back(slug, 'moved'), 303);
    if (!deck) return c.redirect(back(slug, 'nothing'), 303);
    // Δ helper — same substitution as /portal/done: saveDeck only ever writes
    // against the task it is given and the person id it is given, together
    // (workflows/files.ts's own WHERE id = ? AND person_id = ?); taskActorId
    // is what may resolve that person id to the speaker being helped.
    const actorId = await taskActorId(c.env.DB, taskId, principal.personId);
    if (!actorId) return c.redirect(back(slug, 'moved'), 303);
    const outcome = await saveDeck(c.env.DB, c.env.FILES, actorId, taskId, deck);
    return c.redirect(back(slug, fileNote(outcome, 'deck')), 303);
  });

  // -- Δ helper: the speaker's own two writes about who helps them ------
  app.post('/:event/portal/helpers/add', async (c) => {
    const slug = c.req.param('event');
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const outcome = await addHelper(c.env.DB, ev.id, principal.personId, {
      name: String(form['name'] ?? ''),
      email: String(form['email'] ?? ''),
    });
    return c.redirect(back(slug, helperNote(outcome, 'helper-added')), 303);
  });

  app.post('/:event/portal/helpers/remove', async (c) => {
    const slug = c.req.param('event');
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in', 303);
    const form = await c.req.parseBody();
    const helperRowId = String(form['helper'] ?? '');
    if (!helperRowId) return c.redirect(back(slug, 'moved'), 303);
    const outcome = await removeHelper(c.env.DB, ev.id, principal.personId, helperRowId);
    return c.redirect(back(slug, helperNote(outcome, 'helper-removed')), 303);
  });
}
