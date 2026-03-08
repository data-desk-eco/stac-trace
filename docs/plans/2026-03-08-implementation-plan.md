# stac-trace Rewrite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild stac-trace as a static, client-side satellite constellation visualizer with real-time orbital propagation and a STAC1 binary heatmap of global imagery collection activity.

**Architecture:** Python scripts (`uv run`) fetch TLEs from CelesTrak and sync STAC data from UP42 into DuckDB. An encoder script reads DuckDB and produces a compact STAC1 binary file. The frontend is vanilla JS + MapLibre GL globe + satellite.js (sgp4), loading TLEs and STAC1 as static files from GitHub releases.

**Tech Stack:** Python (httpx, duckdb, python-dotenv), DuckDB, MapLibre GL JS, satellite.js, vanilla JS/CSS, GitHub Actions.

---

### Task 1: Directory restructure and cleanup

**Files:**
- Create: `web/index.html`, `web/app.js`, `web/style.css`
- Delete: `index.html` (old), `uv.lock`, `.python-version`, `TODO.md`
- Modify: `.gitignore`

**Step 1: Create web directory with placeholder files**

```bash
mkdir -p web
touch web/index.html web/app.js web/style.css
```

**Step 2: Create data symlink for local dev**

```bash
cd web && ln -s ../data data && cd ..
```

**Step 3: Update .gitignore**

Add:
```
web/data
data/*.stac1
data/tles.txt
data/satellites.json
```

**Step 4: Remove legacy files**

```bash
rm -f uv.lock .python-version TODO.md
```

**Step 5: Commit**

```bash
git add web/.gitkeep web/index.html web/app.js web/style.css .gitignore
git rm uv.lock .python-version TODO.md index.html
git commit -m "chore: restructure for rewrite — web/ dir, remove legacy files"
```

---

### Task 2: TLE fetcher script

**Files:**
- Create: `scripts/fetch_tles.py`
- Create: `data/tles.txt` (output)
- Create: `data/satellites.json` (output)

**Step 1: Write fetch_tles.py**

Script should:
- Use `uv run` with inline deps (`httpx`)
- Fetch EO satellite TLEs from CelesTrak groups: `active`, `resource`, `sarsat` (filter to known EO constellations)
- Known EO operators/constellations to include:
  - Maxar: WorldView-1/2/3, Legion-1/2
  - Airbus: Pléiades 1A/1B, Pléiades Neo 3/4, SPOT 6/7
  - Planet: SkySat (not Doves — too many, wide-area)
  - BlackBridge/Planet: RapidEye (if still active)
  - ICEYE: SAR constellation
  - Capella: SAR constellation
  - Satellogic: NewSat constellation
  - Government: Landsat, Sentinel (lower-res but reference points)
- Output `data/tles.txt` — standard TLE format (name line + 2 element lines)
- Output `data/satellites.json` — metadata per satellite:

```json
{
  "25919": {
    "name": "WorldView-1",
    "norad_id": 25919,
    "operator": "maxar",
    "constellation": "worldview",
    "color": "#e05555",
    "resolution_m": 0.5
  }
}
```

- The operator→color mapping:
  - maxar: `#e05555` (red)
  - airbus: `#5588cc` (blue)
  - planet: `#44aa77` (green)
  - iceye: `#cc9944` (orange)
  - capella: `#cc9944` (orange)
  - satellogic: `#9977bb` (purple)
  - government: `#cccc44` (yellow)
  - other: `#778899` (grey)

- Use a hardcoded lookup table mapping NORAD IDs or satellite names to operator/metadata. CelesTrak names are like `WORLDVIEW-3`, `PLEIADES-NEO 4`, etc. Match on prefix.

**Step 2: Run and verify**

```bash
uv run scripts/fetch_tles.py
head -6 data/tles.txt  # Should show 2 satellites (name + 2 lines each)
python -c "import json; d=json.load(open('data/satellites.json')); print(len(d), 'satellites')"
```

**Step 3: Commit**

```bash
git add scripts/fetch_tles.py
git commit -m "feat: add TLE fetcher for EO constellation tracking"
```

---

### Task 3: Port STAC sync to Python

**Files:**
- Create: `scripts/sync_stac.py`
- Reference: `scripts/sync.sh` (port from this)

**Step 1: Write sync_stac.py**

Port the existing `sync.sh` logic to Python:
- `uv run` with inline deps (`httpx`, `duckdb`, `python-dotenv`)
- OAuth authentication with UP42 (same endpoint)
- Regional splitting (same 5 regions)
- Pagination with `next` token
- jq filtering → Python filtering (constellation != spot, resolution <= 0.75)
- DuckDB insert via Python API (not CLI)
- Sync log tracking
- CLI args: `--days 7` (default), `--host oneatlas` (default)

