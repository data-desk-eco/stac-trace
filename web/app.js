// ── Colours ───────────────────────────────────────────────────────
const OPERATOR_COLORS = {
  maxar: '#e05555', airbus: '#5588cc', planet: '#44aa77',
  iceye: '#cc9944', capella: '#cc9944', satellogic: '#9977bb',
  '21at': '#55aabb', government: '#cccc44', other: '#778899',
};

// Map STAC constellation → operator (for colouring footprints)
const CONSTELLATION_OPERATORS = {
  phr: 'airbus', pneo: 'airbus', 'pneo-hd15': 'airbus', spot: 'airbus',
  skysat: 'planet',
  'capella-geo': 'capella', 'capella-slc': 'capella', 'capella-sicd': 'capella', 'capella-gec': 'capella',
  'beijing-3a': '21at', 'beijing-3n': '21at',
  'worldview-legion': 'maxar', worldview: 'maxar', geoeye: 'maxar',
  iceye: 'iceye',
};

// Map TLE constellation → STAC constellations (for satellite selection filtering)
const CONSTELLATION_MAP = {
  pleiades: ['phr', 'pneo', 'pneo-hd15'],
  spot: ['spot'],
  capella: ['capella-geo', 'capella-slc', 'capella-sicd', 'capella-gec'],
  skysat: ['skysat'],
  worldview: ['worldview', 'worldview-legion', 'geoeye'],
  legion: ['worldview-legion'],
};

const DATA_BASE = 'data';

// ── Trail config ──────────────────────────────────────────────────
const TRAIL_UPDATE_MS = 5000;
const TRAIL_BANDS = [
  { from: 0,    to: 0.25, opacity: 0.3 },
  { from: 0.25, to: 0.5,  opacity: 0.15 },
  { from: 0.5,  to: 0.75, opacity: 0.08 },
  { from: 0.75, to: 1.0,  opacity: 0.03 },
];
const DIM_OPACITY = 0.08;

// ── State ─────────────────────────────────────────────────────────
let satellites = [];
let disabledOperators = new Set();
let selectedSat = null;
let lastTrailUpdate = 0;
let duckdbConn = null;
let dateCounts = [];     // [{date: 'YYYY-MM-DD', count: N}, ...]
let rangeStart = -1;     // index into dateCounts
let rangeEnd = -1;

// Playback state
let playing = false;
let playbackTime = null;     // Date object for current playback time
let playbackFeatures = [];   // all footprints for range, sorted by datetime
let playbackSpeed = 3600;    // seconds of real time per animation frame (~1hr/frame)
let playbackRafId = null;

// ── TLE parsing ───────────────────────────────────────────────────
function parseTLEs(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const tles = [];
  for (let i = 0; i + 2 < lines.length;) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      tles.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
      i += 3;
    } else {
      i++;
    }
  }
  return tles;
}

function extractNoradId(line1) {
  return parseInt(line1.substring(2, 7).trim(), 10);
}

// ── Satellite propagation ─────────────────────────────────────────
function propagate(satrec, date) {
  const posVel = satellite.propagate(satrec, date);
  if (!posVel.position || typeof posVel.position === 'boolean') return null;
  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(posVel.position, gmst);
  return {
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
    alt_km: geo.height,
  };
}

// ── Map setup ─────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      carto: {
        type: 'raster',
        tiles: ['https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png'],
        tileSize: 256,
      },
      labels: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
      },
    },
    layers: [
      { id: 'basemap', type: 'raster', source: 'carto' },
      {
        id: 'country-borders', type: 'line', source: 'labels',
        'source-layer': 'boundary',
        filter: ['==', ['get', 'admin_level'], 2],
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.15)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.5],
        },
      },
      {
        id: 'country-labels', type: 'symbol', source: 'labels',
        'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'country'],
        minzoom: 2,
        layout: {
          'symbol-sort-key': ['get', 'rank'],
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.15,
          'text-max-width': 8,
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-color': 'rgba(0, 0, 0, 0.6)',
          'text-halo-width': 1.5,
        },
      },
    ],
  },
  center: [20, 30],
  zoom: 1.8,
});

map.on('style.load', () => {
  map.setProjection({ type: 'globe' });
});

