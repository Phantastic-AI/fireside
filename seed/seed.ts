// The seed: both conferences, deterministically, from content.ts.
// Every id is stable across rebuilds (R-2: reseed is a full deterministic
// rebuild — DELETE everything, re-insert this, nothing to archaeologize).
import {
  CAST,
  HAND_PROPOSALS,
  AIE_PLACEMENTS,
  EXPANSION,
  EXPANSION_TARGETS,
  CHARLOTTE_SESSIONS,
  CHARLOTTE_STATS,
  SEED_QUESTIONS,
  CFP_QUESTIONS,
  SHARED_SPEAKER_IDS,
  CANCELLED_SESSION_SLUG,
  CHARLOTTE_CANCELLED_SLUG,
  type HandProposal,
} from './content';

// ---------- deterministic machinery ----------

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xf19e51de);
const pick = <T>(arr: readonly T[]): T => {
  const v = arr[Math.floor(rng() * arr.length)];
  if (v === undefined) throw new Error('pick from empty array');
  return v;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

// Times: epoch ms. The two events' clocks.
const MS = { min: 60_000, hour: 3_600_000, day: 86_400_000 };
function utc(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi);
}
// AIE NYC runs in America/New_York (UTC-4 in Sept): 09:30 ET = 13:30 UTC.
const ET = (y: number, mo: number, d: number, h: number, mi = 0) => utc(y, mo, d, h + 4, mi);
// Charlotte in Nov 2025 is UTC-5.
const ET5 = (y: number, mo: number, d: number, h: number, mi = 0) => utc(y, mo, d, h + 5, mi);

// "Now" for seeded relative facts (created_at etc.) — a fixed anchor, so the
// rebuild is byte-stable. Rendered ages ("2 hours ago") compute at request
// time against real now; the anchor sits just before the demo window.
const ANCHOR = utc(2026, 8, 11, 12, 0);

// ---------- row types (plain objects; insert order = FK order) ----------

export type Row = Record<string, unknown>;
export type SeedData = {
  event: Row[];
  person: Row[];
  track: Row[];
  room: Row[];
  submission: Row[];
  participation: Row[];
  review: Row[];
  event_role: Row[];
  task: Row[];
  message: Row[];
  my_schedule: Row[];
  star: Row[];
  connection: Row[];
  question: Row[];
  answer: Row[];
};

// ---------- name mill for the long tail ----------

const FIRST = [
  'Ada','Bram','Chidi','Dalia','Emre','Femi','Greta','Hiro','Ines','Jonas',
  'Kavya','Lars','Mireille','Nadia','Oskar','Palesa','Quinn','Rohan','Sanne','Tarek',
  'Ulla','Vera','Wiktor','Ximena','Yusuf','Zofia','Anselm','Bianca','Cormac','Delphine',
  'Eitan','Farida','Gideon','Halima','Ivo','Jelena','Kofi','Leone','Maud','Nikolai',
  'Odile','Pieter','Rina','Soren','Teodora','Umut','Vesna','Wendell','Yara','Zeno',
];
const LAST = [
  'Abara','Bergstrom','Cywinski','Dorival','Eklund','Ferreira','Grunwald','Halvorsen','Iwata','Jansma',
  'Kaminska','Lindqvist','Marchand','Nakagawa','Obi','Petrova','Quiroga','Rasmussen','Sandoval','Tanaka',
  'Ugarte','Vanterpool','Waverly','Yamamoto','Zielinski','Ashworth','Bellandi','Castellanos','Draper','Engelhardt',
  'Fontaine','Giordano','Hutchins','Ivanova','Jephcott','Kalu','Laurent','Mbeki','Norgaard','Oyinlola',
  'Priestley','Quimby','Rhee','Solano','Tremblay','Ustinov','Villanueva','Whitlock','Yaeger','Zamora',
];
const ORGS = [
  'Cobalt Freight','Halcyon Health','Bluewater Media','Stonebridge Retail','Verity Insurance',
  'Northwind Grid','Cedar & Vine','Quillwork Labs','Harbor Analytics','Foxglove Systems',
  'Tandem Rail','Meridian West','Lanternworks','Copperfield Bank','Silverthread',
  'Basalt Cloud','Wrenfield Logistics','Marigold Care','Pillar & Post','Trelliswork',
];
const TITLES = [
  'Staff Engineer','Engineering Manager','Principal Engineer','Head of Data','Platform Lead',
  'VP Engineering','Senior Engineer','Director of Engineering','ML Engineer','Product Engineer',
  'SRE Lead','CTO','Solutions Architect','Data Science Lead','Infrastructure Engineer',
];

