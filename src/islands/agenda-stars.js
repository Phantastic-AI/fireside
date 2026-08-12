// agenda-stars.js — the hollow star on the public agenda (EMB-10/11).
//
// The signed-out half of one promise my schedule already makes: "star the
// talks you want to see and they line up here, in the order you will walk to
// them." This is the other end of that sentence, and it keeps the list under
// exactly the key src/islands/stars.js reads back:
//
//     localStorage['fireside.stars.' + <event slug>] = ["sub_…", "sub_…"]
//
// The slug arrives on the page as data-stars, so this file never guesses it.
//
// Every star is rendered by the server as a plain link to /{event}/my-schedule.
// With scripts off that link is the honest answer — the page it goes to says
// what starring is and how it works. With scripts on, this takes the click
// instead, keeps the id here, and fills the star in place. Nothing is sent
// anywhere, nothing needs an account, and the same click takes it off again.
//
// Written as a real function and shipped as its own source text (the cfp.js
// convention), so the file you read is the file that runs, inlined by
// ../routes/public/agenda.ts — one fewer request on the screen most likely to
// be opened on one bar of venue wifi.

function agendaStarsIsland() {
  var root = document.querySelector('[data-stars]');
  if (!root) return;
  var KEY = 'fireside.stars.' + root.getAttribute('data-stars');

  function read() {
    try {
      var a = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
    } catch (e) {
      return [];
    }
  }
  function write(a) {
    try {
      localStorage.setItem(KEY, JSON.stringify(a));
    } catch (e) {
      /* a private window: the star still paints for this visit */
    }
  }

  var buttons = [].slice.call(root.querySelectorAll('[data-star]'));
  if (!buttons.length) return;
  var counter = root.querySelector('[data-starcount]');

  function paint(el, on) {
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', on ? 'Take this off my schedule' : 'Star this session');
    var svg = el.querySelector('svg');
    if (svg) svg.setAttribute('fill', on ? 'currentColor' : 'none');
  }

  function tally() {
    if (!counter) return;
    var n = read().length;
    counter.textContent = !n
      ? 'Nothing starred yet.'
      : n === 1
        ? '1 session starred'
        : n + ' sessions starred';
  }

  function toggle(el) {
    var id = el.getAttribute('data-star');
    var a = read();
    var i = a.indexOf(id);
    if (i < 0) a.push(id);
    else a.splice(i, 1);
    write(a);
    paint(el, i < 0);
    tally();
  }

  buttons.forEach(function (el) {
    var on = read().indexOf(el.getAttribute('data-star')) >= 0;
    // Only now does it become a button: with no script it was a link, and a
    // link is what it should have been announced as.
    el.setAttribute('role', 'button');
    paint(el, on);
    el.addEventListener('click', function (e) {
      e.preventDefault();
      toggle(el);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      toggle(el);
    });
  });

  tally();
}

// The shim, and why it is not optional: this module is bundled into the Worker
// with esbuild's keep-names on, which annotates every nested function with a
// __name(fn, "…") call. That helper is defined once at the top of the Worker
// bundle — a place the browser never sees. Ship the text without it and the
// first nested function throws ReferenceError before a single star is wired,
// which is exactly what happens to islands/cfp.js today (flagged in the
// report). One line, entirely inside our own scope, and the source stays the
// source.
export default '(function(){var __name=function(f){return f};(' + agendaStarsIsland.toString() + ')();})();';
