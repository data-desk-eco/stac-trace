# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb"]
# ///
"""Export DuckDB STAC items to GeoParquet for frontend querying.

Simplifies geometries to bounding boxes for compact size and fast rendering.
Sorted by date for efficient date-range queries via row group pruning.
"""

import argparse
import json
import os
import duckdb


def bbox_geojson(geom_str: str) -> str:
    """Convert a GeoJSON geometry to its bounding box polygon."""
    g = json.loads(geom_str)
    coords = g.get("coordinates", [[]])
    # Flatten all coordinate arrays
    flat = coords[0] if g["type"] == "Polygon" else [c for ring in coords for c in ring[0]]
    if not flat:
        return geom_str
    lons = [c[0] for c in flat]
    lats = [c[1] for c in flat]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    return json.dumps({
        "type": "Polygon",
        "coordinates": [[[min_lon, min_lat], [max_lon, min_lat],
                         [max_lon, max_lat], [min_lon, max_lat],
                         [min_lon, min_lat]]]
    }, separators=(",", ":"))


def main():
    parser = argparse.ArgumentParser(description="Export STAC items to GeoParquet")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    parser.add_argument("--output", default="data/footprints.parquet", help="Output path")
    parser.add_argument("--days", type=int, default=None, help="Rolling window in days (default: all data)")
    args = parser.parse_args()

    db = duckdb.connect(args.db, read_only=True)

    where = ""
    if args.days:
        where = f"WHERE CAST(properties->>'datetime' AS TIMESTAMP) >= CAST(current_date - INTERVAL '{args.days} days' AS TIMESTAMP)"

    count = db.execute(f"SELECT COUNT(*) FROM items {where}").fetchone()[0]
    print(f"Processing {count:,} items...")

    # Fetch all items — we need to simplify geometries in Python
    rows = db.execute(f"""
        SELECT
            id,
            properties->>'constellation' AS constellation,
            CAST(properties->>'datetime' AS TIMESTAMP) AS datetime,
            CAST(properties->>'resolution' AS DOUBLE) AS resolution,
            geometry
        FROM items
        {where}
        ORDER BY datetime
    """).fetchall()

    # Simplify geometries to bounding boxes and write via DuckDB
    simplified = []
    for row in rows:
        simplified.append((row[0], row[1], row[2], row[3], bbox_geojson(row[4])))

    db2 = duckdb.connect()
    db2.execute("""
        CREATE TABLE export (
            id VARCHAR, constellation VARCHAR, datetime TIMESTAMP,
            resolution DOUBLE, geojson VARCHAR
        )
    """)
    db2.executemany("INSERT INTO export VALUES (?, ?, ?, ?, ?)", simplified)
    db2.execute(f"""
        COPY export TO '{args.output}'
        WITH (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 5000)
    """)

    result = db2.execute(f"""
        SELECT COUNT(*) as n, COUNT(DISTINCT constellation) as constellations
        FROM '{args.output}'
    """).fetchone()
    print(f"Written: {result[0]:,} rows, {result[1]} constellations")

    size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f"File size: {size_mb:.1f} MB")

    # Export analysis cache if it exists
    cache_output = os.path.join(os.path.dirname(args.output), "cache.parquet")
    try:
        cache_count = db.execute("SELECT count(*) FROM analysis_cache").fetchone()[0]
        if cache_count > 0:
            db.execute(f"COPY analysis_cache TO '{cache_output}' (FORMAT PARQUET, COMPRESSION ZSTD)")
            print(f"Cache: {cache_count} cached analyses exported")
    except duckdb.CatalogException:
        print("Cache: no analysis_cache table found, skipping")

    db.close()
    db2.close()


if __name__ == "__main__":
    main()
