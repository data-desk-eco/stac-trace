# GeoParquet Footprints + Style Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the STAC1 binary heatmap with actual satellite image footprints queried from GeoParquet via duckdb-wasm, and refresh the UI to match raf-watch's visual style.

**Architecture:** Python script exports DuckDB → GeoParquet sorted by constellation. Frontend loads duckdb-wasm and queries the parquet file on satellite selection, rendering actual image footprint polygons. CARTO dark raster basemap + Inter font replaces current OFM vector + Space Mono.

**Tech Stack:** DuckDB (spatial + parquet extensions), duckdb-wasm 1.29.0, MapLibre GL JS, GeoParquet

**Spec:** `docs/superpowers/specs/2026-03-20-geoparquet-footprints-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/export_parquet.py` | Create | Export DuckDB items → GeoParquet with geometry, constellation, datetime, resolution |
| `scripts/encode_stac1.py` | Delete | Replaced by export_parquet.py |
| `data/collection.stac1` | Delete | Replaced by footprints.parquet |
| `web/style.css` | Rewrite | Adopt raf-watch's Inter font, black panels, CSS variable hierarchy |
| `web/index.html` | Modify | Swap fonts, add duckdb-wasm script |
| `web/app.js` | Modify | Replace STAC1 with duckdb-wasm, update basemap, update selection to query parquet |
| `.github/workflows/sync.yml` | Modify | Replace encode_stac1 step with export_parquet, update data.zip contents |
| `.github/workflows/deploy.yml` | No change | Already copies all files from data.zip into web/data |
| `CLAUDE.md` | Modify | Update pipeline docs |

---

### Task 1: Create GeoParquet export script

**Files:**
- Create: `scripts/export_parquet.py`

- [ ] **Step 1: Write the export script**

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb"]
# ///
"""Export DuckDB STAC items to GeoParquet for frontend querying."""

import argparse
import duckdb

def main():
    parser = argparse.ArgumentParser(description="Export STAC items to GeoParquet")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    parser.add_argument("--output", default="data/footprints.parquet", help="Output path")
    args = parser.parse_args()

    db = duckdb.connect(args.db, read_only=True)
    db.execute("INSTALL spatial; LOAD spatial")

    count = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    print(f"Exporting {count:,} items to {args.output}...")

    db.execute(f"""
        COPY (
            SELECT
                id,
                properties->>'constellation' AS constellation,
                CAST(properties->>'datetime' AS TIMESTAMP) AS datetime,
                CAST(properties->>'resolution' AS DOUBLE) AS resolution,
                ST_GeomFromGeoJSON(geometry) AS geometry
            FROM items
            ORDER BY constellation, datetime
        ) TO '{args.output}'
        WITH (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
    """)

    # Verify
    result = db.execute(f"""
        SELECT COUNT(*) as n,
               COUNT(DISTINCT constellation) as constellations
        FROM '{args.output}'
    """).fetchone()
    print(f"Written: {result[0]:,} rows, {result[1]} constellations")

    import os
    size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f"File size: {size_mb:.1f} MB")

    db.close()

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the export and verify output**

Run: `uv run scripts/export_parquet.py`
Expected: Prints row count, constellation count, file size. Creates `data/footprints.parquet`.

- [ ] **Step 3: Verify parquet is queryable with constellation filter**

Run:
```bash
uv run python -c "
import duckdb
db = duckdb.connect()
db.execute('INSTALL spatial; LOAD spatial')
for r in db.execute(\"\"\"
    SELECT constellation, COUNT(*) as n
    FROM 'data/footprints.parquet'
    GROUP BY constellation ORDER BY n DESC
\"\"\").fetchall():
    print(f'  {r[0]:15s} {r[1]:>8,}')
"
```
Expected: Same constellation counts as in DuckDB source.

- [ ] **Step 4: Delete old STAC1 files**

```bash
rm scripts/encode_stac1.py data/collection.stac1
```

- [ ] **Step 5: Commit**

```bash
git add scripts/export_parquet.py
git rm scripts/encode_stac1.py data/collection.stac1
git commit -m "feat: replace STAC1 binary with GeoParquet export"
```

---

### Task 2: Style refresh — CSS + HTML

**Files:**
- Rewrite: `web/style.css`
- Modify: `web/index.html`

Reference: `~/Tools/raf-watch/web/style.css` and `~/Tools/raf-watch/web/index.html` for the target visual style.

- [ ] **Step 1: Rewrite style.css**