// ── Loading progress ─────────────────────────────────────────────
function setLoadingStatus(msg) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

function dismissLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('done');
}

// ── DuckDB-WASM setup ────────────────────────────────────────────
async function initDuckDB() {
  setLoadingStatus('Loading DuckDB...');
  const DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/';
  const duckdb = await import(DUCKDB_CDN + 'duckdb-browser.mjs');
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: DUCKDB_CDN + 'duckdb-mvp.wasm', mainWorker: DUCKDB_CDN + 'duckdb-browser-mvp.worker.js' },
    eh: { mainModule: DUCKDB_CDN + 'duckdb-eh.wasm', mainWorker: DUCKDB_CDN + 'duckdb-browser-eh.worker.js' },
  });
  setLoadingStatus('Initialising query engine...');
  const workerScript = await fetch(bundle.mainWorker).then(r => r.text());
  const workerBlob = new Blob([workerScript], { type: 'text/javascript' });
  const worker = new Worker(URL.createObjectURL(workerBlob));
  const logger = new duckdb.VoidLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule);
  return await db.connect();
}

// ── Parquet URL ──────────────────────────────────────────────────
function parquetUrl() {
  return `${location.origin}${location.pathname}data/footprints.parquet`;
}

// ── Data loading ──────────────────────────────────────────────────
map.on('load', async () => {
  // Add empty sources
  map.addSource('satellites', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addSource('collection', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addSource('selected-trail', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Footprint polygons (below trails and satellites)
  map.addLayer({
    id: 'footprints',
    type: 'fill',
    source: 'collection',
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': 0.25,
      'fill-outline-color': ['get', 'outlineColor'],
    },
  });

  // Satellite trail (shown on selection)
  map.addLayer({
    id: 'selected-trail',
    type: 'line',
    source: 'selected-trail',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'width'],
      'line-opacity': ['get', 'opacity'],
      'line-dasharray': [2, 3],
    },
  });

  // Satellite dots
  map.addLayer({
    id: 'sat-dots',
    type: 'circle',
    source: 'satellites',
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': 'transparent',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': ['get', 'dotOpacity'],
    },
  });

  // Load data in parallel
  setLoadingStatus('Loading satellite data...');
  const [tleText, metaJson, conn] = await Promise.all([
    fetch(`${DATA_BASE}/tles.txt`).then(r => r.ok ? r.text() : ''),
    fetch(`${DATA_BASE}/satellites.json`).then(r => r.ok ? r.json() : {}),
    initDuckDB(),
  ]);
  duckdbConn = conn;

  // Parse TLEs and merge metadata
  const tles = parseTLEs(tleText);
  satellites = tles.map(tle => {
    const noradId = extractNoradId(tle.line1);
    const meta = metaJson[String(noradId)] || {};
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    return {
      name: tle.name,
      noradId,
      satrec,
      operator: meta.operator || 'other',
      constellation: meta.constellation || 'unknown',
      color: meta.color || OPERATOR_COLORS.other,
      resolution_m: meta.resolution_m,
    };
  });

  console.log(`Loaded ${satellites.length} satellites`);

  // Build legend
  buildLegend();

  // Load date histogram and init slider
  setLoadingStatus('Loading imagery dates...');
  await initDateSlider();

  // Ready
  dismissLoading();
  tick();
});

// ── Animation loop ────────────────────────────────────────────────
function tick() {
  if (playing) return; // playback has its own loop

  const now = new Date();
  const nowMs = now.getTime();
  propagateSatellites(now);

  if (selectedSat && nowMs - lastTrailUpdate > TRAIL_UPDATE_MS) {
    lastTrailUpdate = nowMs;
    updateTrails(now);
  }

  requestAnimationFrame(tick);
}

function propagateSatellites(time) {
  const features = [];
  for (const sat of satellites) {
    if (disabledOperators.has(sat.operator)) continue;
    const pos = propagate(sat.satrec, time);
    if (!pos) continue;

    const isSelected = selectedSat && sat.noradId === selectedSat.noradId;
    const isDimmed = selectedSat && !isSelected;

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
      properties: {
        name: sat.name,
        operator: sat.operator,
        constellation: sat.constellation,
        alt_km: Math.round(pos.alt_km),
        color: sat.color,
        noradId: sat.noradId,
        radius: isSelected ? 10 : 7,
        dotOpacity: isDimmed ? DIM_OPACITY : 0.9,
      },
    });
  }
  map.getSource('satellites').setData({ type: 'FeatureCollection', features });
}

