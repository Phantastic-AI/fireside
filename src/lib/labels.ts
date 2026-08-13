// One place, one string, per KYS 02-ubiquitous-language.md §6 ("The label
// map — one place, one string each"). Every rendered state/enum word in the
// product reads from LABELS; no template holds one as a literal. That is what
// makes rule 0.1 ("one fact, one word, everywhere") true rather than
// aspirational, and it is why the SUB-4 ruling (Shortlisted → Maybe) cost one
// line instead of a grep-and-replace across templates.
//
// Two registers, named after the two stages the doc itself uses (02 §2,
// 05-context-pack.md §5): `backstage` is organizer-facing, `onstage` is
// speaker- and public-facing. Where §6 gives the same word to both, the
// entry is a plain string; where it splits, the entry carries both keys;
// where §6 marks a cell "—" (never shown to that audience), the key for
// that register is simply absent — `label()` throws rather than guess.

export type Register = 'backstage' | 'onstage';

type LabelValue = string | Partial<Record<Register, string>>;

const LABELS = {
  // §1.2 — submission decision states (SUB-1..7)
  'submission.draft': 'Draft',
  'submission.submitted': { backstage: 'Undecided', onstage: 'With the committee' },
  'submission.accepted': 'Accepted',
  'submission.waitlisted': 'Maybe', // L-1: reversing this again costs exactly this line
  'submission.rejected': { backstage: 'Declined', onstage: 'Not this time' },
  'submission.withdrawn': 'Withdrawn',
  'submission.cancelled': { backstage: 'Cancelled · still on the agenda', onstage: 'Cancelled' }, // Δ4
  'submission.reinstate': { backstage: 'Put it back on' }, // Δ4 — organizer's own verb, no speaker word
  // §1.3 — machinery, never shown to a speaker. Backstage says "notified":
  // inside the SaaS the organizer is the one who notifies, and that is the
  // plain word for it. The anti-"notified" rule is a marketing-voice stance
  // (the de-slop rite still holds it); the product UI does not (operator,
  // register split, decision-log). Speaker-facing copy and the thesis keep
  // "told".
  'submission.decided_not_told': { backstage: 'Decided · not notified' },
  'submission.told': { backstage: 'Notified {date}' },

  // §1.6 — placement and publishing
  'placement.none': { backstage: 'Not scheduled', onstage: 'Time and room to come' },
  'placement.set': {
    backstage: 'Scheduled · not public yet',
    onstage: '{day} {time}, {room} — not public yet',
  },
  'placement.published': { backstage: 'On the public agenda', onstage: '{day} {time}, {room}' },

  // §1.5 — task states
  'task.open': 'To do',
  'task.done': 'Done',
  'task.cancelled': { backstage: 'Not needed', onstage: 'Not needed anymore' },
  'task.done_cancelled': 'Done · no longer needed',
  'task.overdue': 'Overdue',

  // §1.8 — files
  'file.present': { backstage: 'In', onstage: 'Uploaded' },
  'file.absent': { backstage: 'Not in', onstage: 'Not uploaded yet' },
  'file.absent_overdue': { backstage: 'Not in · was due {date}', onstage: 'Overdue' },
  'file.not_requested': { backstage: 'Not asked for' },

  // §1.9 — messages and the outbox
  'message.staged': { backstage: 'Ready to send' },
  'message.delivered': { backstage: 'Sent {date}', onstage: '{date}' },
  'message.blocked': { backstage: 'Needs an address' },
  'message.kind.received': 'Proposal received',
  'message.kind.decision': 'Decision',
  'message.kind.task': 'Task reminder',
  'message.kind.schedule': 'Schedule',
  'message.emailed': { backstage: 'Emailed {date}' }, // Δ13 R-12 — additional fact, never replaces Sent

  // §1.7 — the call, open and closed (EVT-1..3)
  'call.before': { backstage: 'Opens {date}', onstage: 'Proposals open on {date}' },
  'call.open': { backstage: 'Open · closes in {n} days', onstage: 'You can still submit a talk — closes {date}' },
  'call.closed': { backstage: 'Closed {date}', onstage: 'Proposals closed on {date}' },

  // §1.10 — roles, formats, levels, provenance
  'role.speaker': 'Speaker',
  'role.cospeaker': 'Co-speaker',
  'role.host': 'Host',
  'format.talk': 'Talk',
  'format.workshop': 'Workshop',
  'format.panel': 'Panel',
  'format.lightning': 'Lightning talk',
  'level.new': 'New to this',
  'level.working': 'Working with it already',
  'level.deep': 'Deep in it',
  'source.public': { backstage: 'Sent through the call' },
  'source.admin': { backstage: 'Added by an organizer' },
  'source.seed': { backstage: 'Here from the start' },

  // §1.12 — signing in · Δ1
  'auth.sign_in': { onstage: 'Sign in' },
  'auth.link': { onstage: 'Email me a link' },
  'auth.google': { onstage: 'Continue with Google' },
  'auth.signed_in': { onstage: 'Signed in as {name}' },
  'auth.sign_out': { backstage: 'Sign out', onstage: 'Sign out' },
  'auth.link_expired': { onstage: 'That link has expired — they last two hours' },
  'auth.merged': { onstage: 'Your {n} starred talks came with you' },

  // §1.13 — sharing your schedule · Δ2
  'share.on': { onstage: 'Link on' },
  'share.off': { onstage: 'Link off' },
  'share.create': { onstage: 'Share my schedule' },
  'share.revoke': { onstage: 'Turn the link off' },
  'share.page_off': { onstage: "This schedule isn't shared any more" },

  // §1.14 — Saw it, Missed it, and catching up · Δ3
  'star.unmarked': { onstage: 'Were you there?' },
  'star.watched': { onstage: 'Saw it' },
  'star.missed': { onstage: 'Missed it' },
  'session.recording': { backstage: 'Recording', onstage: 'Watch the talk' },
  'session.no_recording': { backstage: 'No recording yet' },
  'screen.catch_up': { onstage: 'Catch up' },

  // §1.16 — Ask, the concierge · Δ6
  'screen.ask': 'Ask',
  'ask.off': "The concierge isn't switched on for this event",
  'ask.unknown': "I can't see that",

  // §1.17 — themes, search, More like this · Δ8
  'brain.themes': { backstage: 'Group by theme' },
  'brain.more_like_this': { onstage: 'More like this' },

  // §1.18 — the tool layer, "Take me there →" · Δ9
  'tool.take_me_there': 'Take me there',
  'tool.connect': { backstage: 'Connect your tools' },

  // §1.19 — the improvement panes, the five-string contract · Δ10
  'pane.second_look': 'A second look',
  'pane.preview': 'See it in place',
  'pane.use': 'Use this',
  'pane.leave': 'Leave it as it is',
  'pane.versions': 'Earlier versions',
  'pane.balance': { backstage: 'Program balance' },

  // §1.20 — What people asked, the answer loop · Δ10
  'studio.digest': { backstage: 'What people asked' },
  'studio.unanswered': { backstage: "We couldn't answer this" },
  'studio.annotate': { backstage: "Say what's wrong" },
  'studio.draft': { backstage: 'Draft a better answer' },
  'answer.suggested': { backstage: 'Suggested' },
  'answer.in_use': { backstage: 'In use' },
  'answer.replaced': { backstage: 'Replaced' },

  // §1.21 — say you were there · Δ12
  'social.say': { onstage: 'Say you were there' },
  'social.who': { onstage: 'Who was there' },
  'social.remind': { onstage: 'Remind me to connect' },
  'social.list': { onstage: 'People to find' },
  'social.revoke': { onstage: 'Take me off this list' },
  'social.visibility': { onstage: 'What can people see?' },
  'social.empty': { onstage: "Nobody's said they were here yet." },

  // §1.24 — the exchange: find someone by name, ask, accept · Δ conn. Not in
  // 02 §6 (a later parcel) — same register split as §1.21, onstage only.
  'friend.find': { onstage: 'Find someone you met' },
  'friend.search_button': { onstage: 'Search' },
  'friend.search_empty': { onstage: 'No one found by that name yet. Check the spelling, or try a different one.' },
  'friend.request': { onstage: 'Send a request' },
  'friend.sent': { onstage: 'Request sent' },
  'friend.cancel': { onstage: 'Cancel request' },
  'friend.incoming': { onstage: '{name} wants to connect' },
  'friend.accept': { onstage: 'Accept' },
  'friend.not_now': { onstage: 'Not now' },
  'friend.incoming_section': { onstage: 'Asking to connect' },
  'friend.list': { onstage: 'Your people' },
  'friend.list_empty': { onstage: 'Nobody yet. Search a name above once you have met them.' },
  'friend.remove': { onstage: 'Remove' },
  'friend.schedule': { onstage: 'See their schedule' },
  'friend.schedule_empty': { onstage: "{name} hasn't starred anything yet." },
  'friend.done': { onstage: 'Sent. They will see it next time they look.' },
  'friend.accepted': { onstage: 'They are one of your people now.' },
  'friend.removed': { onstage: 'Done. Nothing more to see on either side.' },
  'friend.moved': { onstage: 'That moved while you were looking, so nothing changed.' },
  'friend.trouble': { onstage: 'That did not save. Try it once more.' },

  // §1.22 — Questions, the call's own question editor · Δ13
  'question.section': { backstage: 'Questions' },
  'question.add': { backstage: 'Add a question' },
  'question.edit': { backstage: 'Edit' },
  'question.off': { backstage: 'Turn it off' },
  'question.up': { backstage: 'Move up' },
  'question.down': { backstage: 'Move down' },
  'question.kind.short': { backstage: 'Short answer' },
  'question.kind.long': { backstage: 'Long answer' },
  'question.kind.select': { backstage: 'Pick one' },
  'question.kind.checkbox': { backstage: 'Checkboxes' },
  'question.show_if': { backstage: 'Only when {question} is {answer}' },

  // Δ helper — a speaker's own logistics helper, someone who takes care of
  // the deck, confirms travel, and sends in what the committee asks for,
  // without being on the program themselves (schema/0011). Not in 02 §6 (a
  // later parcel) — onstage only, same register split as friend.* above.
  'helper.section': { onstage: 'People who help you' },
  'helper.blurb': {
    onstage:
      'Someone who takes care of the logistics for you — the deck, confirming travel, sending in ' +
      'what the committee asks for. They sign in the same way you do, and see only what you owe ' +
      'here.',
  },
  'helper.empty': { onstage: 'Nobody yet.' },
  'helper.name_label': { onstage: 'Their name' },
  'helper.email_label': { onstage: 'Their email' },
  'helper.add_button': { onstage: 'Add' },
  'helper.remove': { onstage: 'Remove' },
  'helper.added': { onstage: 'Added. They can sign in the same way you do, at the address you gave.' },
  'helper.removed': { onstage: 'Removed. They no longer have anything to do here.' },
  'helper.no_name': { onstage: 'A name is needed.' },
  'helper.no_email': { onstage: 'An email address is needed.' },
  'helper.self': { onstage: 'That is your own address, so it cannot be added as a helper.' },
  'helper.banner': { onstage: 'Helping {name}' },
  'helper.scope_note': {
    onstage:
      "You can see where {name}'s talks stand, what is due, and the letters from the committee, and " +
      "you can send in what {name} needs to send. The talk itself stays {name}'s alone to change.",
  },

  // §1.23 — reviewing, the committee's own words · Δ13
  'review.queue': { backstage: 'Yours to score · {n}' },
  'review.progress': { backstage: 'Reviewed {n} of {m}' },
  'review.round': { backstage: 'Round {n}' },
  'review.start_round': { backstage: 'Start round {n}' },
  'review.assign': { backstage: 'Assign to a reviewer' },
  'review.blind': { backstage: 'Names and employers are hidden while you score.' },
  'review.save': { backstage: 'Save my scores' },
  'review.done': { backstage: "All {n} scored. That's everything on your list." },
  'review.average': { backstage: 'Average {score} · {n} of {m} reviewed' },
} as const satisfies Record<string, LabelValue>;

