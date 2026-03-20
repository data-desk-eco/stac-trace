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
