# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "duckdb", "python-dotenv"]
# ///
"""Sync SkySat imagery metadata from Planet's Data API into DuckDB."""

import argparse
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import duckdb
import httpx
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

SEARCH_URL = "https://api.planet.com/data/v1/quick-search"

# Cover the globe in overlapping regions to avoid result truncation
REGIONS = [
    ("Americas",      {"type": "Polygon", "coordinates": [[[-180,-90],[-30,-90],[-30,90],[-180,90],[-180,-90]]]}),
    ("Europe_Africa", {"type": "Polygon", "coordinates": [[[-35,-90],[65,-90],[65,90],[-35,90],[-35,-90]]]}),
    ("Asia_Pacific",  {"type": "Polygon", "coordinates": [[[60,-90],[180,-90],[180,90],[60,90],[60,-90]]]}),
]


def make_filter(start_date, end_date, geometry):
    return {
        "type": "AndFilter",
        "config": [
            {
                "type": "DateRangeFilter",
                "field_name": "acquired",
                "config": {"gte": start_date, "lte": end_date},
            },
            {
                "type": "GeometryFilter",
                "field_name": "geometry",
                "config": geometry,
            },
        ],
    }


def parse_feature(feat):
    """Convert a Planet API feature to our DB schema."""
    props = feat.get("properties", {})
    return {
        "id": feat.get("id"),
        "geometry": json.dumps(feat.get("geometry")),
        "properties": json.dumps({
            "constellation": "skysat",
            "datetime": props.get("acquired"),
            "resolution": props.get("gsd"),
            "satellite_id": props.get("satellite_id"),
            "cloud_cover": props.get("cloud_cover"),
            "sun_elevation": props.get("sun_elevation"),
        }),
        "bbox": json.dumps(feat.get("bbox") if "bbox" in feat else None),
        "host": "planet-direct",
    }


def sync_region(client, db, region_name, geometry, start_date, end_date):
    """Sync a single region, paginating through all results."""
    payload = {
        "item_types": ["SkySatCollect"],
        "filter": make_filter(start_date, end_date, geometry),
    }

    total_fetched = 0
    total_new = 0
    page = 0
    url = SEARCH_URL
    t0 = time.monotonic()

    while url:
        page += 1
        if page == 1:
            resp = client.post(url, json=payload)
        else:
            resp = client.get(url)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            log.info(f"    Rate limited, waiting {wait}s...")
            time.sleep(wait)
            continue
        resp.raise_for_status()
        data = resp.json()

        features = data.get("features", [])
        if not features:
            break

        batch = []
        for feat in features:
            item = parse_feature(feat)
            if item["id"]:
                batch.append(item)
                total_fetched += 1

        if batch:
            before = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
            db.executemany(
                "INSERT OR IGNORE INTO items (id, geometry, properties, bbox, host) "
                "VALUES (?, ?::JSON, ?::JSON, ?::JSON, ?)",
                [[b["id"], b["geometry"], b["properties"], b["bbox"], b["host"]] for b in batch],
            )
            after = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
            total_new += after - before

        if page <= 3 or page % 25 == 0:
            elapsed = time.monotonic() - t0
            rate = total_fetched / elapsed if elapsed > 0 else 0
            log.info(f"    p{page}: {total_fetched} items, {total_new} new, {rate:.0f}/s")

        # Next page via _links
        links = data.get("_links", {})
        url = links.get("_next")
        if url:
            payload = None  # Next URL includes everything

        time.sleep(0.25)

    return total_fetched, total_new


def ensure_schema(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            geometry JSON,
            properties JSON,
            bbox JSON,
            host TEXT,
            fetched_at TIMESTAMP DEFAULT current_timestamp
        )
    """)


def main():
    parser = argparse.ArgumentParser(description="Sync SkySat data from Planet API")
    parser.add_argument("--days", type=int, default=30, help="Days to sync (default: 30)")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    args = parser.parse_args()

    load_dotenv()
    api_key = os.environ.get("PLANET_API_KEY", "")
    if not api_key:
        raise SystemExit("Set PLANET_API_KEY in .env")

    end_date = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")
    start_date = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime("%Y-%m-%dT00:00:00Z")

    db = duckdb.connect(args.db)
    ensure_schema(db)
    total_before = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]

    with httpx.Client(timeout=60, auth=(api_key, "")) as client:
        # Verify auth
        resp = client.get("https://api.planet.com/data/v1/item-types")
        resp.raise_for_status()

        log.info(f"Syncing SkySat for {args.days} days ({start_date[:10]} to {end_date[:10]})")

        grand_fetched = 0
        grand_new = 0

        for region_name, geometry in REGIONS:
            log.info(f"\n  {region_name}:")
            fetched, new = sync_region(client, db, region_name, geometry, start_date, end_date)
            log.info(f"  {region_name}: {fetched} fetched, {new} new")
            grand_fetched += fetched
            grand_new += new

    total_after = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    log.info(f"\n{'='*50}")
    log.info(f"Done. {grand_fetched} fetched, {grand_new} new items inserted.")
    log.info(f"Database: {total_before:,} → {total_after:,} items")

    db.close()


if __name__ == "__main__":
    main()
