# Date Slider & Footprint Tooltips

## Overview

Add a date slider (raf-watch style) to filter imagery footprints by date, and hover tooltips on footprint polygons showing metadata. The slider shows a histogram of image counts per date and loads footprints on demand for the selected date, filtered by legend-enabled operators.

## Date Slider Component

### Markup
Glass panel at bottom-left, matching existing panel style. Structure:
- `#date-slider.panel.glass` container (hidden until data loads)
- `#slider-histogram` — bar chart of image counts per date
- `#slider-track` — wraps native `<input type="range">` + tick marks
- `#slider-labels` — start date | current date + image count | end date

### Styling (ported from raf-watch)
- Position: `bottom: 16px; left: 16px`, width ~420px
- Background: `rgba(0,0,0,0.75)` + `backdrop-filter: blur(12px)`
- Histogram bars: 3px wide, `rgba(255,255,255,0.35)`, active bar brighter
- Square slider thumb: 10x10px, `var(--text-muted)` → white on hover
- Labels: 10px Inter, tabular-nums, center label shows `YYYY-MM-DD · N images`
- Responsive: center on mobile ≤768px

### Behavior
1. **On page load**: run aggregate DuckDB query against parquet:
   ```sql
   SELECT CAST(datetime AS DATE) AS date, COUNT(*) AS n
   FROM 'footprints.parquet'
   GROUP BY date ORDER BY date
   ```
2. Build histogram bars (height proportional to max count), tick marks, labels
3. Default to latest date, load footprints for that date
4. **On slider input**: query footprints for new date (filtered by enabled constellations from legend)
5. **On histogram bar click**: jump slider to that date index, trigger load
6. **On legend toggle**: re-query current date with updated constellation filter

## Footprint Loading (refactored)

Current `queryFootprints(constellation, color)` is replaced with a date-aware version.

### Query for selected date
```sql
SELECT id, constellation, datetime, resolution, geojson
FROM 'footprints.parquet'
WHERE CAST(datetime AS DATE) = ?
  AND constellation IN (...)
```

Constellation filter comes from legend-enabled operators mapped through existing `CONSTELLATION_MAP`.

### Map rendering
- Each footprint stored as GeoJSON feature with `id`, `constellation`, `datetime`, `resolution` as properties
- Fill layer: operator color at 25% opacity
- Outline: operator color at 15% opacity
- Color derived from satellite metadata (operator → color mapping)

## Footprint Hover Tooltips

### Behavior
- On `mousemove` over footprint fill layer, show tooltip near cursor
- On `mouseleave`, hide tooltip

### Tooltip content
```
Pléiades Neo
2026-03-15 14:23 UTC
0.3m resolution
id: abc123
```

### Styling
- Reuse existing satellite tooltip style (dark glass, Inter font)
- Position follows mouse with offset

## Integration with Existing Features

- **Satellite selection**: clicking a satellite still works, but now footprints come from the date slider's selected date (filtered to that satellite's constellation)
- **Legend toggles**: affect both satellite dots AND footprint display
- **Date slider visibility**: always visible once date data loads (not tied to satellite selection)

## Files Changed

| File | Changes |
|------|---------|
| `web/index.html` | Add `#date-slider` markup |
| `web/style.css` | Add slider, histogram, tick, label, tooltip styles |
| `web/app.js` | Date slider setup, refactored footprint queries, hover tooltip logic |

## Out of Scope
- Date range selection (single date only)
- Additional parquet columns (cloud cover, off-nadir) — future enhancement
- Footprint clustering/simplification for dense dates
