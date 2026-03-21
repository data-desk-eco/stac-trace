# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb"]
# ///
"""Export DuckDB STAC items to GeoParquet for frontend querying."""

import argparse
import os
import duckdb


def main():
    parser = argparse.ArgumentParser(description="Export STAC items to GeoParquet")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    parser.add_argument("--output", default="data/footprints.parquet", help="Output path")
    parser.add_argument("--days", type=int, default=None, help="Rolling window in days (default: all data)")
    args = parser.parse_args()

    db = duckdb.connect(args.db, read_only=True)

    where = ""
    if args.days:
        where = f"WHERE CAST(properties->>'datetime' AS TIMESTAMP) >= current_timestamp - INTERVAL '{args.days} days'"

    count = db.execute(f"SELECT COUNT(*) FROM items {where}").fetchone()[0]
    print(f"Exporting {count:,} items to {args.output}...")

    db.execute(f"""
        COPY (
            SELECT
                id,
                properties->>'constellation' AS constellation,
                CAST(properties->>'datetime' AS TIMESTAMP) AS datetime,
                CAST(properties->>'resolution' AS DOUBLE) AS resolution,
                geometry AS geojson
            FROM items
            {where}
            ORDER BY constellation, datetime
        ) TO '{args.output}'
        WITH (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
    """)

    result = db.execute(f"""
        SELECT COUNT(*) as n, COUNT(DISTINCT constellation) as constellations
        FROM '{args.output}'
    """).fetchone()
    print(f"Written: {result[0]:,} rows, {result[1]} constellations")

    size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f"File size: {size_mb:.1f} MB")

    db.close()


if __name__ == "__main__":
    main()
