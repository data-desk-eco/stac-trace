// ── Operator colours ──────────────────────────────────────────────
const OPERATOR_COLORS = {
  maxar: '#e05555', airbus: '#5588cc', planet: '#44aa77',
  iceye: '#cc9944', capella: '#cc9944', satellogic: '#9977bb',
  government: '#cccc44', other: '#778899',
};

const DATA_BASE = 'data';

// ── State ─────────────────────────────────────────────────────────
let satellites = [];
let disabledOperators = new Set();
let selectedSat = null;

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

// ── STAC1 binary decoder ──────────────────────────────────────────
function decodeSTAC1(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  const magic = String.fromCharCode(...bytes.slice(0, 5));
  if (magic !== 'STAC1') throw new Error('Not a STAC1 file');

  const gridRes = bytes[5] / 100;
  const bucketDays = bytes[6];
  const epochOffset = view.getUint16(7, true);
  const numConstellations = bytes[9];

  let pos = 10;

  function readUvarint() {
    let result = 0, shift = 0;
    while (true) {
      const b = bytes[pos++];
      result |= (b & 0x7F) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result;
  }

  function readSvarint() {
    const u = readUvarint();
    return (u >>> 1) ^ -(u & 1);
  }

  const numCells = readUvarint();

  const constellations = [];
  for (let i = 0; i < numConstellations; i++) {
    let name = '';
    while (bytes[pos] !== 0) name += String.fromCharCode(bytes[pos++]);
    pos++;
    constellations.push(name);
  }

  const cells = [];
  let gx = 0, gy = 0;

  for (let i = 0; i < numCells; i++) {
    gx += readSvarint();
    gy += readSvarint();
    const nBuckets = readUvarint();
    const buckets = [];
    for (let j = 0; j < nBuckets; j++) {
      const timeOffset = readUvarint();
      const packed = bytes[pos++];
      const constIdx = packed >> 4;
      let count = packed & 0x0F;
      if (count === 15) count = readUvarint();
      buckets.push({ timeOffset, constellation: constellations[constIdx], count });
    }
    cells.push({ gx, gy, buckets });
  }

  return { gridRes, bucketDays, epochOffset, constellations, cells };
}

function stac1ToGeoJSON(decoded, filter) {
  const { gridRes, cells } = decoded;
  const features = [];
  for (const cell of cells) {
    let total = 0;
    for (const b of cell.buckets) {
      if (filter && !filter(b)) continue;
      total += b.count;
    }
    if (total === 0) continue;
    const lon = cell.gx * gridRes;
    const lat = cell.gy * gridRes;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon, lat], [lon + gridRes, lat],
          [lon + gridRes, lat + gridRes], [lon, lat + gridRes],
          [lon, lat]
        ]]
      },
      properties: { count: total }
    });
  }
  return { type: 'FeatureCollection', features };
}

// ── Map setup ─────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      'carto-dark': {
        type: 'raster',
        tiles: ['https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png'],
        tileSize: 256,
        attribution: '&copy; CARTO',
        maxzoom: 18,
      },
      'ofm-labels': {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
      },
    },
    layers: [
      {
        id: 'carto-tiles',
        type: 'raster',
        source: 'carto-dark',
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'ofm-labels',
        'source-layer': 'place',
        filter: ['in', 'class', 'city', 'country', 'continent'],
        layout: {
          'text-field': '{name:latin}',
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14],
          'text-anchor': 'center',
          'text-max-width': 8,
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.45)',
          'text-halo-color': 'rgba(0, 0, 0, 0.6)',
          'text-halo-width': 1,
        },
      },
    ],
  },
  center: [20, 30],
  zoom: 1.8,
  projection: 'globe',
});

// ── Data loading ──────────────────────────────────────────────────
let stac1Data = null;

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

  map.addSource('ground-track', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Heatmap layer (below satellites)
  map.addLayer({
    id: 'collection-heat',
    type: 'fill',
    source: 'collection',
    paint: {
      'fill-color': [
        'interpolate', ['linear'], ['get', 'count'],
        1, 'rgba(255, 255, 255, 0.05)',
        10, 'rgba(255, 100, 50, 0.2)',
        50, 'rgba(255, 50, 50, 0.4)',
        200, 'rgba(255, 0, 0, 0.6)'
      ],
      'fill-outline-color': 'rgba(255, 255, 255, 0.05)',
    },
  });

  // Ground track layer
  map.addLayer({
    id: 'ground-track',
    type: 'line',
    source: 'ground-track',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.5,
      'line-opacity': 0.6,
      'line-dasharray': [2, 2],
    },
  });

  // Satellite dots
  map.addLayer({
    id: 'sat-dots',
    type: 'circle',
    source: 'satellites',
    paint: {
      'circle-radius': 4,
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.9,
    },
  });

  // Load data in parallel
  const [tleText, metaJson, stac1Buf] = await Promise.all([
    fetch(`${DATA_BASE}/tles.txt`).then(r => r.ok ? r.text() : ''),
    fetch(`${DATA_BASE}/satellites.json`).then(r => r.ok ? r.json() : {}),
    fetch(`${DATA_BASE}/collection.stac1`).then(r => r.ok ? r.arrayBuffer() : null),
  ]);

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

  // Decode STAC1 heatmap
  if (stac1Buf) {
    stac1Data = decodeSTAC1(stac1Buf);
    const geojson = stac1ToGeoJSON(stac1Data);
    map.getSource('collection').setData(geojson);
    console.log(`Loaded ${stac1Data.cells.length} heatmap cells`);
  }

  // Build legend
  buildLegend();

  // Start animation
  tick();
});

