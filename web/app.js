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
  'worldview-legion': 'maxar', 'worldview-1': 'maxar', 'worldview-2': 'maxar',
  'worldview-3': 'maxar', 'geoeye-1': 'maxar',
  iceye: 'iceye',
};

// Map TLE constellation → STAC constellations (for satellite selection filtering)
const CONSTELLATION_MAP = {
  pleiades: ['phr', 'pneo', 'pneo-hd15'],
  spot: ['spot'],
  capella: ['capella-geo', 'capella-slc', 'capella-sicd', 'capella-gec'],
  skysat: ['skysat'],
  worldview: ['worldview-1', 'worldview-2', 'worldview-3', 'worldview-legion', 'geoeye-1'],
  legion: ['worldview-legion'],
};

const DATA_BASE = 'data';
const HAS_ANALYSIS = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

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
let playbackOverlaps = [];   // precomputed overlap features with timestamps

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
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
      },
      labels: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
      },
    },
    layers: [
      { id: 'basemap', type: 'raster', source: 'carto' },
      { id: 'satellite-basemap', type: 'raster', source: 'satellite', layout: { visibility: 'none' }, paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.45 } },
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

  map.addSource('overlaps', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addSource('selected-trail', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addSource('pois', {
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
      'fill-opacity': 0.15,
    },
  });

  // Footprint outlines (visible when zoomed in)
  map.addLayer({
    id: 'footprint-outlines',
    type: 'line',
    source: 'collection',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 0.5,
      'line-opacity': 0.3,
    },
  });

  // Invisible fill for overlap click target (must be above footprints fill)
  map.addLayer({
    id: 'footprint-overlap-fill',
    type: 'fill',
    source: 'overlaps',
    paint: {
      'fill-color': 'transparent',
    },
  });

  // White outline for multi-provider overlap intersections
  map.addLayer({
    id: 'footprint-overlap',
    type: 'line',
    source: 'overlaps',
    paint: {
      'line-color': '#ffffff',
      'line-width': 1,
      'line-opacity': 0.6,
    },
  });

  // Selected cluster halo
  map.addSource('cluster-halo', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'cluster-halo',
    type: 'line',
    source: 'cluster-halo',
    paint: {
      'line-color': '#ffffff',
      'line-width': 2.5,
      'line-opacity': 0.9,
    },
  });

  map.addLayer({
    id: 'cluster-halo-glow',
    type: 'line',
    source: 'cluster-halo',
    paint: {
      'line-color': '#ffffff',
      'line-width': 8,
      'line-opacity': 0.15,
      'line-blur': 6,
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

  // POI markers from Overpass — icon + name
  map.addLayer({
    id: 'poi-icons',
    type: 'symbol',
    source: 'pois',
    layout: {
      'text-field': ['get', 'icon'],
      'text-size': 14,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-font': ['Noto Sans Regular'],
    },
    paint: {
      'text-color': '#ffffff',
    },
  });

  map.addLayer({
    id: 'poi-labels',
    type: 'symbol',
    source: 'pois',
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-font': ['Noto Sans Regular'],
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1,
      'text-opacity': 0.85,
    },
  });

  // Load TLE data first (fast, small files) — show satellites immediately
  setLoadingStatus('Loading satellites...');
  const [tleText, metaJson] = await Promise.all([
    fetch(`${DATA_BASE}/tles.txt`).then(r => r.ok ? r.text() : ''),
    fetch(`${DATA_BASE}/satellites.json`).then(r => r.ok ? r.json() : {}),
  ]);

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
  buildLegend();

  // Start satellite animation immediately — don't wait for duckdb
  dismissLoading();
  tick();

  // Load duckdb + date slider in background (heavier, ~4MB WASM download)
  initDuckDB().then(async (conn) => {
    duckdbConn = conn;
    console.log('DuckDB ready');
    await initDateSlider();
  }).catch(err => {
    console.error('DuckDB init failed:', err);
  });
});

// ── Animation loop ────────────────────────────────────────────────
let tickFrame = 0;
function tick() {
  if (playing) return; // playback has its own loop

  const now = new Date();
  const nowMs = now.getTime();

  // Propagate every frame when selected (responsive), every 2nd frame otherwise
  if (selectedSat || ++tickFrame % 2 === 0) {
    propagateSatellites(now);
  }

  if (selectedSat && nowMs - lastTrailUpdate > TRAIL_UPDATE_MS) {
    lastTrailUpdate = nowMs;
    updateTrails(now);
  }

  requestAnimationFrame(tick);
}

