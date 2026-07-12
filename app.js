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

  // The tool is scoped to NF2 for now; the diagnosis is stored in the data
  // file so backups stay meaningful if other diseases are added later.
  // Must be assigned before `state = load()` runs below.
  var DEFAULT_DIAGNOSIS = 'NF2';

  // Anonymous 6-character dataset ID. Generated once when real data first
  // exists, then locked in — nothing in the UI can change it. The alphabet
  // skips easily-confused characters (0/O, 1/I/L) so the code stays readable
  // on printed charts.
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;

  // The patient name never lives in `state`, so it can never end up in a
  // JSON export. It is remembered only to prefill the Save-PNG dialog.
  var PATIENT_NAME_KEY = 'tumorTracker.patientName';

  // Publishing: the secret update token lives outside `state` so a publish
  // payload can never contain it. It IS injected into JSON backups (and read
  // back on import) so a restored backup keeps the right to update.
  var PUBLISH_TOKEN_KEY = 'tumorTracker.publishToken';
  var PUBLISHED_AT_KEY = 'tumorTracker.publishedAt';
  var TOKEN_RE = /^[0-9a-f]{48}$/;

  // ---------------- public viewer routes ----------------
  // /p/CODE renders one published dataset read-only; /explore lists all of
  // them. In these modes localStorage is never read or written — `state`
  // holds the fetched copy and vanishes with the tab.
  var VIEW = (function () {
    var m = location.pathname.match(/^\/p\/([A-HJKMNP-Z2-9]{6})$/);
    if (m) return { mode: 'patient', code: m[1] };
    if (location.pathname === '/explore') return { mode: 'explore' };
    return null;
  })();

  // ---------------- state ----------------

  var state = VIEW ? blankState() : load();
  var charts = [];          // live Chart.js instances
  var armedButton = null;   // two-step delete state
  var armedTimer = null;

  function blankState() {
    return { schemaVersion: SCHEMA_VERSION, diagnosis: DEFAULT_DIAGNOSIS, code: null, tumors: [], drugs: [], events: [] };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankState();
      var data = JSON.parse(raw);
      var out = normalize(data) || blankState();
      var dirty = false;
      // One-time migration: the patient name moves out of the data file into
      // its own key, so JSON exports stay anonymous.
      if (data && typeof data.patient === 'string' && data.patient.trim()) {
        try { localStorage.setItem(PATIENT_NAME_KEY, data.patient.trim().slice(0, 80)); } catch (e2) {}
        dirty = true;
      }
      if (hasData(out) && !out.code) { out.code = genCode(); dirty = true; }
      if (dirty) {
        // not save(): `state` is not assigned yet while load() runs
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (e3) {}
      }
      return out;
    } catch (e) {
      console.warn('Could not read saved data:', e);
      return blankState();
    }
  }

  function save() {
    if (VIEW) return; // viewer modes never persist anything
    if (hasData(state) && !state.code) state.code = genCode();
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
    if (typeof data.diagnosis === 'string' && data.diagnosis.trim()) out.diagnosis = data.diagnosis.trim().slice(0, 40);
    if (typeof data.code === 'string' && CODE_RE.test(data.code)) out.code = data.code;
    (Array.isArray(data.tumors) ? data.tumors : []).forEach(function (t) {
      if (!t || typeof t.name !== 'string' || !TYPES[t.type]) return;
      var tumor = { id: t.id || uid(), name: t.name, type: t.type, measurements: [] };
      (Array.isArray(t.measurements) ? t.measurements : []).forEach(function (m) {
        if (!m || !isDateStr(m.date)) return;
        var rec = {
          id: m.id || uid(), date: m.date,
          note: typeof m.note === 'string' && m.note ? m.note : null
        };
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
        dose: (function (v) {
          // numeric dose; older backups may carry strings like "10 mg"
          var n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
          return isNum(n) && n > 0 ? n : null;
        })(d.dose),
        note: typeof d.note === 'string' && d.note ? d.note : null
      });
    });
    (Array.isArray(data.events) ? data.events : []).forEach(function (e) {
      if (!e || typeof e.label !== 'string' || !isDateStr(e.date)) return;
      // tumorId scopes the event to one tumor's chart; null (or a stale id) means every chart
      var tumorId = typeof e.tumorId === 'string' && out.tumors.some(function (t) { return t.id === e.tumorId; })
        ? e.tumorId : null;
      out.events.push({ id: e.id || uid(), date: e.date, label: e.label, tumorId: tumorId });
    });
    return out;
  }

  // ---------------- sample data for fresh visitors ----------------
  // While nothing has been saved yet, the charts section renders this
  // read-only example so a new visitor sees what the app produces. It lives
  // only in memory — never in localStorage — and vanishes at the first real
  // entry. The editable sections below always work on the real state.

  var sampleCache = null;

  function viewState() {
    if (state.tumors.length || state.drugs.length || state.events.length) return state;
    if (!sampleCache) sampleCache = sampleState();
    return sampleCache;
  }

  function sampleState() {
    // months back from today, pinned mid-month so setMonth can't overshoot
    function ago(months) {
      var d = new Date();
      d.setDate(15);
      d.setMonth(d.getMonth() - months);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      diagnosis: DEFAULT_DIAGNOSIS,
      tumors: [{
        id: 'sample-tumor',
        name: 'Left vestibular schwannoma (example)',
        type: 'xy',
        measurements: [
          { id: 'sm1', date: ago(24), x: 14.2, y: 9.8,  note: 'first MRI' },
          { id: 'sm2', date: ago(21), x: 15.0, y: 10.4, note: null },
          { id: 'sm3', date: ago(18), x: 16.1, y: 11.1, note: null },
          { id: 'sm4', date: ago(15), x: 17.0, y: 11.8, note: null },
          { id: 'sm5', date: ago(11), x: 16.7, y: 11.6, note: 'first scan after treatment' },
          { id: 'sm6', date: ago(7),  x: 16.0, y: 11.1, note: null },
          { id: 'sm7', date: ago(3),  x: 15.2, y: 10.5, note: null }
        ]
      }],
      drugs: [
        { id: 'sample-drug-1', name: 'Everolimus', start: ago(16), end: ago(8), dose: 10, note: null },
        { id: 'sample-drug-2', name: 'Everolimus', start: ago(8), end: null, dose: 5, note: null }
      ],
      events: [
        { id: 'sample-event', date: ago(14), label: 'Gamma Knife radiosurgery', tumorId: 'sample-tumor' }
      ]
    };
  }

  // ---------------- small helpers ----------------

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function hasData(s) { return !!(s.tumors.length || s.drugs.length || s.events.length); }

  function genCode() {
    var buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function $(sel, root) { return (root || document).querySelector(sel); }

  function getPublishToken() {
    try {
      var t = localStorage.getItem(PUBLISH_TOKEN_KEY);
      return t && TOKEN_RE.test(t) ? t : null;
    } catch (e) { return null; }
  }
  function setPublished(token, whenIso) {
    try {
      localStorage.setItem(PUBLISH_TOKEN_KEY, token);
      if (whenIso) localStorage.setItem(PUBLISHED_AT_KEY, whenIso);
    } catch (e) {}
  }
  function clearPublished() {
    try {
      localStorage.removeItem(PUBLISH_TOKEN_KEY);
      localStorage.removeItem(PUBLISHED_AT_KEY);
    } catch (e) {}
  }

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

  // Also escapes quotes: esc() output is used inside value="…" attributes.
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;');
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
    viewState().drugs.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; })
      .forEach(function (d) { if (names.indexOf(d.name) === -1) names.push(d.name); });
    var map = {};
    names.forEach(function (n, i) { map[n] = cssVar('--drug-' + ((i % DRUG_SLOTS) + 1)); });
    return map;
  }

  function shadeKey(d) { return d.name + '\u0000' + (d.dose || ''); }

  // Same medication, different dose → same hue, subtly different band intensity.
  // Opacity is ordered by dose: the lowest dose gets the lightest shade and
  // higher doses get progressively more opaque, regardless of entry order.
  // Doseless periods take the lightest slot.
  function drugShadeMap() {
    var vs = viewState();
    var colors = drugColorMap();
    var bandAlpha = parseFloat(cssVar('--band-alpha'));
    var doses = {};   // name -> distinct doses, sorted ascending
    var noDose = {};  // name -> has at least one doseless period
    vs.drugs.forEach(function (d) {
      var list = doses[d.name] = doses[d.name] || [];
      if (d.dose === null) noDose[d.name] = true;
      else if (list.indexOf(d.dose) === -1) list.push(d.dose);
    });
    Object.keys(doses).forEach(function (n) { doses[n].sort(function (a, b) { return a - b; }); });

    var map = {};
    vs.drugs.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; })
      .forEach(function (d) {
        var key = shadeKey(d);
        if (map[key]) return;
        var rank = d.dose === null ? 0
          : doses[d.name].indexOf(d.dose) + (noDose[d.name] ? 1 : 0);
        map[key] = {
          name: d.name,
          dose: d.dose,
          color: colors[d.name],
          alpha: Math.min(bandAlpha * Math.pow(1.55, rank), 0.45)
        };
      });
    return map;
  }

  // ---------------- derived: time domain ----------------
  // Shared across charts, except events scoped to another tumor don't
  // stretch this chart's axis.

  function timeDomain(tumor) {
    var vs = viewState();
    var min = Infinity, max = -Infinity;
    vs.tumors.forEach(function (t) {
      t.measurements.forEach(function (m) {
        var v = ts(m.date);
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    vs.drugs.forEach(function (d) {
      var s = ts(d.start);
      if (s < min) min = s;
      var e = ts(d.end || todayStr());
      if (e > max) max = e;
    });
    vs.events.forEach(function (e) {
      if (tumor && e.tumorId && e.tumorId !== tumor.id) return;
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
    var codeEl = $('#patient-code');
    codeEl.textContent = state.code || 'assigned on first entry';
    codeEl.classList.toggle('placeholder', !state.code);
    $('#diagnosis-value').textContent = state.diagnosis || DEFAULT_DIAGNOSIS;
    refreshEventTumorOptions();
    renderLegend();
    renderCharts();
    renderTumors();
    renderDrugs();
    renderEvents();
    $('#empty-state').hidden = state.tumors.length > 0;
    $('#empty-example-note').hidden = viewState() === state;
    // Import is a fresh-start action, so it hides once anything is saved;
    // with nothing entered yet there is nothing worth downloading.
    var dataExists = hasData(state);
    $('#btn-import').hidden = dataExists;
    $('#btn-export').disabled = !dataExists;
    $('#btn-export-2').disabled = !dataExists;
    $('#clear-section').hidden = !dataExists;
    renderPublish();
  }

  function renderLegend() {
    var el = $('#overlay-legend');
    var vs = viewState();
    var shades = drugShadeMap();
    var keys = Object.keys(shades);
    if (!keys.length && !vs.events.length) { el.hidden = true; el.innerHTML = ''; return; }
    var html = '<span class="legend-title">On the charts</span>';
    keys.forEach(function (k) {
      var s = shades[k];
      html += '<span class="legend-chip"><span class="legend-swatch" style="background:' +
        withAlpha(s.color, s.alpha + 0.1) + '"></span>' + esc(s.name) +
        (s.dose ? '<span class="legend-dose">' + esc(s.dose) + '</span>' : '') + '</span>';
    });
    if (vs.events.length) {
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

    var vs = viewState();
    var demo = vs !== state; // rendering the read-only example for a fresh visitor
    var shades = drugShadeMap();
    var seriesColors = [cssVar('--series-1'), cssVar('--series-2')];
    var surface = cssVar('--surface');
    var inkMuted = cssVar('--ink-3');
    var ink2 = cssVar('--ink-2');
    var hairline = cssVar('--hairline');
    var eventColor = cssVar('--event');
    var bodyFont = cssVar('--font-body') || 'sans-serif';

    vs.tumors.forEach(function (tumor) {
      var typeDef = TYPES[tumor.type];
      var domain = timeDomain(tumor);
      var card = document.createElement('article');
      card.className = 'chart-card';
      card.dataset.tumorId = tumor.id;
      var hasChart = tumor.measurements.length >= 1 && domain;
      card.innerHTML =
        '<div class="chart-card-head">' +
          '<h3 class="chart-title">' + esc(tumor.name) +
            (demo ? '<span class="example-tag">Example</span>' : '') +
            '<span class="type-tag">' + typeDef.label + ' · ' + typeDef.unit + '</span></h3>' +
          '<div class="chart-head-right">' +
            '<div class="stat-line">' + statLine(tumor) + '</div>' +
            (hasChart && !demo ? '<button type="button" class="btn btn-ghost btn-png" data-save-png title="Download this chart as a PNG image">Save PNG</button>' : '') +
          '</div>' +
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
            .map(function (m) { return { x: ts(m.date), y: m[s.key], note: m.note }; }),
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
      vs.drugs.forEach(function (d, i) {
        var s = shades[shadeKey(d)];
        annotations['drug' + i] = {
          type: 'box',
          xMin: ts(d.start),
          xMax: ts(d.end || todayStr()),
          backgroundColor: withAlpha(s.color, s.alpha),
          borderWidth: 0,
          drawTime: 'beforeDatasetsDraw'
        };
      });
      vs.events.filter(function (e) { return !e.tumorId || e.tumorId === tumor.id; })
        .forEach(function (e, i) {
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
                },
                // the measurement's note, shown once even when two series share the date
                afterBody: function (items) {
                  var notes = [];
                  items.forEach(function (item) {
                    var n = item.raw && item.raw.note;
                    if (n && notes.indexOf(n) === -1) notes.push(n);
                  });
                  return notes;
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

  // ---------------- save chart as PNG ----------------
  // The chart canvas is transparent and has no title, so the export
  // composites it onto a surface-colored canvas with the tumor name drawn in.

  function exportChartPng(card, patient) {
    var tumor = findTumor(card.dataset.tumorId);
    var canvas = card.querySelector('canvas');
    var chart = canvas && Chart.getChart(canvas);
    if (!tumor || !chart) return;
    var typeDef = TYPES[tumor.type];

    var dpr = Math.max(2, window.devicePixelRatio || 1); // at least 2x for crisp exports
    patient = (patient || '').trim();
    // Second title line: "Jane Doe · ID K7F3QX" — or just the ID when no name
    // was given. Real data always has a code by the time a chart is exportable.
    var idLine = (patient ? patient + ' · ' : '') + 'ID ' + (state.code || '');
    var pad = 20, titleH = 52;
    var w = chart.width, h = chart.height;
    var bodyFont = cssVar('--font-body') || 'sans-serif';

    // The overlay legend (medication shades, events) is HTML, not part of the
    // chart canvas — redraw it below the chart so the image stands on its own.
    var shades = drugShadeMap();
    var legendItems = Object.keys(shades).map(function (k) {
      var s = shades[k];
      return { swatch: withAlpha(s.color, s.alpha + 0.1), label: s.name + (s.dose ? ' ' + s.dose : '') };
    });
    if (state.events.some(function (e) { return !e.tumorId || e.tumorId === tumor.id; })) {
      legendItems.push({ tick: true, label: 'events' });
    }

    var out = document.createElement('canvas');
    var ctx = out.getContext('2d');
    var rowH = 19;
    var legendRows = [];
    ctx.font = '500 11px ' + bodyFont;
    var line = [], lx = 0;
    legendItems.forEach(function (it) {
      var itemW = 12 + 5 + ctx.measureText(it.label).width;
      if (line.length && lx + itemW > w) { legendRows.push(line); line = []; lx = 0; }
      it.x = lx;
      line.push(it);
      lx += itemW + 16;
    });
    if (line.length) legendRows.push(line);
    var legendH = legendRows.length ? legendRows.length * rowH + 8 : 0;

    out.width = (w + pad * 2) * dpr;
    out.height = (h + titleH + legendH + pad * 2) * dpr;
    ctx.scale(dpr, dpr); // resizing reset the context, including the font set above

    ctx.fillStyle = cssVar('--surface');
    ctx.fillRect(0, 0, w + pad * 2, h + titleH + legendH + pad * 2);
    ctx.fillStyle = cssVar('--ink');
    ctx.font = '500 18px ' + (cssVar('--font-display') || 'serif');
    ctx.fillText(tumor.name, pad, pad + 16);
    var nameWidth = ctx.measureText(tumor.name).width;
    ctx.fillStyle = cssVar('--ink-3');
    ctx.font = '600 10px ' + (cssVar('--font-body') || 'sans-serif');
    ctx.fillText((typeDef.label + ' · ' + typeDef.unit).toUpperCase(), pad + nameWidth + 10, pad + 15);
    ctx.fillStyle = cssVar('--ink-2');
    ctx.font = 'italic 500 12px ' + (cssVar('--font-body') || 'sans-serif');
    ctx.fillText(idLine, pad, pad + 35);

    ctx.drawImage(canvas, pad, pad + titleH, w, h);

    ctx.font = '500 11px ' + bodyFont;
    legendRows.forEach(function (row, r) {
      var y = pad + titleH + h + 12 + r * rowH;
      row.forEach(function (it) {
        var ix = pad + it.x;
        if (it.tick) {
          ctx.fillStyle = cssVar('--event');
          ctx.fillRect(ix + 5, y, 1.5, 12);
        } else {
          ctx.fillStyle = it.swatch;
          ctx.fillRect(ix, y, 12, 12);
        }
        ctx.fillStyle = cssVar('--ink-2');
        ctx.fillText(it.label, ix + 17, y + 10);
      });
    });

    var slug = function (s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
    var name = [slug(patient), slug(tumor.name)].filter(Boolean).join('-') || 'chart';
    out.toBlob(function (blob) {
      if (!blob) { toast('Could not create the image.'); return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '-' + todayStr() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    }, 'image/png');
  }

  // Save PNG asks for the patient name first. The name is remembered only
  // under PATIENT_NAME_KEY — outside `state` — so it never reaches a JSON
  // export; it exists purely to label the image.
  var pngCard = null; // chart card awaiting the dialog

  $('#charts').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-save-png]');
    if (!btn) return;
    pngCard = btn.closest('.chart-card');
    var input = $('#png-patient-name');
    input.value = '';
    if (!VIEW) {
      try { input.value = localStorage.getItem(PATIENT_NAME_KEY) || ''; } catch (e) {}
    }
    $('#png-dialog').showModal();
  });

  $('#png-cancel').addEventListener('click', function () { $('#png-dialog').close(); });
  $('#png-dialog').addEventListener('close', function () { pngCard = null; });

  // method="dialog" closes the dialog after this handler runs, so pngCard is
  // still set here; a blank submit clears the remembered name.
  $('#png-form').addEventListener('submit', function () {
    var name = $('#png-patient-name').value.trim().slice(0, 80);
    if (!VIEW) {
      try {
        if (name) localStorage.setItem(PATIENT_NAME_KEY, name);
        else localStorage.removeItem(PATIENT_NAME_KEY);
      } catch (e) {}
    }
    if (pngCard) exportChartPng(pngCard, name);
  });

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
        cells += '<td><input type="text" class="note-input" value="' + esc(m.note || '') +
          '" data-mid="' + m.id + '" data-field="note" maxlength="80" aria-label="note"></td>';
        cells += '<td><button type="button" class="icon-btn" data-del-measurement="' + m.id + '" title="Delete this measurement" aria-label="Delete measurement">✕</button></td>';
        return '<tr>' + cells + '</tr>';
      }).join('');

      var newCells = '<td><input type="date" data-new="date" aria-label="new scan date"></td>';
      typeDef.series.forEach(function (s) {
        newCells += '<td><input type="number" step="any" min="0" placeholder="' + esc(s.name) + '" data-new="' + s.key + '" aria-label="new ' + esc(s.name) + '"></td>';
      });
      newCells += '<td><input type="text" class="note-input" placeholder="note" data-new="note" maxlength="80" aria-label="new note"></td>';
      newCells += '<td></td>';

      card.innerHTML =
        '<div class="tumor-card-head">' +
          '<input class="tumor-name-input" type="text" value="' + esc(tumor.name) + '" data-rename maxlength="80" aria-label="Tumor name">' +
          '<span class="type-badge">' + typeDef.label + ' · ' + typeDef.unit + '</span>' +
        '</div>' +
        '<table class="m-table"><thead><tr><th>Scan date</th>' + valueHeads + '<th>Note</th><th></th></tr></thead>' +
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
      if (name) { tumor.name = name; save(); renderAll(); }
      else { input.value = tumor.name; renderTumors(); }
      return;
    }

    if (input.dataset.mid) {
      var m = tumor.measurements.find(function (x) { return x.id === input.dataset.mid; });
      if (!m) return;
      if (input.dataset.field === 'date') {
        if (isDateStr(input.value)) m.date = input.value;
      } else if (input.dataset.field === 'note') {
        m.note = input.value.trim() || null;
        save(); renderCharts();
        return;
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
      // commit right away only when the row is fully filled in AND focus has
      // already left the row — tabbing into the note field must not commit
      // (and rerender) mid-entry. A row still holding focus waits for the
      // focusout handler; the deferred check below sees where focus landed.
      var newRow = input.closest('.new-row');
      setTimeout(function () {
        if (!newRow.isConnected) return;
        if (newRow.contains(document.activeElement)) return;
        tryCommitNewRow(card, tumor, /*requireComplete*/ true);
      }, 0);
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
    var noteInput = row.querySelector('[data-new="note"]');
    var rec = { id: uid(), date: dateInput.value, note: noteInput.value.trim() || null };
    var filled = 0; // a note alone is not a measurement — only values count
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
        // events scoped to the deleted tumor fall back to appearing on every chart
        state.events.forEach(function (e) { if (e.tumorId === tumor.id) e.tumorId = null; });
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

  var editingDrugId = null;

  function renderDrugs() {
    var host = $('#drug-list');
    var shades = drugShadeMap();
    if (!state.drugs.length) {
      host.innerHTML = '<p class="list-empty">No medications recorded yet.</p>';
      return;
    }
    var sorted = state.drugs.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    host.innerHTML = '<div class="row-list">' + sorted.map(function (d) {
      var s = shades[shadeKey(d)];
      return '<div class="data-row' + (d.id === editingDrugId ? ' editing' : '') + '">' +
        '<span class="swatch" style="background:' + withAlpha(s.color, s.alpha + 0.1) + '"></span>' +
        '<span class="row-main">' + esc(d.name) +
          (d.dose ? '<span class="row-dose">' + d.dose + '</span>' : '') + '</span>' +
        '<span class="row-dates">' + fmtDate(d.start) + ' — ' +
          (d.end ? fmtDate(d.end) : '<span class="ongoing">ongoing</span>') + '</span>' +
        '<button type="button" class="icon-btn edit-btn" data-edit-drug="' + d.id + '" title="Edit" aria-label="Edit medication">✎</button>' +
        '<button type="button" class="icon-btn" data-del-drug="' + d.id + '" title="Delete" aria-label="Delete medication">✕</button>' +
        (d.note ? '<div class="row-note-block">' + esc(d.note) + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  // The add form doubles as the edit form: ✎ loads the entry into it,
  // submit saves back, Cancel (or deleting the entry) returns it to add mode.
  function setDrugFormMode() {
    $('#add-drug button[type="submit"]').textContent = editingDrugId ? 'Save changes' : 'Add';
    $('#drug-cancel').hidden = !editingDrugId;
  }

  function exitDrugEdit() {
    editingDrugId = null;
    $('#add-drug').reset();
    setDrugFormMode();
  }

  $('#drug-list').addEventListener('click', function (ev) {
    var editBtn = ev.target.closest('[data-edit-drug]');
    if (editBtn) {
      var d = state.drugs.find(function (x) { return x.id === editBtn.getAttribute('data-edit-drug'); });
      if (!d) return;
      editingDrugId = d.id;
      $('#drug-name').value = d.name;
      $('#drug-start').value = d.start;
      $('#drug-end').value = d.end || '';
      $('#drug-dose').value = d.dose === null ? '' : d.dose;
      $('#drug-note').value = d.note || '';
      setDrugFormMode();
      renderDrugs();
      $('#drug-name').focus();
      return;
    }
    var btn = ev.target.closest('[data-del-drug]');
    if (!btn) return;
    var d = state.drugs.find(function (x) { return x.id === btn.getAttribute('data-del-drug'); });
    if (!d) return;
    if (armTwoStep(btn, '✕')) {
      if (d.id === editingDrugId) exitDrugEdit();
      state.drugs = state.drugs.filter(function (x) { return x.id !== d.id; });
      save(); renderAll();
      toast('Deleted ' + d.name);
    }
  });

  $('#drug-cancel').addEventListener('click', function () {
    exitDrugEdit();
    renderDrugs();
  });

  $('#add-drug').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('#drug-name').value.trim();
    var start = $('#drug-start').value;
    var end = $('#drug-end').value || null;
    var doseV = $('#drug-dose').value === '' ? null : parseFloat($('#drug-dose').value);
    var dose = isNum(doseV) && doseV > 0 ? doseV : null;
    var note = $('#drug-note').value.trim() || null;
    if (!name || !isDateStr(start)) return;
    if (end && end < start) { toast('The end date is before the start date.'); return; }
    if (editingDrugId) {
      var d = state.drugs.find(function (x) { return x.id === editingDrugId; });
      if (d) { d.name = name; d.start = start; d.end = end; d.dose = dose; d.note = note; }
      exitDrugEdit();
    } else {
      state.drugs.push({ id: uid(), name: name, start: start, end: end, dose: dose, note: note });
      ev.target.reset();
    }
    save(); renderAll();
  });

  // ---------------- events section ----------------

  var editingEventId = null;

  // Keep the "Applies to" dropdown in sync with the tumor list, preserving the selection.
  function refreshEventTumorOptions() {
    var sel = $('#event-tumor');
    var current = sel.value;
    sel.innerHTML = '<option value="">Any tumor</option>' + state.tumors.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.name) + '</option>';
    }).join('');
    sel.value = current;
    if (sel.selectedIndex === -1) sel.selectedIndex = 0;
  }

  function renderEvents() {
    var host = $('#event-list');
    if (!state.events.length) {
      host.innerHTML = '<p class="list-empty">No events recorded yet.</p>';
      return;
    }
    var sorted = state.events.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    host.innerHTML = '<div class="row-list">' + sorted.map(function (e) {
      var scope = e.tumorId ? findTumor(e.tumorId) : null;
      return '<div class="data-row' + (e.id === editingEventId ? ' editing' : '') + '">' +
        '<span class="tick"></span>' +
        '<span class="row-main">' + esc(e.label) +
          (scope ? '<span class="row-note">' + esc(scope.name) + '</span>' : '') + '</span>' +
        '<span class="row-dates">' + fmtDate(e.date) + '</span>' +
        '<button type="button" class="icon-btn edit-btn" data-edit-event="' + e.id + '" title="Edit" aria-label="Edit event">✎</button>' +
        '<button type="button" class="icon-btn" data-del-event="' + e.id + '" title="Delete" aria-label="Delete event">✕</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  function setEventFormMode() {
    $('#add-event button[type="submit"]').textContent = editingEventId ? 'Save changes' : 'Add';
    $('#event-cancel').hidden = !editingEventId;
  }

  function exitEventEdit() {
    editingEventId = null;
    $('#add-event').reset();
    setEventFormMode();
  }

  $('#event-list').addEventListener('click', function (ev) {
    var editBtn = ev.target.closest('[data-edit-event]');
    if (editBtn) {
      var e = state.events.find(function (x) { return x.id === editBtn.getAttribute('data-edit-event'); });
      if (!e) return;
      editingEventId = e.id;
      $('#event-date').value = e.date;
      $('#event-label').value = e.label;
      $('#event-tumor').value = e.tumorId || '';
      setEventFormMode();
      renderEvents();
      $('#event-label').focus();
      return;
    }
    var btn = ev.target.closest('[data-del-event]');
    if (!btn) return;
    if (armTwoStep(btn, '✕')) {
      if (btn.getAttribute('data-del-event') === editingEventId) exitEventEdit();
      state.events = state.events.filter(function (x) { return x.id !== btn.getAttribute('data-del-event'); });
      save(); renderAll();
      toast('Event deleted');
    }
  });

  $('#event-cancel').addEventListener('click', function () {
    exitEventEdit();
    renderEvents();
  });

  $('#add-event').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var date = $('#event-date').value;
    var label = $('#event-label').value.trim();
    var tumorId = findTumor($('#event-tumor').value) ? $('#event-tumor').value : null;
    if (!isDateStr(date) || !label) return;
    if (editingEventId) {
      var e = state.events.find(function (x) { return x.id === editingEventId; });
      if (e) { e.date = date; e.label = label; e.tumorId = tumorId; }
      exitEventEdit();
    } else {
      state.events.push({ id: uid(), date: date, label: label, tumorId: tumorId });
      ev.target.reset();
    }
    save(); renderAll();
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
    armedTimer = setTimeout(disarm, 5000);
    return false;
  }

  // ---------------- export / import ----------------

  function exportData() {
    // Backups carry the publish token (outside `state`) so a restored backup
    // can still update the published copy. The server strips it on publish.
    var out = state;
    var token = getPublishToken();
    if (token) {
      out = {};
      for (var k in state) { if (Object.prototype.hasOwnProperty.call(state, k)) out[k] = state[k]; }
      out.publishToken = token;
    }
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
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
      var parsed = null, incoming = null;
      try { parsed = JSON.parse(reader.result); incoming = normalize(parsed); }
      catch (e) {}
      if (!incoming) { toast('That file doesn’t look like a Tumor Tracker backup.'); return; }
      if (hasData(state)) {
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
      // The imported dataset replaces everything — including publish rights.
      if (parsed && typeof parsed.publishToken === 'string' && TOKEN_RE.test(parsed.publishToken)) {
        setPublished(parsed.publishToken, null);
        try { localStorage.removeItem(PUBLISHED_AT_KEY); } catch (e2) {}
      } else {
        clearPublished();
      }
      save(); renderAll();
      toast('Data imported.');
    };
    reader.readAsText(file);
  });

  // ---------------- publishing ----------------
  // Everything here is explicit user action; the app never publishes or
  // updates the public copy on its own.

  function apiFetch(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ').'));
        return data;
      });
    });
  }

  function canPublish() {
    return state.tumors.some(function (t) { return t.measurements.length >= 2; });
  }

  function renderPublish() {
    if (VIEW) { $('#publish-section').hidden = true; return; }
    var dataExists = hasData(state);
    var token = getPublishToken();
    $('#publish-section').hidden = !dataExists;
    if (!dataExists) return;
    $('#btn-publish').hidden = !!token;
    $('#btn-publish').disabled = !canPublish();
    $('#btn-publish').title = canPublish() ? '' : 'Needs at least one tumor with two measurements.';
    $('#btn-publish-update').hidden = !token;
    $('#btn-unpublish').hidden = !token;
    var link = $('#publish-link');
    link.hidden = !token;
    if (token) link.href = '/p/' + state.code;
    var status = $('#publish-status');
    var at = null;
    try { at = localStorage.getItem(PUBLISHED_AT_KEY); } catch (e) {}
    status.hidden = !token;
    if (token) {
      status.textContent = 'Published as ' + state.code +
        (at ? ' · last pushed ' + new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
    }
  }

  // Everything free-text, grouped, so the user can screen it before it goes public.
  function publishPreviewHtml() {
    var html = '<h4>Diagnosis</h4><p>' + esc(state.diagnosis || DEFAULT_DIAGNOSIS) + '</p>';
    html += '<h4>Tumors &amp; measurement notes</h4><ul>';
    state.tumors.forEach(function (t) {
      html += '<li>' + esc(t.name) + ' — ' + t.measurements.length + ' measurement(s)';
      t.measurements.forEach(function (m) {
        if (m.note) html += '<br><span class="preview-note">' + esc(fmtDate(m.date) + ': ' + m.note) + '</span>';
      });
      html += '</li>';
    });
    html += '</ul>';
    if (state.drugs.length) {
      html += '<h4>Medications</h4><ul>';
      state.drugs.forEach(function (d) {
        html += '<li>' + esc(d.name) + (d.dose ? ' · ' + d.dose : '') +
          ' · ' + esc(fmtDate(d.start)) + ' – ' + (d.end ? esc(fmtDate(d.end)) : 'ongoing');
        if (d.note) html += '<br><span class="preview-note">' + esc(d.note) + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }
    if (state.events.length) {
      html += '<h4>Events</h4><ul>';
      state.events.forEach(function (e) {
        html += '<li>' + esc(fmtDate(e.date) + ': ' + e.label) + '</li>';
      });
      html += '</ul>';
    }
    return html;
  }

  function pushPublish(token) {
    var body = { code: state.code, data: JSON.parse(JSON.stringify(state)) };
    if (token) body.token = token;
    return apiFetch('POST', '/api/publish', body);
  }

  $('#btn-publish').addEventListener('click', function () {
    $('#publish-dialog-code').textContent = state.code || '';
    $('#publish-preview').innerHTML = publishPreviewHtml();
    $('#publish-consent').checked = false;
    $('#publish-confirm').disabled = true;
    $('#publish-dialog').showModal();
  });

  $('#publish-consent').addEventListener('change', function () {
    $('#publish-confirm').disabled = !this.checked;
  });
  $('#publish-cancel').addEventListener('click', function () { $('#publish-dialog').close(); });

  $('#publish-form').addEventListener('submit', function () {
    pushPublish(null).then(function (res) {
      if (res.token) setPublished(res.token, res.summary.updatedAt);
      renderPublish();
      toast('Published — thank you for sharing.');
    }).catch(function (err) {
      toast('Could not publish: ' + err.message);
    });
  });

  $('#btn-publish-update').addEventListener('click', function () {
    var token = getPublishToken();
    if (!token) return;
    pushPublish(token).then(function (res) {
      setPublished(token, res.summary.updatedAt);
      renderPublish();
      toast('Published copy updated.');
    }).catch(function (err) {
      // A 403 here means the stored token no longer matches the server's —
      // e.g. a backup restored without its token. Per spec, explain and point
      // at the removal path instead of offering a confusing publish-as-new.
      var hint = /token does not match/.test(err.message)
        ? ' This copy can no longer update the public page. To remove the public copy, contact the site owner (see the footer).'
        : '';
      toast('Could not update: ' + err.message + hint);
    });
  });

  $('#btn-unpublish').addEventListener('click', function () {
    if (!armTwoStep(this, 'Click again to remove from the public gallery')) return;
    var token = getPublishToken();
    if (!token) return;
    apiFetch('DELETE', '/api/published/' + state.code, { token: token }).then(function () {
      clearPublished();
      renderPublish();
      toast('Removed from the public gallery.');
    }).catch(function (err) {
      toast('Could not unpublish: ' + err.message);
    });
  });

  // ---------------- onboarding ----------------

  $('#btn-start').addEventListener('click', function () {
    $('#add-tumor').scrollIntoView({ behavior: 'smooth', block: 'center' });
    // focus without scrolling, or it would cut the smooth scroll short
    $('#tumor-name').focus({ preventScroll: true });
  });

  // ---------------- clear all data ----------------

  $('#btn-clear').addEventListener('click', function () {
    if (!armTwoStep(this, 'Click again to delete everything')) return;
    var pubToken = getPublishToken();
    if (pubToken && state.code) {
      var alsoUnpublish = window.confirm(
        'This data is also published publicly as ID ' + state.code + '.\n\n' +
        'Clearing this browser does NOT remove the public copy.\n\n' +
        'OK = also remove it from the public gallery\nCancel = leave it published'
      );
      if (alsoUnpublish) {
        apiFetch('DELETE', '/api/published/' + state.code, { token: pubToken })
          .then(function () { toast('Removed from the public gallery.'); })
          .catch(function () { toast('Could not reach the server to unpublish.'); });
      }
    }
    clearPublished();
    exitDrugEdit();
    exitEventEdit();
    state = blankState();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderAll();
    toast('All data deleted from this browser.');
  });

  // ---------------- theme changes ----------------

  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', function () { renderAll(); });

  // ---------------- go ----------------

  Chart.register(window['chartjs-plugin-annotation']);
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  function bootPatientView() {
    document.body.classList.add('viewer');
    var robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    document.title = 'Tumor Tracker — public view ' + VIEW.code;
    var note = $('#viewer-note');
    note.hidden = false;
    note.textContent = 'Loading published data…';
    apiFetch('GET', '/api/published/' + VIEW.code).then(function (res) {
      var incoming = normalize(res.data);
      if (!incoming) throw new Error('unreadable data');
      state = incoming;
      var updated = res.summary && res.summary.updatedAt
        ? new Date(res.summary.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
      note.innerHTML = 'Public view — read-only, shared anonymously' +
        (updated ? ' · updated ' + esc(updated) : '') +
        ' · <a href="/explore">all published datasets</a> · <a href="/">track your own</a>';
      renderAll();
    }).catch(function (err) {
      note.textContent = /404|Not published/.test(err.message)
        ? 'Nothing is published under ID ' + VIEW.code + ' (anymore).'
        : 'Could not load this published dataset — please try again later.';
    });
  }

  function bootExploreView() {
    document.body.classList.add('viewer', 'viewer-explore');
    var robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    document.title = 'Tumor Tracker — published datasets';
    var note = $('#viewer-note');
    note.hidden = false;
    note.innerHTML = 'Anonymously shared by patients using this tracker · <a href="/">track your own</a>';
    $('#explore-section').hidden = false;
    var host = $('#explore-list');
    host.innerHTML = '<p class="explore-empty">Loading…</p>';
    apiFetch('GET', '/api/published').then(function (res) {
      if (!res.items.length) {
        host.innerHTML = '<p class="explore-empty">Nothing has been published yet. ' +
          'Be the first — open <a href="/">your tracker</a> and choose “Publish anonymously”.</p>';
        return;
      }
      host.innerHTML = res.items.map(function (s) {
        var span = s.firstDate && s.lastDate ? fmtDate(s.firstDate) + ' – ' + fmtDate(s.lastDate) : '';
        return '<a class="explore-card" href="/p/' + esc(s.code) + '">' +
          '<span class="explore-code">' + esc(s.code) + '</span>' +
          '<span class="explore-diagnosis">' + esc(s.diagnosis || '') + '</span>' +
          '<p>' + s.tumorCount + ' tumor' + (s.tumorCount === 1 ? '' : 's') + ' · ' +
            s.measurementCount + ' measurement' + (s.measurementCount === 1 ? '' : 's') +
            (span ? '<br>' + esc(span) : '') +
            (s.updatedAt ? '<br>updated ' + esc(new Date(s.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })) : '') +
          '</p></a>';
      }).join('');
    }).catch(function () {
      host.innerHTML = '<p class="explore-empty">Could not load the gallery — please try again later.</p>';
    });
  }

  if (!VIEW) {
    renderAll();
  } else if (VIEW.mode === 'patient') {
    bootPatientView();
  } else {
    bootExploreView();
  }
})();