// ── Animation loop ────────────────────────────────────────────────
function tick() {
  const now = new Date();
  const features = [];

  for (const sat of satellites) {
    if (disabledOperators.has(sat.operator)) continue;
    const pos = propagate(sat.satrec, now);
    if (!pos) continue;

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
      },
    });
  }

  map.getSource('satellites').setData({ type: 'FeatureCollection', features });
  requestAnimationFrame(tick);
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
    item.innerHTML = `
      <span class="legend-dot" style="background:${OPERATOR_COLORS[op] || OPERATOR_COLORS.other}"></span>
      <span>${op}</span>
      <span class="legend-count">${count}</span>
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
    <div class="tip-title">${f.properties.name}</div>
    <div class="tip-detail">${f.properties.operator} &middot; ${f.properties.alt_km} km</div>
  `;
  tooltip.style.left = (e.point.x + 14) + 'px';
  tooltip.style.top = (e.point.y - 14) + 'px';
  tooltip.classList.add('visible');
});

map.on('mouseleave', 'sat-dots', () => {
  map.getCanvas().style.cursor = '';
  tooltip.classList.remove('visible');
});

// Heatmap tooltip
map.on('mousemove', 'collection-heat', (e) => {
  if (e.features.length === 0) return;
  const f = e.features[0];
  const count = f.properties.count;
  tooltip.innerHTML = `
    <div class="tip-title">${count} image${count !== 1 ? 's' : ''}</div>
    <div class="tip-detail">collection activity</div>
  `;
  tooltip.style.left = (e.point.x + 14) + 'px';
  tooltip.style.top = (e.point.y - 14) + 'px';
  tooltip.classList.add('visible');
});

map.on('mouseleave', 'collection-heat', () => {
  tooltip.classList.remove('visible');
});

// ── Satellite selection + ground track ────────────────────────────
map.on('click', 'sat-dots', (e) => {
  const f = e.features[0];
  const noradId = f.properties.noradId;
  const sat = satellites.find(s => s.noradId === noradId);
  if (!sat) return;

  selectedSat = sat;

  // Show satellite info
  const info = document.getElementById('sat-info');
  info.innerHTML = `
    <div class="sat-name" style="color:${sat.color}">${sat.name}</div>
    <div class="sat-detail"><span class="sat-label">Operator</span><span>${sat.operator}</span></div>
    <div class="sat-detail"><span class="sat-label">Constellation</span><span>${sat.constellation}</span></div>
    ${sat.resolution_m ? `<div class="sat-detail"><span class="sat-label">Resolution</span><span>${sat.resolution_m}m</span></div>` : ''}
    <div class="sat-detail"><span class="sat-label">NORAD ID</span><span>${sat.noradId}</span></div>
  `;

  // Draw ground track (next 90 minutes, 30-second steps)
  const trackPoints = [];
  const now = new Date();
  for (let s = 0; s <= 90 * 60; s += 30) {
    const t = new Date(now.getTime() + s * 1000);
    const pos = propagate(sat.satrec, t);
    if (pos) trackPoints.push([pos.lon, pos.lat]);
  }

  // Split track at antimeridian crossings
  const segments = splitAtAntimeridian(trackPoints);

  map.getSource('ground-track').setData({
    type: 'FeatureCollection',
    features: segments.map(seg => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: seg },
      properties: { color: sat.color },
    })),
  });

  // Filter heatmap to this constellation
  if (stac1Data) {
    const geojson = stac1ToGeoJSON(stac1Data, b =>
      b.constellation.toLowerCase() === sat.constellation.toLowerCase()
    );
    map.getSource('collection').setData(geojson);
  }

  e.originalEvent.stopPropagation();
});

// Click background to deselect
map.on('click', (e) => {
  if (selectedSat === null) return;
  // Check if we clicked a satellite
  const features = map.queryRenderedFeatures(e.point, { layers: ['sat-dots'] });
  if (features.length > 0) return;

  selectedSat = null;
  document.getElementById('sat-info').innerHTML = '';
  map.getSource('ground-track').setData({ type: 'FeatureCollection', features: [] });

  // Restore full heatmap
  if (stac1Data) {
    map.getSource('collection').setData(stac1ToGeoJSON(stac1Data));
  }
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