function getOrbitalPeriodMin(satrec) {
  return (2 * Math.PI) / satrec.no;
}

function updateTrails(now) {
  if (!selectedSat) return;
  const sat = selectedSat;

  // Trail covers the selected date range
  const rangeStartDate = rangeStart >= 0
    ? new Date(dateCounts[rangeStart].date + 'T00:00:00Z')
    : new Date(now.getTime() - 7 * 86400000);
  const rangeEndDate = rangeEnd >= 0
    ? new Date(dateCounts[rangeEnd].date + 'T23:59:59Z')
    : now;
  const totalSec = (rangeEndDate.getTime() - rangeStartDate.getTime()) / 1000;
  const periodMin = getOrbitalPeriodMin(sat.satrec);
  const periodSec = periodMin * 60;
  // Sample one point per ~30s of orbital time for smooth lines
  const stepSec = 30;
  const totalPoints = Math.min(Math.ceil(totalSec / stepSec), 50000);

  const positions = [];
  for (let i = 0; i <= totalPoints; i++) {
    const secFromEnd = i * stepSec;
    const t = new Date(rangeEndDate.getTime() - secFromEnd * 1000);
    const pos = propagate(sat.satrec, t);
    if (pos) positions.push([pos.lon, pos.lat, secFromEnd / totalSec]);
  }

  if (positions.length < 2) return;

  // Fade trail: recent orbits brighter, older ones fainter
  const features = [];
  for (const band of TRAIL_BANDS) {
    const bandPts = positions.filter(p => p[2] >= band.from && p[2] <= band.to);
    if (bandPts.length < 2) continue;

    const coords = bandPts.map(p => [p[0], p[1]]);
    const segments = splitAtAntimeridian(coords);

    for (const seg of segments) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: seg },
        properties: { color: sat.color, opacity: band.opacity, width: 2 },
      });
    }
  }

  map.getSource('selected-trail').setData({ type: 'FeatureCollection', features });
}

// ── Playback ─────────────────────────────────────────────────────
async function startPlayback() {
  if (playing) return;
  if (rangeStart < 0 || rangeEnd < 0) return;

  // Load all footprints for the range, sorted by time
  const constellations = getEnabledConstellations();
  if (constellations.length === 0) return;

  const startDate = dateCounts[rangeStart].date;
  const endDate = dateCounts[rangeEnd].date;
  const inList = constellations.map(c => `'${c}'`).join(', ');

  setLoadingStatus('Loading playback data...');
  document.getElementById('loading').classList.remove('done');

  const result = await duckdbConn.query(`
    SELECT id, constellation,
           STRFTIME(datetime, '%Y-%m-%dT%H:%M:%S') AS dt,
           resolution, geojson
    FROM '${parquetUrl()}'
    WHERE STRFTIME(CAST(datetime AS DATE), '%Y-%m-%d') BETWEEN '${startDate}' AND '${endDate}'
      AND constellation IN (${inList})
    ORDER BY datetime
  `);

  playbackFeatures = [];
  for (let i = 0; i < result.numRows; i++) {
    const constellation = result.getChildAt(1).get(i);
    const operator = CONSTELLATION_OPERATORS[constellation] || 'other';
    const color = OPERATOR_COLORS[operator] || OPERATOR_COLORS.other;
    const geojson = JSON.parse(result.getChildAt(4).get(i));
    const dt = result.getChildAt(2).get(i);

    playbackFeatures.push({
      type: 'Feature',
      geometry: geojson,
      timestamp: new Date(dt + 'Z').getTime(),
      properties: {
        id: result.getChildAt(0).get(i),
        constellation,
        datetime: dt.replace('T', ' '),
        resolution: result.getChildAt(3).get(i),
        color,
        outlineColor: color + '26',
      },
    });
  }

  dismissLoading();

  playing = true;
  playbackTime = new Date(startDate + 'T00:00:00Z');
  document.getElementById('play-btn').textContent = '■';
  document.getElementById('play-btn').classList.add('playing');
  map.setLayoutProperty('sat-dots', 'visibility', 'none');

  console.log(`Playback: ${playbackFeatures.length} footprints, ${startDate} to ${endDate}`);
  playbackTick();
}

