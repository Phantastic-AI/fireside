// The front of the site. Not a screen of the product — the page that explains
// it, in the founder's own structure: the desk first, then the hands, then the
// day, then the people the day is for.
//
// Register law: D-025 (every headline parses cold to a stranger, no self-talk)
// and D-027 (the product never narrates its own construction — every sentence
// is written for a conference organizer evaluating finished software). The one
// honest disclosure about the example conferences lives in the live section
// and nowhere else. Every claim on this page is true of the running product
// tonight; anything aspirational was cut at the merge (D-031 era) — the
// target-state organization board, near-duplicate detection, a bespoke CLI.
//
// The whole page is drawn from tokens: no images, no webfonts, no third-party
// request of any kind. The product vignettes are HTML and CSS, and the
// concierge vignette is the shipped panel's own face.
//
// Numbers here are the seeded world's constants (1,000 proposals; 328 still
// undecided; 610 letters staged; 60 accepted; 54 speakers; 57 placed
// sessions). The hourly reseed holds them true.
import { esc, page, brand, NAME } from '../../lib/html';
import type { EventCard } from '../../queries/public';

/* ------------------------------------------------------------------ *
 * Content. Kept as data so the shape of the page stays readable.
 * ------------------------------------------------------------------ */

const RUNWAY: { t: string; h: string }[] = [
  { t: '3 months', h: 'Gather proposals around the theme' },
  { t: '2 months', h: 'Bring independent reviews together' },
  { t: '1 month', h: 'Place accepted talks in the lineup' },
  { t: '2 weeks', h: 'Ready speakers and crews' },
  { t: 'Today', h: 'Keep rooms, decks, and people connected' },
  { t: 'After', h: 'Make missed talks easy to find' },
];

const ROLES: { who: string; h: string; p: string }[] = [
  {
    who: 'Editorial lead',
    h: 'Choose talks that belong together once the audience is in the room.',
    p: 'A strong submission can still repeat a theme, crowd out a format, or unbalance a track. Read each proposal beside its neighbors and build the lineup on purpose.',
  },
  {
    who: 'Organizing team',
    h: 'Give every loose end a name and a next move.',
    p: 'A missing deck, an unfinished review, and an unplaced talk need different follow-up. Each one stays attached to its session or its person, so nobody chases a count through old sheets.',
  },
  {
    who: 'Reviewers',
    h: 'Score the talks assigned to you, then submit a complete round.',
    p: 'Reviewers weigh only the proposals assigned to them, with names hidden while they mark. The committee sees the finished round when it is time to shape the lineup.',
  },
  {
    who: 'Speakers',
    h: 'Know what is due and when.',
    p: 'Silence after submit feels like a black hole. The decision, the tasks, the dates, and the next due date live on one page that is the speaker’s own.',
  },
  {
    who: 'Volunteers',
    h: 'Know who is next and whether the deck is in.',
    p: 'At 09:12, a runner has one bar and eight minutes. The green room sheet gives them the next face, room, deck status, contact, and one action — on a link, not a login.',
  },
  {
    who: 'Attendees',
    h: 'Choose between good sessions without losing the rest of the day.',
    p: 'Save the talks you want, catch a room conflict before you start walking, and afterwards say you were in the room — the people who said it too appear on your list, and on nobody else’s.',
  },
  {
    who: 'Public',
    h: 'Let the agenda show why the trip is worth the time away.',
    p: 'Session pages, speaker context, themes, and formats show how the program fits together before anyone books.',
  },
  {
    who: 'Program office',
    h: 'Remember who made past programs great.',
    p: 'Starting from a blank speaker sheet every season wastes trust. The people and the history carry into the next conference.',
  },
];

const LIFECYCLE: { t: string; h: string; p: string }[] = [
  {
    t: 'Discover',
    h: 'Decide whether this conference earns the trip.',
    p: 'The agenda shows the sessions, people, and themes that make the program distinct.',
  },
  {
    t: 'Plan',
    h: 'Build Friday around the talks you saved.',
    p: 'Stars, filters, room details, calendar files, and a conflict check that knows how long the walk is.',
  },
  {
    t: 'Meet',
    h: 'Start with the session you both cared about.',
    p: 'Say you were in the room. If someone else says it too, you appear on each other’s list — and on nobody else’s.',
  },
  {
    t: 'Return',
    h: 'Pick up where your schedule left off.',
    p: 'Recordings land on the sessions themselves, and the schedule stays where it was published. Charlotte, below, is already living its afterlife.',
  },
];