const _satFC = { type: 'FeatureCollection', features: [] };
function propagateSatellites(time) {
  const features = [];
  const hasSelection = selectedSat !== null;
  const selectedId = hasSelection ? selectedSat.noradId : -1;

  for (let j = 0, len = satellites.length; j < len; j++) {
    const sat = satellites[j];
    if (disabledOperators.has(sat.operator)) continue;
    const pos = propagate(sat.satrec, time);
    if (!pos) continue;

    const isSelected = hasSelection && sat.noradId === selectedId;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
      properties: {
        name: sat.name,
        operator: sat.operator,
        constellation: sat.constellation,
        alt_km: (pos.alt_km + 0.5) | 0,
        color: sat.color,
        noradId: sat.noradId,
        radius: isSelected ? 10 : 7,
        dotOpacity: hasSelection && !isSelected ? DIM_OPACITY : 0.9,
      },
    });
  }
  _satFC.features = features;
  map.getSource('satellites').setData(_satFC);
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
           CAST(datetime AS VARCHAR)[:19] AS dt,
           resolution, geojson
    FROM '${parquetUrl()}'
    WHERE CAST(datetime AS DATE) BETWEEN '${startDate}' AND '${endDate}'
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

  playbackOverlaps = computeOverlapFeatures(playbackFeatures, true);
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
  playbackOverlaps = [];
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
  map.getSource('overlaps').setData({ type: 'FeatureCollection', features: playbackOverlaps.filter(f => f.timestamp <= currentMs) });

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
    SELECT CAST(CAST(datetime AS DATE) AS VARCHAR) AS date, COUNT(*) AS n
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

  document.getElementById('date-slider-wrap').classList.add('active');

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
    bar.style.height = `${Math.max(1, (Math.log(d.count + 1) / Math.log(maxCount + 1)) * 24)}px`;
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
let footprintQueryId = 0; // monotonic ID to cancel stale queries
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
  const queryId = ++footprintQueryId;

  const constellations = getEnabledConstellations();
  if (constellations.length === 0) {
    map.getSource('collection').setData({ type: 'FeatureCollection', features: [] });
    map.getSource('overlaps').setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const startDate = dateCounts[rangeStart].date;
  const endDate = dateCounts[rangeEnd].date;
  const inList = constellations.map(c => `'${c}'`).join(', ');
  const result = await duckdbConn.query(`
    SELECT id, constellation,
           CAST(datetime AS VARCHAR)[:16] AS dt,
           resolution, geojson
    FROM '${parquetUrl()}'
    WHERE CAST(datetime AS DATE) BETWEEN '${startDate}' AND '${endDate}'
      AND constellation IN (${inList})
  `);

  // Discard if a newer query was started while this one ran
  if (queryId !== footprintQueryId) return;

  // Extract Arrow columns once, then iterate — avoids repeated getChildAt overhead
  const colId = result.getChildAt(0);
  const colConst = result.getChildAt(1);
  const colDt = result.getChildAt(2);
  const colRes = result.getChildAt(3);
  const colGeo = result.getChildAt(4);
  const n = result.numRows;

  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    const constellation = colConst.get(i);
    const color = OPERATOR_COLORS[CONSTELLATION_OPERATORS[constellation] || 'other'] || OPERATOR_COLORS.other;
    features[i] = {
      type: 'Feature',
      geometry: JSON.parse(colGeo.get(i)),
      properties: {
        id: colId.get(i),
        constellation,
        datetime: colDt.get(i),
        resolution: colRes.get(i),
        color,
      },
    };
  }

  const overlaps = computeOverlapFeatures(features);
  map.getSource('collection').setData({ type: 'FeatureCollection', features });
  map.getSource('overlaps').setData({ type: 'FeatureCollection', features: overlaps });
  console.log(`Loaded ${n} footprints, ${overlaps.length} overlaps for ${startDate} to ${endDate}`);
}

