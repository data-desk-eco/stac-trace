# stac-trace

Real-time EO satellite constellation visualizer with imagery collection heatmap and per-cluster intelligence analysis. Live at ltrg.co.uk/stac-trace

## Architecture

Python scripts (uv run) fetch data into DuckDB, export to GeoParquet. Vanilla JS frontend with MapLibre GL globe, satellite.js propagation, duckdb-wasm for client-side parquet queries. GitHub Actions for daily sync + Pages deploy.

## Directory Layout

- scripts/ — fetch_tles.py, sync_stac.py, sync_planet.py, export_parquet.py
- web/ — index.html, app.js, style.css (the entire frontend)
- data/ — stac.duckdb, tles.txt, satellites.json, footprints.parquet, cache/ (all generated, gitignored)
- serve.py — local dev server with Claude CLI proxy for cluster analysis
- .github/workflows/ — sync.yml (daily pipeline), deploy.yml (Pages deploy)

## Data Pipeline

Run in order:
1. uv run scripts/fetch_tles.py — TLEs from CelesTrak (no auth)
2. uv run scripts/sync_stac.py --days 30 — STAC metadata from UP42 (needs .env)
3. uv run scripts/sync_planet.py — SkySat from Planet API (needs .env)
4. uv run scripts/export_parquet.py — DuckDB to GeoParquet

## Local Development

```
cd web && ln -s ../data data && cd ..
uv run serve.py
```

serve.py serves web/ on :8000 and proxies /api/claude to the claude CLI for cluster analysis. Analysis is localhost-only (disabled on Pages).

## Credentials (.env)

- UP42_USERNAME, UP42_PASSWORD — UP42 STAC API (OAuth)
- PLANET_API_KEY — Planet Data API (basic auth)
- Claude CLI auth via Max subscription (no API key needed)

## Frontend Details

- MapLibre GL JS globe with CARTO dark basemap + Esri satellite (on cluster select)
- OpenFreeMap vector tiles for country labels/borders
- satellite.js SGP4 propagation at idle frame rate
- duckdb-wasm queries footprints.parquet via HTTP range requests
- Multi-provider overlap detection: grid-based spatial index, union-find clustering
- Cluster click: Overpass API for strategic POIs, Claude CLI streaming analysis
- Date range slider with log-scale histogram, playback animation

## Database Schema

items: id TEXT PK, geometry JSON, properties JSON, bbox JSON, host TEXT, fetched_at TIMESTAMP
sync_log: id INTEGER, host TEXT, region TEXT, start_date, end_date, items_added, synced_at

## Deployment

GitHub Pages from web/. Data distributed via latest-data release (data.zip). sync.yml runs daily at 06:00 UTC — full pipeline, upload, deploy. deploy.yml triggers on push to main.