const MECHANICS: { h: string; p: string }[] = [
  {
    h: 'Move it once',
    p: 'Change a room, a contact, or a placement. The public agenda and every permitted working view agree on the new plan.',
  },
  {
    h: 'Keep each role in bounds',
    p: 'Attendees, speakers, reviewers, volunteers, and organizers each see only their part. A reviewer never sees a name while scoring; a runner’s link reaches its own event and nothing else, and carries no sign-in.',
  },
  {
    h: 'Check consequential actions',
    p: 'Decisions, letters, and placements go through the same checked writers in the browser and over MCP. There is no back way around a guard.',
  },
  {
    h: 'Ready on one bar',
    p: 'Pages are server-rendered, small, and readable on phones. The crew carries a link, not an organizer login, and the agenda opens in a basement.',
  },
];

/* ------------------------------------------------------------------ *
 * Vignettes — the product sketched in its own materials.
 * ------------------------------------------------------------------ */

/** The organizer's morning, in one card. Counts are the seeded world's. */
function vgPulse(): string {
  return (
    '<aside class="mkt-vg mkt-pulse" aria-label="The organizer’s morning at a glance">' +
    '<div class="mkt-vg-h">Program pulse<span class="r">AI Engineer New York 2026</span></div>' +
    '<div class="mkt-pr"><span class="l">Proposals</span><span class="v">1,000 in · 328 still undecided</span></div>' +
    '<div class="mkt-pr"><span class="l">Letters</span><span class="v">610 written · none sent by accident</span></div>' +
    '<div class="mkt-pr"><span class="l">Program</span><span class="v">57 sessions placed · 54 speakers</span></div>' +
    '<div class="mkt-pr"><span class="l">Speakers</span><span class="v">Decks and headshots, chased kindly</span></div>' +
    '<div class="mkt-pulse-watch">● The call is still open — the pile grows while you read this.</div>' +
    '</aside>'
  );
}

/** The editorial desk, as the backstage actually draws it. */
function vgBoard(): string {
  const rows: { l: string; v: string; a: string; href: string }[] = [
    { l: 'The pile', v: '1,000 proposals · 328 still undecided', a: 'Open', href: '/admin/aie-nyc/submissions' },
    { l: 'Reviews', v: 'Assigned reading, blind, per reviewer', a: 'Progress', href: '/admin/aie-nyc/reviews' },
    { l: 'Letters', v: '610 staged · they leave in one act', a: 'Outbox', href: '/admin/aie-nyc/outbox' },
    { l: 'Agenda', v: '57 placed · conflicts argue at placement', a: 'Builder', href: '/admin/aie-nyc/agenda' },
  ];
  return (
    '<div class="mkt-vg mkt-board" aria-label="The editorial desk">' +
    '<div class="mkt-vg-h">The desk<span class="r">Signed in as the organizer</span></div>' +
    rows
      .map(
        (r) =>
          `<div class="mkt-pr"><span class="l">${esc(r.l)}</span><span class="v">${esc(r.v)}</span>` +
          `<a class="link" href="${r.href}">${esc(r.a)} →</a></div>`
      )
      .join('') +
    '<div class="mkt-vg-note">A speaker placed in two rooms at once argues at the moment of placement, not at print time.</div>' +
    '</div>'
  );
}