export type LabelKey = keyof typeof LABELS;

/**
 * Resolve a label for a register. Strings with `{token}` placeholders (dates,
 * names, counts, rooms — see §6) are returned unfilled; interpolation is the
 * caller's job, this module only owns the words. Throws if §6 marks the cell
 * "—" for that register: that means the fact is never shown there, and a
 * caller asking for it anyway is the bug, not a missing string.
 */
export function label(key: LabelKey, register: Register): string {
  const entry: LabelValue = LABELS[key];
  if (typeof entry === 'string') return entry;
  const value = entry[register];
  if (value === undefined) {
    throw new Error(`labels: '${key}' has no ${register} string — 02-ubiquitous-language.md §6 marks it "—"`);
  }
  return value;
}

/**
 * §1.3: the pill reads "Decided · not told · 610" in the organizer's register
 * only. The count is never baked into LABELS — §5 rule 2 requires it come
 * from the list behind it, so the caller always supplies it fresh.
 */
export function decidedNotToldPill(count: number): string {
  return `${label('submission.decided_not_told', 'backstage')} · ${count}`;
}

/**
 * 02 §3, left column, lowercased — every literal term the taste-lint script
 * forbids in rendered output (page text, aria-label, title, tooltip, email
 * subject, empty state, error). Two things §3 bans are deliberately absent
 * here because they are not literal substrings a grep can match: the
 * zero-exclamation-mark rule and the zero-emoji rule (§3.3) — enforce those
 * with a character scan, not a word list.
 *
 * Known exemptions the lint script must special-case, not this list: `api`,
 * `cli`, `mcp` and `cfp` are allowed in the event settings Connect section
 * and the README (§1.7, §1.18, §3.1) — nowhere else.
 */