// ---------- the build ----------

export function buildSeed(): SeedData {
  const d: SeedData = {
    event: [], person: [], track: [], room: [], submission: [], participation: [],
    review: [], event_role: [], task: [], message: [], my_schedule: [], star: [],
    connection: [], question: [], answer: [],
  };

  // -- events ------------------------------------------------------------
  const AIE = 'ev-aie-nyc';
  const DDC = 'ev-ddc-clt';
  d.event.push({
    id: AIE, slug: 'aie-nyc', name: 'AI Engineer New York 2026',
    tagline: 'The room where the people actually shipping this stuff compare notes.',
    starts_on: '2026-09-03', ends_on: '2026-09-04',
    timezone: 'America/New_York', tz_label: 'All times ET',
    venue_name: 'Pier 57', venue_address: 'Pier 57, New York',
    cfp_opens_at: utc(2026, 7, 21, 12), cfp_closes_at: ET(2026, 8, 20, 23, 59),
    cfp_intro:
      'This is the room where the people actually shipping this stuff compare notes. We want the talk you would give to your own team on a Monday — the rollout that failed twice, the eval that changed your mind, the number your CFO now quotes back at you. Bring the receipts.',
    cfp_success_message:
      'The committee has it now. You can edit every word until the call closes.',
    questions: JSON.stringify(CFP_QUESTIONS),
    max_submissions: 3, decide_by: '2026-08-27',
    current_round: 1,
    round_scorecards: JSON.stringify({
      '1': [
        { key: 'fit', label: 'Fit for this room', max: 5 },
        { key: 'evidence', label: 'Receipts — numbers, not adjectives', max: 5 },
        { key: 'freshness', label: 'Would a 3rd-year attendee learn something?', max: 5 },
      ],
    }),
    day_start: '09:30', day_end: '17:30', block_minutes: 60,
    agenda_published: 1, green_room_nonce: 'grn-aie-0001', created_at: utc(2026, 7, 20, 12),
  });
  d.event.push({
    id: DDC, slug: 'ddc-clt', name: 'DevOps Days Charlotte 2025',
    tagline: 'Two days, two rooms, no keynote. Talks about the boring parts are the most welcome ones.',
    starts_on: '2025-11-06', ends_on: '2025-11-07',
    timezone: 'America/New_York', tz_label: 'All times ET',
    venue_name: 'The Foundry', venue_address: 'The Foundry, Charlotte',
    cfp_opens_at: utc(2025, 6, 1, 12), cfp_closes_at: ET5(2025, 8, 1, 23, 59),
    cfp_intro:
      'Charlotte has run this for eleven years on volunteer time and a spreadsheet. Talks about the boring parts are the most welcome ones.',
    cfp_success_message: 'The committee has it. Decisions go out in early August.',
    questions: JSON.stringify([]),
    max_submissions: 2, decide_by: '2025-08-06',
    current_round: 1, round_scorecards: JSON.stringify({}),
    day_start: '09:30', day_end: '17:00', block_minutes: 60,
    agenda_published: 1, green_room_nonce: 'grn-ddc-0001', created_at: utc(2025, 5, 20, 12),
  });

  // -- tracks & rooms ----------------------------------------------------
  const aieTracks = [
    ['platform', 'Platform', '#186B78'],
    ['practice', 'Practice', '#8B3A62'],
    ['leadership', 'Leadership', '#6E6224'],
  ] as const;
  aieTracks.forEach(([tslug, name, colour], i) =>
    d.track.push({ id: `trk-aie-${tslug}`, event_id: AIE, name, slug: tslug, colour, position: i })
  );
  const ddcTracks = [
    ['delivery', 'Delivery', '#186B78'],
    ['reliability', 'Reliability', '#8B3A62'],
  ] as const;
  ddcTracks.forEach(([tslug, name, colour], i) =>
    d.track.push({ id: `trk-ddc-${tslug}`, event_id: DDC, name, slug: tslug, colour, position: i })
  );

  const aieRooms = [
    ['Ballroom A', 420], ['Ballroom B', 260], ['Studio', 140], ['Loft', 90], ['Gallery', 120],
  ] as const;
  aieRooms.forEach(([name, cap], i) =>
    d.room.push({ id: `rm-aie-${slug(name)}`, event_id: AIE, name, capacity: cap, position: i })
  );
  (['Main hall', 'Workshop room'] as const).forEach((name, i) =>
    d.room.push({ id: `rm-ddc-${slug(name)}`, event_id: DDC, name, capacity: i === 0 ? 300 : 60, position: i })
  );

  // -- people ------------------------------------------------------------
  const personIds = new Set<string>();
  for (const p of CAST) {
    personIds.add(p.id);
    d.person.push({
      id: p.id, email: p.email, name: p.name,
      sort_name: p.name.split(' ').slice(-1)[0] + ', ' + p.name.split(' ').slice(0, -1).join(' '),
      bio: p.bio, job_title: p.jobTitle, organisation: p.organisation,
      links: p.links, pronouns: p.pronouns, phone: p.phone,
      internal_role: p.internalRole, share_contact: '{}', created_at: ANCHOR - 40 * MS.day,
    });
  }
  // The long tail: enough people for the expanded proposals, one each.
  const tailCount = 940;
  const tail: string[] = [];
  const usedNames = new Set(CAST.map((c) => c.name));
  for (let i = 0; i < tailCount; i++) {
    // index arithmetic: 50×50 = 2,500 unique pairs by construction; on a
    // collision with the cast, bump the surname lane (bounded, deterministic)
    const f = FIRST[i % FIRST.length]!;
    let lastIdx = Math.floor(i / FIRST.length) % LAST.length;
    let name = `${f} ${LAST[lastIdx]!}`;
    let bumps = 0;
    while (usedNames.has(name) && bumps < LAST.length) {
      lastIdx = (lastIdx + 1) % LAST.length;
      name = `${f} ${LAST[lastIdx]!}`;
      bumps++;
    }
    if (usedNames.has(name)) throw new Error('name mill exhausted');
    usedNames.add(name);
    const id = `per-${slug(name)}`;
    tail.push(id);
    personIds.add(id);
    d.person.push({
      id, email: `${slug(name).replace(/-/g, '.')}@example.org`, name,
      sort_name: `${name.split(' ')[1]}, ${name.split(' ')[0]}`,
      bio: null, job_title: pick(TITLES), organisation: pick(ORGS),
      links: null, pronouns: null, phone: null, internal_role: null,
      share_contact: '{}', created_at: ANCHOR - Math.floor(rng() * 20 + 1) * MS.day,
    });
  }

  // -- AIE proposals: 40 by hand + 960 expanded --------------------------
  type Sub = { id: string; state: string; speakerId: string; title: string; format: string;
    minutes: number; track: string; level: string; abstract: string; slugv: string; hand: boolean; coSpeakerIds?: string[] };
  const subs: Sub[] = [];
  let subSeq = 0;
  const subId = () => `sub-aie-${String(++subSeq).padStart(4, '0')}`;

  for (const h of HAND_PROPOSALS) {
    subs.push({
      id: subId(), state: h.state, speakerId: h.speakerId, title: h.title, format: h.format,
      minutes: h.minutes, track: h.track, level: h.level, abstract: h.abstract, slugv: h.slug, hand: true, coSpeakerIds: h.coSpeakerIds,
    });
  }

  // Expanded: fill the remaining targets deterministically.
  const need: Record<string, number> = { ...EXPANSION_TARGETS } as Record<string, number>;
  const states: string[] = [];
  for (const [state, n] of Object.entries(need)) {
    if (state === 'drafts') continue;
    for (let i = 0; i < n; i++) states.push(state === 'submitted' ? 'submitted' : state);
  }
  // interleave states so list pages mix naturally
  for (let i = states.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = states[i]!, b = states[j]!;
    states[i] = b; states[j] = a;
  }
  const seenTitles = new Set(subs.map((s) => s.title));
  let tailIdx = 0;
  for (const state of states) {
    let title = '';
    let guard = 0;
    do {
      const shape = pick(EXPANSION.titleShapes);
      title = shape
        .replace('{domain}', pick(EXPANSION.domains))
        .replace('{artifact}', pick(EXPANSION.artifacts))
        .replace('{outcome}', pick(EXPANSION.outcomes));
      guard++;
    } while (seenTitles.has(title) && guard < 40);
    seenTitles.add(title);
    const abstract = pick(EXPANSION.abstractShapes)
      .replace(/\{domain\}/g, pick(EXPANSION.domains))
      .replace(/\{artifact\}/g, pick(EXPANSION.artifacts))
      .replace(/\{outcome\}/g, pick(EXPANSION.outcomes));
    const speakerId = tail[tailIdx % tail.length]!;
    tailIdx++;
    const format = rng() < 0.82 ? 'Talk' : rng() < 0.5 ? 'Lightning talk' : 'Workshop';
    subs.push({
      id: subId(), state, speakerId, title,
      format, minutes: format === 'Workshop' ? 90 : format === 'Lightning talk' ? 15 : rng() < 0.5 ? 30 : 45,
      track: pick(['platform', 'practice', 'leadership']),
      level: pick(['intro', 'practitioner', 'deep']),
      abstract, slugv: slug(title), hand: false,
    });
  }

  // 8 drafts, outside the 1,000
  for (let i = 0; i < 8; i++) {
    const speakerId = tail[(tailIdx + i) % tail.length]!;
    const title = pick(EXPANSION.titleShapes)
      .replace('{domain}', pick(EXPANSION.domains))
      .replace('{artifact}', pick(EXPANSION.artifacts))
      .replace('{outcome}', pick(EXPANSION.outcomes));
    subs.push({
      id: subId(), state: 'draft', speakerId, title, format: 'Talk', minutes: 30,
      track: pick(['platform', 'practice', 'leadership']), level: 'practitioner',
      abstract: '', slugv: slug(title), hand: false,
    });
  }

  // -- place the accepted 60 (and the one cancelled) ---------------------
  // 5 rooms × (thu 6 + fri 5 hourly slots). Workshops only in the last slot
  // of a day so their 90 minutes never collide with a following talk.
  const slotTimes: { day: 'thu' | 'fri'; t: number; last: boolean }[] = [];
  for (const [dayIdx, day] of (['thu', 'fri'] as const).entries()) {
    const dnum = day === 'thu' ? 3 : 4;
    const hours = day === 'thu' ? [9.5, 10.5, 11.5, 14, 15, 16, 17] : [9.5, 10.5, 11.5, 14, 15, 16];
    hours.forEach((h, i) => {
      slotTimes.push({ day, t: ET(2026, 9, dnum, Math.floor(h), (h % 1) * 60), last: i === hours.length - 1 });
    });
    void dayIdx;
  }
  const roomIds = aieRooms.map(([name]) => `rm-aie-${slug(name)}`);
  const accepted = subs
    .filter((s) => s.state === 'accepted')
    .sort((a, b) => b.minutes - a.minutes); // long formats claim their scarce slots first
  const placements = new Map<string, { room: string; t: number }>();
  const speakerBusy = new Map<string, number[]>();
  // Three of the shortest mill-made talks stay off the grid on purpose: the
  // builder's "To place" rail should demonstrate itself, not sit empty.
  const HOLD_BACK = new Set(
    accepted.filter((s) => !s.hand && s.minutes <= 30).slice(-3).map((s) => s.id)
  );
  {
    let cursor = 0;
    const cap = slotTimes.length * roomIds.length;
    for (const s of accepted) {
      if (HOLD_BACK.has(s.id)) continue;
      let placedAt: { room: string; t: number } | null = null;
      for (let step = 0; step < cap && !placedAt; step++) {
        const idx = (cursor + step) % cap;
        const slotv = slotTimes[Math.floor(idx / roomIds.length)]!;
        const room = roomIds[idx % roomIds.length]!;
        if (s.minutes > 60 && !slotv.last) continue; // workshops end a day’s lane
        const busy = speakerBusy.get(s.speakerId) ?? [];
        if (busy.some((t) => Math.abs(t - slotv.t) < 60 * MS.min)) continue;
        if ([...placements.values()].some((p) => p.room === room && p.t === slotv.t)) continue;
        placedAt = { room, t: slotv.t };
        cursor = idx + 1;
      }
      if (!placedAt) throw new Error(`could not place ${s.id}`);
      placements.set(s.id, placedAt);
      speakerBusy.set(s.speakerId, [...(speakerBusy.get(s.speakerId) ?? []), placedAt.t]);
    }
  }

  // -- write AIE submission rows ----------------------------------------
  const DECIDED = utc(2026, 8, 11, 2); // the committee sat late on the 10th
  const TOLD_ACCEPTED = utc(2026, 8, 11, 3);
  for (const s of subs) {
    const isDraft = s.state === 'draft';
    const isDecided = ['accepted', 'waitlisted', 'rejected'].includes(s.state);
    const isCancelled = s.hand && s.slugv === CANCELLED_SESSION_SLUG;
    const p = placements.get(s.id);
    d.submission.push({
      id: s.id, event_id: AIE, title: s.title, abstract: s.abstract || null,
      format: s.format, track_id: `trk-aie-${s.track}`, level: s.level,
      requested_min: s.minutes, extra: '{}',
      source: s.hand ? 'cfp' : 'cfp',
      created_at: ANCHOR - Math.floor(rng() * 18 + 2) * MS.day,
      submitted_at: isDraft ? null : ANCHOR - Math.floor(rng() * 17 + 1) * MS.day,
      resume_nonce: isDraft ? `rn-${s.id}` : null,
      score: s.hand && isDecided ? Math.floor(rng() * 3) + 7 : null,
      score_notes: null,
      state: isCancelled ? 'cancelled' : s.state,
      decision_version: isDecided || isCancelled ? 1 : 0,
      decided_at: isDecided || isCancelled ? DECIDED : null,
      decision_note: null,
      cancelled_at: isCancelled ? utc(2026, 8, 11, 9) : null,
      cancel_note: isCancelled ? 'Speaker schedule conflict — the talk comes back next year.' : null,
      notified_at: s.state === 'accepted' || isCancelled ? TOLD_ACCEPTED : null,
      starts_at: p ? p.t : null,
      room_id: p ? p.room : null,
      public_slug: s.state === 'accepted' || isCancelled ? s.slugv : null,
      recording_url: null,
    });
    d.participation.push({
      submission_id: s.id, person_id: s.speakerId, role: 'speaker', position: 0, is_submitter: 1,
    });
    for (const [i, pid] of (s.coSpeakerIds ?? []).entries()) {
      d.participation.push({
        submission_id: s.id, person_id: pid, role: 'co_speaker', position: i + 1, is_submitter: 0,
      });
    }
  }

  // -- Charlotte: 14 placed sessions + the declined long tail ------------
  let ddcSeq = 0;
  const ddcSubId = () => `sub-ddc-${String(++ddcSeq).padStart(3, '0')}`;
  const DDC_DECIDED = utc(2025, 8, 6, 14);
  for (const cs of CHARLOTTE_SESSIONS) {
    const dnum = cs.day === 'thu' ? 6 : 7;
    const [hh, mm] = cs.time.split(':').map(Number);
    const t = ET5(2025, 11, dnum, hh ?? 9, mm ?? 0);
    const id = ddcSubId();
    d.submission.push({
      id, event_id: DDC, title: cs.title, abstract: cs.abstract, format: cs.format,
      track_id: `trk-ddc-${cs.track}`, level: 'practitioner', requested_min: cs.minutes,
      extra: '{}', source: 'cfp',
      created_at: utc(2025, 7, Math.floor(rng() * 20) + 1, 12),
      submitted_at: utc(2025, 7, Math.floor(rng() * 24) + 1, 15),
      resume_nonce: null, score: null, score_notes: null,
      state: cs.cancelled ? 'cancelled' : 'accepted',
      decision_version: 1, decided_at: DDC_DECIDED, decision_note: null,
      cancelled_at: cs.cancelled ? utc(2025, 11, 5, 22) : null,
      cancel_note: cs.cancelled ? 'The flight never left. The talk comes back next year.' : null,
      notified_at: DDC_DECIDED + 2 * MS.hour,
      starts_at: t, room_id: `rm-ddc-${slug(cs.room)}`,
      public_slug: cs.slug, recording_url: cs.recordingUrl,
    });
    d.participation.push({ submission_id: id, person_id: cs.speakerId, role: 'speaker', position: 0, is_submitter: 1 });
  }
  // the rest of Charlotte's 84 proposals, declined and told, from shared speakers + tail
  const ddcDeclinedCount = CHARLOTTE_STATS.proposals - CHARLOTTE_SESSIONS.length;
  for (let i = 0; i < ddcDeclinedCount; i++) {
    const id = ddcSubId();
    const speakerId =
      i < SHARED_SPEAKER_IDS.length ? SHARED_SPEAKER_IDS[i]! : tail[(i * 7) % tail.length]!;
    const title = pick(EXPANSION.titleShapes)
      .replace('{domain}', pick(EXPANSION.domains))
      .replace('{artifact}', pick(EXPANSION.artifacts))
      .replace('{outcome}', pick(EXPANSION.outcomes));
    d.submission.push({
      id, event_id: DDC, title, abstract: null, format: 'Talk',
      track_id: `trk-ddc-${rng() < 0.5 ? 'delivery' : 'reliability'}`, level: 'practitioner',
      requested_min: 30, extra: '{}', source: 'cfp',
      created_at: utc(2025, 7, (i % 27) + 1, 10), submitted_at: utc(2025, 7, (i % 27) + 1, 11),
      resume_nonce: null, score: null, score_notes: null,
      state: 'rejected', decision_version: 1, decided_at: DDC_DECIDED,
      decision_note: null, cancelled_at: null, cancel_note: null,
      notified_at: DDC_DECIDED + 2 * MS.hour,
      starts_at: null, room_id: null, public_slug: null, recording_url: null,
    });
    d.participation.push({ submission_id: id, person_id: speakerId, role: 'speaker', position: 0, is_submitter: 1 });
  }

  // -- every shared speaker holds an AIE proposal: reassign, never add ---
  // (adding rows would break the 1,000; instead the first N expanded
  // undecided proposals change hands to the missing shared speakers)
  const aieBySpeaker = new Set(subs.map((s) => s.speakerId));
  const missingShared = SHARED_SPEAKER_IDS.filter((pid) => !aieBySpeaker.has(pid));
  const reassignable = subs.filter((s) => !s.hand && s.state === 'submitted');
  missingShared.forEach((pid, i) => {
    const target = reassignable[i];
    if (!target) throw new Error('not enough undecided proposals to cover shared speakers');
    target.speakerId = pid;
    const part = d.participation.find((p) => p.submission_id === target.id);
    if (part) part.person_id = pid;
  });

  // -- roles, reviews ----------------------------------------------------
  d.event_role.push({ person_id: 'marcus-delacroix', event_id: DDC, role: 'owner', granted_at: utc(2025, 5, 20, 12), granted_by: null });
  d.event_role.push({ person_id: 'lena-fischer', event_id: AIE, role: 'viewer', granted_at: utc(2026, 8, 1, 12), granted_by: 'naomi-adeyemi' });

  const lena = 'lena-fischer';
  const reviewable = subs.filter((s) => s.hand && ['submitted', 'waitlisted', 'accepted'].includes(s.state)).slice(0, 24);
  reviewable.forEach((s, i) => {
    const done = i < 8;
    d.review.push({
      id: `rev-${s.id}`, submission_id: s.id, reviewer_person_id: lena, round: 1,
      scores: done
        ? JSON.stringify({ fit: Math.floor(rng() * 3) + 3, evidence: Math.floor(rng() * 3) + 3, freshness: Math.floor(rng() * 3) + 2 })
        : '{}',
      note: done && i % 3 === 0 ? 'Would pair well with the eval-suite talk.' : null,
      submitted_at: done ? utc(2026, 8, 10, 21) : null,
    });
  });

  // -- messages: the outbox ---------------------------------------------
  // 60 accepted letters, delivered. 610 staged: 12 maybe + 598 declined.
  let msgSeq = 0;
  const msgId = () => `msg-${String(++msgSeq).padStart(4, '0')}`;
  const aieRows = d.submission.filter((r) => r.event_id === AIE);
  for (const r of aieRows) {
    const state = r.state as string;
    if (r.decision_version === 0) continue;
    const pid = (d.participation.find((p) => p.submission_id === r.id) as Row)?.person_id as string;
    if (state === 'accepted' || state === 'cancelled') {
      d.message.push({
        id: msgId(), event_id: AIE, person_id: pid, submission_id: r.id, kind: 'decision',
        decision_version: 1, subject: 'Your talk is on the program',
        body: 'You are on the program at AI Engineer New York 2026. We will write again with your time and room.',
        created_at: TOLD_ACCEPTED - MS.hour, delivered_at: TOLD_ACCEPTED, emailed_at: null, blocked_reason: null,
      });
    } else if (state === 'waitlisted' || state === 'rejected') {
      d.message.push({
        id: msgId(), event_id: AIE, person_id: pid, submission_id: r.id, kind: 'decision',
        decision_version: 1,
        subject: state === 'waitlisted' ? 'Your talk is close — a room may still open' : 'Not this time',
        body:
          state === 'waitlisted'
            ? 'The committee wants this one if space allows. We will know by the week of the event.'
            : 'The committee did not choose this one for the 2026 program. Please send it again next year.',
        created_at: DECIDED + MS.hour, delivered_at: null, emailed_at: null, blocked_reason: null,
      });
    }
  }

  // -- tasks -------------------------------------------------------------
  let taskSeq = 0;
  const acceptedRows = aieRows.filter((r) => r.state === 'accepted');
  for (const r of acceptedRows.slice(0, 30)) {
    const pid = (d.participation.find((p) => p.submission_id === r.id) as Row)?.person_id as string;
    const done = rng() < 0.4;
    d.task.push({
      id: `tsk-${String(++taskSeq).padStart(3, '0')}`, event_id: AIE, person_id: pid, submission_id: r.id,
      kind: 'file_request', template_key: 'slides', title: 'Send your slides',
      instructions: 'PDF or a link. The booth plays PDFs happily; anything else, tell us early.',
      due_on: '2026-08-28', completed_at: done ? ANCHOR - 2 * MS.day : null,
      cancelled_at: null, cancel_reason: null, response: null,
    });
  }

  // -- attendee life: Dani -----------------------------------------------
  const dani = 'dani-okafor';
  d.person.push({
    id: dani, email: 'dani.okafor@example.org', name: 'Dani Okafor',
    sort_name: 'Okafor, Dani', bio: null, job_title: 'Platform Engineer',
    organisation: 'Foxglove Systems', links: null, pronouns: 'she/her', phone: null,
    internal_role: null, share_contact: JSON.stringify({ links: true }),
    created_at: utc(2025, 10, 20, 9),
  });
  d.my_schedule.push({ id: 'ms-dani-ddc', person_id: dani, event_id: DDC, share_nonce: 'shn-dani-1', share_enabled: 1, created_at: utc(2025, 11, 5, 12), updated_at: utc(2025, 11, 7, 22) });
  d.my_schedule.push({ id: 'ms-dani-aie', person_id: dani, event_id: AIE, share_nonce: null, share_enabled: 0, created_at: ANCHOR - 5 * MS.day, updated_at: ANCHOR - MS.day });
  const ddcPlaced = d.submission.filter((r) => r.event_id === DDC && r.starts_at !== null);
  ddcPlaced.slice(0, 8).forEach((r, i) => {
    d.star.push({
      id: `star-dani-${i}`, my_schedule_id: 'ms-dani-ddc', submission_id: r.id,
      starred_at: utc(2025, 11, 5, 13),
      watched_at: i < 4 ? (r.starts_at as number) + MS.hour : null,
      missed_at: i >= 4 && i < 6 ? (r.starts_at as number) + 3 * MS.hour : null,
      shared_at: i < 3 ? (r.starts_at as number) + MS.hour : null,
      connect_note: i === 1 ? 'Up for coffee Friday' : null,
    });
  });
  // a second attendee who shared, so reciprocity has someone to meet
  const noor = 'per-reciprocal-attendee';
  d.person.push({
    id: noor, email: 'noor.attendee@example.org', name: 'Noor Haddad',
    sort_name: 'Haddad, Noor', bio: null, job_title: 'Staff Engineer', organisation: 'Trelliswork',
    links: null, pronouns: null, phone: null, internal_role: null,
    share_contact: JSON.stringify({ work: true }), created_at: utc(2025, 11, 1, 9),
  });
  d.my_schedule.push({ id: 'ms-noor-ddc', person_id: noor, event_id: DDC, share_nonce: null, share_enabled: 0, created_at: utc(2025, 11, 6, 9), updated_at: utc(2025, 11, 7, 20) });
  ddcPlaced.slice(0, 2).forEach((r, i) => {
    d.star.push({
      id: `star-noor-${i}`, my_schedule_id: 'ms-noor-ddc', submission_id: r.id,
      starred_at: utc(2025, 11, 6, 8), watched_at: (r.starts_at as number) + MS.hour,
      missed_at: null, shared_at: (r.starts_at as number) + MS.hour, connect_note: null,
    });
  });
  d.connection.push({
    id: 'con-0001', owner_person_id: dani, other_person_id: noor,
    submission_id: ddcPlaced[0]!.id as string, note: 'Asked the good question about queue depth',
    created_at: utc(2025, 11, 6, 15),
  });

  // -- questions & answers ----------------------------------------------
  let qSeq = 0;
  for (const q of SEED_QUESTIONS) {
    for (let i = 0; i < q.timesAsked; i++) {
      d.question.push({
        id: `qq-${String(++qSeq).padStart(3, '0')}`, event_id: AIE, scope: q.scope,
        conversation_id: null, text: q.text, answered: q.answered ? 1 : 0,
        answer_snapshot: null, asked_at: ANCHOR - Math.floor(rng() * 8 + 1) * MS.day,
        organizer_note: null, annotated_at: null,
      });
    }
  }
  // The concierge must never fail its own suggested questions: every starter
  // chip has a curated answer, matched exact (case-folded) before any model.
  const CURATED: [string, string, string][] = [
    [AIE, 'When does the call for speakers close?',
     'The call closes on 20 August. Until then you can send a proposal, and edit or withdraw it from your portal.'],
    [AIE, 'What should I see on the first day?',
     'Thursday runs from 09:30 across five rooms. Open the agenda, filter to Thursday, and star what pulls at you — your list keeps itself.'],
    [AIE, "Which talks are good if I'm new to this?",
     'Filter the agenda by level — the talks marked for newcomers assume curiosity, not scar tissue. The speaker pages say who each person is.'],
    [DDC, 'What should I see on the first day?',
     'The conference has already happened — the agenda still stands, and the recordings are on each session page.'],
    [DDC, "Which talks are good if I'm new to this?",
     'Start with the recordings: every session page carries one. The agenda shows both days as they ran.'],
    [DDC, 'Where is it, and what time does each day start?',
     'Charlotte, over two days in November 2025 — it has already run. The agenda keeps the full schedule, and the recordings are up.'],
  ];
  CURATED.forEach(([evId, q, body], i) => {
    d.answer.push({
      id: `ans-c${String(i + 1).padStart(2, '0')}`, event_id: evId, question_text: q,
      body, state: 'in_use', supersedes_id: null, source_question_id: null,
      created_at: ANCHOR - 5 * MS.day, accepted_at: ANCHOR - 5 * MS.day,
    });
  });
  d.answer.push({
    id: 'ans-0001', event_id: AIE, question_text: 'Will the talks be recorded?',
    body: 'Yes — every talk is recorded, and recordings land on each session page within two weeks.',
    state: 'in_use', supersedes_id: null, source_question_id: null,
    created_at: ANCHOR - 6 * MS.day, accepted_at: ANCHOR - 6 * MS.day,
  });

  return d;
}

// ---------- distribution check (runs at reseed; refuses a wrong world) ---
export function assertDistribution(d: SeedData): string {
  const aie = d.submission.filter((r) => r.event_id === 'ev-aie-nyc');
  const by = (s: string) => aie.filter((r) => r.state === s).length;
  const drafts = by('draft');
  const nonDraft = aie.length - drafts;
  const decidedNotTold = aie.filter(
    (r) => ['accepted', 'waitlisted', 'rejected'].includes(r.state as string) && r.notified_at === null
  ).length;
  const facts = {
    nonDraft, drafts,
    accepted: by('accepted'), cancelled: by('cancelled'),
    waitlisted: by('waitlisted'), rejected: by('rejected'),
    submitted: by('submitted'), withdrawn: by('withdrawn'),
    decidedNotTold,
  };
  const ok =
    facts.decidedNotTold === 610 &&
    facts.waitlisted === 12 &&
    facts.rejected === 598 &&
    facts.accepted + facts.cancelled === 60 &&
    facts.drafts === 8;
  if (!ok) throw new Error('seed distribution drifted: ' + JSON.stringify(facts));
  return JSON.stringify(facts);
}
