// The concierge, in the corner. The same answers the Ask screen gives, on
// whatever page you are already standing on — so a question does not cost you
// the thing you were reading.
//
// It is a bubble, not a second engine. Every sentence it shows was built and
// escaped by the server: the chips come from GET /:event/ask?panel=1, the
// answers from POST /:event/ask with the same `x-ask: in-place` header the Ask
// screen's own island sends. Nothing here decides what a reader may see.
//
// The one thing that did not come from the server is what somebody typed, and
// that is set with textContent, never as markup.
//
// It is progressive enhancement with nothing to fall back to, and that is the
// point: with scripts off there is no bubble at all, and the concierge is
// still a whole page at /:event/ask, reachable from the nav on every screen
// the bubble appears on. Nothing is only in here.
//
// The conversation lives in sessionStorage, keyed by the event, so walking
// from the agenda to a speaker's page keeps what you were told — and closing
// the tab ends it, because a question asked on a shared laptop in a hallway
// should not be waiting there tomorrow. The same hallway is why the thread is
// also keyed to a person: the panel fragment carries an identity mark, and a
// kept thread is only ever painted for the person it was kept for. Signing
// out, or in as somebody else, drops it instead of replaying it.

function conciergeIsland() {
  var box = document.getElementById('concierge');
  if (!box || !window.fetch) return;
  var slug = box.getAttribute('data-concierge');
  if (!slug) return;

  var ask = '/' + encodeURIComponent(slug) + '/ask';
  // What this page is about, when it is about one thing (a talk reads
  // 's:<slug>'). Sent with every question so the concierge can answer about
  // the thing in front of the reader, not the whole program.
  var here = box.getAttribute('data-cc-here') || '';
  var THREAD = 'fireside.cc.thread.' + slug;
  var OPEN = 'fireside.cc.open.' + slug;
  var WHO = 'fireside.cc.who.' + slug;

  var open = false;
  var busy = false;
  var kept = '';     // the conversation so far, as the server's own markup
  var who = '';      // the identity mark the thread was kept under
  var thread = null; // the scrolling middle of the panel, while it is up
  var greeted = false; // the painted thread holds a real conversation, not dots

  // The brand's flame, the same path the masthead draws (lib/html.ts FLAME).
  var FLAME =
    '<svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">' +
    '<path d="M16 3c1.6 4.2-1.4 6-1.4 8.6 0 1.6 1.2 2.6 2.4 2.6 1.5 0 2.3-1.1 2.2-2.6 2.2 1.9 ' +
    '3.3 4.2 3.3 6.6 0 3.9-3 6.8-6.5 6.8S9.5 22.1 9.5 18.2C9.5 12.3 14.6 9.6 16 3z" fill="#B14D14"/></svg>';

  var FAB =
    '<button class="cc-fab" data-cc-open aria-label="Ask the concierge" aria-expanded="false">' +
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.4 8.4 0 01-9 8.4 9.6 9.6 0 01-2.9-.4L4 21l1.4-3.9A8.3 8.3 0 013 11.5 ' +
    '8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z"/>' +
    '<path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/></svg></button>';

  function panelHtml() {
    return (
      '<div class="cc-panel" role="dialog" aria-modal="true" aria-label="The concierge">' +
      '<div class="cc-head">' + FLAME +
      '<div><div class="t">The concierge</div>' +
      '<div class="s">Ask about the program</div></div>' +
      '<button class="cc-x" data-cc-close aria-label="Close">×</button></div>' +
      '<div class="cc-body" data-cc-thread></div>' +
      '<div class="cc-foot">' +
      '<div class="cc-ask">' +
      '<input type="text" id="cc-q" name="cc-q" data-cc-in autocomplete="off" ' +
      'placeholder="Ask about the program" aria-label="Ask about the program">' +
      '<button type="button" data-cc-send>Ask</button></div>' +
      '<p class="cc-hand">Your agent can work this program too: ' +
      '<span class="code">' + location.origin + '/mcp</span> speaks MCP — ' +
      'connect strings and instructions at <a class="link" href="/agents">/agents</a>.</p>' +
      '</div></div>'
    );
  }

  // ---- what is kept, and where ------------------------------------------
  function recall() {
    try {
      kept = sessionStorage.getItem(THREAD) || '';
      who = sessionStorage.getItem(WHO) || '';
      open = sessionStorage.getItem(OPEN) === '1';
    } catch (e) { /* a private window: the conversation lasts this page only */ }
  }

  // A conversation is written down without its typing dots: a thread kept
  // mid-question comes back showing what was asked, not dots for an answer
  // that is never going to arrive. A thread that has not been greeted yet is
  // not captured at all — a freshly painted, still-empty panel must never
  // overwrite the conversation it is about to restore.
  function keep() {
    if (thread && greeted) {
      var settled = thread.cloneNode(true);
      var w = settled.querySelector('[data-cc-wait]');
      if (w) w.remove();
      kept = settled.innerHTML;
    }
    try {
      sessionStorage.setItem(THREAD, kept);
      sessionStorage.setItem(WHO, who);
      sessionStorage.setItem(OPEN, open ? '1' : '0');
    } catch (e) { /* nowhere to keep it; the panel still works */ }
  }

  /** The identity mark the server stamped on a panel fragment. */
  function markerOf(html) {
    var m = /data-cc-who="([^"]*)"/.exec(html);
    return m ? m[1] : '';
  }

  // ---- pieces the panel grows -------------------------------------------
  function waiting() {
    var el = document.createElement('div');
    el.className = 'cc-fs';
    el.setAttribute('data-cc-wait', '');
    el.innerHTML = '<span class="cc-typing"><i></i><i></i><i></i></span>';
    return el;
  }

  // The one honest thing to say when the reply never lands, with the way to
  // the screen that works without any of this.
  function trouble() {
    var el = document.createElement('div');
    el.className = 'cc-fs';
    var p = document.createElement('p');
    p.textContent = 'I could not reach the program just now. Ask again, or ';
    var a = document.createElement('a');
    a.className = 'link';
    a.href = ask;
    a.textContent = 'open the concierge on its own page';
    p.appendChild(a);
    p.appendChild(document.createTextNode('.'));
    el.appendChild(p);
    return el;
  }

  function land() {
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  // ---- painting ----------------------------------------------------------
  function paint(focus) {
    document.body.classList.toggle('cc-open', open);
    if (!open) {
      box.innerHTML = FAB;
      // Focus goes back to the button that stands where the panel stood, so
      // closing with the keyboard does not drop the reader at the top of the
      // page.
      if (focus) {
        var fb = box.querySelector('.cc-fab');
        if (fb) fb.focus();
      }
      return;
    }
    box.innerHTML = panelHtml();
    thread = box.querySelector('[data-cc-thread]');
    greeted = false;
    greet();
    if (focus) {
      var el = box.querySelector('[data-cc-in]');
      if (el) el.focus();
    }
  }

  function show(next, focus) {
    if (next === open) return;
    if (!next) keep();          // capture the thread while the panel still holds it
    open = next;
    paint(focus);
    keep();
  }

  // Every paint starts by asking the server who is here as well as what to
  // open with: the fragment carries the identity mark. When the mark matches,
  // the kept thread comes back; when it differs — a sign-out, or somebody else
  // signing in on the same tab — the kept thread is dropped, never replayed.
  // When the fetch fails, the kept thread stays unpainted rather than shown
  // unverified, and the way to the full page remains.
  function greet() {
    var wait = waiting();
    thread.appendChild(wait);
    fetch(ask + '?panel=1' + (here ? '&here=' + encodeURIComponent(here) : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var now = markerOf(html);
        if (now !== who) { kept = ''; who = now; }
        wait.remove();
        if (kept) thread.innerHTML = kept;
        else thread.insertAdjacentHTML('beforeend', html);
        greeted = true;
        keep();
        land();
      })
      .catch(function () {
        wait.remove();
        thread.appendChild(trouble());
        land();
      });
  }

  function send(payload, shown) {
    if (busy || !thread) return;
    busy = true;
    var you = document.createElement('div');
    you.className = 'cc-you';
    you.textContent = shown;    // what somebody typed is text, never markup
    thread.appendChild(you);
    var wait = waiting();
    thread.appendChild(wait);
    land();
    fetch(ask, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-ask': 'in-place'
      },
      body: here ? payload + '&here=' + encodeURIComponent(here) : payload
    })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        wait.remove();
        thread.insertAdjacentHTML('beforeend', html);
      })
      .catch(function () {
        wait.remove();
        thread.appendChild(trouble());
      })
      .then(function () {
        busy = false;
        keep();
        land();
      });
  }

  function typed() {
    var el = box.querySelector('[data-cc-in]');
    if (!el) return;
    var q = (el.value || '').trim();
    if (!q) return;
    el.value = '';
    send('q=' + encodeURIComponent(q), q);
  }

  // ---- one delegated listener, installed once ----------------------------
  box.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-cc-open]')) { show(true, true); return; }
    if (t.closest('[data-cc-close]')) { show(false, true); return; }
    // Following a link anywhere in the panel ends the exchange: the panel is
    // recorded closed so it is not standing in front of the page it just
    // chose — which on a phone is the whole screen. The browser does the
    // walking; the repaint waits a beat so a navigation that never happens
    // leaves the button, not a ghost.
    var walk = t.closest('a[href]');
    if (walk && box.contains(walk) &&
        !e.metaKey && !e.ctrlKey && !e.shiftKey && walk.target !== '_blank') {
      open = false;
      keep();
      document.body.classList.remove('cc-open');
      setTimeout(function () { if (!open) paint(false); }, 0);
      return;
    }
    // The chips are the Ask screen's own, rendered by the same builder: `i` is
    // a question the program answers on the spot, `q` is one for the model.
    var chip = t.closest('button[name="i"],button[name="q"]');
    if (chip && chip.value) {
      e.preventDefault();
      send(
        chip.getAttribute('name') + '=' + encodeURIComponent(chip.value),
        (chip.textContent || '').trim() || chip.value
      );
      return;
    }
    // The Confirm button on a staged act: commit exactly that pending row in
    // place. Scripts off, its own form posts and the page comes back instead.
    var confirm = t.closest('button[name="commit"]');
    if (confirm && confirm.value) {
      e.preventDefault();
      send('commit=' + encodeURIComponent(confirm.value), 'Yes, do it');
      return;
    }
    if (t.closest('[data-cc-send]')) typed();
  });

  box.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-cc-in')) return;
    e.preventDefault();
    typed();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) show(false, true);
  });

  recall();
  paint(false);
}

// The bundler's keepNames pass wraps every function it carries in
// `__name(fn, 'name')`, and that helper lives in the bundle's module scope —
// it does not travel inside the source text this exports. So the page defines
// its own before running it. Without this line the whole island dies on its
// first statement, and the corner stays empty.
export default
  '(function(){var __name=function(f){return f};(' + conciergeIsland.toString() + ')();})();';
