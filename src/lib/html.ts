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
    link('/portal', 'Your portal')
  );
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