Key improvements over shell version:
- Proper error handling with retries on transient failures
- Structured logging instead of echo
- Uses duckdb Python package directly

**Step 2: Run against existing database**

```bash
uv run scripts/sync_stac.py --days 7
```

Verify it adds items to the existing `data/stac.duckdb`.

**Step 3: Commit**

```bash
git add scripts/sync_stac.py
git commit -m "feat: port STAC sync to Python"
```

---

### Task 4: STAC1 binary encoder

**Files:**
- Create: `scripts/encode_stac1.py`
- Create: `data/collection.stac1` (output)

**Step 1: Write encode_stac1.py**

Script should:
- `uv run` with inline deps (`duckdb`)
- Read all items from `data/stac.duckdb`
- For each item, extract centroid (from geometry or bbox), datetime, constellation
- Grid centroids to 0.1° cells
- Bucket timestamps into 7-day (weekly) periods from a fixed epoch (2020-01-01)
- Group by (grid_x, grid_y, time_bucket, constellation) → count
- Normalize constellation names to a lookup table
- Sort cells by (grid_y, grid_x) for delta encoding locality
- Encode STAC1 binary format:

```
Header:
  b'STAC1'                    # 5 bytes magic
  uint8 grid_res              # 10 (= 0.1 degrees)
  uint8 time_bucket_days      # 7 (weekly)
  uint16 LE epoch_offset      # days since 2020-01-01
  uint8 num_constellations    # constellation table size
  uvarint num_cells           # total grid cells

Constellation table:
  UTF-8 null-terminated strings, sequential

Cell records (sorted by grid_y, grid_x):
  svarint dx                  # delta grid_x from previous
  svarint dy                  # delta grid_y from previous
  uvarint n_buckets           # time buckets in this cell
  Per bucket:
    uvarint time_offset       # bucket index from epoch
    uint8 packed              # high nibble = constellation index, low nibble = count (0-14)
                              # if low nibble == 15: followed by uvarint for actual count
```

Varint helpers:
```python
def encode_uvarint(n):
    out = bytearray()
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)

def encode_svarint(n):
    return encode_uvarint((n << 1) ^ (n >> 63))
```

**Step 2: Run and verify**

```bash
uv run scripts/encode_stac1.py
ls -lh data/collection.stac1  # Check size
python -c "
f = open('data/collection.stac1', 'rb')
print('magic:', f.read(5))
print('grid_res:', f.read(1)[0])
print('bucket_days:', f.read(1)[0])
"
```

**Step 3: Write a quick decode verification**

Add a `--verify` flag that decodes the output and prints summary stats:
```
STAC1: 142 cells, 8 constellations, 2024-06-01 to 2026-03-08
Top cells: (35.6, 139.7) = 47 images, (51.5, -0.1) = 32 images, ...
```

**Step 4: Commit**

```bash
git add scripts/encode_stac1.py
git commit -m "feat: STAC1 binary encoder for collection heatmap"
```

---

### Task 5: Frontend — HTML skeleton and styles

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`

**Step 1: Write index.html**

Modelled on raf-watch's structure:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>STAC TRACE / satellite imagery activity</title>
  <meta name="description" content="Real-time EO satellite constellation visualizer with collection heatmap">
  <link href="https://unpkg.com/maplibre-gl@5.19.0/dist/maplibre-gl.css" rel="stylesheet">
  <link href="style.css" rel="stylesheet">
</head>
<body>
  <div id="map"></div>
  <div id="panel" class="panel glass">
    <h1>STAC<span class="title-trace">TRACE</span></h1>
    <p class="subtitle">Real-time positions of ~200 Earth observation satellites, with a heatmap of recent high-resolution imagery collection.</p>
    <div id="sat-info"></div>
  </div>
  <div id="legend" class="panel glass">
    <h4>Operator</h4>
    <div id="legend-items"></div>
  </div>
  <div id="tooltip" class="glass"></div>
  <script src="https://unpkg.com/maplibre-gl@5.19.0/dist/maplibre-gl.js"></script>
  <script src="https://unpkg.com/satellite.js@5.0.0/dist/satellite.min.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

**Step 2: Write style.css**

Port raf-watch's glassmorphic style with these adaptations:
- Same CSS custom properties (--bg-panel, --border-subtle, etc.)
- Same .glass, .panel base classes
- Same Inter font
- Legend items with operator colours (circles like raf-watch)
- Tooltip styling
- Mobile responsive
- `.title-trace` styled like `.title-watch` in raf-watch

**Step 3: Verify**

Open `web/index.html` in browser — should show dark background with glass panels, no map yet.

**Step 4: Commit**

```bash
git add web/index.html web/style.css
git commit -m "feat: frontend HTML skeleton with glassmorphic style"
```

---

### Task 6: Frontend — MapLibre globe with satellite layer

**Files:**
- Modify: `web/app.js`

**Step 1: Write app.js — map setup and TLE loading**

Structure (following raf-watch's section-comment style):

```javascript
// ── Operator colours ──────────────────────────────────────────────
const OPERATOR_COLORS = {
  maxar: '#e05555', airbus: '#5588cc', planet: '#44aa77',
  iceye: '#cc9944', capella: '#cc9944', satellogic: '#9977bb',
  government: '#cccc44', other: '#778899',
};

