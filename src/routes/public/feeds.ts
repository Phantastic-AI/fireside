// T610 — the program as data, and as paper.
//
// Two more shapes the same published program comes in, beside the widgets and
// the calendar files:
//
//   /:event/agenda.json    the whole grid as JSON — sessions with times,
//                          rooms, tracks, speakers and their roles, filterable
//                          by ?day= and ?track=. CORS-open, because a feed's
//                          whole purpose is somebody else's origin.
//   /:event/speakers.json  the gallery as JSON.
//   /:event/agenda.html    the grid as plain HTML: no script, no external
//                          styles, safe to paste into anything that takes
//                          markup. The iframe stays the living version; this
//                          one is paper.
//
// All three read the same published-agenda queries the widgets read, refuse
// the same way when nothing is published, and carry the same live-by-reading
// property: no republish step exists because nothing is generated.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc } from '../../lib/html';
import {
  agenda,
  eventBySlug,
  speakersGallery,
  type AgendaSession,
  type EventHome,
} from '../../queries/public';

const CORS = { 'access-control-allow-origin': '*' };
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300',
  ...CORS,
};

function sessionJson(ev: EventHome, s: AgendaSession): Record<string, unknown> {
  return {
    id: s.publicSlug ?? s.id,
    title: s.title,
    abstract: s.abstract,
    cancelled: s.cancelled,
    startsAt: new Date(s.startsAt).toISOString(),
    minutes: s.minutes,
    format: s.format,
    room: s.roomName,
    track: s.track ? { slug: s.track.slug, name: s.track.name } : null,
    speakers: s.speakers.map((p) => ({ name: p.name, role: p.role })),
    url: s.publicSlug ? `https://onfireside.com/${ev.slug}/s/${s.publicSlug}` : null,
    recordingUrl: s.recordingUrl,
  };
}

export function registerFeeds(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/agenda.json', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const a = await agenda(c.env.DB, ev.id);
    if (!a || !a.published) {
      return c.json({ error: 'The agenda is not published yet.' }, 404, CORS);
    }
    const dayFilter = c.req.query('day') ?? null;
    const trackFilter = c.req.query('track') ?? null;
    const days = a.days
      .filter((d) => dayFilter === null || d.day === dayFilter)
      .map((d) => ({
        day: d.day,
        sessions: d.slots
          .flatMap((slot) => slot.sessions)
          .filter((s) => trackFilter === null || s.track?.slug === trackFilter)
          .map((s) => sessionJson(ev, s)),
      }))
      .filter((d) => d.sessions.length > 0);
    return c.body(
      JSON.stringify(
        {
          event: { slug: ev.slug, name: ev.name, timezone: a.timezone, tzLabel: a.tzLabel },
          days,
        },
        null,
        1
      ),
      200,
      JSON_HEADERS
    );
  });

  app.get('/:event/speakers.json', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const gallery = await speakersGallery(c.env.DB, ev.id);
    return c.body(
      JSON.stringify(
        {
          event: { slug: ev.slug, name: ev.name },
          speakers: gallery.map((p) => ({
            id: p.personId,
            name: p.name,
            jobTitle: p.jobTitle,
            organisation: p.organisation,
            url: `https://onfireside.com/${ev.slug}/speakers/${p.personId}`,
          })),
        },
        null,
        1
      ),
      200,
      JSON_HEADERS
    );
  });

  // The grid as paper: one self-contained document, no script, styles inline
  // and minimal, every fact the cards carry. Paste it into a CMS that strips
  // nothing, print it, mail it.
  app.get('/:event/agenda.html', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();
    const a = await agenda(c.env.DB, ev.id);
    if (!a || !a.published) {
      return c.html('<p>The agenda is not published yet.</p>', 404);
    }
    const t = (ms: number): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: a.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));
    const dayWord = (iso: string): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date(`${iso}T12:00:00Z`));
    const rows = a.days
      .map(
        (d) =>
          `<h2 style="font:600 18px/1.3 Georgia,serif;margin:18px 0 6px">${esc(dayWord(d.day))}</h2>` +
          d.slots
            .flatMap((slot) => slot.sessions)
            .map(
              (s) =>
                '<p style="margin:6px 0">' +
                `<b>${esc(t(s.startsAt))}</b> · ${esc(s.title)}` +
                (s.cancelled ? ' <i>(cancelled)</i>' : '') +
                (s.speakers.length
                  ? ` — ${esc(s.speakers.map((p) => p.name).join(', '))}`
                  : '') +
                (s.roomName ? ` · ${esc(s.roomName)}` : '') +
                (s.track ? ` · ${esc(s.track.name)}` : '') +
                '</p>'
            )
            .join('')
      )
      .join('');
    const doc =
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      `<title>${esc(ev.name)} — program</title></head>` +
      '<body style="font:15px/1.5 system-ui,sans-serif;max-width:44em;margin:2em auto;padding:0 1em">' +
      `<h1 style="font:600 24px/1.2 Georgia,serif">${esc(ev.name)}</h1>` +
      (a.tzLabel ? `<p style="color:#666">${esc(a.tzLabel)}</p>` : '') +
      rows +
      `<p style="color:#666;margin-top:20px">The living program: https://onfireside.com/${esc(ev.slug)}/agenda</p>` +
      '</body></html>';
    return c.body(doc, 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...CORS,
    });
  });
}