// ── Multi-provider overlap detection ──────────────────────────────
// Returns GeoJSON features for the intersection rectangles of footprints
// from different operators. Since footprints are axis-aligned bounding boxes,
// each intersection is also a simple bbox.
// Compute intersection rectangles between footprints from different operators.
// Footprints are axis-aligned bounding boxes so each intersection is a simple bbox.
// If withTimestamps is true, each overlap gets the later feature's timestamp
// (for playback: the overlap appears when the second image is acquired).
function computeOverlapFeatures(features, withTimestamps) {
  const CELL = 1; // 1° grid cells
  const grid = {};

  // Index features into grid cells
  const boxes = new Array(features.length);
  for (let i = 0; i < features.length; i++) {
    const coords = features[i].geometry.coordinates[0];
    const minLon = coords[0][0], minLat = coords[0][1];
    const maxLon = coords[2][0], maxLat = coords[2][1];
    const op = CONSTELLATION_OPERATORS[features[i].properties.constellation] || 'other';
    boxes[i] = { minLon, minLat, maxLon, maxLat, op };

    const x0 = Math.floor(minLon / CELL), x1 = Math.floor(maxLon / CELL);
    const y0 = Math.floor(minLat / CELL), y1 = Math.floor(maxLat / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = (cx << 16) ^ cy;
        if (!grid[key]) grid[key] = [];
        grid[key].push(i);
      }
    }
  }

  // Find intersection rectangles between different operators
  const seen = new Set();
  const rects = []; // {minLon, minLat, maxLon, maxLat, ts}
  for (const indices of Object.values(grid)) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length; a++) {
      const ia = indices[a], ba = boxes[ia];
      for (let b = a + 1; b < indices.length; b++) {
        const ib = indices[b], bb = boxes[ib];
        if (ba.op === bb.op) continue;
        const pairKey = ia < ib ? ia * features.length + ib : ib * features.length + ia;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const iMinLon = Math.max(ba.minLon, bb.minLon);
        const iMaxLon = Math.min(ba.maxLon, bb.maxLon);
        const iMinLat = Math.max(ba.minLat, bb.minLat);
        const iMaxLat = Math.min(ba.maxLat, bb.maxLat);
        if (iMinLon >= iMaxLon || iMinLat >= iMaxLat) continue;
        const r = { minLon: iMinLon, minLat: iMinLat, maxLon: iMaxLon, maxLat: iMaxLat,
                    pairs: [{ opA: ba.op, opB: bb.op, idA: features[ia].properties.id, idB: features[ib].properties.id,
                              dtA: features[ia].properties.datetime, dtB: features[ib].properties.datetime }] };
        if (withTimestamps) r.ts = Math.max(features[ia].timestamp, features[ib].timestamp);
        rects.push(r);
      }
    }
  }

  // Union-find to merge overlapping rectangles into clusters
  const parent = rects.map((_, i) => i);
  function find(x) { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; }
  function unite(a, b) { parent[find(a)] = find(b); }

  // Index rects into coarse grid for fast overlap checks
  const rGrid = {};
  const RC = 0.5;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const x0 = Math.floor(r.minLon / RC), x1 = Math.floor(r.maxLon / RC);
    const y0 = Math.floor(r.minLat / RC), y1 = Math.floor(r.maxLat / RC);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = (cx << 16) ^ cy;
        const cell = rGrid[key];
        if (cell) {
          for (const j of cell) {
            const s = rects[j];
            if (r.minLon <= s.maxLon && r.maxLon >= s.minLon &&
                r.minLat <= s.maxLat && r.maxLat >= s.minLat) {
              unite(i, j);
            }
          }
          cell.push(i);
        } else {
          rGrid[key] = [i];
        }
      }
    }
  }

  // Merge each cluster into its bounding box
  const clusters = {};
  for (let i = 0; i < rects.length; i++) {
    const root = find(i);
    const r = rects[i];
    if (!clusters[root]) {
      clusters[root] = { minLon: r.minLon, minLat: r.minLat, maxLon: r.maxLon, maxLat: r.maxLat, ts: r.ts || 0, pairs: [...r.pairs] };
    } else {
      const c = clusters[root];
      c.minLon = Math.min(c.minLon, r.minLon);
      c.minLat = Math.min(c.minLat, r.minLat);
      c.maxLon = Math.max(c.maxLon, r.maxLon);
      c.maxLat = Math.max(c.maxLat, r.maxLat);
      if (r.ts > c.ts) c.ts = r.ts;
      c.pairs.push(...r.pairs);
    }
  }

  const overlaps = [];
  for (const c of Object.values(clusters)) {
    // Deduplicate operators and collect unique image IDs
    const ops = new Set();
    const images = [];
    const seenIds = new Set();
    for (const p of c.pairs) {
      ops.add(p.opA); ops.add(p.opB);
      if (!seenIds.has(p.idA)) { seenIds.add(p.idA); images.push({ id: p.idA, op: p.opA, dt: p.dtA }); }
      if (!seenIds.has(p.idB)) { seenIds.add(p.idB); images.push({ id: p.idB, op: p.opB, dt: p.dtB }); }
    }
    images.sort((a, b) => a.dt < b.dt ? -1 : 1);
    const f = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[c.minLon, c.minLat], [c.maxLon, c.minLat],
                       [c.maxLon, c.maxLat], [c.minLon, c.maxLat],
                       [c.minLon, c.minLat]]],
      },
      properties: {
        operators: JSON.stringify([...ops]),
        imageCount: seenIds.size,
        images: JSON.stringify(images),
      },
    };
    if (withTimestamps) f.timestamp = c.ts;
    overlaps.push(f);
  }
  return overlaps;
}

