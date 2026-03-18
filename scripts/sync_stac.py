# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "duckdb", "python-dotenv"]
# ///
"""Sync STAC data from UP42 into DuckDB.

Fetches high-resolution (<= 0.75m GSD) satellite imagery metadata across
all available hosts, using CQL2 server-side filtering, adaptive rate
limiting, and time-windowed pagination to handle large result sets.
"""

import argparse
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

import duckdb
import httpx
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

AUTH_URL = "https://auth.up42.com/realms/public/protocol/openid-connect/token"
SEARCH_URL = "https://api.up42.com/catalog/hosts/{host}/stac/search"
HOSTS_URL = "https://api.up42.com/hosts"

# Regions — used as fallback if global bbox doesn't work for a host.
# Overlapping edges ensure no gaps at boundaries.
REGIONS = [
    ("Americas",        [-180, -90, -30, 90]),
    ("Europe_Africa",   [-35, -90,  65, 90]),
    ("Asia_Pacific",    [ 60, -90, 180, 90]),
]

# CQL2 filter: exclude SPOT, keep high-res only
CQL2_FILTER = {
    "op": "and",
    "args": [
        {"op": "!=", "args": [{"property": "constellation"}, "spot"]},
        {"op": "<=", "args": [{"property": "resolution"}, 0.75]},
    ],
}

# How many 500-item pages we allow before assuming the result set is
# truncated and we need to split the query into smaller time windows.
MAX_PAGES_BEFORE_SPLIT = 20  # 10,000 items


def authenticate(client: httpx.Client) -> str:
    """Get OAuth token from UP42."""
    username = os.environ.get("UP42_USERNAME", "")
    password = os.environ.get("UP42_PASSWORD", "")
    if not username or not password:
        log.warning("UP42_USERNAME and UP42_PASSWORD not set — skipping STAC sync")
        raise SystemExit(0)

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


def discover_hosts(client: httpx.Client, token: str) -> list[str]:
    """Discover available catalog hosts from UP42 API."""
    try:
        resp = client.get(HOSTS_URL, headers={"Authorization": f"Bearer {token}"})
        resp.raise_for_status()
        data = resp.json()
        # API may return list of dicts with 'name' or 'id' keys
        hosts = []
        for h in data if isinstance(data, list) else data.get("data", data.get("hosts", [])):
            name = h.get("name", h.get("id", h)) if isinstance(h, dict) else str(h)
            if name:
                hosts.append(name)
        if hosts:
            return hosts
    except Exception as e:
        log.warning(f"  Host discovery failed ({e}), using defaults")
    return ["oneatlas"]


def adaptive_delay(resp: httpx.Response, default: float = 0.3) -> float:
    """Read rate-limit headers and sleep accordingly."""
    remaining = resp.headers.get("x-ratelimit-remaining")
    if remaining is not None:
        remaining = int(remaining)
        if remaining < 5:
            time.sleep(5.0)
            return 5.0
        elif remaining < 20:
            time.sleep(1.0)
            return 1.0
    time.sleep(default)
    return default


def extract_next_token(data: dict) -> str | None:
    """Extract pagination token from STAC response links."""
    for link in data.get("links", []):
        if link.get("rel") == "next":
            # Some responses have the token in body, others in href
            if "body" in link and "next" in link["body"]:
                return link["body"]["next"]
            href = link.get("href", "")
            m = re.search(r"next=([^&]+)", href)
            if m:
                return m.group(1)
    return None


def fetch_window(
    client: httpx.Client,
    token: str,
    host: str,
    bbox: list,
    start_date: str,
    end_date: str,
    use_cql2: bool = True,
) -> tuple[list[dict], int]:
    """Fetch all items for a bbox + time window with pagination.

    Returns (items, page_count). If page_count hits MAX_PAGES_BEFORE_SPLIT,
    the caller should split into smaller time windows.
    """
    url = SEARCH_URL.format(host=host)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    payload = {
        "datetime": f"{start_date}/{end_date}",
        "limit": 500,
        "bbox": bbox,
    }
    if use_cql2:
        payload["filter"] = CQL2_FILTER

    items = []
    page = 0

    while True:
        page += 1
        try:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 422 and use_cql2:
                # CQL2 not supported by this host — retry without it
                log.info(f"    CQL2 not supported by {host}, falling back to client-side filtering")
                return fetch_window(client, token, host, bbox, start_date, end_date, use_cql2=False)
            raise

        data = resp.json()

        for feat in data.get("features", []):
            props = feat.get("properties", {})

            # Client-side filtering only needed if CQL2 is off
            if not use_cql2:
                constellation = (props.get("constellation") or "").lower()
                resolution = props.get("resolution")
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

        next_token = extract_next_token(data)
        if not next_token:
            break

        # If we've paginated too much, signal the caller to split
        if page >= MAX_PAGES_BEFORE_SPLIT:
            log.info(f"    Hit {page} pages, will split time window")
            break

        payload["next"] = next_token
        adaptive_delay(resp)

    return items, page