Adopt raf-watch's visual language. Key changes from current:
- Font: Inter (variable weight from `rsms.me/inter/font-files/InterVariable.woff2`) replacing Space Mono
- Panel bg: `rgba(0, 0, 0, 0.75)` replacing `rgba(30, 33, 34, 0.8)`
- CSS variables: `--bg-panel`, `--border-subtle`, `--text-primary/secondary/muted/faint/hint` hierarchy
- Font sizes: `--font-xs: 10px`, `--font-sm: 11px`, `--font-base: 13px`
- Edge spacing: `--edge-spacing: 16px`
- Panel title: 18px weight 600, no uppercase/letter-spacing (raf-watch style)
- Legend: adopt raf-watch's `.legend-item` with flex layout, `.legend-circle` dot, `.legend-cnt` count
- Tooltip: adopt raf-watch's tooltip with `.tt-hex`, `.tt-label`, `.tt-value` classes
- Keep `#sat-info` section for satellite details panel (stac-trace specific)
- Keep existing panel positions (top-left info, bottom-left legend)
- Scrollbar styling for panels
- Mobile breakpoint at 768px

```css
:root {
    --bg-panel: rgba(0, 0, 0, 0.75);
    --border-subtle: rgba(255, 255, 255, 0.08);
    --border-light: rgba(255, 255, 255, 0.1);
    --text-primary: #fff;
    --text-secondary: rgba(255, 255, 255, 0.9);
    --text-muted: rgba(255, 255, 255, 0.6);
    --text-faint: rgba(255, 255, 255, 0.4);
    --text-hint: rgba(255, 255, 255, 0.35);
    --edge-spacing: 16px;

    --font-xs: 10px;
    --font-sm: 11px;
    --font-base: 13px;
}

@font-face {
    font-family: 'Inter';
    src: url('https://rsms.me/inter/font-files/InterVariable.woff2') format('woff2');
    font-weight: 100 900;
    font-display: swap;
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
#map { width: 100%; height: 100%; background: #000; }
.maplibregl-ctrl, .maplibregl-ctrl-logo, .maplibregl-ctrl-attrib { display: none !important; }

.glass {
    background: var(--bg-panel);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
}

.panel {
    position: absolute;
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-base);
}

/* --- Title panel --- */

#panel {
    top: var(--edge-spacing);
    left: var(--edge-spacing);
    padding: 12px 16px;
    width: 220px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    z-index: 10;
}

#panel h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 6px;
    color: var(--text-primary);
    letter-spacing: 0;
    text-transform: none;
}

.title-trace {
    color: var(--text-muted);
    font-style: italic;
}

.subtitle {
    font-size: var(--font-sm);
    line-height: 1.5;
    color: var(--text-faint);
    margin: 0;
}

.subtitle a {
    color: var(--text-muted);
    text-decoration: underline;
}

.subtitle a:hover {
    color: var(--text-primary);
}

/* --- Satellite info --- */

#sat-info {
    font-size: var(--font-sm);
    line-height: 1.7;
    color: var(--text-muted);
    border-top: 1px solid var(--border-subtle);
    padding-top: 10px;
    margin-top: 8px;
}

#sat-info:empty { display: none; }

#sat-info .sat-name {
    font-weight: 600;
    color: var(--text-primary);
    font-size: var(--font-base);
    margin-bottom: 4px;
}

#sat-info .sat-detail {
    display: flex;
    justify-content: space-between;
}

#sat-info .sat-label {
    color: var(--text-faint);
}

/* --- Legend --- */

#legend {
    top: var(--edge-spacing);
    right: var(--edge-spacing);
    padding: 12px 14px;
    z-index: 10;
}

.panel h4 {
    font-size: var(--font-sm);
    font-weight: 500;
    color: var(--text-faint);
    margin: 0 0 8px 0;
}

.legend-item {
    display: flex;
    align-items: center;
    margin: 5px 0;
    font-size: var(--font-sm);
    color: var(--text-muted);
    cursor: pointer;
    transition: opacity 0.15s;
}

.legend-item:hover { color: var(--text-primary); }
.legend-item.disabled { opacity: 0.35; }

.legend-circle {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 10px;
    flex-shrink: 0;
}

.legend-name { flex: 1; }

.legend-cnt {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    margin-left: 10px;
}

/* --- Tooltip --- */

#tooltip {
    display: none;
    position: absolute;
    border: 1px solid var(--border-subtle);
    padding: 10px 14px;
    font-size: var(--font-sm);
    line-height: 1.6;
    z-index: 20;
    pointer-events: none;
    min-width: 180px;
    max-width: 240px;
}

#tooltip .tt-title {
    color: var(--text-primary);
    font-weight: 500;
    font-size: var(--font-base);
}

#tooltip .tt-detail {
    color: var(--text-faint);
    font-size: var(--font-xs);
}

/* --- Scrollbar --- */

#panel::-webkit-scrollbar { width: 4px; }
#panel::-webkit-scrollbar-track { background: transparent; }
#panel::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); }

/* --- Mobile --- */

@media (max-width: 768px) {
    #panel {
        top: 8px;
        left: 8px;
        padding: 12px 16px;
        max-width: 220px;
    }
    #panel h1 { font-size: 16px; }

    #legend {
        top: 8px;
        right: 8px;
        padding: 8px 10px;
    }
}
```