/** The reviewer's room and the committee's, side by side. */
function vgReview(): string {
  return (
    '<div class="mkt-cols">' +
    '<div class="mkt-vg">' +
    '<div class="mkt-vg-h">Yours to score<span class="r">Names hidden while you mark</span></div>' +
    '<div class="mkt-prow"><div><b>Reliable agents under messy inputs</b><i>Talk · Platform</i></div></div>' +
    '<div class="mkt-prow"><div><b>Memory without mystery</b><i>Deep dive · Practice</i></div></div>' +
    '<div class="mkt-prow"><div><b>Evaluating tool use in production</b><i>Workshop · Platform</i></div></div>' +
    '<div class="mkt-vg-note">Marks stay yours until you submit the round.</div>' +
    '</div>' +
    '<div class="mkt-vg">' +
    '<div class="mkt-vg-h">The committee’s pile<span class="r">One page, honest counts</span></div>' +
    '<div class="mkt-pr"><span class="l">Undecided</span><span class="v">328 — the filters are counts, and the counts are true</span></div>' +
    '<div class="mkt-pr"><span class="l">Accepted</span><span class="v">60 talks · 54 speakers behind them</span></div>' +
    '<div class="mkt-pr"><span class="l">Staged</span><span class="v">610 letters, each with the committee’s own sentence</span></div>' +
    '<div class="mkt-vg-note">Decide in private. Tell everyone on purpose.</div>' +
    '</div>' +
    '</div>'
  );
}

/** The shipped concierge panel's own face, drawn still. */
function vgConcierge(): string {
  return (
    '<div class="mkt-vg mkt-cc" aria-label="The concierge">' +
    '<div class="mkt-cc-head"><svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">' +
    '<path d="M16 3c1.6 4.2-1.4 6-1.4 8.6 0 1.6 1.2 2.6 2.4 2.6 1.5 0 2.3-1.1 2.2-2.6 2.2 1.9 ' +
    '3.3 4.2 3.3 6.6 0 3.9-3 6.8-6.5 6.8S9.5 22.1 9.5 18.2C9.5 12.3 14.6 9.6 16 3z" fill="#B14D14"/></svg>' +
    '<b>The concierge</b></div>' +
    '<p class="mkt-cc-lead">I know this conference — the program, the call, and where everything is. Ask me anything about it.</p>' +
    '<div class="mkt-cc-chips"><span>When does the program start?</span><span>Can I still send a talk?</span>' +
    '<span>What do I owe, and by when?</span></div>' +
    '<div class="mkt-cc-you">When does the program start?</div>' +
    '<div class="mkt-cc-ans">The program begins Thursday 3 September at 09:30, at Pier 57 in New York.' +
    '<i>Read off the program just now.</i></div>' +
    '</div>'
  );
}

function vgGreenRoom(): string {
  return (
    '<div class="mkt-phone">' +
    '<div class="mkt-ph-top">Green room<span>09:12</span></div>' +
    '<div class="mkt-ph-lab">Up next · 09:30 · Ballroom A</div>' +
    '<div class="mkt-ph-card">' +
    '<div class="mkt-prow"><span class="mkt-av">EV</span><div><b>Elena Vasquez</b>' +
    '<i>The year the tooling caught up</i></div></div>' +
    '<div class="mkt-ph-row"><span class="mkt-tag ok">Slides in</span>' +
    '<span class="mkt-call">Call · 555 0112</span></div></div>' +
    '<div class="mkt-ph-lab">Then · 10:15 · Ballroom A</div>' +
    '<div class="mkt-ph-card">' +
    '<div class="mkt-prow"><span class="mkt-av">MF</span><div><b>Marcus Feld</b>' +
    '<i>What we broke on purpose</i></div></div>' +
    '<div class="mkt-ph-row"><span class="mkt-tag no">Slides not in</span>' +
    '<span class="mkt-call">Call · 555 0147</span></div></div>' +
    '</div>'
  );
}

/** One speaker's readiness, as the portal and the tracker hold it. */
function vgReadiness(): string {
  return (
    '<div class="mkt-vg">' +
    '<div class="mkt-vg-h">Ready for Friday<span class="r">One speaker’s page</span></div>' +
    '<div class="mkt-pr"><span class="l ok">✓</span><span class="v">Final deck uploaded — received 7 August</span></div>' +
    '<div class="mkt-pr"><span class="l ok">✓</span><span class="v">Headshot in, print quality</span></div>' +
    '<div class="mkt-pr"><span class="l">·</span><span class="v">Confirm arrival contact — due tomorrow</span></div>' +
    '<div class="mkt-vg-note">What is owed is a list with dates, not a feeling. Reminders read as care.</div>' +
    '</div>'
  );
}

