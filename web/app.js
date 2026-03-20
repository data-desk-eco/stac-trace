// ── Colours ───────────────────────────────────────────────────────
const OPERATOR_COLORS = {
  maxar: '#e05555', airbus: '#5588cc', planet: '#44aa77',
  iceye: '#cc9944', capella: '#cc9944', satellogic: '#9977bb',
  government: '#cccc44', other: '#778899',
};

const DATA_BASE = 'data';

// ── Trail config ──────────────────────────────────────────────────
const TRAIL_POINTS = 180;        // points per orbit
const TRAIL_UPDATE_MS = 5000;
const SELECTED_ORBITS = 3;       // show 3 full orbits when selected
const TRAIL_BANDS = [
  { from: 0,    to: 0.25, opacity: 0.5 },
  { from: 0.25, to: 0.5,  opacity: 0.3 },
  { from: 0.5,  to: 0.75, opacity: 0.15 },
  { from: 0.75, to: 1.0,  opacity: 0.06 },
];
const DIM_OPACITY = 0.08;        // opacity for non-selected satellites

// ── State ─────────────────────────────────────────────────────────
let satellites = [];
let disabledOperators = new Set();
let selectedSat = null;
let lastTrailUpdate = 0;

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

// ── DuckDB-WASM setup ────────────────────────────────────────────
async function initDuckDB() {
  const DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/';
  const duckdb = await import(DUCKDB_CDN + 'duckdb-browser.mjs');
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: DUCKDB_CDN + 'duckdb-mvp.wasm', mainWorker: DUCKDB_CDN + 'duckdb-browser-mvp.worker.js' },
    eh: { mainModule: DUCKDB_CDN + 'duckdb-eh.wasm', mainWorker: DUCKDB_CDN + 'duckdb-browser-eh.worker.js' },
  });
  const workerScript = await fetch(bundle.mainWorker).then(r => r.text());
  const workerBlob = new Blob([workerScript], { type: 'text/javascript' });
  const worker = new Worker(URL.createObjectURL(workerBlob));
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule);
  const conn = await db.connect();
  return conn;
}

// ── Data loading ──────────────────────────────────────────────────
let duckdbConn = null;

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

  map.addSource('trails', {
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
      'fill-outline-color': 'rgba(255, 255, 255, 0.15)',
    },
  });

  // Default trails (dashed)
  map.addLayer({
    id: 'trails',
    type: 'line',
    source: 'trails',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'width'],
      'line-opacity': ['get', 'opacity'],
      'line-dasharray': [1, 2],
    },
  });

  // Selected satellite trail (solid)
  map.addLayer({
    id: 'selected-trail',
    type: 'line',
    source: 'selected-trail',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'width'],
      'line-opacity': ['get', 'opacity'],
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

  // Start animation
  tick();
});

