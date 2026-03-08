# stac-trace Rewrite Design

**Date:** 2026-03-08
**Status:** Draft

## Vision

A static, client-side satellite constellation visualizer. A MapLibre globe shows ~200 active EO satellites propagated in real-time using sgp4, colour-coded by operator. A custom binary heatmap layer (STAC1 format) shows where each constellation has been collecting imagery. Everything runs in the browser. No server. Hostable on GitHub Pages.

## Architecture

```
Python scripts (uv run)          Static frontend (web/)
─────────────────────────         ────────────────────────
fetch TLEs from CelesTrak    →   tles.txt
sync STAC from UP42          →   (DuckDB, stays local)
encode STAC1 heatmap         →   collection.stac1
generate satellite metadata  →   satellites.json
                                  ↓
                              MapLibre GL globe
                              sgp4-js propagation
                              STAC1 heatmap layer
```

### Data Files (served statically)

| File | Format | Size est. | Update freq | Purpose |
|------|--------|-----------|-------------|---------|
| `tles.txt` | TLE two-line elements | ~50KB | Daily | Client-side orbit propagation |
| `satellites.json` | JSON | ~20KB | On sync | Operator, color, name, STAC stats per satellite |
| `collection.stac1` | Custom binary | ~200KB | On sync | Global collection heatmap grid |

### Delivery

Data files uploaded as GitHub release assets. GitHub Action runs daily: fetches TLEs, syncs STAC, encodes STAC1, creates/updates release. Frontend fetches from release URL.

## STAC1 Binary Format

A sparse 3D histogram encoding satellite imagery collection density across a global grid: **lat x lon x time**, bucketed by constellation.

### Design Goals

- Encode months of global STAC catalogue data in <500KB
- Decode in browser with zero dependencies
- Support filtering by constellation and time range
- Delta-encoded for compressibility

### Structure

```
┌──────────────────────────────────────────┐
│ Header (fixed)                           │
├──────────────────────────────────────────┤
│ Constellation Lookup Table (variable)    │
├──────────────────────────────────────────┤
│ Cell Records (variable, delta-encoded)   │
└──────────────────────────────────────────┘
```

#### Header (~12 bytes)

| Field | Type | Description |
|-------|------|-------------|
| Magic | 5 bytes | `STAC1` |
| Grid resolution | uint8 | In 1/100th degrees (10 = 0.1 deg, ~11km) |
| Time bucket | uint8 | Size in days (7 = weekly) |
| Epoch | uint16 LE | Start date as days since 2020-01-01 |
| Num constellations | uint8 | Entries in lookup table |
| Num cells | uint32 varint | Total cell records |

#### Constellation Lookup Table

Null-terminated UTF-8 strings, sequential:
```
pléiades-neo\0worldview\0maxar\0jilin\0...
```

Index in table = constellation ID used in cell records.

#### Cell Records

Sorted by grid position (row-major: y then x) for delta encoding locality.

Per cell:
| Field | Type | Description |
|-------|------|-------------|
| dx | svarint | Grid x delta from previous cell |
| dy | svarint | Grid y delta from previous cell |
| n_buckets | uvarint | Number of time buckets with data |

Per bucket within cell:
| Field | Type | Description |
|-------|------|-------------|
| time_offset | uvarint | Bucket index from epoch |
| constellation | 4 bits | Lookup table index |
| count | 4 bits or varint | Image count (0-14 inline, 15 = flag + uvarint follows) |

#### Varint Encoding

Same LEB128 scheme as RAF1:
- **uvarint**: Unsigned, 7 bits per byte, MSB = continuation
- **svarint**: ZigZag-encoded signed → uvarint

#### Size Estimate

- 50,000 active cells globally (conservative)
- Average 3 time buckets per cell
- ~3 bytes per cell header (deltas) + ~2 bytes per bucket = ~9 bytes/cell
- **~450KB raw, ~150KB gzipped**

### Decoding (JavaScript)

```javascript
function decodeSTAC1(buf) {
  const view = new DataView(buf);
  // ... read header, constellation table
  // ... iterate cells, accumulate deltas
  // Returns: Map<gridKey, [{time, constellation, count}]>
}
```

Frontend renders as a MapLibre heatmap/fill layer by mapping grid cells to rectangles.

## Frontend (web/)

### Stack

- **MapLibre GL JS** — Globe projection, vector rendering
- **satellite.js** — sgp4 propagation in the browser (~5KB)
- **Vanilla JS** — No framework, no build step
- Served as static files: `python -m http.server -d web`

### Layout

Glassmorphic dark theme (matching raf-map style):