function vgSchedule(): string {
  return (
    '<div class="mkt-vg">' +
    '<div class="mkt-vg-h">My schedule<span class="r">Saved on this phone</span></div>' +
    '<div class="mkt-prow"><span class="mkt-time">09:30</span><div><b>Evaluating agents under load</b><i>Main stage · 25 min</i></div><span class="mkt-star">★</span></div>' +
    '<div class="mkt-prow"><span class="mkt-time">10:05</span><div><b>Agents in production, honestly</b><i>Studio · 50 min</i></div><span class="mkt-star">★</span></div>' +
    '<div class="mkt-prow"><span class="mkt-time">11:20</span><div><b>Build with the people who made it</b><i>Workshop room · 90 min</i></div><span class="mkt-star">★</span></div>' +
    '<div class="mkt-vg-note">You can make all three — Main stage to Studio is a four-minute walk, and the schedule says so before you start.</div>' +
    '</div>'
  );
}

function vgPeople(): string {
  return (
    '<div class="mkt-vg">' +
    '<div class="mkt-vg-h">People to find<span class="r">Thursday</span></div>' +
    '<div class="mkt-prow"><span class="mkt-av">MA</span><div><b>Marisol Adeyemi</b>' +
    '<i>Coldbrook Systems · “Coffee before the keynote?”</i></div></div>' +
    '<div class="mkt-prow"><span class="mkt-av">TL</span><div><b>Tomás Lindqvist</b>' +
    '<i>Name only — the rest kept private</i></div></div>' +
    '<div class="mkt-prow"><span class="mkt-av">JO</span><div><b>Jun Okafor</b>' +
    '<i>Northwind Labs · jun@example.org</i></div></div>' +
    '<div class="mkt-vg-note">You each said you were at <b>The year the tooling caught up</b>. ' +
    'Nobody else can see that you did. Your name always; work, links, and email each open only if you open them.</div>' +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The live section reads the world.
 * ------------------------------------------------------------------ */

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** A day key (`YYYY-MM-DD`) as its own wall date — no timezone shift, the key
 *  is already the event's local day. Mirrors the event-home helper. */
function dayParts(iso: string): { weekday: string; day: number; month: string; year: number } {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  return {
    weekday: dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }),
    day: d ?? 1,
    month: dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' }),
    year: y ?? 1970,
  };
}
function dateRange(startsOn: string, endsOn: string): string {
  const s = dayParts(startsOn);
  const e = dayParts(endsOn);
  if (startsOn === endsOn) return `${s.weekday} ${s.day} ${s.month} ${s.year}`;
  if (s.month === e.month && s.year === e.year) {
    return `${s.weekday} ${s.day} – ${e.weekday} ${e.day} ${s.month} ${s.year}`;
  }
  if (s.year === e.year) {
    return `${s.weekday} ${s.day} ${s.month} – ${e.weekday} ${e.day} ${e.month} ${e.year}`;
  }
  return `${s.weekday} ${s.day} ${s.month} ${s.year} – ${e.weekday} ${e.day} ${e.month} ${e.year}`;
}

/** The one-line state a card wears, from the lifecycle and nothing backstage. */
function eventStanding(ev: EventCard): string {
  if (ev.lifecycle === 'open') return 'Open · the call is running';
  if (ev.lifecycle === 'happened') return ev.agendaPublished ? 'Happened · recordings up' : 'Happened';
  return ev.agendaPublished ? 'Program set · agenda up' : 'Deciding · the call has closed';
}

