import { Hono } from 'hono';
import { cp0GuardProbe } from './cp0-probe';
import { homePage } from './routes/public/home';
import tokensCss from './styles/tokens.css';
import sharedCss from './styles/shared.css';
import onstageCss from './styles/onstage.css';
import backstageCss from './styles/backstage.css';

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

const cssHeaders = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' };
app.get('/a/on.css', (c) => c.body(tokensCss + sharedCss + onstageCss, 200, cssHeaders));
app.get('/a/back.css', (c) => c.body(tokensCss + sharedCss + backstageCss, 200, cssHeaders));

app.get('/', (c) => c.html(homePage()));

// Build-time scaffold ONLY: every product route exists by CP4; this catch-all
// must be replaced by the real 404 ("There's no stage here.") before judging.
app.notFound((c) =>
  c.html(
    homeShellNote(),
    404
  )
);

function homeShellNote(): string {
  return (
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Fireside</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF7F2;color:#221E17;' +
    "font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif\">" +
    '<div style="text-align:center;max-width:26em;padding:20px"><p style="font-size:22px">🔥 This corridor is still being built.</p>' +
    '<p style="font-size:16px;color:#726858">The fire reaches here within the day. <a href="/" style="color:#B14D14">Back to the front door →</a></p></div>'
  );
}

export default app;
