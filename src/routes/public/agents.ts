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
// is the load-bearing one: with no header, a caller here sees what a
// signed-out browser sees.
//
// Signed in, this page mints the one thing it never stores: a bearer for
// POST /mcp, good for fourteen days, reading and writing as whoever asked for
// it. Minting happens on every visit rather than once and remembered — the
// page holds no state of its own, and a fresh paste is cheaper than a lost
// one. The response carries private, no-store the moment a name is on it.
import { page, brand } from '../../lib/html';
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { makeAgentToken, principalFromCookie, type Principal } from '../../workflows/account';

const ORIGIN = 'https://onfireside.com';

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

/**
 * The card at the top of the page once somebody is signed in: their own
 * paste-ready connect strings, and the one caution that matters. The token
 * itself is minted by the route below, once per visit — this only lays it
 * out.
 */
function connectedCard(principal: Principal, token: string): string {
  const bearer = `Authorization: Bearer ${token}`;
  return (
    '<div class="sec card card-pad" style="border-color:var(--accent,#B14D14)">' +
    `<h2 style="font-size:19px;margin:0 0 6px">Connected as ${principal.name}</h2>` +
    '<p>These read and write as you, everywhere your own sign-in reaches — the same standing, ' +
    'carried by the header instead of a cookie.</p>' +
    '<p style="margin-top:14px"><b>Claude Code</b></p>' +
    code(`claude mcp add --transport http fireside ${ORIGIN}/mcp --header "${bearer}"`) +
    '<p style="margin-top:14px"><b>Anything that reads an <span class="mono">mcpServers</span> block</b></p>' +
    code(
      '{\n' +
        '  "mcpServers": {\n' +
        '    "fireside": {\n' +
        `      "url": "${ORIGIN}/mcp",\n` +
        `      "headers": { "Authorization": "Bearer ${token}" }\n` +
        '    }\n' +
        '  }\n' +
        '}'
    ) +
    '<p class="hint" style="margin-top:14px">This one acts as you. Treat it the way you would a ' +
    'password — whoever holds it holds your own standing. It cannot be cancelled early: it stops ' +
    'working on its own after fourteen days, and signing out does not end it, so share it with an ' +
    'agent you run and nobody else.</p>' +
    '</div>'
  );
}

export function agentsPage(opts: { principal: Principal | null; token: string | null }): string {
  const connected =
    opts.principal && opts.token ? connectedCard(opts.principal, opts.token) : '';
  const body =
    '<div class="stage onstage">' +
    `<header class="mast"><div class="wrap mast-in">${brand()}<nav><a href="/">Home</a><a href="https://github.com/Phantastic-AI/fireside">GitHub</a></nav></div></header>` +
    '<main><div class="wrap" style="max-width:44em">' +
    '<div style="padding:52px 0 8px">' +
    '<h1 class="display" style="font-size:34px">Agents</h1>' +
    '<p class="hint" style="margin-top:10px">Everything the public side of Fireside shows a person, ' +
    'a machine can read at one address — and it can send a proposal through the same guards the form uses.</p>' +
    '</div>' +

    connected +

    '<div class="sec card card-pad">' +
    '<h2 style="font-size:19px;margin:0 0 6px">The address</h2>' +
    `<p>Fireside speaks the Model Context Protocol over plain HTTP: stateless JSON-RPC 2.0 at <span class="mono">POST ${ORIGIN}/mcp</span>, protocol <span class="mono">2025-06-18</span>. ` +
    'No key, no token, no session header is required for any of this — every call stands alone, and a ' +
    'caller carrying none of those is the public: it sees exactly what a signed-out browser sees, and ' +
    'portals, piles, and letters stay behind their sign-in. Somebody with standing here can sign in and ' +
    'mint a second, signed connection on this page — it reads and writes as them, and nothing wider.</p>' +
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
    'Read freely. The demonstration conferences rebuild on a schedule, so test proposals sent to ' +
    'them are swept; anything you create under your own sign-in stays.</p>' +
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
  app.get('/agents', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.html(agentsPage({ principal: null, token: null }));
    // Minted fresh on every visit rather than stored: this page holds no
    // state of its own, and the reader's own standing is what makes the
    // token good, not a row remembering it was ever issued.
    const token = await makeAgentToken(c.env.SESSION_SECRET, principal.personId);
    c.header('cache-control', 'private, no-store');
    return c.html(agentsPage({ principal, token }));
  });
}
