// The sign-in page: three doors, one page. Password for the harness and the
// hurried, a mailed link for everyone else, Google for the one-tap crowd.
import { esc, page, brand, NAME } from '../../lib/html';

export function signInPage(note?: string): string {
  const body =
    '<div class="stage onstage">' +
    `<header class="mast"><div class="wrap mast-in">${brand()}<nav><a href="/">Home</a></nav></div></header>` +
    '<main><div class="wrap" style="max-width:34em">' +
    '<div style="padding:52px 0 8px">' +
    '<h1 class="display" style="font-size:34px">Sign in</h1>' +
    (note ? `<p class="hint" style="margin-top:10px">${esc(note)}</p>` : '') +
    '</div>' +
    '<form class="card card-pad sec" method="post" action="/sign-in" style="display:block">' +
    '<label class="f" for="email"><span class="f-lab">Email</span>' +
    '<input type="email" id="email" name="email" required autocomplete="email" placeholder="you@yourconference.org"></label>' +
    '<label class="f" for="password" style="margin-top:12px"><span class="f-lab">Password</span>' +
    '<input type="password" id="password" name="password" autocomplete="current-password" placeholder="Your password">' +
    '<span class="hint">No password yet? Leave it empty and we will email you a sign-in link instead.</span></label>' +
    '<div class="btnrow" style="margin-top:16px">' +
    '<button class="btn btn-primary" type="submit">Sign in</button>' +
    '<button class="btn" type="submit" formaction="/sign-in/link">Email me a link</button>' +
    '</div>' +
    '</form>' +
    '<div class="sec card card-pad">' +
    '<a class="btn" style="width:100%;justify-content:center" href="/sign-in/google">Continue with Google</a>' +
    '</div>' +
    '<p class="sub sec">New here? <a class="link" href="/sign-up">Create an account</a> — organizers start a conference, speakers find their proposals waiting.</p>' +
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
