// embed-copy.js — a copy button for the embed snippets on the organizer's
// Embeds screen (src/routes/admin/embeds.ts, EMB-15).
//
// NOT WIRED IN YET. src/routes/admin/embeds.ts is an admin route, out of
// this parcel's file discipline (agenda.ts / speakers.ts / ics.ts /
// queries/public.ts only) — this file was built as a ready deliverable and
// flagged in the report rather than reached for. Wiring it in is three
// small, additive edits to embeds.ts's block() function and the route that
// renders the page:
//
//   1. add `data-copy-source` to the readonly <textarea> in block():
//        `<textarea readonly rows="3" aria-label="${esc(title)}" data-copy-source ...`
//   2. inline this island once, the same way agenda.ts inlines
//      agenda-stars.js — import it and append
//      `<script>${String(embedCopyIsland)}</script>` to the page body.
//   3. nothing else. No markup change is required beyond the one attribute:
//      the button itself is injected by the script below, never rendered
//      server-side (see why, next).
//
// Why the button is injected rather than server-rendered: a "Copy" control
// has no meaningful action with scripts off — clicking it would do nothing,
// a dead button is worse than no button — and the textarea it sits beside is
// already selectable and copyable by hand today. So the no-JS baseline stays
// exactly what it already is (a readonly textarea, select-all-and-copy), and
// scripts-on visitors get the one-click upgrade. Same shape as
// agenda-stars.js: a real, working default, and a script that only removes a
// step for whoever has one running.
function embedCopyIsland() {
  var sources = [].slice.call(document.querySelectorAll('[data-copy-source]'));
  if (!sources.length) return;

  sources.forEach(function (src) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.style.marginTop = '8px';
    var label = 'Copy';
    btn.textContent = label;
    src.insertAdjacentElement('afterend', btn);

    function settle(ok) {
      btn.textContent = ok ? 'Copied' : 'Select and copy manually';
      setTimeout(function () {
        btn.textContent = label;
      }, 1600);
    }

    function fallback() {
      try {
        src.focus();
        src.select();
        settle(document.execCommand('copy'));
      } catch (e) {
        settle(false);
      }
    }

    btn.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(src.value).then(
          function () {
            settle(true);
          },
          fallback
        );
      } else {
        fallback();
      }
    });
  });
}

// The shim, and why it is not optional: this module is bundled into the
// Worker with esbuild's keep-names on, which annotates every nested function
// with a __name(fn, "…") call. That helper is defined once at the top of the
// Worker bundle — a place the browser never sees. Ship the text without it
// and the first nested function throws ReferenceError before a single button
// is wired (the same fix every other island in this directory carries).
export default '(function(){var __name=function(f){return f};(' + embedCopyIsland.toString() + ')();})();';
