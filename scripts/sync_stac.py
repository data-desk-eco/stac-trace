# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "duckdb", "python-dotenv"]
# ///
"""Sync STAC data from UP42 into DuckDB.

Streams high-resolution (<= 1.5m GSD) satellite imagery metadata into
DuckDB with automatic token refresh, resumable pagination, and
crash-safe incremental commits.
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

GLOBAL_BBOX = [-180, -90, 180, 90]

# Fallback regions if global bbox fails for a host.
REGIONS = [
    ("Americas",      [-180, -90, -30, 90]),
    ("Europe_Africa", [-35, -90,  65, 90]),
    ("Asia_Pacific",  [ 60, -90, 180, 90]),
]

# CQL2 filter: high-res only (server-side hint; client-side always re-checks)
CQL2_FILTER = {
    "op": "<=",
    "args": [{"property": "resolution"}, 1.5],
}

# Hosts where CQL2 returns incomplete results — use client-side filtering only
NO_CQL2_HOSTS = {"planet"}
# Hosts where global bbox returns truncated results — always use regions
NO_GLOBAL_BBOX_HOSTS = {"planet"}

TOKEN_REFRESH_SECS = 15 * 60  # refresh before 30min expiry


class TokenManager:
    """Manages OAuth token with automatic refresh."""

    def __init__(self, client: httpx.Client):
        self.client = client
        self.username = os.environ.get("UP42_USERNAME", "")
        self.password = os.environ.get("UP42_PASSWORD", "")
        if not self.username or not self.password:
            raise SystemExit("Set UP42_USERNAME and UP42_PASSWORD in .env")
        self._token = None
        self._obtained_at = 0.0

    def get(self) -> str:
        if self._token is None or (time.monotonic() - self._obtained_at) > TOKEN_REFRESH_SECS:
            self._refresh()
        return self._token

    def force_refresh(self):
        self._refresh()

    def _refresh(self):
        resp = self.client.post(AUTH_URL, data={
            "username": self.username,
            "password": self.password,
            "grant_type": "password",
            "client_id": "up42-api",
        })
        resp.raise_for_status()
        self._token = resp.json().get("access_token")
        if not self._token:
            raise SystemExit("Auth failed — no access_token")
        self._obtained_at = time.monotonic()
        log.info("  [token refreshed]")


def discover_hosts(client: httpx.Client, token_mgr: TokenManager) -> list[str]:
    """Discover available catalog hosts."""
    try:
        resp = client.get(HOSTS_URL, headers={"Authorization": f"Bearer {token_mgr.get()}"})
        resp.raise_for_status()
        data = resp.json()
        hosts = []
        for h in data if isinstance(data, list) else data.get("data", data.get("hosts", [])):
            name = h.get("name", h.get("id", h)) if isinstance(h, dict) else str(h)
            if name:
                hosts.append(name)
        if hosts:
            return hosts
    except Exception as e:
        log.warning(f"Host discovery failed ({e}), using defaults")
    return ["oneatlas"]


def adaptive_delay(resp: httpx.Response, default: float = 0.25):
    """Sleep based on rate-limit headers."""
    remaining = resp.headers.get("x-ratelimit-remaining")
    if remaining is not None:
        remaining = int(remaining)
        if remaining < 5:
            time.sleep(5.0)
            return
        elif remaining < 20:
            time.sleep(1.0)
            return
    time.sleep(default)


def extract_next_url(data: dict) -> str | None:
    """Extract the full next page URL from STAC response links.

    The UP42 API requires the next token as a query parameter on the URL,
    NOT in the POST body. We return the full href to POST to directly.
    """
    for link in data.get("links", []):
        if link.get("rel") == "next":
            href = link.get("href", "")
            if href and "next=" in href:
                return href
    return None


MAX_RETRIES = 5


def post_with_retry(client, url, headers, json_payload, token_mgr):
    """POST with retry on timeout/network errors and 401 token refresh."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = client.post(url, headers=headers, json=json_payload)
            if resp.status_code == 401:
                token_mgr.force_refresh()
                headers["Authorization"] = f"Bearer {token_mgr.get()}"
                resp = client.post(url, headers=headers, json=json_payload)
            resp.raise_for_status()
            return resp
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.RemoteProtocolError) as e:
            if attempt < MAX_RETRIES - 1:
                wait = 3 * (attempt + 1)
                log.info(f"    Retry {attempt+1}/{MAX_RETRIES} after {type(e).__name__}, waiting {wait}s...")
                time.sleep(wait)
            else:
                raise
    return None  # unreachable