- [ ] **Step 2: Update index.html**

Replace Space Mono font links with Inter. Add duckdb-wasm ESM script. Update meta tags.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>STAC TRACE / satellite imagery activity</title>
  <meta name="description" content="Real-time EO satellite constellation visualizer showing where high-resolution imagery is being collected">
  <link href="https://unpkg.com/maplibre-gl@5.19.0/dist/maplibre-gl.css" rel="stylesheet">
  <link href="style.css" rel="stylesheet">
</head>
<body>
  <div id="map"></div>
  <div id="panel" class="panel glass">
    <h1>STAC<span class="title-trace">TRACE</span></h1>
    <p class="subtitle">Real-time positions of Earth observation satellites showing where high-resolution imagery is being collected.</p>
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

Note: duckdb-wasm will be loaded dynamically in app.js (ESM import) rather than a script tag, because it needs async initialisation.

- [ ] **Step 3: Verify page loads with new styles**

Run: `python -m http.server -d web 8000` and open http://localhost:8000
Expected: Page loads with Inter font, black glass panels, raf-watch colour scheme. Satellites still animate. No heatmap (that code is removed in Task 3).

- [ ] **Step 4: Commit**

```bash
git add web/style.css web/index.html
git commit -m "feat: adopt raf-watch visual style — Inter font, dark panels"
```

---

### Task 3: Replace STAC1 with duckdb-wasm in app.js

**Files:**
- Modify: `web/app.js`

This is the main task. Replace the STAC1 binary decoder and heatmap with duckdb-wasm querying GeoParquet for actual footprints on satellite selection.

- [ ] **Step 1: Update basemap to CARTO dark raster**

In the map style definition, replace the OFM vector sources/layers with:
- CARTO dark raster basemap (`dark_nolabels`)
- OFM vector source for labels only (country borders + country labels)
- Match raf-watch label styling (text colours, sizes, letter-spacing)

The map style object should look like:

```javascript
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
```

- [ ] **Step 2: Remove all STAC1 code**

Delete from app.js:
- `decodeSTAC1()` function (lines ~63-123)
- `stac1ToGeoJSON()` function (lines ~125-151)
- `let stac1Data = null;` state variable
- The `collection.stac1` fetch from the `Promise.all` data loading block
- The STAC1 decode block (`if (stac1Buf) { ... }`)
- The `collection-heat` mousemove/mouseleave tooltip handlers
- References to `stac1Data` in `selectSatellite()` and `deselectSatellite()`

Keep:
- The `collection` GeoJSON source (will be used for footprints)
- The `collection-heat` layer definition (will be restyled for footprints in next step)

- [ ] **Step 3: Restyle the collection layer for footprints**

Rename `collection-heat` layer to `footprints`. Change paint to use the satellite's operator colour (passed as a feature property):

```javascript
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
```

Place this layer BEFORE the trail layers so footprints render beneath trails and satellite dots.

- [ ] **Step 4: Add duckdb-wasm initialisation**

Add at the top of app.js, after the constants:

```javascript
// ── DuckDB-WASM setup ────────────────────────────────────────────
let duckdbConn = null;

async function initDuckDB() {
  const DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/';
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: DUCKDB_CDN + 'duckdb-mvp.wasm', mainWorker: DUCKDB_CDN + 'duckdb-browser-mvp.worker.js' },
    eh: { mainModule: DUCKDB_CDN + 'duckdb-eh.wasm', mainWorker: DUCKDB_CDN + 'duckdb-browser-eh.worker.js' },
  });
  const worker = new Worker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule);
  const conn = await db.connect();
  await conn.query("INSTALL spatial; LOAD spatial");
  return conn;
}
```

In the `map.on('load')` handler, add duckdb init alongside the existing data fetches:

