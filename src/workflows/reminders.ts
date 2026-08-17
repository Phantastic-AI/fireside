// T605 — the reminder nobody has to remember to send.
//
// Once a day (the same cron that rebuilds the demo), every OPEN task that is
// due soon or overdue writes its speaker one reminder: a message in their
// portal, and an email when the address is real. The organizer's own bulk
// "Ask everyone at once" stays exactly as it was — this is the pass that runs
// when nobody thought to press it.
//
// Three rules keep it polite:
//   1. ONCE A DAY, AT MOST. last_reminded_on records the calendar day (in the
//      event's own timezone) a task last nagged; a task already nagged today
//      is skipped, so a cron retry or a second deploy never doubles a nag.
//   2. ONE LETTER PER PERSON PER CONFERENCE. All of somebody's due tasks in
//      one note with the earliest date, not a drip of separate nags.
//   3. AN EVENT CAN TURN IT OFF. auto_reminders (default on) is the switch,
//      in settings, per conference.
//
// The words are files.ts's own reminder vocabulary, so the automated nag and
// the organizer's hand-pressed one read as the same product speaking.

import { newId, now } from '../lib/db';
import { reminderBody } from './files';

/** Due within this many days (or overdue) is worth a reminder. */
export const REMIND_WITHIN_DAYS = 3;

type EmailBinding = {
  send(msg: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
  }): Promise<unknown>;
};

/** Today as the event's own calendar day — a due date is a local fact. */
export function localDay(timezone: string, nowMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/** The ISO day `days` ahead of a given ISO day. */
export function daysAhead(isoDay: string, days: number): string {
  const ms = Date.parse(`${isoDay}T12:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Titles said once each: two tasks with one name read "Send your slides ×2",
 *  never the same line twice. */
export function dedupeTitles(titles: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
}

type DueRow = {
  task_id: string;
  event_id: string;
  event_slug: string;
  event_name: string;
  timezone: string;
  person_id: string;
  person_name: string;
  email: string | null;
  title: string;
  due_on: string;
};

const ORIGIN = 'https://onfireside.com';

function isRealAddress(email: string): boolean {
  return !/@example\.(org|com|net)$/i.test(email);
}

/**
 * The daily pass. Returns how many letters went out and to how many people —
 * the cron's log line, and the number a test asserts on.
 */
export async function runDueReminders(
  db: D1Database,
  email: { binding: EmailBinding; from: string } | null,
  waitUntil: (p: Promise<unknown>) => void,
  nowMs: number = Date.now()
): Promise<{ letters: number; tasks: number }> {
  // Every open, dated task on a reminding event, its person and its event —
  // filtered to due-soon per event timezone in the pass below, because
  // "today" is not one fact across timezones.
  const res = await db
    .prepare(
      `SELECT t.id AS task_id, t.title, t.due_on, t.last_reminded_on,
              e.id AS event_id, e.slug AS event_slug, e.name AS event_name, e.timezone,
              pe.id AS person_id, pe.name AS person_name, pe.email
         FROM task t
         JOIN event e ON e.id = t.event_id AND e.auto_reminders = 1
         JOIN person pe ON pe.id = t.person_id
        WHERE t.completed_at IS NULL AND t.cancelled_at IS NULL AND t.due_on IS NOT NULL
          AND (t.submission_id IS NULL OR EXISTS (
                 SELECT 1 FROM submission s WHERE s.id = t.submission_id
                   AND s.state NOT IN ('withdrawn','cancelled')))`
    )
    .all<DueRow & { last_reminded_on: string | null }>();

  // Group by person-per-event; keep only tasks due soon and not nagged today.
  const buckets = new Map<string, DueRow[]>();
  for (const r of res.results ?? []) {
    const today = localDay(r.timezone, nowMs);
    const horizon = daysAhead(today, REMIND_WITHIN_DAYS);
    if (r.due_on > horizon) continue;
    if (r.last_reminded_on !== null && r.last_reminded_on >= today) continue;
    const key = `${r.event_id}\n${r.person_id}`;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  let letters = 0;
  let tasks = 0;
  for (const list of buckets.values()) {
    const first = list[0];
    if (!first) continue;
    const today = localDay(first.timezone, nowMs);
    const titles = dedupeTitles(list.map((r) => r.title));
    const earliest = list.map((r) => r.due_on).sort()[0] ?? first.due_on;
    const subject =
      titles.length === 1
        ? `Reminder: ${titles[0]}`
        : `Reminder: ${titles.length} deliverables still open`;
    const body = reminderBody(
      titles,
      first.event_name,
      earliest,
      `${ORIGIN}/${first.event_slug}/portal`
    );
    const messageId = newId('msg');
    const t = now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO message (id, event_id, person_id, kind, subject, body, created_at, delivered_at)
           VALUES (?,?,?,'note',?,?,?,?)`
        )
        .bind(messageId, first.event_id, first.person_id, subject, body, t, t),
      ...list.map((r) =>
        db.prepare('UPDATE task SET last_reminded_on = ? WHERE id = ?').bind(today, r.task_id)
      ),
    ]);
    letters += 1;
    tasks += list.length;

    if (email && first.email && isRealAddress(first.email)) {
      const to = first.email;
      const name = first.person_name;
      waitUntil(
        (async () => {
          try {
            await email.binding.send({
              to,
              from: { email: email.from, name: 'Fireside' },
              subject,
              text: `Hello ${name},\n\n${body}\n\n— sent from Fireside.`,
            });
            await db
              .prepare('UPDATE message SET emailed_at = ? WHERE id = ?')
              .bind(now(), messageId)
              .run();
          } catch {
            // the reminder is in their portal either way
          }
        })()
      );
    }
  }
  return { letters, tasks };
}
