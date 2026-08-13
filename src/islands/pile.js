// The pile, client side. Plain JS, no framework, no build step.
//
// Written as a real function and shipped as its own source text, so the file
// you read is the file that runs. The page inlines it.
//
// Everything on this screen already works without it: the checkboxes are real
// checkboxes, the buttons are real submit buttons, the search is a real form.
// This adds the keyboard, because j/k is respect for someone who reads six
// hundred proposals in stolen half-hours:
//
//   j / k   move the row focus
//   x       choose the focused row
//   Enter   open it
//   Esc     let go of everything chosen
//
// and it keeps the count in the action bar honest as boxes are ticked.

function pileIsland() {
  var form = document.querySelector('[data-pile]');
  if (!form) return;
  var rows = [].slice.call(form.querySelectorAll('.prow'));
  if (!rows.length) return;
  var out = form.querySelector('[data-chosen]');
  var cursor = -1;

  function boxOf(row) { return row.querySelector('input[type=checkbox]'); }
  function linkOf(row) { return row.querySelector('h3 a'); }

  function tally() {
    var n = 0;
    rows.forEach(function (r) {
      var b = boxOf(r);
      var on = !!b && b.checked;
      if (on) n++;
      r.classList.toggle('sel', on);
    });
    if (!out) return;
    out.textContent = n === 0
      ? 'Nothing chosen yet'
      : n === 1 ? '1 chosen' : n.toLocaleString('en-US') + ' chosen';
  }

  function focus(i) {
    cursor = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach(function (r, k) { r.classList.toggle('cursor', k === cursor); });
    var row = rows[cursor];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function typing(el) {
    if (!el || !el.tagName) return false;
    if (/^(textarea|select)$/i.test(el.tagName)) return true;
    return el.tagName.toLowerCase() === 'input' && el.type !== 'checkbox';
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(e.target)) return;

    if (e.key === 'j') { focus(cursor + 1); e.preventDefault(); }
    else if (e.key === 'k') { focus(cursor < 1 ? 0 : cursor - 1); e.preventDefault(); }
    else if (e.key === 'x') {
      var row = rows[cursor];
      if (!row) { focus(0); return; }
      var b = boxOf(row);
      if (b) { b.checked = !b.checked; tally(); }
      e.preventDefault();
    } else if (e.key === 'Enter') {
      // A checkbox with the focus would otherwise submit the whole form, and
      // deciding is never something you fall into.
      var here = rows[cursor] || (e.target.closest ? e.target.closest('.prow') : null);
      var a = here && linkOf(here);
      if (a) { e.preventDefault(); location.href = a.href; }
    } else if (e.key === 'Escape') {
      rows.forEach(function (r) { var b = boxOf(r); if (b) b.checked = false; });
      tally();
    }
  });

  form.addEventListener('change', tally);
  rows.forEach(function (r, i) {
    r.addEventListener('click', function (e) {
      if (e.target.closest('a,button')) return;
      focus(i);
    });
  });

  tally();
}

// The bundler's keepNames pass wraps every named function it carries in
// `__name(fn, 'name')`, and that helper lives in the bundle's module scope — it
// does not travel inside the source text this exports. So the page defines its
// own before running it. Without this line the whole island dies on its first
// wrapped call (this file has several named inner functions), and the pile's
// keyboard selection, focus and typeahead go with it. Matches cfp/concierge/ask.
export default
  '(function(){var __name=function(f){return f};(' + pileIsland.toString() + ')();})();';