function stopPlayback() {
  playing = false;
  playbackTime = null;
  playbackFeatures = [];
  if (playbackRafId) cancelAnimationFrame(playbackRafId);
  playbackRafId = null;

  document.getElementById('play-btn').textContent = '▶';
  document.getElementById('play-btn').classList.remove('playing');
  map.setLayoutProperty('sat-dots', 'visibility', 'visible');

  // Return to live mode
  loadFootprintsForRange();
  tick();
}

function playbackTick() {
  if (!playing) return;

  const endTime = new Date(dateCounts[rangeEnd].date + 'T23:59:59Z').getTime();
  const startTime = new Date(dateCounts[rangeStart].date + 'T00:00:00Z').getTime();

  // Advance time
  playbackTime = new Date(playbackTime.getTime() + playbackSpeed * 1000);

  if (playbackTime.getTime() > endTime) {
    stopPlayback();
    return;
  }

  // Hide satellites during playback (they move too fast to be useful)

  // Show footprints acquired up to playback time
  const currentMs = playbackTime.getTime();
  const visible = playbackFeatures.filter(f => f.timestamp <= currentMs);
  map.getSource('collection').setData({ type: 'FeatureCollection', features: visible });

  // Update slider label to show playback time
  const progress = (currentMs - startTime) / (endTime - startTime);
  const dateStr = playbackTime.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const container = document.getElementById('slider-labels');
  container.innerHTML = `
    <span>${dateCounts[rangeStart].date}</span>
    <span class="current">${dateStr} · ${visible.length} images</span>
    <span>${dateCounts[rangeEnd].date}</span>
  `;

  playbackRafId = requestAnimationFrame(playbackTick);
}

