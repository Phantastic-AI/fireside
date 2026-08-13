// The sign-in page: three doors, one page. Password for the harness and the
// hurried, a mailed link for everyone else, Google for the one-tap crowd.
import { esc, page, brand, NAME } from '../../lib/html';

/** Notes sometimes carry a sign-in link for the demonstration people. A link
 *  a person (or their agent) cannot click is a wall, so URLs render as
 *  anchors — everything else stays escaped text. */
function noteHtml(note: string): string {
  const m = note.match(/https:\/\/[^\s]+/);
  if (!m) return esc(note);
  const url = m[0];
  const i = note.indexOf(url);
  return (
    esc(note.slice(0, i)) +
    `<a class="link" href="${esc(url)}" style="word-break:break-all">${esc(url)}</a>` +
    esc(note.slice(i + url.length))
  );
}

export function signInPage(note?: string): string {
  const body =
    '<div class="stage onstage">' +
    `<header class="mast"><div class="wrap mast-in">${brand()}<nav><a href="/">Home</a></nav></div></header>` +
    '<main><div class="wrap" style="max-width:34em">' +
    '<div style="padding:52px 0 8px">' +
    '<h1 class="display" style="font-size:34px">Sign in</h1>' +
    (note ? `<p class="hint" style="margin-top:10px">${noteHtml(note)}</p>` : '') +
    '</div>' +
    '<form class="card card-pad sec" method="post" action="/sign-in" style="display:block">' +
    '<label class="f" for="email"><span class="f-lab">Email</span>' +
    '<input type="email" id="email" name="email" required autocomplete="email" placeholder="you@yourconference.org"></label>' +
    '<label class="f" for="password" style="margin-top:12px"><span class="f-lab">Password</span>' +
    '<input type="password" id="password" name="password" autocomplete="current-password" placeholder="Your password"></label>' +
    // One clear primary action; the mailed-link path is a quiet alternative
    // beneath it, not a second button competing for the same press.
    '<div class="btnrow" style="margin-top:16px">' +
    '<button class="btn btn-primary" type="submit">Sign in</button>' +
    '</div>' +
    '<p class="hint" style="margin-top:12px">No password? ' +
    '<button type="submit" formaction="/sign-in/link" ' +
    'style="background:none;border:0;padding:0;font:inherit;color:var(--ember);' +
    'font-weight:560;cursor:pointer;text-decoration:underline;text-underline-offset:2px">' +
    'Email me a sign-in link instead</button>.</p>' +
    '</form>' +
    '<div class="sec card card-pad">' +
    '<a class="btn" style="width:100%;justify-content:center" href="/sign-in/google">Continue with Google</a>' +
    '</div>' +
    '<p class="sub sec">New here? <a class="link" href="/sign-up">Create an account</a> — organizers start a conference, speakers find their proposals waiting.</p>' +
    '<div class="card card-pad" style="margin-top:8px"><p class="sub" style="margin:0">Looking around first? ' +
    'Both conferences here belong to <b>naomi@example.org</b>, password ' +
    '<b>read-them-before-they-go</b> — sign in as her and the whole backstage is yours to walk. ' +
    'Speakers and reviewers get a mailed link; for @example.org addresses it prints right here.</p></div>' +
    '</div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span><span>An open-source call for speakers.</span></div></footer></div>`;

  return page({ title: 'Sign in · Fireside', register: 'onstage', body });
}

export function signUpPage(note?: string): string {
  const body =
    '<div class="stage onstage">' +
    `<header class="mast"><div class="wrap mast-in">${brand()}<nav><a href="/">Home</a><a href="/sign-in">Sign in</a></nav></div></header>` +
    '<main><div class="wrap" style="max-width:34em">' +
    '<div style="padding:52px 0 8px">' +
    '<h1 class="display" style="font-size:34px">Create your account</h1>' +
    '<p class="lede" style="margin-top:10px;font-size:17px">One account does it all: start a conference of your own, or pick up the proposals already waiting on your email.</p>' +
    (note ? `<p class="hint" style="margin-top:10px">${esc(note)}</p>` : '') +
    '</div>' +
    '<form class="card card-pad sec" method="post" action="/sign-up" style="display:block">' +
    '<label class="f" for="name"><span class="f-lab">Your name</span>' +
    '<input type="text" id="name" name="name" required autocomplete="name" placeholder="As it should appear on a program"></label>' +
    '<label class="f" for="email" style="margin-top:12px"><span class="f-lab">Email</span>' +
    '<input type="email" id="email" name="email" required autocomplete="email" placeholder="you@yourconference.org"></label>' +
    '<label class="f" for="password" style="margin-top:12px"><span class="f-lab">Password</span>' +
    '<input type="password" id="password" name="password" required minlength="8" autocomplete="new-password" placeholder="At least eight characters"></label>' +
    '<div class="btnrow" style="margin-top:16px"><button class="btn btn-primary" type="submit">Create account</button></div>' +
    '</form>' +
    '</div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span><span>An open-source call for speakers.</span></div></footer></div>`;

  return page({ title: 'Create your account · Fireside', register: 'onstage', body });
}