// ── Legend ─────────────────────────────────────────────────────────
function buildLegend() {
  const container = document.getElementById('legend-items');
  const operatorsWithFootprints = new Set(Object.values(CONSTELLATION_OPERATORS));
  const operators = {};
  for (const sat of satellites) {
    if (!operatorsWithFootprints.has(sat.operator)) continue;
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

// ── Area enrichment (Overpass + LLM) ──────────────────────────────
let enrichRequestId = 0;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Broad query: all named features with strategically interesting tags
function buildOverpassQuery(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:10];(
    nwr["military"](${bbox});
    nwr["landuse"="military"](${bbox});
    nwr["aeroway"="aerodrome"](${bbox});
    nwr["aeroway"="helipad"](${bbox});
    nwr["landuse"="port"](${bbox});
    nwr["industrial"="port"](${bbox});
    nwr["power"="plant"](${bbox});
    nwr["plant:source"="nuclear"](${bbox});
    nwr["generator:source"="nuclear"](${bbox});
    nwr["amenity"="embassy"](${bbox});
    nwr["amenity"="prison"](${bbox});
    nwr["man_made"="works"](${bbox});
    nwr["man_made"="petroleum_well"](${bbox});
    nwr["man_made"="pipeline"](${bbox});
    nwr["office"="government"](${bbox});
    nwr["building"="government"](${bbox});
    nwr["amenity"="fuel"]["capacity"](${bbox});
    nwr["landuse"="reservoir"](${bbox});
    nwr["man_made"="water_works"](${bbox});
    nwr["man_made"="wastewater_plant"](${bbox});
    nwr["telecom"](${bbox});
    nwr["man_made"="communications_tower"](${bbox});
    nwr["railway"="station"](${bbox});
  );out center tags;`;
}

// Distil Overpass elements to a compact summary for the LLM
function summariseElements(elements) {
  const items = [];
  const seen = new Set();
  for (const el of elements) {
    if (!el.tags) continue;
    const name = el.tags['name:en'] || el.tags.name || '';
    const lat = el.center ? el.center.lat : el.lat;
    const lon = el.center ? el.center.lon : el.lon;
    // Keep key tags, drop noise
    const keep = {};
    for (const [k, v] of Object.entries(el.tags)) {
      if (['source', 'source:date', 'created_by', 'note', 'fixme', 'FIXME',
           'addr:housenumber', 'addr:street', 'addr:city', 'addr:postcode',
           'building:levels', 'roof:shape', 'roof:material'].includes(k)) continue;
      if (k.startsWith('name:') && k !== 'name:en') continue;
      keep[k] = v;
    }
    const key = `${name}:${JSON.stringify(keep)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, lat, lon, tags: keep });
  }
  return items;
}

