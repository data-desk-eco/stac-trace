# stac-trace

Real-time Earth observation satellite constellation visualizer showing where high-resolution imagery is being collected. What's being watched?

## Quick Start

```bash
# Fetch satellite TLEs (no credentials needed)
uv run scripts/fetch_tles.py

# Serve locally
python -m http.server -d web
# Open http://localhost:8000
```

To include image footprint data:

```bash
# Set UP42 credentials in .env (UP42_USERNAME, UP42_PASSWORD)
uv run scripts/sync_stac.py --days 30
uv run scripts/export_parquet.py
```

## Data Pipeline

```
CelesTrak ─→ fetch_tles.py ──→ tles.txt + satellites.json
UP42 API  ─→ sync_stac.py ──→ stac.duckdb ─→ export_parquet.py ─→ footprints.parquet
                                                                          ↓
                                                    web/app.js ← MapLibre GL globe
```

- **satellite.js** propagates TLEs in real-time (SGP4) with full-orbit trails
- **duckdb-wasm** queries GeoParquet for actual footprint polygons on satellite selection
- **GitHub Actions** syncs data daily, deploys to Pages via releases

## License

MIT