export const BANNED_WORDS: string[] = [
  // 3.1 — dev-speak
  'record',
  'records',
  '1,000 matching records · rendered 50 at a time',
  'rendered',
  'paginated',
  'page size',
  'lazy-loaded',
  'virtualized',
  'route',
  'endpoint',
  'route not installed',
  'null',
  'none',
  'nil',
  'undefined',
  'empty',
  'n/a',
  'invalid',
  'error',
  'error code',
  '403',
  '500',
  'stack trace',
  'the list request failed (403)',
  'in_review',
  // "notify/notified/notification" are a MARKETING-voice ban, not a product
  // one (operator, register split): inside the SaaS backstage the organizer
  // notifies speakers, and that is the plain word. The de-slop rite's own
  // taste bank still forbids them in marketing copy. So they are absent here.
  'upload-file',
  'todo-sub-4',
  'slug',
  'entity',
  'object',
  'model',
  'schema',
  'field',
  'payload',
  'json',
  'uuid',
  'id',
  'sync',
  'config',
  'flag',
  'toggle state',
  'enum',
  'boolean',
  'query',
  'filter expression',
  'search index',
  'asset',
  'blob',
  'attachment',
  'artifact',
  'user',
  'end user',
  'actor',
  'data',
  'dataset',
  'webhook',
  'tenant',
  'workspace',
  'instance',
  'api',
  'cli',
  'mcp',
  'connection key',
  'workflow',
  'automation',
  'trigger',
  'rule',
  'recipe',
  'pipeline',
  'when this then that',
  'ai',
  'assistant',
  'chatbot',
  'copilot',
  'bot',
  'agent',
  'powered by',
  'beta',
  '✨',
  'suggestion applied',
  'auto-fix',
  'enhance',
  'improve with ai',
  'rewrite for me',
  'loading…',

  // 3.2 — jargon and category-speak
  'waved',
  'waived',
  'in wave',
  'wave 1',
  'evaluation required',
  'evaluation plan',
  'review queue',
  'in review',
  'waitlisted',
  'waitlist',
  'holding queue',
  'position 7',
  'rejected',
  'denied',
  'unsuccessful',
  'submission',
  'comms',
  'blast',
  'participant role min/max',
  'combined character limits across fields',
  'cfp',
  'attendee',
  'attendees',
  'registrant',
  'registration',
  'ticket',
  'waves',
  'cohorts',
  'segments',
  'engagement',
  'who-starred-what',
  'contact support',
  'help desk',
  'submit a ticket',
  'noreply@',
  'dashboard',
  'widget',
  'module',
  'panel',

  // 3.3 — register offenders
  'utilize',
  'leverage',
  'facilitate',
  'enable',
  'disable',
  'please note that',
  'in order to',
  'at this time',
  'kindly',
  'we regret to inform you',
  'unfortunately',
  'due to the volume of submissions',
  'oops!',
  'something went wrong',
  'whoops',
  'uh-oh',
  'are you sure?',
  'successfully',
  'successfully saved',
  'click here',
  'sorry for the inconvenience',
];