// ── TLE parsing ───────────────────────────────────────────────────
function parseTLEs(text) { /* returns [{name, line1, line2}] */ }

// ── Satellite propagation ─────────────────────────────────────────
function propagate(satrec, date) {
  // Uses satellite.js to get lat/lon/alt
  // Returns {lat, lon, alt_km} or null on error
}

// ── Map setup ─────────────────────────────────────────────────────
const mapStyle = { /* CARTO Dark raster + OpenFreeMap labels, globe projection */ };
const map = new maplibregl.Map({ ... });

// ── Data loading ──────────────────────────────────────────────────
// Fetch satellites.json + tles.txt in parallel
// Parse TLEs, create satrec objects
// Build GeoJSON FeatureCollection of current positions

// ── Animation loop ────────────────────────────────────────────────
// requestAnimationFrame loop:
//   - propagate all satellites to current time
//   - update GeoJSON source
//   - update legend counts

// ── Legend ─────────────────────────────────────────────────────────
// Build legend from OPERATOR_COLORS
// Click to toggle operator visibility

// ── Tooltip ───────────────────────────────────────────────────────
// Hover satellite dot → show name, operator, altitude, speed
// Click satellite → select, show ground track
```

Data URLs (configurable, defaults to GitHub releases):
```javascript
const DATA_BASE = 'data';  // Local dev uses symlink; production uses release URL
```

**Step 2: Implement map initialization**

- Globe projection
- CARTO Dark Matter basemap (same as raf-watch)
- OpenFreeMap label layers
- No attribution controls (hidden via CSS like raf-watch)

**Step 3: Implement TLE loading + satellite.js propagation**

- Fetch `tles.txt`, parse into satellite.js satrec objects
- Fetch `satellites.json`, merge metadata
- `propagate(satrec, now)` → `{lat, lon, alt_km}`
- Build GeoJSON FeatureCollection with point per satellite

**Step 4: Implement animation loop**

```javascript
function tick() {
  const now = new Date();
  const features = satellites.map(sat => {
    const pos = propagate(sat.satrec, now);
    if (!pos) return null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
      properties: { name: sat.name, operator: sat.operator, alt_km: pos.alt_km, color: sat.color }
    };
  }).filter(Boolean);
  map.getSource('satellites').setData({ type: 'FeatureCollection', features });
  requestAnimationFrame(tick);
}
```

**Step 5: Add satellite dot layer**

```javascript
map.addLayer({
  id: 'sat-dots',
  type: 'circle',
  source: 'satellites',
  paint: {
    'circle-radius': 4,
    'circle-color': ['get', 'color'],
    'circle-opacity': 0.9,
  }
});
```

**Step 6: Implement legend**

Build from OPERATOR_COLORS, same DOM structure as raf-watch. Click toggles operator visibility via filter expression.

**Step 7: Implement tooltip**

Mousemove on `sat-dots` layer → position tooltip, show satellite name/operator/altitude.

**Step 8: Test locally**

```bash
# Generate test data first
uv run scripts/fetch_tles.py
# Serve
python -m http.server -d web
# Open http://localhost:8000 — should see animated satellite dots on globe
```

**Step 9: Commit**

```bash
git add web/app.js
git commit -m "feat: live satellite constellation visualization on MapLibre globe"
```

---

### Task 7: Frontend — STAC1 decoder and heatmap layer

**Files:**
- Modify: `web/app.js`

**Step 1: Write STAC1 decoder**

```javascript
// ── STAC1 binary decoder ──────────────────────────────────────────
function decodeSTAC1(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  // Verify magic
  const magic = String.fromCharCode(...bytes.slice(0, 5));
  if (magic !== 'STAC1') throw new Error('Not a STAC1 file');

  const gridRes = bytes[5] / 100;         // e.g. 0.1 degrees
  const bucketDays = bytes[6];
  const epochOffset = view.getUint16(7, true);
  const numConstellations = bytes[9];

  let pos = 10;

  // Read constellation table
  const constellations = [];
  for (let i = 0; i < numConstellations; i++) {
    let name = '';
    while (bytes[pos] !== 0) name += String.fromCharCode(bytes[pos++]);
    pos++; // skip null
    constellations.push(name);
  }

  // Read uvarint/svarint (same as RAF1)
  function readUvarint() { /* ... */ }
  function readSvarint() { /* ... */ }

  // Read cells
  const numCells = readUvarint();
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
```

**Step 2: Convert decoded cells to GeoJSON grid rectangles**

```javascript
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
```

**Step 3: Add heatmap fill layer**

```javascript
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
    'fill-outline-color': 'rgba(255, 255, 255, 0.05)'
  }
}, 'sat-dots');  // Insert below satellite dots
```

**Step 4: Add heatmap cell tooltip**

Hover on `collection-heat` layer → show image count, constellation breakdown.

**Step 5: Test locally**

```bash
uv run scripts/encode_stac1.py  # Generate test STAC1 file
python -m http.server -d web
# Open browser — should see heatmap grid under satellite dots
```

**Step 6: Commit**

```bash
git add web/app.js
git commit -m "feat: STAC1 heatmap layer showing collection density"
```

---

### Task 8: Satellite selection and ground tracks

**Files:**
- Modify: `web/app.js`

**Step 1: Click satellite → show ground track**

On click of `sat-dots`:
- Propagate selected satellite for next 90 minutes at 30-second intervals
- Draw as LineString on `ground-track` layer
- Filter heatmap to that satellite's constellation
- Show satellite details in `#sat-info` panel

