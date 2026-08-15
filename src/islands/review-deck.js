// review-deck.js — the reviewer's queue as a deck of cards.
//
// The server renders the round's queue as a column of scorecard forms, each
// one a proposal, each posting to /reviews/stage (staging is already
// save-as-you-go — "yours until you submit"). With scripts off that column is
// the honest whole: scroll it, score, press Save on each. This takes over when
// scripts are on and turns it into what a reviewer actually wants: one card at
// a time, a way forward and back, a count of where they are, and a score that
// saves itself as they go so they never fear losing it on the way to the next.
//
// The full column stays one press away ("Show all") — the alternate view, never
// the default. Nothing here changes what is stored; it only changes how many
// cards you look at once. Written as its own source text (the cfp.js
// convention) and inlined by ../routes/admin/reviews.ts.
function reviewDeckIsland() {
  var forms = Array.prototype.slice.call(
    document.querySelectorAll('form[action$="/reviews/stage"]')
  );
  // A deck of one is just the page; leave it be.
  if (forms.length < 2) return;

  var idx = 0;
  var showingAll = false;

  function marked(f) {
    var got = false;
    // A scale renders a default-checked "No mark yet" radio with an empty
    // value, so a real mark is a checked radio that actually carries one.
    f.querySelectorAll('input[type=radio]').forEach(function (r) {
      if (r.checked && r.value) got = true;
    });
    f.querySelectorAll('select').forEach(function (s) {
      if (s.value) got = true;
    });
    f.querySelectorAll('textarea[name^="score"]').forEach(function (t) {
      if (t.value.trim()) got = true;
    });
    return got;
  }

  function scored() {
    var n = 0;
    forms.forEach(function (f) {
      if (marked(f)) n += 1;
    });
    return n;
  }

  // The sticky toolbar: progress, the way forward and back, and the toggle to
  // the full column.
  var bar = document.createElement('div');
  bar.setAttribute(
    'style',
    'position:sticky;top:0;z-index:6;display:flex;gap:10px;align-items:center;' +
      'flex-wrap:wrap;padding:12px 0;margin-bottom:4px;background:var(--paper,#fff);' +
      'border-bottom:1px solid var(--line-soft,#e5e5e5)'
  );

  function btn(labelHtml) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.innerHTML = labelHtml;
    return b;
  }
  var prev = btn('&larr; Back');
  var next = btn('Next &rarr;');
  var count = document.createElement('span');
  count.className = 'sub';
  count.setAttribute('style', 'font-variant-numeric:tabular-nums');
  var toggle = btn('Show all');
  toggle.style.marginLeft = 'auto';

  bar.appendChild(prev);
  bar.appendChild(count);
  bar.appendChild(next);
  bar.appendChild(toggle);
  forms[0].parentNode.insertBefore(bar, forms[0]);

  // A small saved-state line inside each card, next to its Save button.
  var savedEls = {};
  forms.forEach(function (f) {
    var s = document.createElement('span');
    s.className = 'sub';
    s.setAttribute('style', 'margin-left:6px;font-variant-numeric:tabular-nums');
    var row = f.querySelector('.btnrow');
    if (row) row.appendChild(s);
    savedEls[f.id] = s;
  });
  function setSaved(f, text) {
    var s = savedEls[f.id];
    if (s) s.textContent = text;
  }

  function render() {
    forms.forEach(function (f, i) {
      f.style.display = showingAll || i === idx ? '' : 'none';
    });
    if (showingAll) {
      count.textContent = 'All ' + forms.length + ' proposals · ' + scored() + ' scored';
      prev.style.display = 'none';
      next.style.display = 'none';
      toggle.innerHTML = 'Back to the deck';
    } else {
      count.textContent =
        'Proposal ' + (idx + 1) + ' of ' + forms.length + ' · ' + scored() + ' scored';
      prev.style.display = '';
      next.style.display = '';
      prev.disabled = idx === 0;
      next.disabled = idx === forms.length - 1;
      toggle.innerHTML = 'Show all';
    }
  }

  function go(n) {
    idx = Math.max(0, Math.min(forms.length - 1, n));
    render();
    if (!showingAll) {
      bar.scrollIntoView({ block: 'nearest' });
      var first = forms[idx].querySelector('input,select,textarea,button');
      if (first && first.focus) {
        try {
          first.focus({ preventScroll: true });
        } catch (e) {
          /* older browsers */
        }
      }
    }
  }

  prev.addEventListener('click', function () {
    go(idx - 1);
  });
  next.addEventListener('click', function () {
    go(idx + 1);
  });
  toggle.addEventListener('click', function () {
    showingAll = !showingAll;
    render();
    bar.scrollIntoView({ block: 'nearest' });
  });

  // Arrow keys move the deck, but never while the reviewer is typing in a
  // field — there the arrows belong to the cursor.
  document.addEventListener('keydown', function (e) {
    if (showingAll) return;
    var t = e.target;
    var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowRight') {
      go(idx + 1);
    } else if (e.key === 'ArrowLeft') {
      go(idx - 1);
    }
  });

  // Autosave: staging already is save-as-you-go, so a change to a card posts
  // itself, debounced, and says so. The server answers 204 to a deck post, so
  // nothing navigates. A failed save costs nothing — the manual Save button is
  // still there, and the mark is still on the page.
  var timers = {};
  function save(f) {
    setSaved(f, 'Saving…');
    fetch(f.action, {
      method: 'POST',
      body: new FormData(f),
      headers: { 'x-fireside-deck': '1' },
      credentials: 'same-origin',
    })
      .then(function (r) {
        setSaved(f, r.ok ? 'Saved' : 'Not saved yet');
        render();
      })
      .catch(function () {
        setSaved(f, 'Not saved yet');
      });
  }
  forms.forEach(function (f) {
    f.addEventListener('input', function () {
      clearTimeout(timers[f.id]);
      setSaved(f, 'Saving…');
      timers[f.id] = setTimeout(function () {
        save(f);
      }, 900);
    });
    // The Save button in deck mode flushes the save without leaving the page.
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      clearTimeout(timers[f.id]);
      save(f);
    });
  });

  render();
}
export default '(function(){var __name=function(f){return f};(' + reviewDeckIsland.toString() + ')();})();';
