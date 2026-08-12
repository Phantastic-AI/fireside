// The call for speakers, client side. Plain JS, no framework, no build step.
//
// Written as a real function and shipped as its own source text, so the file
// you read is the file that runs. The page inlines it — one fewer request on
// the screen most likely to be opened on one bar of signal.
//
// It does four things and nothing else:
//   1. Tab (or the button on a phone) accepts the example in a placeholder.
//   2. Counts: characters where there is a ceiling, answers where there isn't.
//   3. Keeps the whole form in localStorage, keyed by the event, so a closed
//      laptop and a dead battery cost nothing.
//   4. Evaluates the organizer's show-if conditions as the answers change.

function cfpIsland() {
  var form = document.querySelector('[data-cfp]');
  if (!form) return;
  var KEY = 'fireside.cfp.' + form.getAttribute('data-cfp');
  var saved = form.querySelector('[data-saved]');
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
  // stays hidden with it. A hidden control is also released from being
  // required — the browser must never block a send over something invisible.
  function condition() {
    conds.forEach(function (box) {
      var on = valueOf(box.getAttribute('data-when')) === box.getAttribute('data-is');
      box.hidden = !on;
      [].slice.call(box.querySelectorAll('[data-needed]')).forEach(function (el) {
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
  var writing = 0;
  function store() {
    var bag = {};
    [].slice.call(form.elements).forEach(function (el) {
      if (!el.name || el.type === 'submit') return;
      if (el.type === 'checkbox') bag[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) bag[el.name] = el.value; }
      else bag[el.name] = el.value;
    });
    try { localStorage.setItem(KEY, JSON.stringify(bag)); } catch (e) { return false; }
    return true;
  }
  function keep() {
    clearTimeout(writing);
    writing = setTimeout(function () {
      if (store() && saved) saved.textContent = 'Saved on this device.';
    }, 400);
  }
  function restore() {
    var bag;
    try { bag = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return; }
    var found = false;
    [].slice.call(form.elements).forEach(function (el) {
      if (!el.name || !(el.name in bag)) return;
      var was = bag[el.name];
      if (el.type === 'checkbox') { if (!el.checked && was === true) { el.checked = true; found = true; } }
      else if (el.type === 'radio') { if (!el.checked && el.value === was) { el.checked = true; found = true; } }
      else if (!el.value && typeof was === 'string' && was) { el.value = was; found = true; }
    });
    if (found && saved) saved.textContent = 'Picked up where you left off on this device.';
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
    if (store() && saved) saved.textContent = 'Saved on this device. Close the page and come back to it.';
  });
  form.addEventListener('submit', function () {
    try { localStorage.removeItem(KEY); } catch (e) { /* a private window; nothing to clear */ }
  });

  restore();
  condition();
  tally();
  characters();
  tint();
}

export default '(' + cfpIsland.toString() + ')();';
