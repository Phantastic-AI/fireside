// stars.js — the "my schedule" island (S-10, /:event/my-schedule).
//
// Everyone's schedule here starts anonymous: a list of starred session ids in
// localStorage, keyed by event slug, so it works with no account and nothing
// sent anywhere. For a visitor who has never signed in, this file is the whole
// page: it reads that list, writes it back on toggle, and paints rows the
// server already put in time order — no date math here, times and day labels
// arrive pre-formatted in the embedded JSON.
//
// For a signed-in visitor the page is server-rendered from their own list, and
// this file has exactly one job left: the handshake that moves what this
// browser was holding onto their account, once.
//
//   1. Local ids that the server's list already has → the copy here is no
//      longer the original, so it is cleared.
//   2. Local ids the server's list does not have (and that name a session on
//      this agenda) → post them to /{event}/my-schedule/adopt and let the
//      redirect repaint. Nothing local is cleared until the next load proves
//      the server has them, so a failed post costs nothing.
//   3. One attempt per tab per event (sessionStorage), so no arrangement of
//      refusals can turn this into a loop.
//
// Served byte-for-byte at /a/stars.js — imported as raw text by
// ../routes/public/schedule.ts via the wrangler Text rule for src/islands/*.js.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function plural(n, one, many) {
    return n === 1 ? '1 ' + one : n + ' ' + many;
  }

  // Every row on this page is, by definition, a starred one — the button
  // here is always the filled star; the hollow "star it" state belongs to
  // the agenda page's own controls, a later parcel.
  var STAR_ON =
    '<svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">' +
    '<path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z"/></svg>';

  var dataEl = document.getElementById('my-schedule-data');
  var data = { slug: '', days: [], signedIn: false, mine: [] };
  try {
    data = JSON.parse((dataEl && dataEl.textContent) || '{}');
  } catch (e) {
    /* leave data empty — render() below shows the empty state */
  }

  var KEY = 'fireside.stars.' + data.slug;
  function stars() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function forget() {
    try {
      localStorage.removeItem(KEY);
    } catch (e) {
      /* a private window; there was nothing to clear */
    }
  }
  function toggleStar(id) {
    var a = stars(),
      i = a.indexOf(id);
    if (i < 0) a.push(id);
    else a.splice(i, 1);
    try {
      localStorage.setItem(KEY, JSON.stringify(a));
    } catch (e) {
      /* private browsing: the toggle still repaints this render */
    }
    return i < 0;
  }

  // ---- signed in: hand the browser's list over, once, and step aside ----

  function known() {
    var ids = {};
    (data.days || []).forEach(function (d) {
      (d.sessions || []).forEach(function (s) {
        ids[s.id] = 1;
      });
    });
    return ids;
  }

  function adopt() {
    var local = stars();
    if (!local.length) return;
    var here = known();
    var already = {};
    (data.mine || []).forEach(function (id) {
      already[id] = 1;
    });
    var extra = local.filter(function (id) {
      return here[id] && !already[id];
    });
    if (!extra.length) {
      forget();
      return;
    }
    var form = document.getElementById('adopt-stars');
    var field = form && form.querySelector('[name=sessions]');
    if (!form || !field) return;
    var once = 'fireside.adopted.' + data.slug;
    try {
      if (sessionStorage.getItem(once)) return;
      sessionStorage.setItem(once, '1');
    } catch (e) {
      /* no session storage: the attempt below still runs, just unguarded */
    }
    field.value = extra.join(',');
    form.submit();
  }

  if (data.signedIn) {
    adopt();
    return;
  }

  // ---- signed out: this file is the page ----

  var root = document.getElementById('my-schedule-root');
  if (!root) return;

  // D-029: the page never pretends time and distance away — overlaps and
  // no-gap room changes get a quiet line. Same arithmetic as the server's.
  function physicsNotes(rows) {
    var notes = {};
    function addNote(id, note) {
      notes[id] = notes[id] || [];
      if (notes[id].indexOf(note) < 0) notes[id].push(note);
    }
    var live = rows
      .filter(function (s) { return !s.cancelled; })
      .slice()
      .sort(function (a, b) { return a.at - b.at; });
    for (var i = 0; i < live.length; i++) {
      var a = live[i];
      var aEnd = a.at + a.mins * 60000;
      for (var j = i + 1; j < live.length; j++) {
        var b = live[j];
        if (b.at < aEnd) {
          addNote(a.id, 'Overlaps with ' + b.title + '.');
          addNote(b.id, 'Overlaps with ' + a.title + '.');
          continue;
        }
        var gap = Math.round((b.at - aEnd) / 60000);
        if (gap < 10 && a.room && b.room && a.room !== b.room) {
          addNote(b.id, gap === 0
            ? 'Tight turn \u2014 ' + a.room + ' to ' + b.room + ', no gap.'
            : 'Tight turn \u2014 ' + a.room + ' to ' + b.room + ', ' + gap + ' min.');
        }
        break;
      }
    }
    return notes;
  }

  function row(s, noteList) {
    var track = s.track
      ? '<span class="tk" style="--tc:' + esc(s.track.colour) + ';--tw:' + esc(s.track.colour) + '22">' +
        esc(s.track.name) + '</span>'
      : '';
    var struck = s.cancelled ? ' style="text-decoration:line-through;color:var(--muted)"' : '';
    var title = s.slug
      ? '<a href="/' + esc(data.slug) + '/s/' + esc(s.slug) + '"' + struck + '>' + esc(s.title) + '</a>'
      : '<span' + struck + '>' + esc(s.title) + '</span>';
    return (
      '<article class="sesh" style="--tc:' + esc(s.track ? s.track.colour : '#726858') + '">' +
      '<div class="sesh-main"><div class="sesh-when"><span class="time">' + esc(s.time) + '</span>' +
      (s.room ? '<span class="room">' + esc(s.room) + '</span>' : '') + '</div>' +
      '<h3>' + title + '</h3>' +
      (s.speakers ? '<div class="sesh-by"><span>' + esc(s.speakers) + '</span></div>' : '') +
      '<div class="sesh-meta">' + track + '<span>' + esc(s.format) + ' · ' + esc(s.minutes) + '</span>' +
      (s.cancelled ? '<span class="chip plain" style="color:var(--danger)">' + esc(s.cancelledLabel) + '</span>' : '') +
      '</div>' +
      (noteList || []).map(function (n) {
        return '<div class="sub" style="margin-top:6px;color:var(--danger)">' + esc(n) + '</div>';
      }).join('') +
      '</div>' +
      '<button class="starbtn" data-star="' + esc(s.id) + '" aria-pressed="true" aria-label="Remove from my schedule">' +
      STAR_ON + '</button></article>'
    );
  }

  function render() {
    var set = stars();
    var total = 0;
    var out = '';
    data.days.forEach(function (d) {
      var inDay = d.sessions.filter(function (s) {
        return set.indexOf(s.id) >= 0;
      });
      if (!inDay.length) return;
      total += inDay.length;
      var notes = physicsNotes(inDay);
      out += '<div class="dayhead">' + esc(d.label) + '</div><div class="slot">' + inDay.map(function (s) {
        return row(s, notes[s.id]);
      }).join('') + '</div>';
    });

    if (!total) {
      root.innerHTML =
        '<div class="sec state-out"><h2>Nothing starred yet.</h2>' +
        '<p>Star the talks you want to see and they line up here, in the order you will walk to them.</p>' +
        '<a class="btn btn-primary" href="/' + esc(data.slug) + '/agenda">Browse the agenda →</a></div>';
      return;
    }

    root.innerHTML =
      '<p class="sub" style="margin:2px 0 18px">' + plural(total, 'session starred', 'sessions starred') + '</p>' + out;

    root.querySelectorAll('[data-star]').forEach(function (b) {
      b.addEventListener('click', function () {
        toggleStar(b.dataset.star);
        render();
      });
    });
  }

  render();
})();
