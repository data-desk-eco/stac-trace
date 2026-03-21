# GeoParquet Footprints + Style Refresh

## Summary

Replace the STAC1 binary heatmap with actual satellite image footprints queried from GeoParquet via duckdb-wasm. Refresh the UI to match raf-watch's visual style. Footprints are shown only when a satellite is selected.

## Data Pipeline

### New: `scripts/export_parquet.py`

Exports DuckDB items to a GeoParquet file (`data/footprints.parquet`) sorted by constellation for efficient range-request querying.

Columns:
- `id` (TEXT) — STAC item ID
- `constellation` (TEXT) — e.g. "pneo", "phr", "beijing-3a"
- `satellite` (TEXT) — extracted from `providerProperties.acquisitionIdentifier` where possible (PHR1A, PHR1B, PNEO3, PNEO4), falls back to constellation name
- `datetime` (TIMESTAMP) — acquisition time
- `resolution` (FLOAT) — GSD in metres
- `geometry` (GEOMETRY) — WKB polygon footprint

Sorted by `constellation, datetime` so duckdb-wasm can skip irrelevant row groups via column statistics.

### Remove

- `scripts/encode_stac1.py` — no longer needed
- `data/collection.stac1` — replaced by `data/footprints.parquet`

### Pipeline update

```bash
uv run scripts/fetch_tles.py
uv run scripts/sync_stac.py --days 30
uv run scripts/export_parquet.py   # new step, replaces encode_stac1.py
```

## Frontend

### duckdb-wasm integration

- Load duckdb-wasm from CDN (ESM bundle)
- On page load: initialise a duckdb instance, register the remote parquet file via `httpfs` for range-request access
- No query at startup — footprints only appear on satellite selection

### Satellite selection flow

1. User clicks satellite dot
2. `selectSatellite(sat)` queries: `SELECT geometry, datetime, resolution FROM 'data/footprints.parquet' WHERE constellation = ? ORDER BY datetime DESC`
   - Use constellation (not individual satellite name) because beijing-3 and capella items lack satellite-level IDs, and constellation matches what the TLE metadata provides
3. Convert WKB geometries to GeoJSON polygons
4. Set on the `collection` map source
5. On deselect: clear the source

### Map layers

Replace `collection-heat` (fill with count-based interpolation) with `footprints` layer:
- Type: `fill`
- Paint: semi-transparent fill using the selected satellite's operator colour
- Outline: subtle white stroke

### Remove

- STAC1 decoder (`decodeSTAC1`, `stac1ToGeoJSON`)
- STAC1 fetch from data loading
- Heatmap tooltip (`collection-heat` mousemove/mouseleave)

## Style Refresh

Adopt raf-watch's visual language:

### Basemap
- Switch from OFM vector tiles to CARTO dark raster (`dark_nolabels`) + OFM vector labels overlay
- Keep globe projection

### CSS
- Font: Inter (variable weight from rsms.me) replacing Space Mono
- Panel background: `rgba(0, 0, 0, 0.75)` (raf-watch) replacing `rgba(30, 33, 34, 0.8)`
- CSS variables: adopt raf-watch's `--text-primary`, `--text-secondary`, `--text-muted`, `--text-faint`, `--text-hint` hierarchy
- Panel spacing: `--edge-spacing: 16px`
- Keep existing panel layout (top-left info, bottom-left legend)

### Colours
- Operator colours stay the same (already match raf-watch's palette: `#e05555`, `#5588cc`, `#44aa77`, etc.)
- Map label colours: match raf-watch (`rgba(255,255,255,0.85)` for countries)

## Files Changed

| File | Action |
|------|--------|
| `scripts/export_parquet.py` | New — DuckDB → GeoParquet export |
| `scripts/encode_stac1.py` | Delete |
| `web/index.html` | Add duckdb-wasm script tag, remove Space Mono font, add Inter font |
| `web/app.js` | Replace STAC1 with duckdb-wasm queries, update map style, remove heatmap code |
| `web/style.css` | Adopt raf-watch variables and styling |
| `data/collection.stac1` | Delete (replaced by footprints.parquet) |
| `CLAUDE.md` | Update pipeline docs |
