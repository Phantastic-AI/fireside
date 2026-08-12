// The page shell, both registers. Markup vocabulary is the prototype's —
// the lifted CSS in src/styles/ is the binding skin.

export const NAME = 'Fireside';

export const FLAME =
  '<svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3c1.6 4.2-1.4 6-1.4 8.6 0 1.6 1.2 2.6 2.4 2.6 1.5 0 2.3-1.1 2.2-2.6 2.2 1.9 3.3 4.2 3.3 6.6 0 3.9-3 6.8-6.5 6.8S9.5 22.1 9.5 18.2C9.5 12.3 14.6 9.6 16 3z" fill="#B14D14"/></svg>';

/** HTML-escape. Every interpolated string goes through this unless marked raw. */
export function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function brand(): string {
  return `<a class="brand" href="/">${FLAME}${NAME}</a>`;
}

type PageOpts = {
  title: string;
  description?: string;
  register: 'onstage' | 'backstage';
  body: string;
};

export function page(o: PageOpts): string {
  const bundle = o.register === 'onstage' ? '/a/on.css' : '/a/back.css';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(o.title)}</title>` +
    (o.description ? `<meta name="description" content="${esc(o.description)}">` : '') +
    `<link rel="stylesheet" href="${bundle}">` +
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FLAME)}">` +
    '</head><body>' +
    o.body +
    '</body></html>'
  );
}

/** Event-scoped onstage nav — one builder so six screens cannot drift. */
export function eventNav(slug: string, here: string, callOpen: boolean): string {
  const link = (path: string, label: string) =>
    `<a href="/${slug}${path}"${here === path ? ' aria-current="page"' : ''}>${label}</a>`;
  return (
    link('', 'The event') +
    (callOpen ? link('/cfp', 'The call') : '') +
    link('/agenda', 'Agenda') +
    link('/speakers', 'Speakers') +
    link('/my-schedule', 'My schedule') +
    link('/ask', 'Ask') +
    link('/portal', 'Your portal')
  );
}

const BS_NAV: [path: string, label: string][] = [
  ['', 'Program'],
  ['/submissions', 'Proposals'],
  ['/reviews', 'Reviews'],
  ['/agenda', 'Agenda'],
  ['/people', 'People'],
  ['/green-room', 'Green room'],
  ['/slides', 'Slides'],
  ['/outbox', 'Outbox'],
  ['/settings', 'Settings'],
];

/** The backstage chrome — dark top bar, event switch, section nav. */
export function backstageShell(o: {
  eventSlug: string;
  eventName: string;
  here: string; // '' | '/submissions' | ...
  who: string; // "Naomi Adeyemi · Organizer"
  whoInitials: string;
  tzLabel: string;
  body: string;
  crumb?: string;
}): string {
  const nav = BS_NAV.map(([p, lab]) =>
    p === o.here
      ? `<span aria-current="page">${lab}</span>`
      : `<a href="/admin/${o.eventSlug}${p}">${lab}</a>`
  ).join('');
  return (
    '<div class="stage backstage">' +
    `<div class="bs-top"><div class="wrap wrap-wide bs-top-in">${brand()}` +
    `<a class="evt-switch" href="/admin">${esc(o.eventName)} <span style="opacity:.6">⌄</span></a>` +
    `<div class="bs-me"><span style="width:26px;height:26px;border-radius:50%;display:inline-grid;place-items:center;background:var(--ember-wash);color:var(--ember);font-size:11px;font-weight:700">${esc(o.whoInitials)}</span><span>${esc(o.who)}</span></div>` +
    '</div></div>' +
    `<div class="bs-nav"><div class="wrap wrap-wide bs-nav-in">${nav}</div></div>` +
    `<main><div class="wrap wrap-wide">${o.crumb ? `<div class="crumb">${o.crumb}</div>` : ''}${o.body}</div></main>` +
    `<footer class="foot"><div class="wrap wrap-wide foot-in"><span class="fname">${NAME}</span>` +
    `<span>${esc(o.tzLabel)}</span>` +
    `<span style="margin-left:auto"><a class="link" href="/${o.eventSlug}">See the public page ↗</a></span>` +
    '</div></footer></div>'
  );
}

/** The backstage refusal — one page for every ScopeError, in its own words. */
export function deniedPage(message?: string): string {
  return page({
    title: NAME,
    register: 'backstage',
    body:
      '<div class="stage backstage"><main style="min-height:70vh;display:grid;place-items:center">' +
      '<div class="card card-pad" style="max-width:30em">' +
      `<h1 class="serif" style="font-size:24px;font-weight:600;margin:0">${esc(message ?? 'That conference is not one of yours.')}</h1>` +
      '<p class="sub" style="margin:10px 0 0">If it should be, ask an organizer of that event to add you from their settings.</p>' +
      '<p style="margin:16px 0 0"><a class="link" href="/admin">Back to your events →</a></p>' +
      '</div></main></div>',
  });
}

/** The onstage chrome: masthead, main, footer. `nav` is pre-built links. */
export function onstageShell(nav: string, body: string, foot?: string): string {
  return (
    '<div class="stage onstage">' +
    `<header class="mast"><div class="wrap mast-in">${brand()}<nav>${nav}</nav></div></header>` +
    `<main>${body}</main>` +
    '<footer class="foot"><div class="wrap foot-in">' +
    `<span class="fname">${NAME}</span>` +
    `<span>${foot ?? 'An open-source call for speakers.'}</span>` +
    '</div></footer></div>'
  );
}
