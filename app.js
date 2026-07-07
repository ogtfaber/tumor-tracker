/* Tumor Tracker — all data lives in localStorage; nothing leaves the browser. */
(function () {
  'use strict';

  var STORAGE_KEY = 'tumorTracker.v1';
  var SCHEMA_VERSION = 1;

  var TYPES = {
    x:   { label: 'single diameter', unit: 'mm',  series: [{ key: 'x', name: 'diameter' }] },
    xy:  { label: 'two diameters',   unit: 'mm',  series: [{ key: 'x', name: 'x' }, { key: 'y', name: 'y' }] },
    vol: { label: 'volume',          unit: 'cm³', series: [{ key: 'v', name: 'volume' }] }
  };

  var DRUG_SLOTS = 6;

  // ---------------- state ----------------

  var state = load();
  var charts = [];          // live Chart.js instances
  var armedButton = null;   // two-step delete state
  var armedTimer = null;

  function blankState() {
    return { schemaVersion: SCHEMA_VERSION, tumors: [], drugs: [], events: [] };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankState();
      var data = JSON.parse(raw);
      return normalize(data) || blankState();
    } catch (e) {
      console.warn('Could not read saved data:', e);
      return blankState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save — browser storage may be full or blocked.');
    }
  }

  // Validate + coerce an arbitrary parsed object into our schema. Returns null if hopeless.
  function normalize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var out = blankState();
    (Array.isArray(data.tumors) ? data.tumors : []).forEach(function (t) {
      if (!t || typeof t.name !== 'string' || !TYPES[t.type]) return;
      var tumor = { id: t.id || uid(), name: t.name, type: t.type, measurements: [] };
      (Array.isArray(t.measurements) ? t.measurements : []).forEach(function (m) {
        if (!m || !isDateStr(m.date)) return;
        var rec = { id: m.id || uid(), date: m.date };
        TYPES[t.type].series.forEach(function (s) {
          rec[s.key] = isNum(m[s.key]) ? m[s.key] : null;
        });
        if (TYPES[t.type].series.some(function (s) { return rec[s.key] !== null; })) {
          tumor.measurements.push(rec);
        }
      });
      sortByDate(tumor.measurements);
      out.tumors.push(tumor);
    });
    (Array.isArray(data.drugs) ? data.drugs : []).forEach(function (d) {
      if (!d || typeof d.name !== 'string' || !isDateStr(d.start)) return;
      out.drugs.push({
        id: d.id || uid(), name: d.name, start: d.start,
        end: isDateStr(d.end) ? d.end : null,
        note: typeof d.note === 'string' && d.note ? d.note : null
      });
    });
    (Array.isArray(data.events) ? data.events : []).forEach(function (e) {
      if (!e || typeof e.label !== 'string' || !isDateStr(e.date)) return;
      out.events.push({ id: e.id || uid(), date: e.date, label: e.label });
    });
    return out;
  }

  // ---------------- small helpers ----------------

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function $(sel, root) { return (root || document).querySelector(sel); }

  // Parse "YYYY-MM-DD" as local noon — immune to timezone edge cases on chart axes.
  function ts(dateStr) {
    var p = dateStr.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12).getTime();
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(dateStr) {
    return new Date(ts(dateStr)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function sortByDate(arr) { arr.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }); }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function withAlpha(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  // Drug name → color slot. Names get slots in order of first appearance (by start date).
  function drugColorMap() {
    var names = [];
    state.drugs.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; })
      .forEach(function (d) { if (names.indexOf(d.name) === -1) names.push(d.name); });
    var map = {};
    names.forEach(function (n, i) { map[n] = cssVar('--drug-' + ((i % DRUG_SLOTS) + 1)); });
    return map;
  }

  // ---------------- derived: shared time domain ----------------

  function timeDomain() {
    var min = Infinity, max = -Infinity;
    state.tumors.forEach(function (t) {
      t.measurements.forEach(function (m) {
        var v = ts(m.date);
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    state.drugs.forEach(function (d) {
      var s = ts(d.start);
      if (s < min) min = s;
      var e = ts(d.end || todayStr());
      if (e > max) max = e;
    });
    state.events.forEach(function (e) {
      var v = ts(e.date);
      if (v < min) min = v;
      if (v > max) max = v;
    });
    if (!isFinite(min)) return null;
    if (min === max) { min -= 45 * 864e5; max += 45 * 864e5; }
    var pad = (max - min) * 0.04;
    return { min: min - pad, max: max + pad };
  }

  // ---------------- rendering ----------------

  function renderAll() {
    renderLegend();
    renderCharts();
    renderTumors();
    renderDrugs();
    renderEvents();
    $('#empty-state').hidden = state.tumors.length > 0;
  }

  function renderLegend() {
    var el = $('#overlay-legend');
    var map = drugColorMap();
    var names = Object.keys(map);
    if (!names.length && !state.events.length) { el.hidden = true; el.innerHTML = ''; return; }
    var html = '<span class="legend-title">On the charts</span>';
    names.forEach(function (n) {
      html += '<span class="legend-chip"><span class="legend-swatch" style="background:' +
        withAlpha(map[n], parseFloat(cssVar('--band-alpha')) + 0.1) + '"></span>' + esc(n) + '</span>';
    });
    if (state.events.length) {
      html += '<span class="legend-chip"><span class="legend-tick"></span>events</span>';
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  function renderCharts() {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
    var host = $('#charts');
    host.innerHTML = '';

    var domain = timeDomain();
    var map = drugColorMap();
    var bandAlpha = parseFloat(cssVar('--band-alpha'));
    var seriesColors = [cssVar('--series-1'), cssVar('--series-2')];
    var surface = cssVar('--surface');
    var inkMuted = cssVar('--ink-3');
    var ink2 = cssVar('--ink-2');
    var hairline = cssVar('--hairline');
    var eventColor = cssVar('--event');
    var bodyFont = cssVar('--font-body') || 'sans-serif';

    state.tumors.forEach(function (tumor) {
      var typeDef = TYPES[tumor.type];
      var card = document.createElement('article');
      card.className = 'chart-card';
      card.innerHTML =
        '<div class="chart-card-head">' +
          '<h3 class="chart-title">' + esc(tumor.name) +
            '<span class="type-tag">' + typeDef.label + ' · ' + typeDef.unit + '</span></h3>' +
          '<div class="stat-line">' + statLine(tumor) + '</div>' +
        '</div>' +
        (tumor.measurements.length >= 1
          ? '<div class="chart-wrap"><canvas></canvas></div>'
          : '<p class="chart-note">No measurements yet — add them in the Tumors section below.</p>');
      host.appendChild(card);

      if (tumor.measurements.length < 1 || !domain) return;

      var datasets = typeDef.series.map(function (s, i) {
        return {
          label: s.name,
          data: tumor.measurements
            .filter(function (m) { return isNum(m[s.key]); })
            .map(function (m) { return { x: ts(m.date), y: m[s.key] }; }),
          borderColor: seriesColors[i],
          backgroundColor: seriesColors[i],
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBorderColor: surface,   // the 2px surface ring
          pointBorderWidth: 2,
          tension: 0,
          spanGaps: true
        };
      }).filter(function (ds) { return ds.data.length > 0; });

      var annotations = {};
      state.drugs.forEach(function (d, i) {
        annotations['drug' + i] = {
          type: 'box',
          xMin: ts(d.start),
          xMax: ts(d.end || todayStr()),
          backgroundColor: withAlpha(map[d.name], bandAlpha),
          borderWidth: 0,
          drawTime: 'beforeDatasetsDraw'
        };
      });
      state.events.forEach(function (e, i) {
        annotations['event' + i] = {
          type: 'line',
          xMin: ts(e.date),
          xMax: ts(e.date),
          borderColor: eventColor,
          borderWidth: 1,
          drawTime: 'beforeDatasetsDraw',
          label: {
            display: true,
            content: e.label,
            position: 'end',
            rotation: -90,
            font: { size: 9, family: bodyFont },
            color: ink2,
            backgroundColor: withAlpha(surface === '#1a1a19' ? '#1a1a19' : '#fcfcfb', 0.75),
            padding: { x: 4, y: 2 }
          }
        };
      });

      var chart = new Chart(card.querySelector('canvas'), {
        type: 'line',
        data: { datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: {
            legend: {
              display: datasets.length > 1,
              position: 'top',
              align: 'end',
              labels: {
                boxWidth: 18, boxHeight: 2, usePointStyle: false,
                color: ink2, font: { family: bodyFont, size: 11 }
              }
            },
            tooltip: {
              backgroundColor: cssVar('--ink'),
              titleColor: cssVar('--page'),
              bodyColor: cssVar('--page'),
              titleFont: { family: bodyFont, size: 12 },
              bodyFont: { family: bodyFont, size: 12 },
              padding: 10,
              cornerRadius: 8,
              displayColors: datasets.length > 1,
              callbacks: {
                title: function (items) {
                  return items.length ? new Date(items[0].parsed.x).toLocaleDateString(undefined,
                    { year: 'numeric', month: 'long', day: 'numeric' }) : '';
                },
                label: function (item) {
                  return ' ' + item.dataset.label + ': ' + item.parsed.y + ' ' + typeDef.unit;
                }
              }
            },
            annotation: { annotations: annotations }
          },
          scales: {
            x: {
              type: 'time',
              min: domain.min,
              max: domain.max,
              time: { tooltipFormat: 'PP' },
              grid: { color: hairline, drawTicks: false },
              border: { color: cssVar('--baseline') },
              ticks: { color: inkMuted, font: { family: bodyFont, size: 11 }, maxRotation: 0, autoSkipPadding: 24 }
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: typeDef.unit, color: inkMuted, font: { family: bodyFont, size: 11 } },
              grid: { color: hairline, drawTicks: false },
              border: { display: false },
              ticks: { color: inkMuted, font: { family: bodyFont, size: 11 }, maxTicksLimit: 6 }
            }
          }
        }
      });
      charts.push(chart);
    });
  }

  function statLine(tumor) {
    var typeDef = TYPES[tumor.type];
    if (!tumor.measurements.length) return '';
    var parts = typeDef.series.map(function (s) {
      var vals = tumor.measurements.filter(function (m) { return isNum(m[s.key]); });
      if (!vals.length) return null;
      var latest = vals[vals.length - 1][s.key];
      var seg = '<strong>' + (typeDef.series.length > 1 ? s.name + ' ' : '') + latest + ' ' + typeDef.unit + '</strong>';
      if (vals.length > 1) {
        var prev = vals[vals.length - 2][s.key];
        var first = vals[0][s.key];
        seg += ' ' + delta(latest, prev, 'vs previous');
        if (vals.length > 2) seg += ' ' + delta(latest, first, 'vs first');
      }
      return seg;
    }).filter(Boolean);
    return parts.join('<span class="sep">·</span>');
  }

  function delta(now, then, label) {
    if (!isNum(then) || then === 0) return '';
    var pct = ((now - then) / then) * 100;
    var cls = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : '';
    var sign = pct > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + pct.toFixed(1) + '% ' + label + '</span>';
  }

  // ---------------- tumors section ----------------

  function renderTumors() {
    var host = $('#tumor-list');
    host.innerHTML = '';
    state.tumors.forEach(function (tumor) {
      var typeDef = TYPES[tumor.type];
      var card = document.createElement('div');
      card.className = 'tumor-card';
      card.dataset.tumorId = tumor.id;

      var valueHeads = typeDef.series.map(function (s) {
        return '<th>' + esc(s.name) + ' (' + typeDef.unit + ')</th>';
      }).join('');

      var rows = tumor.measurements.map(function (m) {
        var cells = '<td><input type="date" value="' + m.date + '" data-mid="' + m.id + '" data-field="date" aria-label="scan date"></td>';
        typeDef.series.forEach(function (s) {
          cells += '<td><input type="number" step="any" min="0" value="' + (isNum(m[s.key]) ? m[s.key] : '') +
            '" data-mid="' + m.id + '" data-field="' + s.key + '" aria-label="' + esc(s.name) + '"></td>';
        });
        cells += '<td><button type="button" class="icon-btn" data-del-measurement="' + m.id + '" title="Delete this measurement" aria-label="Delete measurement">✕</button></td>';
        return '<tr>' + cells + '</tr>';
      }).join('');

      var newCells = '<td><input type="date" data-new="date" aria-label="new scan date"></td>';
      typeDef.series.forEach(function (s) {
        newCells += '<td><input type="number" step="any" min="0" placeholder="' + esc(s.name) + '" data-new="' + s.key + '" aria-label="new ' + esc(s.name) + '"></td>';
      });
      newCells += '<td></td>';

      card.innerHTML =
        '<div class="tumor-card-head">' +
          '<input class="tumor-name-input" type="text" value="' + esc(tumor.name) + '" data-rename maxlength="80" aria-label="Tumor name">' +
          '<span class="type-badge">' + typeDef.label + ' · ' + typeDef.unit + '</span>' +
        '</div>' +
        '<table class="m-table"><thead><tr><th>Scan date</th>' + valueHeads + '<th></th></tr></thead>' +
        '<tbody>' + rows + '<tr class="new-row">' + newCells + '</tr></tbody></table>' +
        '<div class="card-footer"><button type="button" class="btn" data-del-tumor>Delete tumor</button></div>';

      host.appendChild(card);
    });
  }

  function findTumor(id) {
    return state.tumors.find(function (t) { return t.id === id; });
  }

  // Event delegation for the tumors section
  $('#tumor-list').addEventListener('change', function (ev) {
    var input = ev.target;
    var card = input.closest('.tumor-card');
    if (!card) return;
    var tumor = findTumor(card.dataset.tumorId);
    if (!tumor) return;

    if (input.hasAttribute('data-rename')) {
      var name = input.value.trim();
      if (name) { tumor.name = name; save(); renderLegend(); renderCharts(); }
      else { input.value = tumor.name; }
      renderTumors();
      return;
    }

    if (input.dataset.mid) {
      var m = tumor.measurements.find(function (x) { return x.id === input.dataset.mid; });
      if (!m) return;
      if (input.dataset.field === 'date') {
        if (isDateStr(input.value)) m.date = input.value;
      } else {
        var v = input.value === '' ? null : parseFloat(input.value);
        m[input.dataset.field] = isNum(v) && v >= 0 ? v : null;
      }
      // drop the row if every value was cleared
      var typeDef = TYPES[tumor.type];
      if (typeDef.series.every(function (s) { return !isNum(m[s.key]); })) {
        tumor.measurements = tumor.measurements.filter(function (x) { return x.id !== m.id; });
      }
      sortByDate(tumor.measurements);
      save(); renderTumors(); renderCharts();
      return;
    }

    if (input.dataset.new !== undefined) {
      // commit right away only when the row is fully filled in; a partial row
      // waits (see the focusout handler) so tabbing between its fields is safe
      tryCommitNewRow(card, tumor, /*requireComplete*/ true);
    }
  });

  // A partially-filled new row (e.g. x entered, y left blank) commits once
  // focus moves outside the row. Deferred a tick: a commit's own rerender also
  // fires focusout from the removed inputs, and the stale row must not
  // re-commit — isConnected filters it out after the timeout.
  $('#tumor-list').addEventListener('focusout', function (ev) {
    var row = ev.target.closest('.new-row');
    if (!row) return;
    setTimeout(function () {
      if (!row.isConnected) return;
      if (row.contains(document.activeElement)) return;
      var card = row.closest('.tumor-card');
      var tumor = card && findTumor(card.dataset.tumorId);
      if (tumor) tryCommitNewRow(card, tumor, false);
    }, 0);
  });

  var committing = false;

  function tryCommitNewRow(card, tumor, requireComplete) {
    if (committing) return;
    var row = card.querySelector('.new-row');
    var dateInput = row.querySelector('[data-new="date"]');
    if (!isDateStr(dateInput.value)) return;
    var typeDef = TYPES[tumor.type];
    var rec = { id: uid(), date: dateInput.value };
    var filled = 0;
    typeDef.series.forEach(function (s) {
      var el = row.querySelector('[data-new="' + s.key + '"]');
      var v = el.value === '' ? null : parseFloat(el.value);
      rec[s.key] = isNum(v) && v >= 0 ? v : null;
      if (rec[s.key] !== null) filled++;
    });
    if (filled === 0) return; // nothing to save yet
    if (requireComplete && filled < typeDef.series.length) return; // still typing
    committing = true;
    tumor.measurements.push(rec);
    sortByDate(tumor.measurements);
    save(); renderTumors(); renderCharts();
    committing = false;
    if (requireComplete) {
      // the row was completed deliberately — put the cursor back in the same
      // tumor's new-row date, ready for the next scan
      var fresh = $('#tumor-list .tumor-card[data-tumor-id="' + tumor.id + '"] [data-new="date"]');
      if (fresh) fresh.focus();
    }
  }

  $('#tumor-list').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    var card = btn.closest('.tumor-card');
    var tumor = findTumor(card.dataset.tumorId);
    if (!tumor) return;

    if (btn.hasAttribute('data-del-measurement')) {
      tumor.measurements = tumor.measurements.filter(function (m) { return m.id !== btn.getAttribute('data-del-measurement'); });
      save(); renderTumors(); renderCharts();
      return;
    }
    if (btn.hasAttribute('data-del-tumor')) {
      if (armTwoStep(btn, 'Delete “' + tumor.name + '”?')) {
        state.tumors = state.tumors.filter(function (t) { return t.id !== tumor.id; });
        save(); renderAll();
        toast('Deleted ' + tumor.name);
      }
    }
  });

  $('#add-tumor').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('#tumor-name').value.trim();
    var type = $('#tumor-type').value;
    if (!name || !TYPES[type]) return;
    state.tumors.push({ id: uid(), name: name, type: type, measurements: [] });
    save(); renderAll();
    ev.target.reset();
    var fresh = $('#tumor-list .tumor-card:last-child [data-new="date"]');
    if (fresh) fresh.focus();
  });

  // ---------------- drugs section ----------------

  function renderDrugs() {
    var host = $('#drug-list');
    var map = drugColorMap();
    if (!state.drugs.length) {
      host.innerHTML = '<p class="list-empty">No medications recorded yet.</p>';
      return;
    }
    var sorted = state.drugs.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    host.innerHTML = '<div class="row-list">' + sorted.map(function (d) {
      return '<div class="data-row">' +
        '<span class="swatch" style="background:' + withAlpha(map[d.name], parseFloat(cssVar('--band-alpha')) + 0.1) + '"></span>' +
        '<span class="row-main">' + esc(d.name) + (d.note ? '<span class="row-note">' + esc(d.note) + '</span>' : '') + '</span>' +
        '<span class="row-dates">' + fmtDate(d.start) + ' — ' +
          (d.end ? fmtDate(d.end) : '<span class="ongoing">ongoing</span>') + '</span>' +
        '<button type="button" class="icon-btn" data-del-drug="' + d.id + '" title="Delete" aria-label="Delete medication">✕</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  $('#drug-list').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-del-drug]');
    if (!btn) return;
    var d = state.drugs.find(function (x) { return x.id === btn.getAttribute('data-del-drug'); });
    if (!d) return;
    if (armTwoStep(btn, '✕')) {
      state.drugs = state.drugs.filter(function (x) { return x.id !== d.id; });
      save(); renderAll();
      toast('Deleted ' + d.name);
    }
  });

  $('#add-drug').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('#drug-name').value.trim();
    var start = $('#drug-start').value;
    var end = $('#drug-end').value || null;
    var note = $('#drug-note').value.trim() || null;
    if (!name || !isDateStr(start)) return;
    if (end && end < start) { toast('The end date is before the start date.'); return; }
    state.drugs.push({ id: uid(), name: name, start: start, end: end, note: note });
    save(); renderAll();
    ev.target.reset();
  });

  // ---------------- events section ----------------

  function renderEvents() {
    var host = $('#event-list');
    if (!state.events.length) {
      host.innerHTML = '<p class="list-empty">No events recorded yet.</p>';
      return;
    }
    var sorted = state.events.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    host.innerHTML = '<div class="row-list">' + sorted.map(function (e) {
      return '<div class="data-row">' +
        '<span class="tick"></span>' +
        '<span class="row-main">' + esc(e.label) + '</span>' +
        '<span class="row-dates">' + fmtDate(e.date) + '</span>' +
        '<button type="button" class="icon-btn" data-del-event="' + e.id + '" title="Delete" aria-label="Delete event">✕</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  $('#event-list').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-del-event]');
    if (!btn) return;
    if (armTwoStep(btn, '✕')) {
      state.events = state.events.filter(function (x) { return x.id !== btn.getAttribute('data-del-event'); });
      save(); renderAll();
      toast('Event deleted');
    }
  });

  $('#add-event').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var date = $('#event-date').value;
    var label = $('#event-label').value.trim();
    if (!isDateStr(date) || !label) return;
    state.events.push({ id: uid(), date: date, label: label });
    save(); renderAll();
    ev.target.reset();
  });

  // ---------------- two-step delete ----------------
  // First click arms the button; second click within 3s confirms.

  function disarm() {
    if (armedButton) {
      armedButton.classList.remove('btn-danger-armed', 'armed');
      if (armedButton.dataset.origText) armedButton.textContent = armedButton.dataset.origText;
      armedButton = null;
    }
    clearTimeout(armedTimer);
  }

  function armTwoStep(btn, armedLabel) {
    if (armedButton === btn) { disarm(); return true; }
    disarm();
    armedButton = btn;
    btn.dataset.origText = btn.textContent;
    if (armedLabel && armedLabel !== '✕') btn.textContent = armedLabel;
    btn.classList.add('btn-danger-armed', 'armed');
    btn.title = 'Click again to confirm';
    armedTimer = setTimeout(disarm, 3000);
    return false;
  }

  // ---------------- export / import ----------------

  function exportData() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tumor-tracker-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    toast('Backup downloaded — keep it somewhere safe.');
  }

  $('#btn-export').addEventListener('click', exportData);
  $('#btn-export-2').addEventListener('click', exportData);

  $('#btn-import').addEventListener('click', function () { $('#import-file').click(); });

  $('#import-file').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try { incoming = normalize(JSON.parse(reader.result)); }
      catch (e) { incoming = null; }
      if (!incoming) { toast('That file doesn’t look like a Tumor Tracker backup.'); return; }
      var hasData = state.tumors.length || state.drugs.length || state.events.length;
      if (hasData) {
        var n = incoming.tumors.length;
        var ok = window.confirm(
          'Replace everything currently in this browser with the imported file?\n\n' +
          'Imported: ' + n + ' tumor' + (n === 1 ? '' : 's') + ', ' +
          incoming.drugs.length + ' medication period(s), ' + incoming.events.length + ' event(s).\n\n' +
          'Your current data will be overwritten.'
        );
        if (!ok) return;
      }
      state = incoming;
      save(); renderAll();
      toast('Data imported.');
    };
    reader.readAsText(file);
  });

  // ---------------- theme changes ----------------

  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', function () { renderAll(); });

  // ---------------- go ----------------

  Chart.register(window['chartjs-plugin-annotation']);
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  renderAll();
})();
