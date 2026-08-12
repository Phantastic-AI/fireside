// stars.js — the "my schedule" island (S-10, /:event/my-schedule).
//
// Everyone's schedule here starts anonymous: a list of starred session ids in
// localStorage, keyed by event slug, so it works with no account and nothing
// sent anywhere. This file only reads that list, writes it back on toggle,
// and paints rows the server already put in time order — no date math here,
// times and day labels arrive pre-formatted in the embedded JSON.
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

  var root = document.getElementById('my-schedule-root');
  if (!root) return;
  var dataEl = document.getElementById('my-schedule-data');
  var data = { slug: '', days: [] };
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

  function row(s) {
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
      '</div></div>' +
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
      out += '<div class="dayhead">' + esc(d.label) + '</div><div class="slot">' + inDay.map(row).join('') + '</div>';
    });

    if (!total) {
      root.innerHTML =
        '<div class="sec state-out"><h2>Nothing starred yet.</h2>' +
        '<p>Star a session on the agenda and it turns up here — kept in this browser, no account needed.</p>' +
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
