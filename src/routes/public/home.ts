// The front door. Not a screen of the product — the site that explains it.
//
// Register law: D-025 (every headline parses cold to a stranger, no self-talk)
// and D-027 (the product never narrates its own construction, its demo-ness,
// or any contest — every sentence here is written for a conference organizer
// evaluating finished software). The single honest disclosure about the
// example conferences lives in the live section and nowhere else.
//
// The whole page is drawn from tokens: no images, no webfonts, no third-party
// request of any kind. The product vignettes are HTML and CSS.
import { esc, page, brand, NAME } from '../../lib/html';

/* ------------------------------------------------------------------ *
 * Content. Kept as data so the shape of the page stays readable.
 * ------------------------------------------------------------------ */

const SPINE = ['The call', 'The deciding', 'The telling', 'The build-up', 'The day', 'The after'];

// Product truths, not build notes. When the events become live queries these
// two counts come from the database with them (L-5); the rest are constants
// of the software itself.
const NUMBERS: { n: string; l: string }[] = [
  { n: '2', l: 'live example conferences' },
  { n: '1,000', l: 'proposals inside them' },
  { n: '3', l: 'ways to sign in' },
  { n: '1', l: 'server to run' },
  { n: '0', l: 'trackers' },
];

const PAIRS: { x: string; y: string }[] = [
  {
    x: 'One green button that decides and tells six hundred people in the same breath.',
    y: 'Deciding and telling are two separate acts here, with a room between them.',
  },
  {
    x: 'A table that ends at zero rows and leaves you standing there.',
    y: 'Every empty screen names the next thing to do, and links straight to it.',
  },
  {
    x: 'A review queue that feeds you one proposal at a time, under a counter that says 1,000 when the truth is 40.',
    y: 'The whole list on one page. The filters are counts, and the counts are true.',
  },
  {
    x: 'Make an account, verify your email, and then you may begin typing your abstract.',
    y: 'One page, no account until you press send, and a half-written abstract that survives a dead battery.',
  },
  {
    x: 'Speaker mail that reads like it was drafted by a compliance department.',
    y: 'Letters carry the committee’s own sentence, in the committee’s own words.',
  },
  {
    x: 'A schedule page that needs four requests and a spinner to say 10:30, Ballroom A.',
    y: 'Plain pages, no spinner. The agenda opens on one bar of venue wifi.',
  },
];

const REST: { h: string; p: string }[] = [
  {
    h: 'Review rounds and blind mode',
    p: 'Assignments per reviewer, names hidden while scoring, and your scores private until you submit them.',
  },
  {
    h: 'Decisions and the outbox',
    p: 'Decide in private, read the letters, then send hundreds in one deliberate act. None twice, none forgotten.',
  },
  {
    h: 'The speaker portal',
    p: 'One page per speaker: the decision, the tasks, the dates, what is still owed. Reminders that read as care.',
  },
  {
    h: 'The agenda builder',
    p: 'Click to place. A double-booked room, or a speaker in two places at once, surfaces at the moment of placement rather than at print time.',
  },
  {
    h: 'Embeds and calendar files',
    p: 'Put the agenda, the speaker gallery, or one person’s itinerary on your own site. Every schedule is one calendar file away.',
  },
  {
    h: 'A concierge, and the same doors for your agent',
    p: 'Ask a question and get working links back rather than paragraphs. The public doors — the program, the speakers, the call itself — are also MCP: point your agent at /mcp.',
  },
];

const YEAR: { phase: string; line: string; door: string; href: string }[] = [
  {
    phase: 'The call',
    line: 'Speakers write and nothing is lost. The pile grows in front of you, themed and searchable from the first day.',
    door: 'Open the form',
    href: '/aie-nyc/cfp',
  },
  {
    phase: 'The deciding',
    line: 'Rounds, blind mode, aggregates. Your score stays yours until you submit it; the committee’s becomes a shape you can read.',
    door: 'Open the pile',
    href: '/admin/aie-nyc/submissions',
  },
  {
    phase: 'The telling',
    line: 'Letters stage quietly, get read, and leave in one act — each with the note you wrote for that person.',
    door: 'Open the outbox',
    href: '/admin/aie-nyc/outbox',
  },
  {
    phase: 'The build-up',
    line: 'Decks chased, headshots collected, travel times confirmed. Kindly, on a schedule, and not by you.',
    door: 'Open a speaker’s portal',
    href: '/aie-nyc/portal',
  },
  {
    phase: 'The day',
    line: 'Run of show on every phone with a lanyard behind it, down to the room the next speaker is standing outside.',
    door: 'Open the green room',
    href: '/admin/aie-nyc/green-room',
  },
  {
    phase: 'The after',
    line: 'Recordings land on the sessions, the schedule stays where you published it, and the people met in corridors survive the week.',
    door: 'Open Charlotte, 2025',
    href: '/ddc-clt',
  },
];