def parse_feature(feat: dict, host: str) -> dict | None:
    """Parse a single STAC feature. Returns None if filtered out.

    Always applies client-side filtering as a safety net — CQL2 server-side
    filtering is unreliable on some hosts (e.g. oneatlas passes SPOT through).
    """
    props = feat.get("properties", {})

    resolution = props.get("resolution")
    try:
        if resolution is not None and float(resolution) > 1.5:
            return None
    except (ValueError, TypeError):
        return None

    return {
        "id": props.get("id", feat.get("id")),
        "geometry": json.dumps(feat.get("geometry")),
        "properties": json.dumps(props),
        "bbox": json.dumps(feat.get("bbox")),
        "host": host,
    }


def stream_fetch(
    client: httpx.Client,
    token_mgr: TokenManager,
    db: duckdb.DuckDBPyConnection,
    host: str,
    bbox: list,
    start_date: str,
    end_date: str,
    use_cql2: bool = True,
) -> tuple[int, int, bool]:
    """Stream-fetch items and insert directly to DB. Returns (total_fetched, new_inserted, hit_limit)."""
    url = SEARCH_URL.format(host=host)

    payload = {
        "datetime": f"{start_date}/{end_date}",
        "limit": 250,
        "bbox": bbox,
    }
    if use_cql2:
        payload["filter"] = CQL2_FILTER

    total_fetched = 0
    total_new = 0
    page = 0
    t0 = time.monotonic()
    batch = []
    BATCH_SIZE = 250

    def flush_batch():
        nonlocal total_new
        if not batch:
            return
        before = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        db.executemany(
            "INSERT OR IGNORE INTO items (id, geometry, properties, bbox, host) "
            "VALUES (?, ?::JSON, ?::JSON, ?::JSON, ?)",
            [[item["id"], item["geometry"], item["properties"], item["bbox"], item["host"]] for item in batch],
        )
        after = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        total_new += after - before
        batch.clear()

    request_url = url
    next_url = None

    while True:
        page += 1
        headers = {
            "Authorization": f"Bearer {token_mgr.get()}",
            "Content-Type": "application/json",
        }

        # Use next URL if available, otherwise use base URL with payload
        post_url = next_url if next_url else request_url

        try:
            resp = post_with_retry(client, post_url, headers, payload, token_mgr)
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status == 422 and use_cql2:
                log.info(f"    CQL2 not supported, falling back to client-side filter")
                flush_batch()
                return stream_fetch(client, token_mgr, db, host, bbox, start_date, end_date, use_cql2=False)
            elif status in (542, 502, 503):
                # Server-side pagination limit (542) or server overload
                # Save what we have and signal caller to split time window
                log.info(f"    HTTP {status} at page {page} ({total_fetched} items) — pagination limit hit")
                flush_batch()
                return total_fetched, total_new, True  # hit_limit=True
            elif status == 422:
                # 422 without CQL2 — likely bbox issue, re-raise so caller can try regions
                flush_batch()
                raise
            else:
                raise
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.RemoteProtocolError) as e:
            log.warning(f"    Network error after {MAX_RETRIES} retries ({type(e).__name__}), saving progress")
            flush_batch()
            return total_fetched, total_new, False

        data = resp.json()
        features = data.get("features", [])

        for feat in features:
            item = parse_feature(feat, host)
            if item:
                batch.append(item)
                total_fetched += 1

        if len(batch) >= BATCH_SIZE:
            flush_batch()

        next_url = extract_next_url(data)

        # Progress logging
        elapsed = time.monotonic() - t0
        rate = total_fetched / elapsed if elapsed > 0 else 0
        if page <= 3 or page % 25 == 0:
            log.info(f"    p{page}: {total_fetched} items, {total_new} new, {rate:.0f}/s")

        if not next_url or not features:
            break

        adaptive_delay(resp)

    flush_batch()
    return total_fetched, total_new, False


def stream_fetch_adaptive(
    client: httpx.Client,
    token_mgr: TokenManager,
    db: duckdb.DuckDBPyConnection,
    host: str,
    bbox: list,
    start_date: str,
    end_date: str,
    use_cql2: bool = True,
    depth: int = 0,
) -> tuple[int, int]:
    """Fetch with automatic time-window splitting when pagination limits are hit."""
    fetched, new, hit_limit = stream_fetch(
        client, token_mgr, db, host, bbox, start_date, end_date, use_cql2,
    )

    if hit_limit and depth < 8:
        # Split time range in half and recurse
        start_dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        if (end_dt - start_dt).total_seconds() < 3600:
            # Don't split below 1 hour
            log.info(f"    Window too small to split further")
            return fetched, new
        mid_dt = start_dt + (end_dt - start_dt) / 2
        mid_str = mid_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        log.info(f"    Splitting: {start_date[:10]}..{mid_str[:10]} + {mid_str[:10]}..{end_date[:10]}")

        f1, n1 = stream_fetch_adaptive(client, token_mgr, db, host, bbox, start_date, mid_str, use_cql2, depth + 1)
        f2, n2 = stream_fetch_adaptive(client, token_mgr, db, host, bbox, mid_str, end_date, use_cql2, depth + 1)
        return fetched + f1 + f2, new + n1 + n2

    return fetched, new


