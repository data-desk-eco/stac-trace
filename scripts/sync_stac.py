# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "duckdb", "python-dotenv"]
# ///
"""Sync STAC data from UP42 into DuckDB with incremental fetching."""

import argparse
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import duckdb
import httpx
from dotenv import load_dotenv
import os

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

AUTH_URL = "https://auth.up42.com/realms/public/protocol/openid-connect/token"
SEARCH_URL = "https://api.up42.com/catalog/hosts/{host}/stac/search"

REGIONS = [
    ("Americas", [-180, -60, -60, 75]),
    ("Europe_Africa", [-30, -60, 60, 75]),
    ("Middle_East_Asia", [30, -60, 90, 75]),
    ("East_Asia_Pacific", [60, -60, 180, 75]),
    ("Antarctica", [-180, -90, 180, -60]),
]


def authenticate(client: httpx.Client) -> str:
    """Get OAuth token from UP42."""
    username = os.environ.get("UP42_USERNAME", "")
    password = os.environ.get("UP42_PASSWORD", "")
    if not username or not password:
        raise SystemExit("Error: UP42_USERNAME and UP42_PASSWORD must be set in .env")

    resp = client.post(AUTH_URL, data={
        "username": username,
        "password": password,
        "grant_type": "password",
        "client_id": "up42-api",
    })
    resp.raise_for_status()
    token = resp.json().get("access_token")
    if not token:
        raise SystemExit("Error: Authentication failed — no access_token in response")
    return token


def fetch_region(
    client: httpx.Client,
    token: str,
    host: str,
    region_name: str,
    bbox: list,
    start_date: str,
    end_date: str,
) -> list[dict]:
    """Fetch all items for a region with pagination."""
    url = SEARCH_URL.format(host=host)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {"datetime": f"{start_date}/{end_date}", "limit": 500, "bbox": bbox}

    items = []
    page = 0

    while True:
        page += 1
        resp = client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

        for feat in data.get("features", []):
            props = feat.get("properties", {})
            constellation = (props.get("constellation") or "").lower()
            resolution = props.get("resolution")

            # Filter: no SPOT, resolution <= 0.75m
            if constellation == "spot":
                continue
            try:
                if resolution is not None and float(resolution) > 0.75:
                    continue
            except (ValueError, TypeError):
                continue

            items.append({
                "id": props.get("id", feat.get("id")),
                "geometry": json.dumps(feat.get("geometry")),
                "properties": json.dumps(props),
                "bbox": json.dumps(feat.get("bbox")),
                "host": host,
            })

        # Check for next page
        next_token = None
        for link in data.get("links", []):
            if link.get("rel") == "next":
                href = link.get("href", "")
                import re
                m = re.search(r"next=([^&]+)", href)
                if m:
                    next_token = m.group(1)
                break

        if not next_token:
            break

        payload["next"] = next_token
        time.sleep(0.3)

    log.info(f"  {region_name}: {len(items)} items ({page} pages)")
    return items


def ensure_schema(db: duckdb.DuckDBPyConnection):
    """Create tables if they don't exist."""
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
    db.execute("""
        CREATE SEQUENCE IF NOT EXISTS sync_log_seq START 1
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER DEFAULT nextval('sync_log_seq'),
            host TEXT,
            region TEXT,
            start_date TIMESTAMP,
            end_date TIMESTAMP,
            items_added INTEGER,
            synced_at TIMESTAMP DEFAULT current_timestamp
        )
    """)


def main():
    parser = argparse.ArgumentParser(description="Sync STAC data from UP42")
    parser.add_argument("--days", type=int, default=7, help="Number of days to sync (default: 7)")
    parser.add_argument("--host", default="oneatlas", help="STAC host (default: oneatlas)")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    args = parser.parse_args()

    load_dotenv()

    end_date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    start_date = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    log.info(f"Syncing {args.host} for last {args.days} days...")

    db = duckdb.connect(args.db)
    ensure_schema(db)

    before_count = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]

    with httpx.Client(timeout=30, follow_redirects=True) as client:
        token = authenticate(client)
        log.info("Authenticated. Querying regions...")

        all_items = []
        for region_name, bbox in REGIONS:
            try:
                items = fetch_region(client, token, args.host, region_name, bbox, start_date, end_date)
                all_items.extend(items)

                # Log sync
                db.execute(
                    "INSERT INTO sync_log (host, region, start_date, end_date, items_added) VALUES (?, ?, ?, ?, ?)",
                    [args.host, region_name, start_date, end_date, len(items)],
                )
            except httpx.HTTPStatusError as e:
                log.warning(f"  {region_name}: HTTP {e.response.status_code} — skipping")
                continue

    # Bulk insert (ignore duplicates)
    if all_items:
        log.info(f"\nInserting {len(all_items)} items...")
        for item in all_items:
            db.execute(
                "INSERT OR IGNORE INTO items (id, geometry, properties, bbox, host) VALUES (?, ?::JSON, ?::JSON, ?::JSON, ?)",
                [item["id"], item["geometry"], item["properties"], item["bbox"], item["host"]],
            )

    after_count = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    new_inserted = after_count - before_count

    log.info(f"Inserted {new_inserted} new items (skipped {len(all_items) - new_inserted} duplicates)")
    log.info(f"Total items in database: {after_count}")

    db.close()


if __name__ == "__main__":
    main()