```javascript
const [tleText, metaJson, conn] = await Promise.all([
  fetch(`${DATA_BASE}/tles.txt`).then(r => r.ok ? r.text() : ''),
  fetch(`${DATA_BASE}/satellites.json`).then(r => r.ok ? r.json() : {}),
  initDuckDB(),
]);
duckdbConn = conn;
```

Add the duckdb-wasm script tag to index.html (before app.js):
```html
<script src="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser.cjs"></script>
```

Wait — duckdb-wasm's browser bundle exposes a global `duckdb` namespace when loaded via script tag. Check the CDN bundle path. The correct UMD/global entry point is:

```html
<script src="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser-blocking.cjs"></script>
```

Actually, for async usage the recommended approach is the ESM bundle or the non-blocking CJS. Test which global is exposed. The simplest approach: load via script tag and use the `duckdb` global.

Use this in index.html (before app.js):
```html
<script src="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser.cjs"></script>
```

- [ ] **Step 5: Add footprint query on satellite selection**

Replace the STAC1 filtering in `selectSatellite()` with a duckdb-wasm query:

```javascript
async function queryFootprints(constellation, color) {
  if (!duckdbConn) return;
  const parquetUrl = `${location.origin}${location.pathname}data/footprints.parquet`;
  const result = await duckdbConn.query(`
    SELECT ST_AsGeoJSON(geometry) as geojson
    FROM '${parquetUrl}'
    WHERE constellation = '${constellation}'
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
```

Update `selectSatellite()` — replace the `if (stac1Data)` block with:
```javascript
queryFootprints(sat.constellation, sat.color);
```

Update `deselectSatellite()` — replace the `if (stac1Data)` block with:
```javascript
map.getSource('collection').setData({ type: 'FeatureCollection', features: [] });
```

- [ ] **Step 6: Update legend to use raf-watch CSS classes**

In `buildLegend()`, update the HTML to use the new CSS classes:

```javascript
item.innerHTML = `
  <span class="legend-circle" style="background:${color}"></span>
  <span class="legend-name">${op}</span>
  <span class="legend-cnt">${count}</span>
`;
```

- [ ] **Step 7: Update tooltip to use new CSS classes**

In the sat-dots mousemove handler:
```javascript
tooltip.innerHTML = `
  <div class="tt-title">${f.properties.name}</div>
  <div class="tt-detail">${f.properties.operator} &middot; ${f.properties.alt_km} km</div>
`;
tooltip.style.left = (e.point.x + 14) + 'px';
tooltip.style.top = (e.point.y - 14) + 'px';
tooltip.style.display = 'block';
```

In mouseleave: `tooltip.style.display = 'none';`

Remove the `collection-heat` tooltip handlers entirely (no longer relevant — footprints don't need hover counts).

- [ ] **Step 8: Verify end-to-end in browser**

Run: `python -m http.server -d web 8000` and open http://localhost:8000

Verify:
1. Page loads with CARTO dark basemap, Inter font, raf-watch panel style
2. Satellites animate with orbital trails
3. Click a satellite → footprint polygons appear in the operator's colour
4. Click background → footprints clear
5. Legend toggles operators on/off
6. Console shows "Loaded N footprints for X"
7. No console errors

- [ ] **Step 9: Commit**

```bash
git add web/app.js web/index.html
git commit -m "feat: replace STAC1 heatmap with duckdb-wasm GeoParquet footprints"
```

---

### Task 4: Update CI/CD and docs

**Files:**
- Modify: `.github/workflows/sync.yml`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update sync workflow**

In `.github/workflows/sync.yml`:

Replace the "Encode STAC1" step:
```yaml
      - name: Export GeoParquet
        run: uv run scripts/export_parquet.py
```

Update the "Package and upload data" step to include `footprints.parquet` instead of `collection.stac1`:
```yaml
          zip -r ../data.zip tles.txt satellites.json footprints.parquet stac.duckdb
```

Update the "Copy data into web directory" step:
```yaml
          cp data/tles.txt data/satellites.json data/footprints.parquet web/data/
```

- [ ] **Step 2: Update CLAUDE.md**

Update the Data Pipeline section:
- Replace step 3 (`encode_stac1.py`) with `export_parquet.py`
- Remove `--verify` flag reference
- Update Directory Structure: `collection.stac1` → `footprints.parquet`
- Update STAC1 Binary Format section → GeoParquet section explaining the format
- Update Frontend section: mention duckdb-wasm instead of STAC1 decoder
- Update Deployment section: `collection.stac1` → `footprints.parquet` in data.zip

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sync.yml CLAUDE.md
git commit -m "docs: update pipeline for GeoParquet, remove STAC1 references"
```