// ── Date slider ──────────────────────────────────────────────────
async function initDateSlider() {
  if (!duckdbConn) return;

  const result = await duckdbConn.query(`
    SELECT STRFTIME(CAST(datetime AS DATE), '%Y-%m-%d') AS date, COUNT(*) AS n
    FROM '${parquetUrl()}'
    GROUP BY date ORDER BY date
  `);

  dateCounts = [];
  for (let i = 0; i < result.numRows; i++) {
    dateCounts.push({
      date: result.getChildAt(0).get(i),
      count: Number(result.getChildAt(1).get(i)),
    });
  }

  if (dateCounts.length === 0) return;

  buildHistogram();
  buildSliderTicks();
  initRangeInteraction();

  document.getElementById('date-slider').classList.add('active');

  // Default: last 3 days
  // Play button
  document.getElementById('play-btn').addEventListener('click', () => {
    if (playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  setRange(Math.max(0, dateCounts.length - 3), dateCounts.length - 1);
}

function idxToPercent(i) {
  return dateCounts.length <= 1 ? 0 : (i / (dateCounts.length - 1)) * 100;
}

function percentToIdx(pct) {
  return Math.round((pct / 100) * (dateCounts.length - 1));
}

function buildHistogram() {
  const container = document.getElementById('slider-histogram');
  container.innerHTML = '';
  const maxCount = Math.max(...dateCounts.map(d => d.count));

  dateCounts.forEach((d, i) => {
    const bar = document.createElement('div');
    bar.className = 'histo-bar';
    bar.style.left = `${idxToPercent(i)}%`;
    bar.style.height = `${Math.max(1, (d.count / maxCount) * 24)}px`;
    container.appendChild(bar);
  });
}

function buildSliderTicks() {
  const container = document.getElementById('slider-ticks');
  container.innerHTML = '';
  let lastMonth = '';
  dateCounts.forEach((d, i) => {
    const month = d.date.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = `${idxToPercent(i)}%`;
      container.appendChild(tick);
    }
  });
}

function updateRangeUI() {
  const rangeEl = document.getElementById('slider-range');
  rangeEl.style.left = `${idxToPercent(rangeStart)}%`;
  rangeEl.style.right = `${100 - idxToPercent(rangeEnd)}%`;

  // Highlight histogram bars in range
  const bars = document.querySelectorAll('#slider-histogram .histo-bar');
  bars.forEach((bar, i) => {
    bar.classList.toggle('active', i >= rangeStart && i <= rangeEnd);
  });

  // Labels
  const totalImages = dateCounts.slice(rangeStart, rangeEnd + 1).reduce((s, d) => s + d.count, 0);
  const container = document.getElementById('slider-labels');
  if (rangeStart === rangeEnd) {
    container.innerHTML = `
      <span>${dateCounts[0].date}</span>
      <span class="current">${dateCounts[rangeStart].date} · ${totalImages.toLocaleString()} images</span>
      <span>${dateCounts[dateCounts.length - 1].date}</span>
    `;
  } else {
    container.innerHTML = `
      <span>${dateCounts[0].date}</span>
      <span class="current">${dateCounts[rangeStart].date} to ${dateCounts[rangeEnd].date} · ${totalImages.toLocaleString()} images</span>
      <span>${dateCounts[dateCounts.length - 1].date}</span>
    `;
  }
}

function setRange(start, end, skipLoad) {
  start = Math.max(0, Math.min(start, dateCounts.length - 1));
  end = Math.max(0, Math.min(end, dateCounts.length - 1));
  if (start > end) [start, end] = [end, start];
  if (start === rangeStart && end === rangeEnd) return;
  rangeStart = start;
  rangeEnd = end;
  updateRangeUI();
  if (!skipLoad) {
    loadFootprintsForRange();
    if (selectedSat) {
      lastTrailUpdate = 0;
      updateTrails(new Date());
    }
  }
}

function initRangeInteraction() {
  const track = document.getElementById('slider-track');
  const rangeEl = document.getElementById('slider-range');
  let dragMode = null; // 'start', 'end', 'slide', or null
  let dragStartX = 0;
  let dragStartIdxA = 0;
  let dragStartIdxB = 0;

  function xToIdx(clientX) {
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    return percentToIdx(pct);
  }

  // Determine drag mode from click position relative to range handles
  rangeEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = rangeEl.getBoundingClientRect();
    const edgeZone = 10; // px from edge to count as handle drag
    if (e.clientX - rect.left < edgeZone) {
      dragMode = 'start';
    } else if (rect.right - e.clientX < edgeZone) {
      dragMode = 'end';
    } else {
      dragMode = 'slide';
    }
    dragStartX = e.clientX;
    dragStartIdxA = rangeStart;
    dragStartIdxB = rangeEnd;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onDragEnd);
  });

  // Click on track outside range: move nearest handle
  track.addEventListener('mousedown', (e) => {
    if (e.target === rangeEl || rangeEl.contains(e.target)) return;
    const idx = xToIdx(e.clientX);
    // Move whichever handle is closer
    const distToStart = Math.abs(idx - rangeStart);
    const distToEnd = Math.abs(idx - rangeEnd);
    if (distToStart <= distToEnd) {
      setRange(idx, rangeEnd);
    } else {
      setRange(rangeStart, idx);
    }
  });

  function onDrag(e) {
    const idx = xToIdx(e.clientX);
    if (dragMode === 'start') {
      setRange(idx, rangeEnd, true);
    } else if (dragMode === 'end') {
      setRange(rangeStart, idx, true);
    } else if (dragMode === 'slide') {
      const trackRect = track.getBoundingClientRect();
      const dxPct = ((e.clientX - dragStartX) / trackRect.width) * 100;
      const dIdx = percentToIdx(dxPct + idxToPercent(dragStartIdxA)) - dragStartIdxA;
      const span = dragStartIdxB - dragStartIdxA;
      let newStart = dragStartIdxA + dIdx;
      let newEnd = newStart + span;
      if (newStart < 0) { newStart = 0; newEnd = span; }
      if (newEnd >= dateCounts.length) { newEnd = dateCounts.length - 1; newStart = newEnd - span; }
      setRange(newStart, newEnd, true);
    }
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onDragEnd);
    dragMode = null;
    loadFootprintsForRange();
  }

  // Touch support
  rangeEl.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    const rect = rangeEl.getBoundingClientRect();
    const edgeZone = 20;
    if (touch.clientX - rect.left < edgeZone) {
      dragMode = 'start';
    } else if (rect.right - touch.clientX < edgeZone) {
      dragMode = 'end';
    } else {
      dragMode = 'slide';
    }
    dragStartX = touch.clientX;
    dragStartIdxA = rangeStart;
    dragStartIdxB = rangeEnd;
    document.addEventListener('touchmove', onTouchDrag, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  });

  function onTouchDrag(e) {
    e.preventDefault();
    onDrag({ clientX: e.touches[0].clientX });
  }

  function onTouchEnd() {
    document.removeEventListener('touchmove', onTouchDrag);
    document.removeEventListener('touchend', onTouchEnd);
    dragMode = null;
    loadFootprintsForRange();
  }
}

