// The front door: marketing home and live demo doors, one page.
// Copy source: KYS docs/public-site.md (D-025: headlines parse cold).
import { esc, onstageShell, page } from '../../lib/html';

// TODO(seed): these two cards render from queries the moment seed.ts lands —
// the counts on this page must be the counts in the database (L-5).
const EVENTS_STUB = [
  {
    slug: 'aie-nyc',
    name: 'AI Engineer New York 2026',
    dates: 'Thu 3 – Fri 4 September 2026',
    where: 'New York',
    state: 'Open · closes in 9 days',
    open: true,
    line: '1,000 proposals · 60 accepted · 610 decisions waiting to be sent',
    cta: 'Open the call',
    href: '/aie-nyc/cfp',
  },
  {
    slug: 'ddc-clt',
    name: 'DevOps Days Charlotte 2025',
    dates: 'Thu 6 – Fri 7 November 2025',
    where: 'Charlotte',
    state: 'Happened · recordings up',
    open: false,
    line: '84 proposals · 14 accepted · the after still working',
    cta: 'See the program →',
    href: '/ddc-clt/agenda',
  },
];

const MIRROR: [string, string][] = [
  [
    'One green button that decides and tells 600 people in the same breath.',
    'A decision leaves when you send it, not when you make it. Who has been told is never a guess.',
  ],
  [
    'A table that ends at zero rows and leaves you nowhere to go.',
    'Every empty screen names the next thing to do, and links to it.',
  ],
  [
    'A queue that feeds a reviewer one proposal at a time, under a count that says 1,000 where the truth is 40.',
    'The whole list on one page, with the counts that are actually true.',
  ],
  [
    'Make an account, verify your email, and then you may begin typing.',
    'One page, no account until you press send, and a half-typed abstract that survives anything.',
  ],
  [
    'Your program lives inside the tool, and getting it out again is copy and paste.',
    'A public agenda anyone can embed, and a calendar file that costs nothing.',
  ],
  [
    'Speaker emails that read like they were written by a compliance department.',
    'Decision letters that carry the committee’s own sentence, in the committee’s own words.',
  ],
];

const WALK: { phase: string; line: string; door: string; href: string }[] = [
  {
    phase: 'The call',
    line: 'A form that teaches by example and saves every keystroke. Speakers write; nothing gets lost.',
    door: 'The form itself',
    href: '/aie-nyc/cfp',
  },
  {
    phase: 'The deciding',
    line: 'Review rounds, blind mode, scores that stay yours until you submit them.',
    door: 'The proposals pile',
    href: '/admin/aie-nyc/submissions',
  },
  {
    phase: 'The telling',
    line: 'Decisions stage quietly. Letters go out in one deliberate act — each with your note, none twice, none forgotten.',
    door: 'The outbox',
    href: '/admin/aie-nyc/outbox',
  },
  {
    phase: 'The build-up',
    line: 'Speakers get structure: tasks with dates, nudges that are care, a portal that answers “what do I owe?”',
    door: 'A speaker’s portal',
    href: '/aie-nyc/portal',
  },
  {
    phase: 'The day',
    line: 'Run-of-show on a phone: who’s next, are their slides in, tap to call.',
    door: 'The green room',
    href: '/admin/aie-nyc/green-room',
  },
  {
    phase: 'The after',
    line: 'Recordings land on sessions, attendees catch up on what they missed, and next year starts from this year’s people.',
    door: 'Charlotte, 2025',
    href: '/ddc-clt',
  },
];

const PERSONAS: { who: string; line: string }[] = [
  {
    who: 'For organizers',
    line: 'The pile made workable — filters, bulk decisions, themes, and one card that always says who is waiting on you.',
  },
  {
    who: 'For speakers',
    line: 'Your words stay yours. If your talk is accepted, it goes on the program exactly as you wrote it.',
  },
  {
    who: 'For attendees',
    line: 'No account, no cookie wall. Star a talk, share a schedule, find the people who saw what you saw.',
  },
  {
    who: 'For the crew',
    line: 'One screen per volunteer: faces, times, slides in or not, one phone number to tap.',
  },
  {
    who: 'For your agent',
    line: 'Everything the buttons do, a machine can do — MCP, CLI, and an HTTP API with the same verbs and the same guardrails. Point your agent at /mcp.',
  },
];

