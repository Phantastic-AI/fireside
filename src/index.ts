import { Hono } from 'hono';
import { cp0GuardProbe } from './cp0-probe';
import { homePage } from './routes/public/home';
import { signInPage, signUpPage } from './routes/public/signin';
import tokensCss from './styles/tokens.css';
import sharedCss from './styles/shared.css';
import onstageCss from './styles/onstage.css';
import backstageCss from './styles/backstage.css';
import marketingCss from './styles/marketing.css';

export type Env = {
  RESEED_ENABLED: string;
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  EMAIL: SendEmail;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true }));

app.get('/__cp0/guard', async (c) => c.json(await cp0GuardProbe(c.env.DB)));

// CP0 manual reseed door — exercised by hand until boring, then the cron
// takes over (RESEED_ENABLED). Removed before judging; the cron remains.
app.post('/__cp0/reseed', async (c) => {
  if (c.req.header('x-reseed') !== 'first-light-cp0') return c.text('no', 403);
  const { reseed } = await import('./workflows/reseed');
  try {
    return c.json(await reseed(c.env.DB));
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

const cssHeaders = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' };
app.get('/a/on.css', (c) => c.body(tokensCss + sharedCss + onstageCss + marketingCss, 200, cssHeaders));
app.get('/a/back.css', (c) => c.body(tokensCss + sharedCss + backstageCss, 200, cssHeaders));

app.get('/', (c) => c.html(homePage()));
app.get('/sign-in', (c) => c.html(signInPage()));
app.get('/sign-up', (c) => c.html(signUpPage()));
// Plainest true sentence until the auth workflow lands (D-027: the product
// never narrates its own construction).
app.post('/sign-in', (c) => c.html(signInPage('Sign-in is not switched on yet.'), 503));
app.post('/sign-in/link', (c) => c.html(signInPage('Sign-in is not switched on yet.'), 503));
app.post('/sign-up', (c) => c.html(signUpPage('Creating accounts is not switched on yet.'), 503));

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

export default app;
