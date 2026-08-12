// The page for the thing typing on somebody's behalf — or rather, for the
// person deciding whether to point it here.
//
// /mcp is the machine's entrance; this is the sign beside it, human-readable,
// with the connect strings ready to paste. It is served by the product rather
// than the repository so the link works for everyone the moment they meet the
// concierge, signed in or not.
//
// Register law: everything on this page is a present-tense fact about the
// running software. No roadmap, no construction talk. The one scope sentence
// is the load-bearing one: an agent here sees what a signed-out browser sees.
import { page, brand } from '../../lib/html';
import type { Hono } from 'hono';
import type { Env } from '../../index';

const ORIGIN = 'https://fireside.phantastic.ai';

const TOOLS: { name: string; line: string }[] = [
  { name: 'list_events', line: 'The conferences running here, and the short names they go by.' },
  { name: 'event', line: 'One event whole — dates, whether its call is open, what it holds.' },
  { name: 'agenda', line: 'The published program, filterable to one day.' },
  { name: 'session', line: 'One talk: its people, room, time, and recording when there is one.' },
  { name: 'speakers', line: 'The speaker gallery, as the public sees it.' },
  { name: 'speaker', line: 'One speaker’s page: bio, sessions, the links they chose to share.' },
  { name: 'cfp_questions', line: 'Every question the call asks, with its rules, before writing a word.' },
];

function code(text: string): string {
  return `<pre class="mono" style="background:var(--card,#fff);border:1px solid var(--line,#ded5c7);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:13px;line-height:1.5;margin:8px 0 0">${text}</pre>`;
}

export function agentsPage(): string {
  const body =
    '<div class="stage onstage">' +
    `<header class="mast"><div class="wrap mast-in">${brand()}<nav><a href="/">Home</a><a href="https://github.com/Phantastic-AI/fireside">GitHub</a></nav></div></header>` +
    '<main><div class="wrap" style="max-width:44em">' +
    '<div style="padding:52px 0 8px">' +
    '<h1 class="display" style="font-size:34px">Agents</h1>' +
    '<p class="hint" style="margin-top:10px">Everything the public side of Fireside shows a person, ' +
    'a machine can read at one address — and it can send a proposal through the same guards the form uses.</p>' +
    '</div>' +

    '<div class="sec card card-pad">' +
    '<h2 style="font-size:19px;margin:0 0 6px">The address</h2>' +
    `<p>Fireside speaks the Model Context Protocol over plain HTTP: stateless JSON-RPC 2.0 at <span class="mono">POST ${ORIGIN}/mcp</span>, protocol <span class="mono">2025-06-18</span>. ` +
    'No key, no token, no session header — every call stands alone, and every caller is the public. ' +
    'An agent here sees exactly what a signed-out browser sees: portals, piles, and letters stay behind their sign-in.</p>' +
    '</div>' +

    '<div class="sec card card-pad">' +
    '<h2 style="font-size:19px;margin:0 0 6px">Connecting</h2>' +
    '<p><b>Claude Code</b></p>' +
    code(`claude mcp add --transport http fireside ${ORIGIN}/mcp`) +
    '<p style="margin-top:14px"><b>Claude, on the web or desktop</b> — Settings → Connectors → Add custom connector, then paste the address.</p>' +
    '<p style="margin-top:14px"><b>Anything that reads an <span class="mono">mcpServers</span> block</b></p>' +
    code(`{ "mcpServers": { "fireside": { "url": "${ORIGIN}/mcp" } } }`) +
    '<p style="margin-top:14px"><b>Clients that only speak stdio</b></p>' +
    code(`npx mcp-remote ${ORIGIN}/mcp`) +
    '</div>' +

    '<div class="sec card card-pad">' +
    '<h2 style="font-size:19px;margin:0 0 6px">The tools</h2>' +
    '<div style="display:grid;gap:8px;margin-top:8px">' +
    TOOLS.map(
      (t) =>
        `<div style="display:grid;grid-template-columns:11em 1fr;gap:10px;align-items:baseline">` +
        `<span class="mono" style="font-size:13px">${t.name}</span><span>${t.line}</span></div>`
    ).join('') +
    '</div>' +
    '<p style="margin-top:14px"><b>And one action.</b> <span class="mono" style="font-size:13px">submit_proposal</span> files a real proposal ' +
    'into an open call — the same writer as the public form, with the same guards, the same cap per person, ' +
    'and the same refusals in the same words. A proposal sent by an agent is not a lesser proposal.</p>' +
    '</div>' +

    '<div class="sec card card-pad">' +
    '<h2 style="font-size:19px;margin:0 0 6px">The wire, if you would rather see it</h2>' +
    code(
      `curl -X POST ${ORIGIN}/mcp \\\n` +
        `  -H 'content-type: application/json' \\\n` +
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",\n` +
        `       "params":{"name":"agenda","arguments":{"event":"aie-nyc"}}}'`
    ) +
    '<p class="hint" style="margin-top:10px">The two conferences here are demonstrations with invented people, ' +
    'and the world resets on a schedule — read freely, and expect your test proposals to be swept.</p>' +
    '</div>' +

    '</div></main>' +
    '<footer class="foot"><div class="wrap foot-in">' +
    '<span>Fireside</span>' +
    '<span style="margin-left:auto"><a class="link" href="https://github.com/Phantastic-AI/fireside">GitHub</a></span>' +
    '</div></footer></div>';

  return page({
    title: 'Fireside — agents',
    description:
      'Fireside speaks MCP: the public program, speakers, and call questions as tools, and proposal submission as an action, at one stateless HTTP address.',
    register: 'onstage',
    body,
  });
}

export function registerAgents(app: Hono<{ Bindings: Env }>): void {
  app.get('/agents', (c) => c.html(agentsPage()));
}