// ── Footprint loading ────────────────────────────────────────────
function getEnabledConstellations() {
  // Get STAC constellation names for operators that are in the legend and not disabled
  const legendOperators = new Set(satellites.map(s => s.operator));
  const enabled = [];
  for (const [constellation, operator] of Object.entries(CONSTELLATION_OPERATORS)) {
    if (legendOperators.has(operator) && !disabledOperators.has(operator)) {
      enabled.push(constellation);
    }
  }
  // If a satellite is selected, filter to just that satellite's constellations
  if (selectedSat) {
    const satConstellations = CONSTELLATION_MAP[selectedSat.constellation] || [selectedSat.constellation];
    return enabled.filter(c => satConstellations.includes(c));
  }
  return enabled;
}

async function loadFootprintsForRange() {
  if (!duckdbConn || rangeStart < 0) return;

  const constellations = getEnabledConstellations();
  if (constellations.length === 0) {
    map.getSource('collection').setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const startDate = dateCounts[rangeStart].date;
  const endDate = dateCounts[rangeEnd].date;
  const inList = constellations.map(c => `'${c}'`).join(', ');
  const result = await duckdbConn.query(`
    SELECT id, constellation,
           STRFTIME(datetime, '%Y-%m-%d %H:%M') AS dt,
           resolution, geojson
    FROM '${parquetUrl()}'
    WHERE STRFTIME(CAST(datetime AS DATE), '%Y-%m-%d') BETWEEN '${startDate}' AND '${endDate}'
      AND constellation IN (${inList})
  `);

  const features = [];
  for (let i = 0; i < result.numRows; i++) {
    const constellation = result.getChildAt(1).get(i);
    const operator = CONSTELLATION_OPERATORS[constellation] || 'other';
    const color = OPERATOR_COLORS[operator] || OPERATOR_COLORS.other;
    const geojson = JSON.parse(result.getChildAt(4).get(i));
    const dt = result.getChildAt(2).get(i);

    features.push({
      type: 'Feature',
      geometry: geojson,
      properties: {
        id: result.getChildAt(0).get(i),
        constellation,
        datetime: dt,
        resolution: result.getChildAt(3).get(i),
        color,
        outlineColor: color + '26', // hex + 15% alpha
      },
    });
  }

  map.getSource('collection').setData({ type: 'FeatureCollection', features });
  console.log(`Loaded ${features.length} footprints for ${startDate} to ${endDate}`);
}

// ── Legend ─────────────────────────────────────────────────────────
function buildLegend() {
  const container = document.getElementById('legend-items');
  const operators = {};
  for (const sat of satellites) {
    operators[sat.operator] = (operators[sat.operator] || 0) + 1;
  }

  for (const [op, count] of Object.entries(operators).sort((a, b) => b[1] - a[1])) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const color = OPERATOR_COLORS[op] || OPERATOR_COLORS.other;
    item.innerHTML = `
      <span class="legend-circle" style="background:${color}"></span>
      <span class="legend-name">${op}</span>
      <span class="legend-cnt">${count}</span>
    `;
    item.addEventListener('click', () => {
      if (disabledOperators.has(op)) {
        disabledOperators.delete(op);
        item.classList.remove('disabled');
      } else {
        disabledOperators.add(op);
        item.classList.add('disabled');
      }
      // Re-query footprints with updated filter
      if (rangeStart >= 0) {
        loadFootprintsForRange();
      }
    });
    container.appendChild(item);
  }
}

