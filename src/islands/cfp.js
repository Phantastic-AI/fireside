// The call for speakers, client side. Plain JS, no framework, no build step.
//
// Written as a real function and shipped as its own source text, so the file
// you read is the file that runs. The page inlines it — one fewer request on
// the screen most likely to be opened on one bar of signal.
//
// It does five things and nothing else:
//   1. Tab (or the button on a phone) accepts the example in a placeholder.
//   2. Counts: characters where there is a ceiling, answers where there isn't.
//   3. Keeps the whole form in localStorage, keyed by the event, so a closed
//      laptop and a dead battery cost nothing.
//   4. Evaluates the organizer's show-if conditions as the answers change.
//   5. Says, in words, what it kept and what it brought back.
//
// It fails open. The server draws every conditional question in the open with
// its condition written underneath, and never marks one required unless the
// controlling answer already matches; this file narrows that down to the one
// question being asked right now. A browser that never runs a line of it still
// gets a whole, sendable form.

function cfpIsland() {
  var form = document.querySelector('[data-cfp]');
  if (!form) return;
  var KEY = 'fireside.cfp.' + form.getAttribute('data-cfp');
  var saved = form.querySelector('[data-saved]');
  var resume = form.querySelector('[data-resume]');
  var discard = form.querySelector('[data-discard]');
  var tallyOut = form.querySelector('[data-answered]');
  var conds = [].slice.call(form.querySelectorAll('[data-when]'));
  var counted = [].slice.call(form.querySelectorAll('[data-count]'));

  function hidden(el) {
    var box = el.closest('[data-when]');
    return !!box && box.hidden;
  }

  function valueOf(qid) {
    var els = [].slice.call(form.querySelectorAll('[data-qid="' + qid + '"]'));
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (hidden(el)) continue;
      if (el.type === 'checkbox') { if (el.checked) return 'true'; continue; }
      if (el.type === 'radio') { if (el.checked) return el.value; continue; }
      return el.value || '';
    }
    return els.length && els[0].type === 'checkbox' ? 'false' : '';
  }

  // Walked in document order, so a question hanging off a hidden question
  // stays hidden with it. A question out of sight is released from being
  // required and switched off outright: the browser must never block a send
  // over something invisible, and an invisible answer must never be posted.
  function condition() {
    conds.forEach(function (box) {
      var on = valueOf(box.getAttribute('data-when')) === box.getAttribute('data-is');
      box.hidden = !on;
      [].slice.call(box.querySelectorAll('input,select,textarea')).forEach(function (el) {
        el.disabled = !on;
        if (!el.hasAttribute('data-needed')) return;
        if (on) el.setAttribute('required', 'required');
        else el.removeAttribute('required');
      });
    });
  }

  function tally() {
    if (!tallyOut) return;
    var done = 0;
    var total = 0;
    var seen = {};
    counted.forEach(function (el) {
      if (hidden(el)) return;
      if (el.type === 'checkbox') return; // an unticked box is answered, not blank
      if (el.type === 'radio') {
        if (seen[el.name]) return;
        seen[el.name] = 1;
        total++;
        if (form.querySelector('input[name="' + el.name + '"]:checked')) done++;
        return;
      }
      total++;
      if ((el.value || '').trim()) done++;
    });
    tallyOut.textContent = done + ' of ' + total + ' answered';
  }

  function characters() {
    [].slice.call(form.querySelectorAll('[data-limit]')).forEach(function (el) {
      var out = form.querySelector('[data-count-for="' + el.id + '"]');
      if (!out) return;
      var max = Number(el.getAttribute('data-limit'));
      out.textContent = (el.value || '').length.toLocaleString('en-US') +
        ' / ' + max.toLocaleString('en-US');
    });
  }

  // ---- the draft that survives a dead battery ----------------------------
  //
  // Every named control, including the conditional questions that are out of
  // sight and switched off, so a form that comes back comes back whole.
  var writing = 0;

  // What the server drew, taken before anything is put back over it. This is
  // what "start with a blank form" restores, so discarding a draft is instant
  // and costs no round trip.
  var originals = [].slice.call(form.elements).map(function (el) {
    return { el: el, value: el.value, checked: el.checked };
  });

  function bagOf() {
    var bag = {};
    [].slice.call(form.elements).forEach(function (el) {
      if (!el.name || el.type === 'submit' || el.type === 'button') return;
      if (el.type === 'checkbox') bag[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) bag[el.name] = el.value; }
      else bag[el.name] = el.value;
    });
    return bag;
  }

  function anythingIn(bag) {
    for (var k in bag) {
      if (bag[k] === true) return true;
      if (typeof bag[k] === 'string' && bag[k] !== '') return true;
    }
    return false;
  }

  function store() {
    try { localStorage.setItem(KEY, JSON.stringify(bagOf())); } catch (e) { return false; }
    return true;
  }

  function forget() {
    try { localStorage.removeItem(KEY); } catch (e) { /* a private window; nothing to clear */ }
  }

  function keep() {
    clearTimeout(writing);
    writing = setTimeout(function () {
      if (store() && saved) saved.textContent = 'Saved on this device.';
    }, 400);
  }

  // Stored words win over drawn ones: the draft is written on every keystroke,
  // so it is never older than what the server put in the box.
  function restore() {
    var bag;
    try { bag = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return false; }
    if (!bag || typeof bag !== 'object') return false;
    var found = false;
    [].slice.call(form.elements).forEach(function (el) {
      if (!el.name || !Object.prototype.hasOwnProperty.call(bag, el.name)) return;
      var was = bag[el.name];
      if (el.type === 'checkbox') {
        if (typeof was === 'boolean' && el.checked !== was) { el.checked = was; found = true; }
      } else if (el.type === 'radio') {
        if (!el.checked && el.value === was) { el.checked = true; found = true; }
      } else if (typeof was === 'string' && was !== '' && el.value !== was) {
        el.value = was;
        found = true;
      }
    });
    return found;
  }

  function startAgain() {
    clearTimeout(writing); // a keystroke still in flight must not write it back
    forget();
    originals.forEach(function (o) {
      if (o.el.type === 'checkbox' || o.el.type === 'radio') o.el.checked = o.checked;
      else o.el.value = o.value;
    });
    if (resume) resume.hidden = true;
    if (saved) saved.textContent = '';
    condition();
    tally();
    characters();
    tint();
  }

  // ---- the example, accepted -------------------------------------------
  function accept(el) {
    if (!el || el.value || !el.placeholder) return;
    el.value = el.placeholder;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  [].slice.call(form.querySelectorAll('[data-ghost]')).forEach(function (el) {
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || e.shiftKey || el.value || !el.placeholder) return;
      e.preventDefault();
      accept(el);
    });
  });
  [].slice.call(form.querySelectorAll('[data-eg]')).forEach(function (button) {
    button.addEventListener('click', function () {
      var box = button.closest('.fw');
      accept(box && box.querySelector('[data-ghost]'));
      var eg = button.closest('.eg');
      if (eg) eg.style.display = 'none';
    });
  });

  // The chosen row carries the track's own colour, so the choice is visible
  // without reading it.
  function tint() {
    [].slice.call(form.querySelectorAll('[data-radio]')).forEach(function (l) {
      var input = l.querySelector('input');
      l.classList.toggle('on', !!input && input.checked);
    });
  }

  form.addEventListener('input', function () { condition(); tally(); characters(); keep(); });
  form.addEventListener('change', function () { condition(); tally(); tint(); keep(); });
  var later = form.querySelector('[data-save]');
  if (later) later.addEventListener('click', function () {
    if (store() && saved) {
      saved.textContent = 'Saved on this device. Close the page and come back to it — ' +
        'your words will be here.';
    }
  });
  if (discard) discard.addEventListener('click', startAgain);
  // A send that lands leaves for the thanks screen and the draft goes with it.
  form.addEventListener('submit', forget);

  var came = restore();
  if (came && resume) resume.hidden = false;
  condition();
  tally();
  characters();
  tint();
  // A refused send comes back to this same form with every word still in it,
  // and with nothing behind it — the send above cleared that. Write it again
  // straight away, so walking away from a refusal loses nothing either.
  if (!came && form.hasAttribute('data-refused') && anythingIn(bagOf())) store();
}

// The bundler's keepNames pass wraps every function it carries in
// `__name(fn, 'name')`, and that helper lives in the bundle's module scope —
// it does not travel inside the source text this exports. So the page defines
// its own before running it. Without this line the whole island dies on its
// first statement, taking the conditions, the counts and the draft with it.
export default
  '(function(){var __name=function(f){return f};(' + cfpIsland.toString() + ')();})();';