// The two seeded conferences carry hand-written walkthrough copy — the demo's
// front line, keyed by slug so they render only while they are really in the
// world. Everything else the page might list gets the generic card below.
const CURATED: Record<string, string> = {
  'aie-nyc':
    '<div class="mkt-ev"><h3>AI Engineer New York 2026</h3>' +
    '<p class="when">Thursday 3 – Friday 4 September · New York</p>' +
    '<p class="st"><i></i>Open · closing in nine days</p>' +
    '<p class="ln">The call is open and the committee is mid-decision: a thousand proposals ' +
    'in, six hundred and ten decisions made and not yet sent. Walk in and finish it.</p>' +
    '<div class="more"><strong>Backstage, signed in as the organizer</strong>' +
    '<a class="link" href="/admin/aie-nyc/submissions">The pile</a>' +
    '<a class="link" href="/admin/aie-nyc/outbox">The outbox</a>' +
    '<a class="link" href="/aie-nyc/portal">A speaker’s portal</a>' +
    '<a class="link" href="/admin/aie-nyc/green-room">The green room</a></div>' +
    '<p class="ln" style="margin-top:10px">The organizer sign-in is published in the repository’s ' +
    'README. Sign in with it, decide things, send the letters, and move a session into a room ' +
    'that is already busy — watch it argue.</p>' +
    '<div class="go"><a class="btn btn-primary btn-lg" href="/aie-nyc/cfp">Open the call →</a>' +
    '<a class="btn btn-lg" href="/aie-nyc">See the conference →</a>' +
    '<a class="btn btn-lg" href="/aie-nyc/ask">Ask it anything →</a></div>' +
    '</div>',
  'ddc-clt':
    '<div class="mkt-ev mkt-past"><h3>DevOps Days Charlotte 2025</h3>' +
    '<p class="when">Thursday 6 – Friday 7 November · Charlotte</p>' +
    '<p class="st"><i></i>Happened · recordings up</p>' +
    '<p class="ln">A conference in its afterlife. Recordings sit on the sessions, the schedule ' +
    'stands exactly as it ran, and the people who met in the hallway are still finding each ' +
    'other on it.</p>' +
    '<div class="more mkt-more-txt"><strong>Open to anyone</strong>The program, the speakers, ' +
    'the recordings and the people, with no sign-in at all.</div>' +
    '<div class="go"><a class="btn btn-lg" href="/ddc-clt">See the program →</a>' +
    '<a class="btn" href="/ddc-clt/ask">Ask it anything →</a>' +
    '</div></div>',
};

/** The headline over the live cards, counting what is actually there. Falls
 *  back to the plain sentence if the list could not be read. */
function liveHeadline(events: EventCard[]): string {
  const n = events.length;
  if (n === 0) return 'Walk a conference running on this right now.';
  if (n === 1) return 'A conference is running on this right now.';
  return `${numberWord(n).replace(/^./, (c) => c.toUpperCase())} conferences are running on this right now.`;
}

/** The cards: the curated two first, in walkthrough order, then any other
 *  event the world holds — a conference stood up while the page was live. */
function liveCards(events: EventCard[]): string {
  const order = ['aie-nyc', 'ddc-clt'];
  const bySlug = new Map(events.map((e) => [e.slug, e]));
  const cards: string[] = [];
  for (const slug of order) {
    if (bySlug.has(slug)) cards.push(CURATED[slug]!);
  }
  for (const ev of events) {
    if (!order.includes(ev.slug)) cards.push(genericCard(ev));
  }
  // If the read came back empty, the seeded pair is still the honest default:
  // the page is never blank where a conference should be.
  if (!cards.length) return CURATED['aie-nyc']! + CURATED['ddc-clt']!;
  return cards.join('');
}

/** A card for an event with no hand-written walkthrough — a conference someone
 *  (or an agent walking the call) stood up while the page was live. Public
 *  surfaces only, no backstage numbers, no invented copy. */