- **Globe** — Full viewport, dark basemap
- **Legend** (top-right) — Constellation colours, clickable to filter
- **Info panel** (top-left) — Title, satellite count, selected satellite details
- **Time controls** (bottom) — Scrub through collection history, animate orbits

### Map Layers

1. **Satellite positions** — Animated dots, colour-coded by operator, updated every second via requestAnimationFrame
2. **Ground tracks** — Current orbit trace (next ~90 min) for selected satellite
3. **Collection heatmap** — STAC1 decoded grid, colour intensity = image count, filterable by constellation/time
4. **Satellite labels** — Name on hover/click

### Interactions

- **Hover satellite** — Show name, operator, altitude, velocity
- **Click satellite** — Select it: show full orbit ground track, upcoming passes, collection history from STAC1 layer filtered to that constellation
- **Hover heatmap cell** — Show image count, constellation breakdown, date range
- **Legend click** — Toggle constellation visibility (both satellites and heatmap)
- **Time slider** — Filter heatmap by date range

### Colour Scheme

| Operator | Colour |
|----------|--------|
| Maxar (WorldView, Legion) | Red |
| Airbus (Pléiades, SPOT) | Blue |
| Planet (SkySat, Dove) | Green |
| BlackBridge / ICEYE | Orange |
| Government / military | Yellow |
| Other commercial | White |

## Python Scripts (scripts/)

All scripts use `uv run` with inline dependency declarations. No requirements.txt, no venv.

### scripts/fetch_tles.py

- Fetches current TLEs from CelesTrak for EO satellite groups
- Filters to active EO constellations (~200 satellites)
- Outputs `data/tles.txt` (standard TLE format)
- Generates `data/satellites.json` with metadata (name, NORAD ID, operator, colour)

### scripts/sync_stac.py

- Port of existing `scripts/sync.sh` to Python
- OAuth authentication with UP42
- Regional splitting + pagination
- Appends to `data/stac.duckdb` (existing schema)
- Incremental: uses sync_log to avoid re-fetching

### scripts/encode_stac1.py

- Reads DuckDB, grids all footprint centroids
- Buckets by time (weekly) and constellation
- Encodes STAC1 binary format
- Outputs `data/collection.stac1`

### scripts/status.py

- Port of existing `scripts/status.sh`
- Database statistics and health check

## Directory Structure

```
stac-trace/
├── web/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data -> ../data       # Symlink for local dev
├── scripts/
│   ├── fetch_tles.py
│   ├── sync_stac.py
│   ├── encode_stac1.py
│   └── status.py
├── queries/
│   └── analyze.sql            # Keep for future hotspot analysis
├── data/
│   ├── stac.duckdb            # Persistent STAC archive (local only)
│   ├── tles.txt               # Current TLEs
│   ├── satellites.json        # Satellite metadata
│   └── collection.stac1       # Encoded heatmap
├── docs/
│   └── plans/
├── .github/
│   └── workflows/
│       └── sync.yml           # Daily TLE + STAC sync, release upload
├── CLAUDE.md
├── README.md
└── .gitignore
```

## GitHub Actions Workflow

```yaml
# .github/workflows/sync.yml
# Runs daily
# 1. uv run scripts/fetch_tles.py
# 2. uv run scripts/sync_stac.py --days 7
# 3. uv run scripts/encode_stac1.py
# 4. Upload tles.txt, satellites.json, collection.stac1 as release assets
#    to a rolling "data" release (overwrite existing assets)
```

Frontend fetches data from:
```
https://github.com/{owner}/stac-trace/releases/download/data/tles.txt
https://github.com/{owner}/stac-trace/releases/download/data/satellites.json
https://github.com/{owner}/stac-trace/releases/download/data/collection.stac1
```

## Migration Path

1. Keep existing shell scripts working during transition
2. Port sync logic to Python first (validates against existing data)
3. Build STAC1 encoder against existing DuckDB data
4. Build frontend from scratch in `web/`
5. Remove old shell scripts and Makefile once Python pipeline is solid
6. Clean up legacy files (.python-version, uv.lock, old index.html)

## Open Questions

- **CelesTrak TLE groups**: Which specific groups cover all EO sats? Likely `visual`, `resource`, `earth-resources` — needs research.
- **Satellite ↔ constellation mapping**: TLEs use NORAD names, STAC uses constellation names (e.g. "pléiades-neo"). Need a mapping table.
- **STAC1 versioning**: Include format version in header for future evolution?
- **Swath visualization**: Phase 2 — project sensor field-of-view as ground footprint. Requires satellite attitude data we may not have.
