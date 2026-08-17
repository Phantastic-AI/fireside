// The minimal, high-value unit set: the pure functions where a silent
// regression actually costs. Not the 22k lines of route markup — the logic
// with real invariants and zero I/O. Run: npx tsx --test test/units.mts
//
// Deliberately small. Each block pins a behaviour we either depend on for
// correctness (the committee average), for safety (the open-redirect guard,
// the label register wall), or already broke once (weightedAverage counting
// words as zero — the two-averages bug, decision-log D-035).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weightedAverage, averageOf, scorecardFor, type ScorecardKey } from '../src/queries/reviews';
import { label } from '../src/lib/labels';
import { safeNext } from '../src/lib/url';
import { reminderBody } from '../src/workflows/files';
import { ticketIdFromRecipient } from '../src/workflows/reply-email';
import { commitDecision, capabilitiesOf, normalizeContacts, type Pending } from '../src/workflows/agent';
import { catalogFor, parsePlan, canActHere, conciergeAct } from '../src/workflows/plan';
import type { Principal } from '../src/workflows/account';

const scale = (key: string, weight: 1 | 2 | 3 = 2): ScorecardKey => ({
  key,
  label: key,
  kind: 'scale',
  max: 5,
  options: [],
  weight,
});
const text = (key: string): ScorecardKey => ({ key, label: key, kind: 'text', max: 5, options: [], weight: 2 });
const select = (key: string): ScorecardKey => ({ key, label: key, kind: 'select', max: 5, options: ['a', 'b'], weight: 2 });

// --- weightedAverage: scale lines only, weighted, words never averaged ------
// This is the exact bug from D-035: a text/select answer must NOT be counted
// as a zero and drag the number down.
test('weightedAverage: unweighted mean of the scale lines', () => {
  const card = [scale('a'), scale('b')];
  assert.equal(weightedAverage(card, { a: 4, b: 2 }), 3);
});

test('weightedAverage: a heavy line counts three times a light one', () => {
  const card = [scale('a', 3), scale('b', 1)];
  // (3*4 + 1*0) / (3+1) = 3
  assert.equal(weightedAverage(card, { a: 4, b: 0 }), 3);
});

test('weightedAverage: a text or select answer is never averaged (the D-035 bug)', () => {
  const card = [scale('fit'), select('rec'), text('why')];
  // Only fit=4 counts; "Strong yes" and the note are words, not a zero.
  assert.equal(weightedAverage(card, { fit: 4, rec: 'Strong yes', why: 'good' }), 4);
});

test('weightedAverage: no scale marks at all is null, not zero', () => {
  const card = [scale('a'), text('why')];
  assert.equal(weightedAverage(card, { why: 'a note only' }), null);
  assert.equal(weightedAverage(card, {}), null);
});

// --- averageOf: the same value, plus whether "weighted" is honestly true ----
test('averageOf: weighted is false when every marked line carries the same weight', () => {
  const card = [scale('a', 2), scale('b', 2)];
  assert.deepEqual(averageOf(card, { a: 4, b: 2 }), { value: 3, weighted: false });
});

test('averageOf: weighted is true only when marked lines carry more than one weight', () => {
  const card = [scale('a', 3), scale('b', 1)];
  const r = averageOf(card, { a: 4, b: 2 });
  assert.equal(r?.weighted, true);
});

test('averageOf: a heavy line nobody marked does not make it weighted', () => {
  const card = [scale('a', 3), scale('b', 2)];
  // only b marked → one weight in play → not weighted
  assert.equal(averageOf(card, { b: 3 })?.weighted, false);
});

// --- scorecardFor: parsing the stored per-round scorecard --------------------
test('scorecardFor: empty/absent falls back to a single overall scale', () => {
  const card = scorecardFor('{}', 1);
  assert.equal(card.length, 1);
  assert.equal(card[0]?.key, 'overall');
  assert.equal(card[0]?.kind, 'scale');
});

test('scorecardFor: reads a round, defaults kind=scale and weight=2', () => {
  const stored = JSON.stringify({ '1': [{ key: 'fit', label: 'Fit' }] });
  const card = scorecardFor(stored, 1);
  assert.equal(card[0]?.key, 'fit');
  assert.equal(card[0]?.label, 'Fit');
  assert.equal(card[0]?.kind, 'scale');
  assert.equal(card[0]?.weight, 2);
});

test('scorecardFor: a select with fewer than two options degrades to text', () => {
  const stored = JSON.stringify({ '1': [{ key: 'rec', kind: 'select', options: ['only-one'] }] });
  assert.equal(scorecardFor(stored, 1)[0]?.kind, 'text');
});