def fetch_region_adaptive(
    client: httpx.Client,
    token: str,
    host: str,
    region_name: str,
    bbox: list,
    start_date: str,
    end_date: str,
) -> list[dict]:
    """Fetch a region, splitting time windows if result sets are too large."""
    items, pages = fetch_window(client, token, host, bbox, start_date, end_date)

    if pages >= MAX_PAGES_BEFORE_SPLIT:
        # Result set was truncated — split the time range in half and recurse
        start_dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        mid_dt = start_dt + (end_dt - start_dt) / 2
        mid_str = mid_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

        log.info(f"    Splitting {region_name}: {start_date[:10]}..{mid_str[:10]} + {mid_str[:10]}..{end_date[:10]}")

        items_a = fetch_region_adaptive(client, token, host, region_name, bbox, start_date, mid_str)
        items_b = fetch_region_adaptive(client, token, host, region_name, bbox, mid_str, end_date)

        # Deduplicate by id (items at the boundary)
        seen = {it["id"] for it in items_a}
        combined = items_a[:]
        for it in items_b:
            if it["id"] not in seen:
                combined.append(it)
                seen.add(it["id"])
        return combined

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
    parser.add_argument("--days", type=int, default=7, help="Days to sync (default: 7)")
    parser.add_argument("--host", default=None, help="Specific host (default: auto-discover all)")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    parser.add_argument("--global-bbox", action="store_true", help="Try global bbox before regional split")
    args = parser.parse_args()

    load_dotenv()

    end_date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    start_date = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    db = duckdb.connect(args.db)
    ensure_schema(db)
    before_count = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]

    with httpx.Client(timeout=60, follow_redirects=True) as client:
        token = authenticate(client)

        # Determine hosts to query
        if args.host:
            hosts = [args.host]
        else:
            hosts = discover_hosts(client, token)

        log.info(f"Syncing {len(hosts)} host(s) for last {args.days} days: {', '.join(hosts)}")

        all_items = []

        for host in hosts:
            log.info(f"\n── {host} ──")
            host_items = []

            if args.global_bbox:
                # Try global bbox first
                log.info("  Trying global bbox...")
                try:
                    items = fetch_region_adaptive(
                        client, token, host, "global",
                        [-180, -90, 180, 90], start_date, end_date,
                    )
                    host_items.extend(items)
                    log.info(f"  Global: {len(items)} items")
                except httpx.HTTPStatusError as e:
                    log.warning(f"  Global bbox failed (HTTP {e.response.status_code}), falling back to regions")
                    args.global_bbox = False  # Don't try global again

            if not args.global_bbox:
                # Regional queries
                for region_name, bbox in REGIONS:
                    try:
                        items = fetch_region_adaptive(
                            client, token, host, region_name,
                            bbox, start_date, end_date,
                        )
                        host_items.extend(items)
                        log.info(f"  {region_name}: {len(items)} items")
                    except httpx.HTTPStatusError as e:
                        log.warning(f"  {region_name}: HTTP {e.response.status_code} — skipping")
                        continue

            # Deduplicate within host (overlapping regions)
            seen = set()
            deduped = []
            for item in host_items:
                if item["id"] not in seen:
                    deduped.append(item)
                    seen.add(item["id"])
            host_items = deduped

            log.info(f"  Total for {host}: {len(host_items)} unique items")
            all_items.extend(host_items)

            # Log sync
            db.execute(
                "INSERT INTO sync_log (host, region, start_date, end_date, items_added) VALUES (?, ?, ?, ?, ?)",
                [host, "all", start_date, end_date, len(host_items)],
            )

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

    log.info(f"\nInserted {new_inserted} new items (skipped {len(all_items) - new_inserted} duplicates)")
    log.info(f"Total items in database: {after_count}")

    db.close()


if __name__ == "__main__":
    main()
