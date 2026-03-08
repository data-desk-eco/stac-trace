# stac-trace

Real-time Earth observation satellite constellation visualizer with a heatmap of recent high-resolution imagery collection. What's being watched?

## Quick Start

```bash
# Fetch satellite TLEs (no credentials needed)
uv run scripts/fetch_tles.py

# Serve locally
python -m http.server -d web
# Open http://localhost:8000
```

To include STAC collection heatmap data:

```bash
# Set UP42 credentials in .env (UP42_USERNAME, UP42_PASSWORD)
uv run scripts/sync_stac.py --days 30
uv run scripts/encode_stac1.py
```

## Data Pipeline

```
CelesTrak ─→ fetch_tles.py ──→ tles.txt + satellites.json
UP42 API  ─→ sync_stac.py ──→ stac.duckdb ─→ encode_stac1.py ─→ collection.stac1
                                                                        ↓
                                                  web/app.js ← MapLibre GL globe
```

- **satellite.js** propagates TLEs in real-time (SGP4) with full-orbit trails
- **STAC1** compact binary format delivers collection heatmap in ~2-5KB
- **GitHub Actions** syncs data daily, deploys to Pages via releases

## License

MIT
