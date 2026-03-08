# stac-trace

Real-time Earth observation satellite constellation visualizer with a heatmap of recent high-resolution imagery collection activity. 'What's being watched?'

Live at: `ltrg.co.uk/stac-trace`

## System Architecture

- **Python scripts** (`scripts/`) for data fetching and encoding (run with `uv run`)
- **DuckDB** (`data/stac.duckdb`) for persistent STAC data storage
- **Vanilla JS frontend** (`web/`) with MapLibre GL globe + satellite.js
- **STAC1 binary format** for compact heatmap data delivery
- **GitHub Actions** for daily data sync + Pages deployment
- Uses UP42 [API docs](https://developer.up42.com/reference/overview) for STAC queries
- UP42 credentials in `.env` (OAuth authentication)

## Directory Structure

```
scripts/
  fetch_tles.py    # Fetch TLEs from CelesTrak for EO constellations
  sync_stac.py     # Incremental STAC data sync from UP42
  encode_stac1.py  # Encode DuckDB data to STAC1 binary format
queries/
  analyze.sql      # DuckDB SQL for hotspot detection (legacy)
web/
  index.html       # Frontend entry point
  app.js           # MapLibre globe, satellite propagation, STAC1 decoder
  style.css        # Dark minimal UI, Space Mono
  data -> ../data  # Symlink for local dev
data/
  stac.duckdb      # Persistent database (gitignored)
  tles.txt         # TLE data (generated)
  satellites.json  # Satellite metadata (generated)
  collection.stac1 # Binary heatmap data (generated)
.github/workflows/
  deploy.yml       # Deploy to Pages on push (downloads data from release)
  sync.yml         # Daily: fetch data, upload to release, deploy Pages
```

## Data Pipeline

```bash
# 1. Fetch satellite TLEs (no credentials needed)
uv run scripts/fetch_tles.py

# 2. Sync STAC imagery metadata from UP42 (needs .env credentials)
uv run scripts/sync_stac.py --days 30

# 3. Encode heatmap binary
uv run scripts/encode_stac1.py

# Verify encoded output
uv run scripts/encode_stac1.py --verify
```

All three steps must run in order. Steps 1 and 3 are fast. Step 2 hits the UP42 API and may take minutes depending on `--days`.

### Local Development

```bash
# Create data symlink if missing
cd web && ln -s ../data data && cd ..

# Serve frontend
python -m http.server -d web
# Open http://localhost:8000
```

## Key Technical Details

### Authentication
- OAuth endpoint: `https://auth.up42.com/realms/public/protocol/openid-connect/token`
- Client ID: `up42-api`, grant type: `password`
- Env vars: `UP42_USERNAME` and `UP42_PASSWORD` (set in `.env`)

### STAC Sync (`sync_stac.py`)
- Auto-discovers available UP42 hosts (not just `oneatlas`)
- CQL2 server-side filtering with fallback to client-side
- 3 overlapping regions for global coverage, deduplicates results
- Adaptive rate limiting from response headers
- Time-window bisection when result sets exceed 10,000 items
- CLI: `--days 7` (default), `--host oneatlas` (specific host), `--global-bbox` (try single query)

### TLE Fetching (`fetch_tles.py`)
- CelesTrak active + resource groups
- Matches by name prefix: Maxar, Airbus, Planet, ICEYE, Capella, Satellogic, government
- Outputs `tles.txt` (standard TLE format) + `satellites.json` (metadata with operator/color/resolution)

### STAC1 Binary Format
- 0.1° grid cells, 7-day time buckets, epoch 2020-01-01
- Delta-encoded coordinates, varint-compressed
- Constellation-indexed with nibble-packed counts (overflow at 15)
- Typical output: ~2-5KB for hundreds of grid cells

### Frontend (`web/app.js`)
- MapLibre GL JS globe projection with OpenFreeMap vector tiles
- Dark theme: muted green land, dark ocean, subtle borders
- satellite.js SGP4 propagation in requestAnimationFrame loop
- Per-satellite orbital period trails (dashed, operator-coloured)
- Click satellite: 3-orbit solid trail, others hidden, constellation-filtered heatmap
- STAC1 binary decoder for heatmap grid (bright green fill)
- Space Mono monospace font

### Database Schema

```sql
items (id TEXT PRIMARY KEY, geometry JSON, properties JSON, bbox JSON, host TEXT, fetched_at TIMESTAMP)
sync_log (id INTEGER, host TEXT, region TEXT, start_date TIMESTAMP, end_date TIMESTAMP, items_added INTEGER, synced_at TIMESTAMP)
```

### Deployment
- **GitHub Pages** served from `web/` directory
- **Data distribution**: `latest-data` release contains `data.zip` with TLEs, satellite metadata, STAC1 binary, and DuckDB
- **`deploy.yml`**: on push to main — downloads data from release, bundles into `web/data/`, deploys Pages
- **`sync.yml`**: daily 06:00 UTC — runs full pipeline, uploads data.zip to release, deploys Pages
- Live URL: `ltrg.co.uk/stac-trace`