// ── Animation loop ────────────────────────────────────────────────
function tick() {
  const now = new Date();
  const nowMs = now.getTime();
  const features = [];

  for (const sat of satellites) {
    if (disabledOperators.has(sat.operator)) continue;
    const pos = propagate(sat.satrec, now);
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

  // Update trails periodically (not every frame)
  if (nowMs - lastTrailUpdate > TRAIL_UPDATE_MS) {
    lastTrailUpdate = nowMs;
    updateTrails(now);
  }

  requestAnimationFrame(tick);
}

function getOrbitalPeriodMin(satrec) {
  // satrec.no is mean motion in rad/min → period = 2π / no
  return (2 * Math.PI) / satrec.no;
}

function updateTrails(now) {
  const defaultFeatures = [];
  const selectedFeatures = [];

  for (const sat of satellites) {
    if (disabledOperators.has(sat.operator)) continue;

    const isSelected = selectedSat && sat.noradId === selectedSat.noradId;
    if (selectedSat && !isSelected) continue; // hide non-selected trails entirely
    const orbits = isSelected ? SELECTED_ORBITS : 1;
    const totalPoints = TRAIL_POINTS * orbits;
    const periodMin = getOrbitalPeriodMin(sat.satrec);
    const stepSec = (periodMin * 60) / TRAIL_POINTS;
    const lineWidth = isSelected ? 4 : 2;

    // Propagate backwards
    const positions = [];
    for (let i = 0; i <= totalPoints; i++) {
      const secAgo = i * stepSec;
      const t = new Date(now.getTime() - secAgo * 1000);
      const pos = propagate(sat.satrec, t);
      if (pos) positions.push([pos.lon, pos.lat, i / totalPoints]);
    }

    if (positions.length < 2) continue;

    const target = isSelected ? selectedFeatures : defaultFeatures;

    for (const band of TRAIL_BANDS) {
      const bandPts = positions.filter(p => p[2] >= band.from && p[2] <= band.to);
      if (bandPts.length < 2) continue;

      const coords = bandPts.map(p => [p[0], p[1]]);
      const segments = splitAtAntimeridian(coords);

      for (const seg of segments) {
        target.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg },
          properties: { color: sat.color, opacity: band.opacity, width: lineWidth },
        });
      }
    }
  }

  map.getSource('trails').setData({ type: 'FeatureCollection', features: defaultFeatures });
  map.getSource('selected-trail').setData({ type: 'FeatureCollection', features: selectedFeatures });
}

// ── Footprint query ──────────────────────────────────────────────
// Map TLE constellation names → STAC constellation names
const CONSTELLATION_MAP = {
  pleiades: ['phr', 'pneo', 'pneo-hd15'],
  spot: ['spot'],
  capella: ['capella-geo', 'capella-slc', 'capella-sicd', 'capella-gec'],
  // beijing-3 satellites are in STAC as 21AT but not in our TLE set
};

async function queryFootprints(constellation, color) {
  if (!duckdbConn) return;
  const parquetUrl = `${location.origin}${location.pathname}data/footprints.parquet`;
  const stacNames = CONSTELLATION_MAP[constellation] || [constellation];
  const inList = stacNames.map(n => `'${n}'`).join(', ');
  const result = await duckdbConn.query(`
    SELECT geojson
    FROM '${parquetUrl}'
    WHERE constellation IN (${inList})
  `);

  const features = [];
  for (let i = 0; i < result.numRows; i++) {
    const geojson = JSON.parse(result.getChildAt(0).get(i));
    features.push({
      type: 'Feature',
      geometry: geojson,
      properties: { color },
    });
  }

  map.getSource('collection').setData({ type: 'FeatureCollection', features });
  console.log(`Loaded ${features.length} footprints for ${constellation}`);
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
    });
    container.appendChild(item);
  }
}

// ── Tooltip ───────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');

map.on('mousemove', 'sat-dots', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  const f = e.features[0];
  tooltip.innerHTML = `
    <div class="tt-title">${f.properties.name}</div>
    <div class="tt-detail">${f.properties.operator} &middot; ${f.properties.alt_km} km</div>
  `;
  tooltip.style.left = (e.point.x + 14) + 'px';
  tooltip.style.top = (e.point.y - 14) + 'px';
  tooltip.style.display = 'block';
});

map.on('mouseleave', 'sat-dots', () => {
  map.getCanvas().style.cursor = '';
  tooltip.style.display = 'none';
});

// ── Satellite selection ───────────────────────────────────────────
function selectSatellite(sat) {
  selectedSat = sat;

  // Show satellite info
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

  // Query footprints for this constellation
  queryFootprints(sat.constellation, sat.color);

  // Force immediate trail update
  lastTrailUpdate = 0;
}

function deselectSatellite() {
  selectedSat = null;
  document.getElementById('sat-info').innerHTML = '';

  // Clear footprints
  map.getSource('collection').setData({ type: 'FeatureCollection', features: [] });

  // Force immediate trail update
  lastTrailUpdate = 0;
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
