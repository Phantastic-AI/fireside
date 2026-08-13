import { Hono } from 'hono';
import { homePage } from './routes/public/home';
import { listEvents } from './queries/public';
import { FAVICON } from './lib/html';
import { signInPage, signUpPage } from './routes/public/signin';
import { registerCfp } from './routes/public/cfp';
import { registerPortal } from './routes/public/portal';
import { registerAgenda } from './routes/public/agenda';
import { registerSpeakers } from './routes/public/speakers';
import { registerSchedule } from './routes/public/schedule';
import { registerConnect } from './routes/public/connect';
import { registerEventHome } from './routes/public/event';
import { registerEditProposal } from './routes/public/edit';
import { registerIcs } from './routes/public/ics';
import { registerAsk } from './routes/public/ask';
import { registerMcp } from './mcp';
import { registerAgents } from './routes/public/agents';
import { registerFiles } from './routes/files';
import { registerAdminHome } from './routes/admin/home';
import { registerPile } from './routes/admin/pile';
import { registerProposal } from './routes/admin/proposal';
import { registerOutbox } from './routes/admin/outbox';
import { registerAdminAgenda } from './routes/admin/agenda';
import { registerPeople } from './routes/admin/people';
import { registerGreenRoomAdmin } from './routes/admin/greenroom';
import { registerFilesLibrary } from './routes/admin/files';
import { registerSettings } from './routes/admin/settings';
import { registerReviews } from './routes/admin/reviews';
import { registerEmbeds } from './routes/admin/embeds';
import { registerCrm } from './routes/admin/crm';
import { registerParticipants } from './routes/admin/participants';
import {
  signUp,
  signIn,
  sessionCookie,
  clearSessionCookie,
  principalFromCookie,
  makeMagicLink,
  isRealAddress,
  findPersonByEmail,
} from './workflows/account';
import tokensCss from './styles/tokens.css';
import sharedCss from './styles/shared.css';
import onstageCss from './styles/onstage.css';
import backstageCss from './styles/backstage.css';
import marketingCss from './styles/marketing.css';

export type Env = {
  RESEED_ENABLED: string;
  RESEED_KEY: string;
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  FROM_EMAIL: string;
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  EMAIL: SendEmail;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true }));