function genericCard(ev: EventCard): string {
  const past = ev.lifecycle === 'happened';
  const where = ev.venueName ? ` · ${esc(ev.venueName)}` : '';
  const s = encodeURIComponent(ev.slug);
  const call =
    ev.lifecycle === 'open'
      ? `<a class="btn btn-primary btn-lg" href="/${s}/cfp">Open the call →</a>`
      : '';
  return (
    `<div class="mkt-ev${past ? ' mkt-past' : ''}"><h3>${esc(ev.name)}</h3>` +
    `<p class="when">${esc(dateRange(ev.startsOn, ev.endsOn))}${where}</p>` +
    `<p class="st"><i></i>${esc(eventStanding(ev))}</p>` +
    `<p class="ln">Stood up on Fireside, and open to walk: the program, the speakers, and — ` +
    `while the call is open — the form itself.</p>` +
    `<div class="go">${call}<a class="btn btn-lg" href="/${s}">See the conference →</a>` +
    `<a class="btn" href="/${s}/ask">Ask it anything →</a></div>` +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * The page.
 * ------------------------------------------------------------------ */

export function homePage(signedIn = false, events: EventCard[] = []): string {
  const nav =
    '<a href="#program">Program</a>' +
    '<a href="#team">Team</a>' +
    '<a href="#attendees">Attendees</a>' +
    '<a href="#mechanics">How it works</a>' +
    '<a href="#ask-anywhere">Concierge</a>' +
    '<a href="#live">Walk one</a>' +
    (signedIn
      ? '<a href="/admin">Backstage</a><a href="/sign-out">Sign out</a>'
      : '<a href="/sign-in">Sign in</a>');

  const hero =
    '<section class="mkt-hero"><div class="mkt-wrap">' +
    '<div class="mkt-hero-grid">' +
    '<div>' +
    '<p class="mkt-kick">Conference program software · for editorial teams</p>' +
    '<h1>Keep your whole conference <em>humming in sync.</em></h1>' +
    '<p class="mkt-lede">Months before the audience arrives, follow the proposals, reviews, placements, ' +
    'and speaker obligations that still need a decision. By show day, reviewers can finish their ' +
    'assigned proposals, speakers can check what is due, volunteers can run the next room, and ' +
    'attendees can use the agenda.</p>' +
    '<div class="mkt-cta">' +
    '<a class="btn btn-primary btn-lg" href="#live">Walk a live conference →</a>' +
    '<a class="btn btn-lg" href="#program">See the program desk</a>' +
    (signedIn ? '<a class="btn btn-lg" href="/admin">Your backstage</a>' : '') +
    '</div>' +
    '</div>' +
    vgPulse() +
    '</div>' +
    `<div class="mkt-run">${RUNWAY.map(
      (s) => `<div class="mkt-run-s"><span>${esc(s.t)}</span><h3>${esc(s.h)}</h3></div>`
    ).join('')}</div>` +
    '</div></section>';

  const program =
    '<section class="mkt-sec mkt-deep" id="program"><div class="mkt-wrap mkt-cols">' +
    '<div>' +
    '<p class="mkt-kick">The editorial desk</p>' +
    '<h2 class="mkt-h">A thousand proposals make it inordinately hard to curate a program that matches the theme and wows the audience.</h2>' +
    '<p class="mkt-p">The program chair is weighing the theme, the audience, the formats, and the ' +
    'people behind every promising talk. Fireside keeps the proposals, the review marks, and the ' +
    'placement questions together while those choices are still open.</p>' +
    '</div>' +
    vgBoard() +
    '</div></section>';

  const turn =
    '<section class="mkt-turn"><div class="mkt-wrap">' +
    '<p class="mkt-kick">The rule everything else follows from</p>' +
    '<p>A decision leaves when you send it, not when you make it.' +
    '<b>Who has been told is never a guess.</b></p>' +
    '</div></section>';

  const team =
    '<section class="mkt-sec" id="team"><div class="mkt-wrap">' +
    '<p class="mkt-kick">One program · many hands</p>' +
    '<h2 class="mkt-h">Each person sees the work they carry.</h2>' +
    '<p class="mkt-lede">The editorial lead shapes the lineup. Organizers follow open obligations, ' +
    'reviewers finish their rounds, speakers see what is due, volunteers run the next room, and ' +
    'attendees use the day. Each gets the context for their part without inheriting the whole ' +
    'control room.</p>' +
    '<div class="mkt-grid">' +
    ROLES.map(
      (r) =>
        `<div class="mkt-cell"><p class="mkt-role">${esc(r.who)}</p><h3>${esc(r.h)}</h3><p>${esc(r.p)}</p></div>`
    ).join('') +
    '</div></div></section>';

  const proof =
    '<section class="mkt-proof"><div class="mkt-wrap">' +
    '<p class="q">Save the stress for <b>choosing the talks.</b></p>' +
    '<p class="s">That is the work only the program team can do. They should not spend Friday ' +
    'rechecking counts, searching inboxes for a deck, or discovering that a speaker never got ' +
    'the reminder.</p>' +
    '</div></section>';

  const review =
    '<section class="mkt-sec" id="review"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Collaborative review</p>' +
    '<h2 class="mkt-h">Let reviewers think alone, then let the committee see together.</h2>' +
    '<p class="mkt-lede">A reviewer who sees the wrong name cannot unsee it. A half-submitted round ' +
    'leaves the committee guessing. Reviewers assess what is assigned to them; the committee reads ' +
    'finished rounds when it is time to shape the lineup.</p>' +
    vgReview() +
    '</div></section>';

  const concierge =
    // id is 'ask-anywhere', not 'concierge': shared.css pins #concierge fixed
    // in the corner for the bubble's mount, and a section that borrowed the id
    // would inherit position:fixed and float over the hero.
    '<section class="mkt-sec mkt-deep" id="ask-anywhere"><div class="mkt-wrap mkt-cols">' +
    '<div>' +
    '<p class="mkt-kick">The concierge</p>' +
    '<h2 class="mkt-h">Ask the program a question, get the page you were after.</h2>' +
    '<p class="mkt-p">On every page of an event there is a corner to ask in. Six questions are ' +
    'answered straight off the database — no model in the path, no wait — and the concierge knows ' +
    'who is asking: an organizer asks after the pile, a speaker after what is owed. A question ' +
    'nobody could answer lands with the organizers, so the next person gets a better one.</p>' +
    '<p class="mkt-p">It extends the same courtesy to your agent. Fireside speaks MCP: the public ' +
    'program as tools for anyone, and a printed connect command for the signed-in — so a reviewer ' +
    'can hand their queue to Claude and file every review without leaving the terminal.</p>' +
    '<a class="mkt-door" href="/agents">Connect your agent →</a>' +
    '<a class="mkt-door" href="/aie-nyc/ask" style="margin-left:18px">Ask it anything →</a>' +
    '</div>' +
    vgConcierge() +
    '</div></section>';

  const showday =
    '<section class="mkt-sec" id="showday"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Final weeks · show day</p>' +
    '<h2 class="mkt-h">Every promise lands with the person carrying it.</h2>' +
    '<p class="mkt-lede">A forgotten deck or arrival contact becomes a Friday emergency. On show ' +
    'day, a volunteer with one bar still knows the next face, the room, the slide status, and the ' +
    'one number to tap. The private detail stays in the organizer and runner views that need it.</p>' +
    `<div class="mkt-cols">${vgReadiness()}${vgGreenRoom()}</div>` +
    '</div></section>';

  const attendees =
    '<section class="mkt-sec mkt-deep" id="attendees"><div class="mkt-wrap">' +
    '<p class="mkt-kick">The attendee experience</p>' +
    '<h2 class="mkt-h">A full program needs a workable day.</h2>' +
    '<p class="mkt-lede">The smorgasbord is the point. With one phone and one day, an attendee can ' +
    'save sessions, catch conflicts before the walk, find the room, and return to what they ' +
    'missed. And the hallway track is real: say you were in the room, and find the people who ' +
    'said it too.</p>' +
    `<div class="mkt-cols">${vgSchedule()}${vgPeople()}</div>` +
    '</div></section>';

  const lifecycle =
    '<section class="mkt-sec"><div class="mkt-wrap mkt-cols">' +
    '<div>' +
    '<p class="mkt-kick">Public, during, after</p>' +
    '<h2 class="mkt-h">The agenda helps people decide, use the day, and come back to it.</h2>' +
    '<p class="mkt-p">Before the trip, people need to know why these talks belong together. During ' +
    'the conference, they need a schedule that works where the wifi does not. Afterward, they need ' +
    'a direct route to what they missed.</p>' +
    '</div>' +
    `<div class="mkt-year">${LIFECYCLE.map(
      (w) =>
        `<div class="mkt-step"><div class="ph">${esc(w.t)}</div>` +
        `<div class="bd"><h3 style="margin:0 0 4px;font-size:16px">${esc(w.h)}</h3><p>${esc(w.p)}</p></div></div>`
    ).join('')}</div>` +
    '</div></section>';

  const live =
    '<section class="mkt-sec mkt-top" id="live"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Walk one</p>' +
    `<h2 class="mkt-h">${liveHeadline(events)}</h2>` +
    '<p class="mkt-lede">Open one and walk it end to end: the public call, the ' +
    'organizer’s pile, the letters waiting to go, the sheet the crew carries on the day.</p>' +
    `<div class="mkt-doors">${liveCards(events)}</div>` +
    '<p class="mkt-note">The seeded conferences are demonstrations with invented people, and ' +
    'everything resets on a schedule — so a conference stood up here, by an organizer or by an ' +
    'agent walking the call, is real while it lasts and swept with the rest.</p>' +
    '</div></section>';

  const mechanics =
    '<section class="mkt-sec" id="mechanics"><div class="mkt-wrap mkt-cols">' +
    '<div>' +
    '<p class="mkt-kick">How it works</p>' +
    '<h2 class="mkt-h">A new room or speaker detail reaches the people acting on it.</h2>' +
    '<p class="mkt-p">The organizer, the speaker, the volunteer, and the attendee do not work ' +
    'from separate versions of the program. Their permitted views agree the moment a session, a ' +
    'contact, or a placement changes.</p>' +
    '<div class="mkt-facts" style="margin-top:18px"><span>Apache-2.0</span><span>One Worker, one database</span>' +
    '<span>Your speaker data, in your account</span><span>No trackers, no cookie wall</span></div>' +
    '<p class="mkt-p" style="margin-top:16px">Fireside is open source, and it runs in your own ' +
    'Cloudflare account — no fleet to operate, no vendor sitting inside your speakers’ personal ' +
    'data. Clone it, put your own name on it, and have your own call open by the end of an ' +
    'afternoon.</p>' +
    '<a class="mkt-door" href="https://github.com/Phantastic-AI/fireside">Read the source →</a>' +
    '</div>' +
    `<div class="mkt-grid mkt-grid-1">${MECHANICS.map(
      (m) => `<div class="mkt-cell"><h3>${esc(m.h)}</h3><p>${esc(m.p)}</p></div>`
    ).join('')}</div>` +
    '</div></section>';

  const founder =
    '<section class="mkt-sec mkt-deep"><div class="mkt-wrap mkt-founder">' +
    '<p class="mkt-kick">Why this matters to me</p>' +
    '<blockquote>I love conferences where 25 minutes can crystallize the field, 50 can open it ' +
    'up, and a workshop lets you learn from the people who made the thing. Fireside is for the ' +
    'program teams who create those days and for everyone trying to get more from them.</blockquote>' +
    '<p class="mkt-sig">Aditya, founder of Fireside</p>' +
    '</div></section>';

  const closing =
    '<section class="mkt-proof mkt-top"><div class="mkt-wrap">' +
    '<p class="q">Bring us the conference <b>you are already planning.</b></p>' +
    '<p class="s">Bring the talks still competing for a place, the speakers who need an answer, ' +
    'and the Friday details that cannot be lost in an inbox. Carry them through the agenda, the ' +
    'green room, and the sessions people return to afterward.</p>' +
    '<a class="mkt-door" href="#live">Walk your conference through Fireside →</a>' +
    '</div></section>';

  const body =
    '<div class="stage onstage">' +
    `<header class="mast mkt-mast"><div class="wrap mast-in">${brand()}<nav>${nav}</nav></div></header>` +
    '<main class="mkt-main">' +
    hero +
    program +
    turn +
    team +
    proof +
    review +
    concierge +
    showday +
    attendees +
    lifecycle +
    live +
    mechanics +
    founder +
    closing +
    '</main>' +
    '<footer class="foot mkt-foot"><div class="wrap foot-in">' +
    `<span class="fname">${NAME}</span>` +
    '<span>Conference program software, open source.</span>' +
    '<span style="margin-left:auto"><a class="link" href="https://github.com/Phantastic-AI/fireside">GitHub</a></span>' +
    '</div></footer></div>';

  return page({
    title: 'Fireside — keep your whole conference humming in sync',
    description:
      'Open-source conference program software: the call for speakers, blind review rounds, ' +
      'decisions and letters, the agenda, the speaker portal, the green room, a role-aware ' +
      'concierge, MCP for agents, and an attendee layer where the people who saw the same talk ' +
      'find each other.',
    register: 'onstage',
    body,
  });
}
