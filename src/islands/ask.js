// Ask, in place. Progressive enhancement over a form that already works: the
// page renders and answers with JavaScript switched off, and this only removes
// the reload between a question and its answer.
//
// It asks the same door the form posts to, with one extra header, and the
// server hands back just the answer instead of a whole page — one small reply
// on one bar of signal rather than a fresh document. Everything it inserts was
// escaped and built server-side; the only thing that came from the person at
// the keyboard is set with textContent, never as markup.

function askIsland() {
  var form = document.querySelector('[data-ask]');
  var thread = document.querySelector('[data-ask-thread]');
  if (!form || !thread || !window.fetch || !window.FormData) return;
  var input = form.querySelector('[data-ask-input]');
  if (!input) return;
  var busy = false;

  function waiting() {
    var box = document.createElement('div');
    box.className = 'cc-fs';
    box.setAttribute('data-ask-wait', '');
    box.innerHTML = '<span class="cc-typing"><i></i><i></i><i></i></span>';
    return box;
  }

  function land(el) {
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function send(body, shown) {
    if (busy || !body) return;
    busy = true;
    form.setAttribute('aria-busy', 'true');

    var you = document.createElement('div');
    you.className = 'cc-you';
    you.textContent = shown;          // what someone typed is text, never markup
    thread.appendChild(you);
    var wait = waiting();
    thread.appendChild(wait);
    input.value = '';
    land(wait);

    fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-ask': 'in-place'
      },
      body: body
    })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        wait.remove();
        thread.insertAdjacentHTML('beforeend', html);
        land(thread.lastElementChild);
      })
      .catch(function () {
        // The one honest thing to do when the reply never lands: fall back to
        // the page that works without any of this.
        wait.remove();
        input.value = shown;
        form.removeAttribute('data-ask');
        form.submit();
      })
      .then(function () {
        busy = false;
        form.removeAttribute('aria-busy');
        input.focus();
      });
  }

  form.addEventListener('submit', function (e) {
    if (!form.hasAttribute('data-ask')) return;   // the fallback path, let it go
    var pressed = e.submitter;
    // An instant chip wins over whatever sits half-typed in the box: the
    // press is the question.
    if (pressed && pressed.name === 'i' && pressed.value) {
      e.preventDefault();
      send('i=' + encodeURIComponent(pressed.value), (pressed.textContent || '').trim() || pressed.value);
      return;
    }
    var q = pressed && pressed.name === 'q' ? pressed.value : input.value;
    q = (q || '').trim();
    if (!q) return;                               // let the browser say it is blank
    e.preventDefault();
    send('q=' + encodeURIComponent(q), q);
  });
}

export default '(' + askIsland.toString() + ')();';