async function queryOverpass(south, west, north, east) {
  const query = buildOverpassQuery(south, west, north, east);
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (resp.status === 429 || resp.status === 504) continue;
      if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
      return await resp.json();
    } catch (err) {
      console.warn(`Overpass (${endpoint}) failed:`, err);
    }
  }
  return null;
}

function buildLLMPrompt(osmFeatures, operators, imageCount, lat, lon) {
  return `Location: ${lat}°N, ${lon}°E
Imaged by: ${operators.join(', ')} (${imageCount} images)

OSM features in area:
${JSON.stringify(osmFeatures)}

You have access to web search. Do 2-4 targeted searches. Search in BOTH English AND the local language of the location (e.g. Arabic, Ukrainian, Chinese, Russian). Prioritise primary sources: government statements, military communiques, local news agencies, official incident reports. Avoid aggregators and opinion pieces.

Then write a pithy, confident assessment of WHAT is being watched and WHY these satellite providers are tasking imagery here. Write for an analyst who knows the domain — no throat-clearing, no caveats, no "it's worth noting".

Write a single short paragraph: state where this is, name the key facilities, and explain why this area is being watched — connecting it to current events or strategic context informed by your web searches. No preamble, no structure, just one dense paragraph.

Output PLAIN TEXT only. No markdown, no formatting. Keep it under 100 words.`;
}

async function streamLLM(container, osmItems, prompt) {
  // Place POI markers on map
  const mapFeatures = osmItems
    .filter(it => it.lat != null && it.lon != null && it.name)
    .map(it => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
      properties: { icon: '·', name: it.name },
    }));
  if (map.getSource('pois')) {
    map.getSource('pois').setData({ type: 'FeatureCollection', features: mapFeatures });
  }

  container.innerHTML = '<div class="enrich-status">Connecting...</div><div class="enrich-report" style="display:none"><p class="enrich-para"></p></div>';
  const statusEl = container.querySelector('.enrich-status');
  const reportEl = container.querySelector('.enrich-report');
  const paraEl = container.querySelector('.enrich-para');

  try {
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let searchCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;

        let event;
        try { event = JSON.parse(payload); } catch { continue; }

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              text += block.text;
              paraEl.textContent = text;
              reportEl.style.display = '';
              statusEl.style.display = 'none';
            }
            if (block.type === 'tool_use' && block.name === 'WebSearch') {
              searchCount++;
              const query = block.input?.query || '';
              statusEl.textContent = `Searching: ${query}`;
              statusEl.style.display = '';
            }
            if (block.type === 'tool_use' && block.name === 'WebFetch') {
              statusEl.textContent = `Reading: ${block.input?.url || ''}`;
              statusEl.style.display = '';
            }
          }
        }
      }
    }

    statusEl.style.display = 'none';
    if (!text) {
      reportEl.style.display = 'none';
      container.innerHTML = '<span class="enrich-empty">Analysis unavailable</span>';
    }

  } catch (err) {
    console.warn('LLM stream failed:', err);
    statusEl.style.display = 'none';
    if (osmItems.length > 0) {
      const named = osmItems.filter(it => it.name).slice(0, 12);
      container.innerHTML = named.map(it =>
        `<div class="poi-clickable" data-lat="${it.lat}" data-lon="${it.lon}">${it.name}</div>`
      ).join('');
      container.querySelectorAll('.poi-clickable').forEach(row => {
        row.addEventListener('click', () => {
          map.flyTo({ center: [parseFloat(row.dataset.lon), parseFloat(row.dataset.lat)], zoom: 14, duration: 1500 });
        });
      });
    } else {
      container.innerHTML = '<span class="enrich-empty">Analysis unavailable</span>';
    }
  }
}

function clearPOIs() {
  if (map.getSource('pois')) {
    map.getSource('pois').setData({ type: 'FeatureCollection', features: [] });
  }
}

function highlightCluster(feature) {
  const haloData = { type: 'FeatureCollection', features: [] };
  if (feature) {
    // Reconstruct a clean GeoJSON feature to avoid serialization issues
    haloData.features = [{
      type: 'Feature',
      geometry: JSON.parse(JSON.stringify(feature.geometry)),
      properties: {},
    }];
  }
  map.getSource('cluster-halo').setData(haloData);
  // Dim other layers
  map.setPaintProperty('footprints', 'fill-opacity', feature ? 0.05 : 0.15);
  map.setPaintProperty('footprint-outlines', 'line-opacity', feature ? 0.1 : 0.3);
  map.setPaintProperty('footprint-overlap', 'line-opacity', feature ? 0.2 : 0.6);
}