test('scorecardFor: a bad criterion key is dropped, not rendered broken', () => {
  const stored = JSON.stringify({ '1': [{ key: 'has spaces!' }, { key: 'good' }] });
  const card = scorecardFor(stored, 1);
  assert.deepEqual(card.map((k) => k.key), ['good']);
});

// --- safeNext: the open-redirect guard --------------------------------------
test('safeNext: accepts a plain same-origin path', () => {
  assert.equal(safeNext('/aie-nyc/portal'), '/aie-nyc/portal');
});

test('safeNext: refuses a protocol-relative //host (the open redirect)', () => {
  assert.equal(safeNext('//evil.example.com/x'), null);
});

test('safeNext: refuses a backslash-relative /\\host', () => {
  assert.equal(safeNext('/\\evil.example.com'), null);
});

test('safeNext: refuses anything not starting with a single slash', () => {
  assert.equal(safeNext('https://evil.example.com'), null);
  assert.equal(safeNext('evil'), null);
  assert.equal(safeNext(''), null);
  assert.equal(safeNext(null), null);
  assert.equal(safeNext(undefined), null);
});

test('safeNext: refuses control characters and over-long paths', () => {
  assert.equal(safeNext('/x\nY'), null);
  assert.equal(safeNext('/' + 'a'.repeat(600)), null);
});

// --- reminderBody: the outbound reminder carries a real scoped portal link ---
test('reminderBody: one deliverable names it, the date, and the portal link', () => {
  const b = reminderBody(['Slides'], 'AI Engineer NY', '2026-09-01', 'https://onfireside.com/aie-nyc/portal');
  assert.match(b, /Slides is still open/);
  assert.match(b, /https:\/\/onfireside\.com\/aie-nyc\/portal/);
});

test('reminderBody: several deliverables list each, and still carry the link', () => {
  const b = reminderBody(['Slides', 'Bio'], 'AIE', '2026-09-01', 'https://onfireside.com/aie-nyc/portal');
  assert.match(b, /- Slides/);
  assert.match(b, /- Bio/);
  assert.match(b, /onfireside\.com\/aie-nyc\/portal/);
});

// --- ticketIdFromRecipient: the inbound reply address parser ---
test('ticketIdFromRecipient: pulls the id from a plain reply+ address', () => {
  assert.equal(ticketIdFromRecipient('reply+rt-abc234@onfireside.com'), 'rt-abc234');
});

test('ticketIdFromRecipient: tolerates angle brackets and a display name', () => {
  assert.equal(ticketIdFromRecipient('Fireside <reply+rt-abc234@onfireside.com>'), 'rt-abc234');
});

test('ticketIdFromRecipient: rejects a non-reply recipient', () => {
  assert.equal(ticketIdFromRecipient('hello@onfireside.com'), null);
  assert.equal(ticketIdFromRecipient('naomi@example.org'), null);
  assert.equal(ticketIdFromRecipient('reply@onfireside.com'), null); // no +id
});

// --- the agentic-write security boundary: commitDecision (pure state machine) ---
const basePending = (over: Partial<Pending> = {}): Pending => ({
  id: 'pa-1',
  personId: 'per-me',
  eventId: 'ev-1',
  surface: 'event',
  actionType: 'connect_request',
  tier: 'confirm',
  countExpected: null,
  expiresAt: 10_000,
  status: 'open',
  ...over,
});

test('commitDecision: a clean open action by its owner commits', () => {
  assert.deepEqual(commitDecision(basePending(), 'per-me', true, 5_000, null), { ok: true });
});

test('commitDecision: only the owner can commit (no cross-user)', () => {
  assert.deepEqual(commitDecision(basePending(), 'per-someone-else', true, 5_000, null), {
    ok: false,
    reason: 'not-yours',
  });
});

test('commitDecision: an already-committed action cannot replay', () => {
  assert.deepEqual(commitDecision(basePending({ status: 'committed' }), 'per-me', true, 5_000, null), {
    ok: false,
    reason: 'gone',
  });
});

test('commitDecision: a cancelled action is gone', () => {
  assert.deepEqual(commitDecision(basePending({ status: 'cancelled' }), 'per-me', true, 5_000, null).ok, false);
});

test('commitDecision: a stale action cannot commit', () => {
  assert.deepEqual(commitDecision(basePending({ expiresAt: 4_000 }), 'per-me', true, 5_000, null), {
    ok: false,
    reason: 'expired',
  });
});