def ensure_schema(db: duckdb.DuckDBPyConnection):
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
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY,
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
    parser.add_argument("--host", default=None, help="Specific host (default: auto-discover)")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    args = parser.parse_args()

    load_dotenv()

    # Use midnight timestamps — some hosts (e.g. Planet) return fewer results with mid-day times
    end_date = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")
    start_date = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime("%Y-%m-%dT00:00:00Z")

    db = duckdb.connect(args.db)
    ensure_schema(db)
    total_before = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]

    with httpx.Client(timeout=120, follow_redirects=True) as client:
        token_mgr = TokenManager(client)

        if args.host:
            hosts = [args.host]
        else:
            hosts = discover_hosts(client, token_mgr)

        log.info(f"Syncing {len(hosts)} host(s) for {args.days} days ({start_date[:10]} to {end_date[:10]})")
        log.info(f"Hosts: {', '.join(hosts)}")

        grand_fetched = 0
        grand_new = 0

        for host_idx, host in enumerate(hosts, 1):
            log.info(f"\n── [{host_idx}/{len(hosts)}] {host} ──")

            use_cql2 = host not in NO_CQL2_HOSTS

            # Some hosts truncate global bbox results — go straight to regions
            if host in NO_GLOBAL_BBOX_HOSTS:
                for region_name, bbox in REGIONS:
                    try:
                        fetched, new = stream_fetch_adaptive(
                            client, token_mgr, db, host, bbox, start_date, end_date,
                            use_cql2=use_cql2,
                        )
                        log.info(f"  {region_name}: {fetched} fetched, {new} new")
                        grand_fetched += fetched
                        grand_new += new
                    except httpx.HTTPStatusError as e2:
                        log.warning(f"  {region_name}: HTTP {e2.response.status_code}, skipping")
                        continue
                # Log and continue to next host
                next_id = db.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM sync_log").fetchone()[0]
                db.execute(
                    "INSERT INTO sync_log (id, host, region, start_date, end_date, items_added) VALUES (?, ?, ?, ?, ?, ?)",
                    [next_id, host, "regions", start_date, end_date, grand_new],
                )
                continue

            # Try global bbox first
            try:
                fetched, new = stream_fetch_adaptive(
                    client, token_mgr, db, host, GLOBAL_BBOX, start_date, end_date,
                    use_cql2=use_cql2,
                )
                log.info(f"  Global: {fetched} fetched, {new} new")
                grand_fetched += fetched
                grand_new += new
            except httpx.HTTPStatusError as e:
                status = e.response.status_code
                if status == 404:
                    log.info(f"  Not available (404), skipping")
                    continue
                elif status in (400, 422):
                    # Global bbox not supported, try regional
                    log.info(f"  Global bbox failed (HTTP {status}), trying regions...")
                    for region_name, bbox in REGIONS:
                        try:
                            fetched, new = stream_fetch_adaptive(
                                client, token_mgr, db, host, bbox, start_date, end_date,
                                use_cql2=use_cql2,
                            )
                            log.info(f"  {region_name}: {fetched} fetched, {new} new")
                            grand_fetched += fetched
                            grand_new += new
                        except httpx.HTTPStatusError as e2:
                            log.warning(f"  {region_name}: HTTP {e2.response.status_code}, skipping")
                            continue
                else:
                    log.warning(f"  HTTP {status}, skipping")
                    continue

            # Log sync
            next_id = db.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM sync_log").fetchone()[0]
            db.execute(
                "INSERT INTO sync_log (id, host, region, start_date, end_date, items_added) VALUES (?, ?, ?, ?, ?, ?)",
                [next_id, host, "global", start_date, end_date, grand_new],
            )

    total_after = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    log.info(f"\n{'='*50}")
    log.info(f"Done. {grand_fetched} fetched, {grand_new} new items inserted.")
    log.info(f"Database: {total_before} → {total_after} items")

    db.close()


if __name__ == "__main__":
    main()