// ── Tooltip ───────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');

function showTooltip(html, e) {
  tooltip.innerHTML = html;
  tooltip.style.left = (e.point.x + 14) + 'px';
  tooltip.style.top = (e.point.y - 14) + 'px';
  tooltip.style.display = 'block';
}

function hideTooltip() {
  tooltip.style.display = 'none';
}

map.on('mousemove', 'sat-dots', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  const f = e.features[0];
  showTooltip(`
    <div class="tt-title">${f.properties.name}</div>
    <div class="tt-detail">${f.properties.operator} · ${f.properties.alt_km} km</div>
  `, e);
});

map.on('mouseleave', 'sat-dots', () => {
  map.getCanvas().style.cursor = '';
  hideTooltip();
});

map.on('mousemove', 'footprints', (e) => {
  if (e.features.length === 0) return;
  // Dedupe by id (MapLibre can return same feature from multiple tiles)
  const seen = new Set();
  const unique = e.features.filter(f => {
    if (seen.has(f.properties.id)) return false;
    seen.add(f.properties.id);
    return true;
  });
  const count = unique.length;
  const header = count > 1 ? `<div class="tt-title">${count} images</div>` : '';
  const items = unique.slice(0, 8).map(f => {
    const p = f.properties;
    const dt = p.datetime || '';
    const res = p.resolution ? ` · ${p.resolution}m` : '';
    return `<div class="tt-detail">${p.constellation} ${dt}${res}</div>`;
  }).join('');
  const more = count > 8 ? `<div class="tt-detail">+ ${count - 8} more</div>` : '';
  showTooltip(header + items + more, e);
});

map.on('mouseleave', 'footprints', () => {
  hideTooltip();
});

// ── Satellite selection ───────────────────────────────────────────
function selectSatellite(sat) {
  selectedSat = sat;

  const info = document.getElementById('sat-info');
  const periodMin = getOrbitalPeriodMin(sat.satrec);
  info.innerHTML = `
    <div class="sat-name">${sat.name}</div>
    <div class="sat-detail"><span class="sat-label">Operator</span><span>${sat.operator}</span></div>
    <div class="sat-detail"><span class="sat-label">Constellation</span><span>${sat.constellation}</span></div>
    ${sat.resolution_m ? `<div class="sat-detail"><span class="sat-label">Resolution</span><span>${sat.resolution_m}m</span></div>` : ''}
    <div class="sat-detail"><span class="sat-label">Orbital period</span><span>${Math.round(periodMin)} min</span></div>
    <div class="sat-detail"><span class="sat-label">NORAD ID</span><span>${sat.noradId}</span></div>
  `;

  // Re-query footprints filtered to this satellite's constellations
  if (rangeStart >= 0) {
    loadFootprintsForRange();
  }

  // Show trail immediately
  lastTrailUpdate = 0;
  updateTrails(new Date());
}

function deselectSatellite() {
  selectedSat = null;
  document.getElementById('sat-info').innerHTML = '';

  // Clear trail
  map.getSource('selected-trail').setData({ type: 'FeatureCollection', features: [] });

  // Re-query footprints for all constellations
  if (rangeStart >= 0) {
    loadFootprintsForRange();
  }
}

map.on('click', 'sat-dots', (e) => {
  const f = e.features[0];
  const noradId = f.properties.noradId;
  const sat = satellites.find(s => s.noradId === noradId);
  if (!sat) return;
  selectSatellite(sat);
  e.originalEvent.stopPropagation();
});

map.on('click', (e) => {
  if (selectedSat === null) return;
  const features = map.queryRenderedFeatures(e.point, { layers: ['sat-dots'] });
  if (features.length > 0) return;
  deselectSatellite();
});

// ── Helpers ───────────────────────────────────────────────────────
function splitAtAntimeridian(coords) {
  if (coords.length < 2) return [coords];
  const segments = [[]];
  segments[0].push(coords[0]);

  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1][0];
    const curr = coords[i][0];
    if (Math.abs(curr - prev) > 180) {
      segments.push([]);
    }
    segments[segments.length - 1].push(coords[i]);
  }

  return segments.filter(s => s.length >= 2);
}