function setSatelliteBasemap(on) {
  map.setLayoutProperty('basemap', 'visibility', on ? 'none' : 'visible');
  map.setLayoutProperty('satellite-basemap', 'visibility', on ? 'visible' : 'none');
}

map.on('click', 'footprint-overlap-fill', (e) => {
  const id = ++enrichRequestId;
  const f = e.features[0];
  const operators = JSON.parse(f.properties.operators);
  const images = JSON.parse(f.properties.images);
  const coords = f.geometry.coordinates[0];
  const cLat = ((coords[0][1] + coords[2][1]) / 2).toFixed(3);
  const cLon = ((coords[0][0] + coords[2][0]) / 2).toFixed(3);

  const opBadges = operators.map(op => {
    const color = OPERATOR_COLORS[op] || OPERATOR_COLORS.other;
    return `<span class="card-op-badge"><span class="card-op-dot" style="background:${color}"></span>${op}</span>`;
  }).join('');

  const imageRows = images.map(img => {
    const color = OPERATOR_COLORS[img.op] || OPERATOR_COLORS.other;
    return `<div class="card-image-row">
      <span class="card-image-op" style="background:${color}"></span>
      <span class="card-image-id" title="${img.id}">${img.id}</span>
      <span class="card-image-dt">${img.dt}</span>
    </div>`;
  }).join('');

  const pad = 0.05;
  const south = Math.min(coords[0][1], coords[2][1]) - pad;
  const north = Math.max(coords[0][1], coords[2][1]) + pad;
  const west = Math.min(coords[0][0], coords[2][0]) - pad;
  const east = Math.max(coords[0][0], coords[2][0]) + pad;

  const analysisHtml = HAS_ANALYSIS
    ? `<div class="card-section-label">Analysis</div><div id="enrich-results" class="enrich-loading">Querying area...</div>`
    : '';

  document.getElementById('card-title').textContent = `${operators.length} providers · ${images.length} images`;
  document.getElementById('card-body').innerHTML = `
    <div class="card-operators">${opBadges}</div>
    <a class="card-coords" href="https://earth.google.com/web/@${cLat},${cLon},0a,5000d,35y,0h,0t,0r" target="_blank" rel="noopener">${cLat}° N, ${cLon}° E</a>
    <div class="card-section-label">Images</div>
    ${imageRows}
    ${analysisHtml}
  `;
  document.getElementById('overlap-card').classList.add('visible');
  setSatelliteBasemap(true);
  highlightCluster(f);

  if (HAS_ANALYSIS) {
    // Pipeline: Overpass → summarise → stream LLM
    (async () => {
      const el = () => id === enrichRequestId ? document.getElementById('enrich-results') : null;

      const overpassData = await queryOverpass(south, west, north, east);
      if (id !== enrichRequestId) return;

      const osmItems = overpassData?.elements ? summariseElements(overpassData.elements) : [];
      const prompt = buildLLMPrompt(osmItems, operators, images.length, cLat, cLon);

      const target = el();
      if (!target) return;

      await streamLLM(target, osmItems, prompt);
    })();
  }

  e.originalEvent.stopPropagation();
});

map.on('mouseenter', 'footprint-overlap-fill', () => {
  map.getCanvas().style.cursor = 'pointer';
});

map.on('mouseleave', 'footprint-overlap-fill', () => {
  map.getCanvas().style.cursor = '';
});

document.getElementById('card-close').addEventListener('click', () => {
  document.getElementById('overlap-card').classList.remove('visible');
  clearPOIs();
  setSatelliteBasemap(false);
  highlightCluster(null);
});

map.on('click', (e) => {
  // Close overlap card on background click
  const overlapHit = map.queryRenderedFeatures(e.point, { layers: ['footprint-overlap-fill'] });
  if (overlapHit.length === 0) {
    document.getElementById('overlap-card').classList.remove('visible');
    clearPOIs();
    setSatelliteBasemap(false);
  highlightCluster(null);
  }
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