// The favicon, served as a real file at both the modern path and the one
// browsers and link-unfurlers request by default. Same SVG for each — an SVG
// answered for .ico is accepted everywhere that matters, and it means one
// crisp mark at every tab size with no binary asset to carry.
const faviconHeaders = { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' };
app.get('/favicon.svg', (c) => c.body(FAVICON, 200, faviconHeaders));
app.get('/favicon.ico', (c) => c.body(FAVICON, 200, faviconHeaders));

// The manual reseed door, behind a real secret (RESEED_KEY) — the demo world
// can be rebuilt on purpose, never by a stranger reading a public repo.
app.post('/__cp0/reseed', async (c) => {
  const key = c.req.header('x-reseed');
  if (!c.env.RESEED_KEY || !key || key !== c.env.RESEED_KEY) return c.text('no', 403);
  const { reseed } = await import('./workflows/reseed');
  try {
    return c.json(await reseed(c.env.DB, c.env.FILES));
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

const cssHeaders = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' };
app.get('/a/on.css', (c) => c.body(tokensCss + sharedCss + onstageCss + marketingCss, 200, cssHeaders));
app.get('/a/back.css', (c) => c.body(tokensCss + sharedCss + backstageCss, 200, cssHeaders));

app.get('/', async (c) => {
  const me = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
  // The live section reads the world rather than asserting it: a conference
  // created while the page is up — by an organizer, or by an agent walking the
  // call — is counted and shown, so the page never says "two" when there are
  // three.
  const events = await listEvents(c.env.DB);
  return c.html(homePage(!!me, events));
});
app.get('/sign-in', (c) => c.html(signInPage()));
app.get('/sign-up', (c) => c.html(signUpPage()));

/** Where signing in lands you: your backstage if you hold any standing, your
 *  portal if you are a speaker at exactly one conference, and otherwise the
 *  front door — which knows your name once you are signed in. */
async function afterSignIn(db: D1Database, personId: string): Promise<string> {
  // Standing comes in two shapes: install-wide (person.internal_role, how the
  // seeded organizers hold the whole place) and per-event rows. Either one
  // means the backstage is where signing in should land.
  const role = await db
    .prepare(
      `SELECT 1 FROM person WHERE id = ?1 AND internal_role IS NOT NULL
       UNION ALL
       SELECT 1 FROM event_role WHERE person_id = ?1
       LIMIT 1`
    )
    .bind(personId)
    .first();
  if (role) return '/admin';
  const events = await db
    .prepare(
      `SELECT e.slug FROM participation pa
         JOIN submission s ON s.id = pa.submission_id
         JOIN event e ON e.id = s.event_id
        WHERE pa.person_id = ? AND s.state <> 'draft'
        GROUP BY e.slug LIMIT 2`
    )
    .bind(personId)
    .all<{ slug: string }>();
  const one = events.results.length === 1 ? events.results[0] : null;
  return one ? `/${one.slug}/portal` : '/';
}

async function requestMagicLink(c: { env: Env; req: { url: string } }, email: string): Promise<string> {
  const person = await findPersonByEmail(c.env.DB, email);
  if (!person?.email) return 'If that address is in the system, a sign-in link is on its way.';
  const origin = new URL(c.req.url).origin;
  const link = await makeMagicLink(c.env.SESSION_SECRET, origin, person.id);
  if (isRealAddress(person.email)) {
    await c.env.EMAIL.send({
      to: person.email,
      from: { email: c.env.FROM_EMAIL, name: 'Fireside' },
      subject: 'Your sign-in link',
      text: `Hello ${person.name},\n\nHere is your sign-in link for Fireside:\n\n${link}\n\nIt works for the next two hours. If you did not ask for it, ignore this and nothing happens.`,
    });
    return 'If that address is in the system, a sign-in link is on its way.';
  }
  // The seeded cast has no inbox; their links print here instead.
  return `That address has no inbox we can reach, so the link is here: ${link}`;
}

app.post('/sign-in', async (c) => {
  const form = await c.req.parseBody();
  const email = String(form['email'] ?? '');
  const password = String(form['password'] ?? '');
  if (!email) return c.html(signInPage('An email address is needed.'), 400);
  if (!password) {
    return c.html(signInPage(await requestMagicLink(c, email)));
  }
  const person = await signIn(c.env.DB, email, password);
  if (!person) return c.html(signInPage('That address and password do not match.'), 401);
  c.header('set-cookie', await sessionCookie(c.env.SESSION_SECRET, person.id));
  return c.redirect(await afterSignIn(c.env.DB, person.id));
});

app.post('/sign-in/link', async (c) => {
  const form = await c.req.parseBody();
  const email = String(form['email'] ?? '');
  if (!email) return c.html(signInPage('An email address is needed.'), 400);
  return c.html(signInPage(await requestMagicLink(c, email)));
});

app.get('/sign-in/magic', async (c) => {
  const t = c.req.query('t') ?? '';
  const { verifyToken } = await import('./lib/sign');
  const p = await verifyToken(c.env.SESSION_SECRET, t);
  if (!p || p.purpose !== 'magic') {
    return c.html(signInPage('That link has expired. Ask for a fresh one below.'), 400);
  }
  c.header('set-cookie', await sessionCookie(c.env.SESSION_SECRET, p.subjectId));
  return c.redirect(await afterSignIn(c.env.DB, p.subjectId));
});

app.post('/sign-up', async (c) => {
  const form = await c.req.parseBody();
  const res = await signUp(c.env.DB, {
    name: String(form['name'] ?? ''),
    email: String(form['email'] ?? ''),
    password: String(form['password'] ?? ''),
  });
  if (!res.ok) return c.html(signUpPage(res.error), 400);
  c.header('set-cookie', await sessionCookie(c.env.SESSION_SECRET, res.personId));
  // A brand-new person has nothing yet; the backstage is where their first
  // conference gets made.
  return c.redirect('/admin');
});

app.get('/sign-out', (c) => {
  c.header('set-cookie', clearSessionCookie);
  return c.redirect('/');
});

// ---------- Google ----------

app.get('/sign-in/google', async (c) => {
  const { signToken, randomNonce } = await import('./lib/sign');
  const origin = new URL(c.req.url).origin;
  const state = await signToken(c.env.SESSION_SECRET, {
    purpose: 'oauth_state',
    subjectId: '-',
    nonce: randomNonce(),
    exp: Date.now() + 10 * 60_000,
  });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${origin}/sign-in/google/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  return c.redirect(u.toString());
});

app.get('/sign-in/google/callback', async (c) => {
  const { verifyToken } = await import('./lib/sign');
  const state = await verifyToken(c.env.SESSION_SECRET, c.req.query('state') ?? '');
  const code = c.req.query('code');
  if (!state || state.purpose !== 'oauth_state' || !code) {
    return c.html(signInPage('Google sign-in did not complete. Try again below.'), 400);
  }
  const origin = new URL(c.req.url).origin;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/sign-in/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return c.html(signInPage('Google sign-in did not complete. Try again below.'), 502);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  const idToken = tokens.id_token;
  if (!idToken) return c.html(signInPage('Google sign-in did not complete. Try again below.'), 502);
  const payloadPart = idToken.split('.')[1] ?? '';
  const claims = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))
    )
  ) as { sub: string; email?: string; name?: string };
  const db = c.env.DB;
  let person = await db
    .prepare('SELECT id FROM person WHERE google_sub = ?')
    .bind(claims.sub)
    .first<{ id: string }>();
  if (!person && claims.email) {
    const byEmail = await findPersonByEmail(db, claims.email);
    if (byEmail) {
      await db.prepare('UPDATE person SET google_sub = ? WHERE id = ?').bind(claims.sub, byEmail.id).run();
      person = { id: byEmail.id };
    }
  }
  if (!person) {
    const { newId } = await import('./lib/db');
    const id = newId('per');
    await db
      .prepare(
        'INSERT INTO person (id, email, name, sort_name, google_sub, share_contact, created_at, last_signed_in_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind(id, claims.email ?? null, claims.name ?? 'Someone from Google', claims.name ?? '', claims.sub, '{}', Date.now(), Date.now())
      .run();
    person = { id };
  }
  c.header('set-cookie', await sessionCookie(c.env.SESSION_SECRET, person.id));
  return c.redirect(await afterSignIn(c.env.DB, person.id));
});

// Who am I — the smallest window into the Principal (smoke-testable).
app.get('/api/me', async (c) => {
  const p = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
  return p ? c.json(p) : c.json({ signedIn: false }, 401);
});

// ---------- Backstage ----------
// The CRM lives at /admin/crm and must be registered BEFORE registerAdminHome's
// broad GET /admin/:eventSlug, or "crm" is read as an event slug and the
// database page 404s. Static prefix, so first-registered wins the match.
registerCrm(app);
// All /admin/* prefixes are static and /gr/:nonce is its own street —
// no matcher-order hazards among these nine.
registerAdminHome(app);
registerPile(app);
registerProposal(app);
// Participant correction sits under /admin/:eventSlug/submissions/:id/participants
// — a deeper path than the proposal page, so order with registerProposal is safe.
registerParticipants(app);
registerOutbox(app);
registerAdminAgenda(app);
registerPeople(app);
registerGreenRoomAdmin(app);
registerFilesLibrary(app);
registerSettings(app);
registerReviews(app);
registerEmbeds(app);

// ---------- The event screens ----------
// registerEventHome goes last: its GET /:eventSlug matches broadest, and it
// calls next() for unknown slugs so the 404 below still owns the miss.
// registerIcs sits before registerAgenda so /:event/s/:slug.ics wins the
// match before the session page's bare :slug can swallow the suffix.
registerMcp(app);
registerAgents(app);
registerFiles(app);
registerCfp(app);
registerEditProposal(app);
registerPortal(app);
registerIcs(app);
registerAgenda(app);
registerSpeakers(app);
registerSchedule(app);
registerConnect(app);
registerAsk(app);
registerEventHome(app);

// The product 404 — its real copy, from the prototype, from day one.
app.notFound((c) =>
  c.html(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Fireside</title>' +
      '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF7F2;color:#221E17;' +
      "font-family:ui-sans-serif,-apple-system,sans-serif\">" +
      '<div style="max-width:28em;padding:20px;background:#fff;border:1px solid #E7DFD3;border-radius:10px">' +
      '<h1 style="font-family:Palatino,Georgia,serif;font-weight:600;font-size:26px;margin:0">There&#39;s no stage here.</h1>' +
      '<p style="font-size:15px;margin:10px 0 0">This page submitted a strong proposal. The committee passed.</p>' +
      '<p style="font-size:14px;font-style:italic;color:#726858;margin:8px 0 0">It happens to the best of us.</p>' +
      '<p style="margin:16px 0 0"><a href="/" style="color:#B14D14;font-weight:650;text-decoration:none">See the events that are running →</a></p>' +
      '</div>',
    404
  )
);

export default {
  fetch: app.fetch,
  // Hourly: reseed only once RESEED_ENABLED flips true (R-2 — the cron earns
  // its trigger by being exercised manually first); maintenance rides along.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.RESEED_ENABLED === 'true') {
      const { reseed } = await import('./workflows/reseed');
      ctx.waitUntil(reseed(env.DB, env.FILES));
    }
  },
};