// MISSING FROM 02 §6:
// These facts get a "Word" in §1.x prose but no row in the §6 table, so no
// key exists for them above. Do not guess their strings or their register
// split — flag for the doc owner instead.
//   - `call.happened` (or similar) — §1.7: "An event that already ran... its
//     landing card reads 'Happened · recordings up'." EVT-1/2/3 are all in
//     §6; this fourth call-lifecycle fact (past EVT-3) is not.
//   - a "Saved" autosave state — §1.4: "autosave happened → Saved." Unclear
//     whether this is a real enum value or a transient toast with no backing
//     field; §1.4 has no organizer/speaker split to copy from either way.
//   - a "Sent" post-submit state — §1.4: "after sending → Sent." Distinct
//     from `message.delivered`'s "Sent {date}" (that's an outbox message;
//     this is the proposal-submission receipt). Same open question as above:
//     enum value or one-off confirmation copy, and which register(s) see it.

// Δ CP1 additions (provisional rulings, decision-log 2026-08-12): mappings
// from STORED values to label keys, and the fourth call-lifecycle fact the
// doc pass owes 02 §6. Stored casing follows the seed ('Talk', 'intro'…).
export const FORMAT_KEY: Record<string, LabelKey> = {
  Talk: 'format.talk',
  'Lightning talk': 'format.lightning',
  Workshop: 'format.workshop',
  Panel: 'format.panel',
};
export const LEVEL_KEY: Record<string, LabelKey> = {
  intro: 'level.new',
  practitioner: 'level.working',
  deep: 'level.deep',
};
/** The past event's call state, canonical from the prototype landing. */
export const CALL_HAPPENED = 'Happened · recordings up';