/* ------------------------------------------------------------------ *
 * Vignettes — the product sketched in its own materials.
 * ------------------------------------------------------------------ */

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
    'Nobody else can see that you did.</div>' +
    '</div>'
  );
}

function vgDirectory(): string {
  const years = ['2021', '2022', '2023', '2024', '2025', '2026'];
  const spoke = new Set(['2022', '2023', '2025', '2026']);
  return (
    '<div class="mkt-vg">' +
    '<div class="mkt-srch"><span class="q">accepted 2025, reliability</span>' +
    '<span class="c">14 people</span></div>' +
    '<div class="mkt-prow"><span class="mkt-av">PR</span><div><b>Priya Raghunathan</b>' +
    '<i>Staff engineer, Foundry · Lisbon</i></div></div>' +
    '<div class="mkt-years">' +
    years.map((y) => `<span class="${spoke.has(y) ? 'on' : ''}">${esc(y)}</span>`).join('') +
    '</div>' +
    '<div class="mkt-tags"><span class="mkt-tag ok">Four talks</span>' +
    '<span class="mkt-tag">Reviewed 2024</span>' +
    '<span class="mkt-tag">Room loved it</span></div>' +
    '<div class="mkt-vg-note">One person, six years, two conferences — and every word of it hers to correct.</div>' +
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

function vgCall(): string {
  return (
    '<div class="mkt-vg">' +
    '<div class="mkt-vg-h">Your talk in one paragraph<span class="r">148 / 1200</span></div>' +
    '<div class="mkt-field">We shipped the rewrite on a Friday and spent the weekend rolling it back. ' +
    'Here is what the third attempt got right, and the two things we</div>' +
    '<div class="mkt-eg"><b>For example</b>Name the room you are talking to, the thing that went ' +
    'wrong, and what was different afterwards.' +
    '<span class="mkt-egbtn">Use this as a starting point</span></div>' +
    '<div class="mkt-saved">Saved, a moment ago</div>' +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * Sections.
 * ------------------------------------------------------------------ */

function show(o: {
  flip?: boolean;
  kick: string;
  h: string;
  body: string[];
  door?: { label: string; href: string };
  art: string;
}): string {
  return (
    `<section class="mkt-show${o.flip ? ' mkt-flip' : ''}"><div class="mkt-wrap mkt-show-in">` +
    '<div class="mkt-show-txt">' +
    `<p class="mkt-kick">${o.kick}</p>` +
    `<h2 class="mkt-h">${o.h}</h2>` +
    o.body.map((p) => `<p class="mkt-p">${p}</p>`).join('') +
    (o.door ? `<a class="mkt-door" href="${o.door.href}">${o.door.label} →</a>` : '') +
    '</div>' +
    `<div class="mkt-show-art">${o.art}</div>` +
    '</div></section>'
  );
}

export function homePage(signedIn = false): string {
  const nav =
    '<a href="#product">The product</a>' +
    '<a href="#year">The year</a>' +
    '<a href="#live">Walk one</a>' +
    '<a href="#open">Open source</a>' +
    (signedIn
      ? '<a href="/admin">Backstage</a><a href="/sign-out">Sign out</a>'
      : '<a href="/sign-in">Sign in</a>');

  const hero =
    '<section class="mkt-hero"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Open source · Apache-2.0 · One Worker</p>' +
    '<h1>One place for speakers, sessions, and <em>the day of the show.</em></h1>' +
    '<p class="mkt-lede">Fireside runs the call, the committee, the decisions, the agenda ' +
    'and the green room — organizers get a pile that finally moves, speakers get one page ' +
    'that tells them exactly what is still due, and attendees find the people who were in ' +
    'the room with them.</p>' +
    '<div class="mkt-cta">' +
    '<a class="btn btn-primary btn-lg" href="#live">Walk a live conference →</a>' +
    (signedIn
      ? '<a class="btn btn-lg" href="/admin">Your backstage →</a>'
      : '<a class="btn btn-lg" href="/sign-in">Sign in</a>') +
    '</div>' +
    `<div class="mkt-spine">${SPINE.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` +
    '</div></section>';

  const numbers =
    '<div class="mkt-wrap"><div class="mkt-nums">' +
    NUMBERS.map((s) => `<div class="mkt-num"><div class="n">${esc(s.n)}</div><div class="l">${esc(s.l)}</div></div>`).join('') +
    '</div></div>';

  const pain =
    '<section class="mkt-sec mkt-deep"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Why it exists</p>' +
    '<h2 class="mkt-h">Everything we hate about call-for-speakers tools.</h2>' +
    '<p class="mkt-lede">This is not market research. It is a grudge, itemized, with what ' +
    'we did about each line of it.</p>' +
    '<div class="mkt-pairs">' +
    PAIRS.map(
      (p) => `<div class="mkt-pair"><p class="x">${esc(p.x)}</p><p class="y">${esc(p.y)}</p></div>`
    ).join('') +
    '</div>' +
    '<p class="mkt-confess">Exhibit A of our desperation: three spreadsheets, a shared inbox, ' +
    'a Trello board nobody archived, and one organizer who has personally typed 610 rejection ' +
    'emails.</p>' +
    '</div></section>';

  const turn =
    '<section class="mkt-turn"><div class="mkt-wrap">' +
    '<p class="mkt-kick">The rule everything else follows from</p>' +
    '<p>A decision leaves when you send it, not when you make it.' +
    '<b>Who has been told is never a guess.</b></p>' +
    '</div></section>';

  const product =
    '<div id="product">' +
    show({
      kick: 'The attendee layer',
      h: 'The people who sat through the same talk can find each other.',
      body: [
        'Star a session, and afterwards you can say you were there. If someone else in that ' +
          'room says it too, the two of you appear on each other’s list, and on nobody else’s.',
        'Your name always. Where you work, your links, your email — each one opens only if you ' +
          'open it. No messages to moderate, no follower graph, no notification you did not ask ' +
          'for. Fireside shows the door and then gets out of the way.',
      ],
      door: { label: 'See a conference that already happened', href: '/ddc-clt' },
      art: vgPeople(),
    }) +
    show({
      flip: true,
      kick: 'People, not rows',
      h: 'A speaker is a person with a history, not a row behind a talk.',
      body: [
        'Fireside keeps people across years and across events. “Accepted in 2025, and the room ' +
          'loved it” is a query, not something one committee member half-remembers on a call.',
        'Next year’s program starts from the people you already trust — who spoke, who ' +
          'reviewed, who you turned down kindly and should ask again.',
      ],
      door: { label: 'Open a speaker’s own page', href: '/aie-nyc/portal' },
      art: vgDirectory(),
    }) +
    show({
      kick: 'The day of the show',
      h: 'The day of the show, on a volunteer’s phone.',
      body: [
        'Who is next, what they look like, whether their slides are in, and one number to tap ' +
          'when they are not in the room.',
        'The green room sheet is a link you hand to a runner. Read-only, no account needed, ' +
          'and none of your own sign-in ends up in somebody else’s pocket. It opens in a ' +
          'basement on one bar of signal, because that is where it gets used.',
      ],
      door: { label: 'Open the green room', href: '/admin/aie-nyc/green-room' },
      art: vgGreenRoom(),
    }) +
    show({
      flip: true,
      kick: 'The call for speakers',
      h: 'A form that teaches by example and never loses a keystroke.',
      body: [
        'Every field can carry a real example of a good answer, written by you, one tap away. ' +
          'Speakers stop guessing what you want and start writing it.',
        'Every keystroke saves as it is typed, so a closed laptop costs nothing. Ask your own ' +
          'questions, reorder them, and show one only when an earlier answer calls for it — no ' +
          'separate form builder, no export, no second tool to keep in step.',
      ],
      door: { label: 'Open the call', href: '/aie-nyc/cfp' },
      art: vgCall(),
    }) +
    '</div>';

  const rest =
    '<section class="mkt-sec mkt-deep mkt-top"><div class="mkt-wrap">' +
    '<p class="mkt-kick">The rest of the job</p>' +
    '<h2 class="mkt-h">And everything else a conference actually needs.</h2>' +
    '<div class="mkt-grid">' +
    REST.map((r) => `<div class="mkt-cell"><h3>${esc(r.h)}</h3><p>${esc(r.p)}</p></div>`).join('') +
    '<div class="mkt-cell mkt-ways"><b>Three ways to sign in:</b> a password, a link in your ' +
    'email, or Google. Attendees need none of them until they want their starred sessions to ' +
    'follow them to another device.</div>' +
    '</div></div></section>';

  const year =
    '<section class="mkt-sec" id="year"><div class="mkt-wrap">' +
    '<p class="mkt-kick">The shape of the thing</p>' +
    '<h2 class="mkt-h">A conference is a year, not a day.</h2>' +
    '<p class="mkt-lede">Fireside is built along it. Each door below opens at that exact ' +
    'moment of the year.</p>' +
    '<div class="mkt-year">' +
    YEAR.map(
      (w) =>
        `<div class="mkt-step"><div class="ph">${esc(w.phase)}</div>` +
        `<div class="bd"><p>${esc(w.line)}</p>` +
        `<a class="link" href="${w.href}">${esc(w.door)} →</a></div></div>`
    ).join('') +
    '</div></div></section>';

  const live =
    '<section class="mkt-sec mkt-top" id="live"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Walk one</p>' +
    '<h2 class="mkt-h">Two conferences are running on this right now.</h2>' +
    '<p class="mkt-lede">Open either one and walk it end to end: the public call, the ' +
    'organizer’s pile, the letters waiting to go, the sheet the crew carries on the day.</p>' +
    '<div class="mkt-doors">' +
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
    '<div class="go"><a class="btn btn-primary btn-lg" href="/aie-nyc/cfp">Open the call →</a>' +
    '<a class="btn btn-lg" href="/aie-nyc/ask">Ask it anything →</a></div>' +
    '</div>' +
    '<div class="mkt-ev mkt-past"><h3>DevOps Days Charlotte 2025</h3>' +
    '<p class="when">Thursday 6 – Friday 7 November · Charlotte</p>' +
    '<p class="st"><i></i>Happened · recordings up</p>' +
    '<p class="ln">A conference in its afterlife. Recordings sit on the sessions, the schedule ' +
    'stands exactly as it ran, and the people who met in the hallway are still finding each ' +
    'other on it.</p>' +
    '<div class="more mkt-more-txt"><strong>Open to anyone</strong>The program, the speakers, ' +
    'the recordings and the people, with no sign-in at all.</div>' +
    '<div class="go"><a class="btn btn-lg" href="/ddc-clt">See the program →</a>' +
    '<a class="btn" href="/ddc-clt/ask">Ask it anything →</a></div>' +
    '</div>' +
    '</div>' +
    '<p class="mkt-note">These are demonstration conferences with invented people. Everything ' +
    'resets on a schedule.</p>' +
    '</div></section>';

  const close =
    '<section class="mkt-sec mkt-deep mkt-top" id="open"><div class="mkt-wrap">' +
    '<p class="mkt-kick">Open source</p>' +
    '<h2 class="mkt-h">Yours, all the way down.</h2>' +
    '<p class="mkt-lede">Fireside is Apache-2.0. It runs as one Cloudflare Worker over one ' +
    'SQLite database — no fleet to operate, no queue to babysit, and no vendor sitting inside ' +
    'your speakers’ personal data. Clone it, put your own name on it, and have your own call ' +
    'open by the end of an afternoon.</p>' +
    '<div class="mkt-facts"><span>Apache-2.0</span><span>One Worker, one database</span>' +
    '<span>Your speaker data, in your account</span><span>No trackers, no cookie wall</span></div>' +
    '<div class="mkt-try"><h3>Try it as the organizer</h3>' +
    '<p>The organizer sign-in for the two conferences above is published in the ' +
    '<span class="mkt-code">README</span> of the repository. Sign in with it, decide things, ' +
    'send the letters, move a session into a room that is already busy and watch it argue.</p>' +
    '<div class="btnrow" style="margin-top:18px">' +
    '<a class="btn btn-primary" href="https://github.com/Phantastic-AI/fireside">The repository →</a>' +
    '<a class="btn" href="#live">Walk a conference</a>' +
    '</div></div>' +
    '</div></section>';

  // No script on this page, deliberately. The one entrance is CSS, above the
  // fold, so nothing is ever hidden from a reader, a crawler or a printer.
  const body =
    '<div class="stage onstage">' +
    `<header class="mast mkt-mast"><div class="wrap mast-in">${brand()}<nav>${nav}</nav></div></header>` +
    '<main class="mkt-main">' +
    hero +
    numbers +
    pain +
    turn +
    product +
    rest +
    year +
    live +
    close +
    '</main>' +
    '<footer class="foot mkt-foot"><div class="wrap foot-in">' +
    `<span class="fname">${NAME}</span>` +
    '<span>An open-source call for speakers — and everything after.</span>' +
    '<span style="margin-left:auto"><a class="link" href="https://github.com/Phantastic-AI/fireside">GitHub</a></span>' +
    '</div></footer></div>';

  return page({
    title: 'Fireside — one place for speakers, sessions, and the day of the show',
    description:
      'Open-source conference software: the call for speakers, review rounds, decisions and ' +
      'letters, the agenda, the speaker portal, the green room, and an attendee layer that lets ' +
      'the people who saw the same talk find each other.',
    register: 'onstage',
    body,
  });
}