**Step 2: Ground track styling**

```javascript
map.addLayer({
  id: 'ground-track',
  type: 'line',
  source: 'ground-track',
  paint: {
    'line-color': ['get', 'color'],
    'line-width': 1.5,
    'line-opacity': 0.6,
    'line-dasharray': [2, 2]
  }
});
```

**Step 3: Click map background → deselect**

Clear ground track, unfilter heatmap, clear sat-info panel.

**Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat: satellite selection with ground track and constellation filter"
```

---

### Task 9: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/sync.yml`

**Step 1: Write workflow**

```yaml
name: Sync data
on:
  schedule:
    - cron: '0 6 * * *'  # Daily at 06:00 UTC
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v4

      - name: Fetch TLEs
        run: uv run scripts/fetch_tles.py

      - name: Sync STAC data
        run: uv run scripts/sync_stac.py --days 7
        env:
          UP42_USERNAME: ${{ secrets.UP42_USERNAME }}
          UP42_PASSWORD: ${{ secrets.UP42_PASSWORD }}

      - name: Encode STAC1
        run: uv run scripts/encode_stac1.py

      - name: Upload release assets
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create data --title "Data" --notes "Auto-updated data files" 2>/dev/null || true
          gh release upload data data/tles.txt data/satellites.json data/collection.stac1 --clobber
```

**Step 2: Commit**

```bash
git add .github/workflows/sync.yml
git commit -m "feat: daily GitHub Actions workflow for TLE + STAC sync"
```

---

### Task 10: Update CLAUDE.md and README

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Step 1: Rewrite CLAUDE.md**

Update to reflect new architecture: Python scripts, web/ frontend, STAC1 format, GitHub releases workflow.

**Step 2: Rewrite README.md**

Brief project description, screenshot placeholder, quick start (`uv run scripts/fetch_tles.py && python -m http.server -d web`).

**Step 3: Remove old shell scripts and Makefile**

```bash
git rm scripts/init.sh scripts/sync.sh scripts/analyze.sh scripts/geocode.sh scripts/status.sh Makefile
```

Keep `queries/analyze.sql` for future hotspot analysis work.

**Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update project docs for rewrite"
```

---

## Execution Order

Tasks 1-4 are sequential (each builds on the prior).
Tasks 5-7 are the frontend core (sequential within, but Task 5-6 can start after Task 2).
Task 8 depends on Task 6.
Task 9 is independent after Task 4.
Task 10 is last.

```
1 (restructure)
  → 2 (TLE fetcher)
    → 3 (STAC sync port)
      → 4 (STAC1 encoder)
  → 5 (HTML/CSS)
    → 6 (map + satellites)
      → 7 (STAC1 heatmap)
        → 8 (selection + tracks)
  → 9 (GitHub Actions)
→ 10 (docs cleanup)
```