export function homePage(): string {
  const cards = EVENTS_STUB.map(
    (e) =>
      `<a class="card evcard" href="${e.href}">` +
      `<h3>${esc(e.name)}</h3>` +
      `<div class="when">${esc(e.dates)} · ${esc(e.where)}</div>` +
      `<div class="state"><span class="dot${e.open ? '' : ' closed'}"></span>${esc(e.state)}</div>` +
      `<div class="sub">${esc(e.line)}</div>` +
      `<div class="cta"><span class="btn btn-primary">${esc(e.cta)}</span></div>` +
      '</a>'
  ).join('');

  const mirror =
    '<div class="mirror">' +
    '<h3 class="hh">Everything we hate about call-for-speakers tools</h3>' +
    '<h3 class="hp">What we are proud of in this one</h3>' +
    '<h3 class="hm">Everything we hate about call-for-speakers tools — and what we did about each one</h3>' +
    MIRROR.map(([hate, proud]) => `<div class="mi hate">${esc(hate)}</div><div class="mi proud">${esc(proud)}</div>`).join('') +
    '<p class="confess">Exhibit A of our desperation: three spreadsheets, a shared inbox, a Trello board nobody archived, and one organizer who has personally typed 610 rejection emails.</p>' +
    '</div>';

  const walk =
    '<div class="sec"><h2 class="display" style="font-size:28px">A conference is a year, not a day.</h2>' +
    '<p class="lede" style="margin-top:10px">Fireside is built along it. Every door below opens on the live demo, at exactly that moment of the year.</p>' +
    '<div class="grid2" style="margin-top:18px">' +
    WALK.map(
      (w) =>
        '<div class="card card-pad">' +
        `<div class="kicker">${esc(w.phase)}</div>` +
        `<p style="margin-top:8px">${esc(w.line)}</p>` +
        `<p style="margin-top:10px"><a class="link" href="${w.href}">${esc(w.door)} →</a></p>` +
        '</div>'
    ).join('') +
    '</div></div>';

  const personas =
    '<div class="sec"><h2 class="display" style="font-size:28px">Everyone gets their own door.</h2>' +
    '<div class="grid2" style="margin-top:18px">' +
    PERSONAS.map(
      (p) =>
        '<div class="card card-pad">' +
        `<h3 class="serif" style="font-size:20px;font-weight:600">${esc(p.who)}</h3>` +
        `<p class="sub" style="margin-top:6px">${esc(p.line)}</p>` +
        '</div>'
    ).join('') +
    '</div></div>';

  const opensource =
    '<div class="sec" style="border-top:1px solid var(--line);padding-top:26px">' +
    '<h2 class="display" style="font-size:28px">Yours, all the way down.</h2>' +
    '<p class="lede" style="margin-top:10px;max-width:38em">Fireside is Apache-2.0 open source. It runs as one Cloudflare Worker with one SQLite database — no fleet, no vendor inside your speaker data. Deploy it yourself in an afternoon, or walk the demo first.</p>' +
    '<div class="btnrow" style="margin-top:16px">' +
    '<a class="btn" href="https://github.com/Phantastic-AI/fireside">View the source</a>' +
    '<a class="btn" href="/admin">Walk through backstage →</a>' +
    '</div>' +
    '</div>';

  const body =
    '<div class="wrap">' +
    '<div style="padding:56px 0 8px">' +
    '<h1 class="display" style="max-width:15em">One place for speakers, sessions, and <b>the day of the show.</b></h1>' +
    '<p class="lede" style="margin-top:20px;max-width:40em">Fireside runs your call for speakers, your review committee, your decisions, your agenda, and your green room — one open-source home, from the first proposal to the last recording link.</p>' +
    '<p class="hint" style="margin-top:14px">This demo is the real product with a synthetic conference inside. It resets itself; break anything you like.</p>' +
    '</div>' +
    '<div class="sec"><h2 class="display" style="font-size:28px">Two conferences are running on this right now.</h2>' +
    '<p class="lede" style="margin-top:10px">Open one and you are looking at the real thing — the public call, the organizer’s pile, the agenda, the green room sheet backstage.</p>' +
    `<div class="evcards" style="margin-top:18px">${cards}</div></div>` +
    `<div class="sec">${mirror}</div>` +
    walk +
    personas +
    opensource +
    '</div>';

  return page({
    title: 'Fireside — an open-source call for speakers',
    description:
      'One place for speakers, sessions, and the day of the show. An open-source call for speakers, review workflow, agenda, and green room.',
    register: 'onstage',
    body: onstageShell('<a href="/admin">Organizer</a>', body),
  });
}