test('commitDecision: capability is re-checked live — lost standing refuses', () => {
  assert.deepEqual(commitDecision(basePending(), 'per-me', false, 5_000, null), { ok: false, reason: 'not-allowed' });
});

test('commitDecision: a numbered tier needs the exact number re-stated', () => {
  const p = basePending({ tier: 'confirm-number', countExpected: 610 });
  assert.deepEqual(commitDecision(p, 'per-me', true, 5_000, 610), { ok: true });
  assert.deepEqual(commitDecision(p, 'per-me', true, 5_000, 609), { ok: false, reason: 'wrong-number' });
  assert.deepEqual(commitDecision(p, 'per-me', true, 5_000, null), { ok: false, reason: 'wrong-number' });
});

// --- capabilitiesOf: capability INTERSECT surface (the dual-role hole) --------
const prin = (over: Partial<Principal> = {}): Principal => ({
  personId: 'per-me',
  name: 'Me',
  email: null,
  role: null,
  eventRoles: {},
  ...over,
});

test('capabilitiesOf: a plain attendee gets the low-stakes acts, nothing more', () => {
  const caps = capabilitiesOf(prin(), 'ev-1', 'event');
  assert.equal(caps.has('star'), true);
  assert.equal(caps.has('connect'), true);
  assert.equal(caps.has('invite'), false);
  assert.equal(caps.has('review'), false);
});

test('capabilitiesOf: an organizer gets organizer acts on the backstage', () => {
  const caps = capabilitiesOf(prin({ role: 'organizer' }), 'ev-1', 'backstage');
  assert.equal(caps.has('invite'), true);
  assert.equal(caps.has('decide'), true);
});

test('capabilitiesOf: a dual-role organizer in the speaker portal gets ONLY speaker acts', () => {
  // The account is an organizer, but on the portal surface it must not carry
  // organizer power — the intersection Codex insisted on.
  const caps = capabilitiesOf(prin({ role: 'organizer' }), 'ev-1', 'portal');
  assert.equal(caps.has('invite'), false);
  assert.equal(caps.has('decide'), false);
  assert.equal(caps.has('star'), true);
});

test('capabilitiesOf: an attendee on the backstage surface can do nothing', () => {
  assert.equal(capabilitiesOf(prin(), 'ev-1', 'backstage').size, 0);
});

test('capabilitiesOf: the global (pre-conference) surface exposes no writes in v1', () => {
  assert.equal(capabilitiesOf(prin({ role: 'organizer' }), null, 'global').size, 0);
});

// --- the concierge planner: catalog scoping + the parse contract -------------
// The planner is untrusted and supple; these pin the DETERMINISTIC edges of it —
// it is never offered an action the principal cannot take, and a garbled or
// hostile reply degrades to "just answer the question", never to a silent act.
test('catalogFor: an action appears only when its capability is held', () => {
  assert.equal(catalogFor(new Set(['star'])).some((a) => a.type === 'star'), true);
  assert.equal(catalogFor(new Set()).length, 0);
  // A capability with no action wired yet contributes nothing — no phantom acts.
  assert.equal(catalogFor(new Set(['review'])).some((a) => a.type === 'star'), false);
});

const starCatalog = catalogFor(new Set(['star']));

test('parsePlan: a plain question routes to the read-only path', () => {
  assert.deepEqual(parsePlan('{"route":"question"}', starCatalog), { route: 'question' });
});

test('parsePlan: a well-formed act on an offered action passes its args through', () => {
  const p = parsePlan('{"route":"act","action":"star","args":{"submissionId":"sub-9","on":true},"say":"Starring it."}', starCatalog);
  assert.deepEqual(p, { route: 'act', action: 'star', args: { submissionId: 'sub-9', on: true }, say: 'Starring it.' });
});

test('parsePlan: an act naming an action we never offered degrades to a question', () => {
  // Not a refusal of a hidden power — we simply never claimed to have it.
  const p = parsePlan('{"route":"act","action":"send_outbox","args":{"count":610},"say":"Sending."}', starCatalog);
  assert.deepEqual(p, { route: 'question' });
});

test('parsePlan: a clarify needs a real question back, or it is just a question', () => {
  assert.deepEqual(parsePlan('{"route":"clarify","say":"Which keynote?"}', starCatalog), {
    route: 'clarify',
    say: 'Which keynote?',
  });
  assert.deepEqual(parsePlan('{"route":"clarify","say":""}', starCatalog), { route: 'question' });
});

