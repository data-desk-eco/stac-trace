# stac-trace

Real-time Earth observation satellite constellation visualizer with a heatmap of recent high-resolution imagery collection activity. 'What's being watched?'

## System Architecture

- **Python scripts** (`scripts/`) for data fetching and encoding (run with `uv run`)
- **DuckDB** (`data/stac.duckdb`) for persistent STAC data storage
- **Vanilla JS frontend** (`web/`) with MapLibre GL globe + satellite.js
- **STAC1 binary format** for compact heatmap data delivery
- **GitHub Actions** for daily automated data sync
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
  style.css        # Glassmorphic UI styles
  data -> ../data  # Symlink for local dev
data/
  stac.duckdb      # Persistent database
  tles.txt         # TLE data (generated)
  satellites.json  # Satellite metadata (generated)
  collection.stac1 # Binary heatmap data (generated)
.github/
  workflows/
    sync.yml       # Daily data sync workflow
```

## Workflow

```bash
# Data pipeline
uv run scripts/fetch_tles.py           # Fetch satellite TLEs
uv run scripts/sync_stac.py --days 30  # Sync STAC data from UP42
uv run scripts/encode_stac1.py         # Encode heatmap binary

# Local development
python -m http.server -d web           # Serve frontend at localhost:8000

# Verify STAC1 output
uv run scripts/encode_stac1.py --verify
```

## Key Technical Details

### Authentication
- Uses OAuth token endpoint: `https://auth.up42.com/realms/public/protocol/openid-connect/token`
- Client ID: `up42-api`
- Grant type: `password`
- Credentials from environment variables: `UP42_USERNAME` and `UP42_PASSWORD`

### TLE Fetching
- Sources: CelesTrak active + resource groups
- Matches satellites by name prefix to known EO constellations
- Outputs TLE text file + JSON metadata with operator/color/resolution
- Covers: Maxar, Airbus, Planet, ICEYE, Capella, Satellogic, government

### STAC Sync
- 500-item limit per request with pagination
- Splits world into 5 regions for complete coverage
- Filters: resolution <= 0.75m, excludes SPOT
- 0.3s delay between paginated requests

### STAC1 Binary Format
- Compact binary encoding for frontend heatmap delivery
- 0.1° grid cells with 7-day time buckets
- Delta-encoded coordinates, varint-compressed
- Constellation-indexed with nibble-packed counts
- Typical output: ~2-5KB for hundreds of grid cells

### Frontend
- MapLibre GL JS with globe projection
- CARTO Dark Matter basemap + OpenFreeMap labels
- satellite.js (SGP4) for real-time orbital propagation
- requestAnimationFrame animation loop
- Click satellite → ground track + constellation-filtered heatmap
- Glassmorphic UI panels

### Database Schema

```sql
items (id TEXT PRIMARY KEY, geometry JSON, properties JSON, bbox JSON, host TEXT, fetched_at TIMESTAMP)
sync_log (id INTEGER, host TEXT, region TEXT, start_date TIMESTAMP, end_date TIMESTAMP, items_added INTEGER, synced_at TIMESTAMP)
```

### GitHub Actions
- Daily sync at 06:00 UTC via `.github/workflows/sync.yml`
- Uploads TLEs, satellite metadata, and STAC1 binary as GitHub release assets