test('parsePlan: garbage or no JSON at all is a question, never an act', () => {
  assert.deepEqual(parsePlan('I think you should star it!', starCatalog), { route: 'question' });
  assert.deepEqual(parsePlan('', starCatalog), { route: 'question' });
  assert.deepEqual(parsePlan('{not valid json', starCatalog), { route: 'question' });
});

test('parsePlan: JSON wrapped in prose is still read (small models do this)', () => {
  const p = parsePlan('Sure! {"route":"act","action":"star","args":{"submissionId":"s1","on":false},"say":"Unstarring."} ok?', starCatalog);
  assert.deepEqual(p, { route: 'act', action: 'star', args: { submissionId: 's1', on: false }, say: 'Unstarring.' });
});

// --- normalizeContacts: the invite recipient list, made safe to freeze --------
// The model resolves WHO (from Gmail, wherever); this only checks shape and
// refuses the malformed, so a garbage entry never becomes a person row.
test('normalizeContacts: trims names, lowercases emails, keeps the good ones', () => {
  const out = normalizeContacts([{ name: '  Ada Lovelace ', email: 'Ada@Example.ORG' }]);
  assert.deepEqual(out, [{ name: 'Ada Lovelace', email: 'ada@example.org' }]);
});

test('normalizeContacts: drops entries with no name or no @-address', () => {
  const out = normalizeContacts([
    { name: '', email: 'x@y.org' },
    { name: 'No Email', email: 'not-an-address' },
    { name: 'Bram', email: 'bram@example.org' },
  ]);
  assert.deepEqual(out, [{ name: 'Bram', email: 'bram@example.org' }]);
});

test('normalizeContacts: de-duplicates by address, first name wins', () => {
  const out = normalizeContacts([
    { name: 'Ada', email: 'ada@example.org' },
    { name: 'Ada L.', email: 'ada@example.org' },
  ]);
  assert.equal(out.length, 1);
});

test('normalizeContacts: anything that is not an array of objects is empty', () => {
  assert.deepEqual(normalizeContacts('nope'), []);
  assert.deepEqual(normalizeContacts([1, 'two', null]), []);
  assert.deepEqual(normalizeContacts(undefined), []);
});

// --- conciergeAct routing: failure is NOT a silent question (Codex #4) --------
// A stub model lets us pin the routing without a live call. capabilitiesOf grants
// every principal 'star' on the event surface, so the planner is always reached.
const stubAi = (reply: string) => ({ run: async () => ({ response: reply }) }) as unknown as Parameters<typeof conciergeAct>[0]['AI'];
const actEnv = (reply: string) => ({ DB: {} as any, FILES: {} as any, AI: stubAi(reply) });
const where = { eventId: 'ev-1', surface: 'event' as const };

test('canActHere: an attendee can act on the event surface, no one can on global', () => {
  assert.equal(canActHere(prin(), 'ev-1', 'event'), true);
  assert.equal(canActHere(prin({ role: 'organizer' }), null, 'global'), false);
});

test('conciergeAct: an empty model reply is unavailable, never a silent question', async () => {
  // The Codex #4 fix: a planner that could not answer must not be treated as
  // "this was a question" and quietly answered — we do not know that.
  const out = await conciergeAct(actEnv(''), prin(), where, 'unstar the keynote', []);
  assert.equal(out.kind, 'unavailable');
});

test('conciergeAct: a confident question falls through to the read path', async () => {
  const out = await conciergeAct(actEnv('{"route":"question"}'), prin(), where, 'where is the venue?', []);
  assert.equal(out.kind, 'not-an-action');
});

test('conciergeAct: an ambiguous action asks back rather than guessing', async () => {
  const out = await conciergeAct(actEnv('{"route":"clarify","say":"Which keynote?"}'), prin(), where, 'star the keynote', []);
  assert.equal(out.kind, 'clarify');
  if (out.kind === 'clarify') assert.match(out.say, /Which keynote/);
});

// --- label: the register wall (throws rather than showing the wrong voice) ---
test('label: returns the string for a plain, register-agnostic key', () => {
  assert.equal(typeof label('ask.unknown', 'onstage'), 'string');
});

test('label: a two-register key returns each register its own word', () => {
  assert.equal(label('submission.rejected', 'backstage'), 'Declined');
  assert.equal(label('submission.rejected', 'onstage'), 'Not this time');
});

test('label: throws when a key has no string for the asked register', () => {
  // helper.banner is onstage-only; asking for backstage must throw, never
  // silently render an empty or wrong-register word.
  assert.throws(() => label('helper.banner', 'backstage'), /no backstage string/);
});
