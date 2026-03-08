# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb"]
# ///
"""Encode DuckDB STAC items into compact STAC1 binary format for frontend heatmap."""

import argparse
import json
import struct
import sys
from collections import defaultdict
from datetime import date, datetime

import duckdb

EPOCH = date(2020, 1, 1)
GRID_RES = 10  # stored as int, means 0.1 degrees
BUCKET_DAYS = 7


def encode_uvarint(n: int) -> bytes:
    out = bytearray()
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


def encode_svarint(n: int) -> bytes:
    return encode_uvarint((n << 1) ^ (n >> 63))


def decode_uvarint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = data[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def decode_svarint(data: bytes, pos: int) -> tuple[int, int]:
    u, pos = decode_uvarint(data, pos)
    return (u >> 1) ^ -(u & 1), pos


def main():
    parser = argparse.ArgumentParser(description="Encode STAC items to STAC1 binary")
    parser.add_argument("--db", default="data/stac.duckdb", help="Database path")
    parser.add_argument("--output", default="data/collection.stac1", help="Output file")
    parser.add_argument("--verify", action="store_true", help="Decode and print summary")
    args = parser.parse_args()

    if args.verify:
        verify(args.output)
        return

    db = duckdb.connect(args.db, read_only=True)

    # Extract centroid, datetime, constellation from all items
    rows = db.execute("""
        SELECT
            properties->>'datetime' as dt,
            COALESCE(properties->>'constellation', 'unknown') as constellation,
            CASE
                WHEN geometry->>'type' = 'Point'
                    THEN CAST(geometry->'coordinates'->>0 AS DOUBLE)
                WHEN bbox IS NOT NULL
                    THEN (CAST(bbox->>0 AS DOUBLE) + CAST(bbox->>2 AS DOUBLE)) / 2
                ELSE NULL
            END as lon,
            CASE
                WHEN geometry->>'type' = 'Point'
                    THEN CAST(geometry->'coordinates'->>1 AS DOUBLE)
                WHEN bbox IS NOT NULL
                    THEN (CAST(bbox->>1 AS DOUBLE) + CAST(bbox->>3 AS DOUBLE)) / 2
                ELSE NULL
            END as lat
        FROM items
        WHERE lon IS NOT NULL AND lat IS NOT NULL
    """).fetchall()
    db.close()

    if not rows:
        print("No items found in database")
        sys.exit(1)

    print(f"Processing {len(rows)} items...")

    # Build constellation table
    constellation_set = sorted(set(r[1].lower() for r in rows))
    const_to_idx = {c: i for i, c in enumerate(constellation_set)}

    # Grid and bucket items
    # Key: (grid_x, grid_y) -> list of (time_bucket, constellation_idx)
    grid_res = GRID_RES / 100  # 0.1 degrees
    cells = defaultdict(list)

    for dt_str, constellation, lon, lat in rows:
        # Parse datetime
        try:
            dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00")).date()
        except (ValueError, AttributeError):
            continue

        days_since_epoch = (dt - EPOCH).days
        if days_since_epoch < 0:
            continue
        time_bucket = days_since_epoch // BUCKET_DAYS

        gx = int(lon / grid_res)
        gy = int(lat / grid_res)
        cidx = const_to_idx[constellation.lower()]

        cells[(gx, gy)].append((time_bucket, cidx))

    # Aggregate: (gx, gy) -> [(time_bucket, constellation_idx, count)]
    aggregated = {}
    for (gx, gy), entries in cells.items():
        bucket_counts = defaultdict(int)
        for tb, cidx in entries:
            bucket_counts[(tb, cidx)] += 1
        aggregated[(gx, gy)] = sorted(bucket_counts.items())

    # Sort cells by (gy, gx) for delta encoding
    sorted_cells = sorted(aggregated.items(), key=lambda x: (x[0][1], x[0][0]))

    # Calculate epoch offset (min time bucket * BUCKET_DAYS)
    all_buckets = [tb for cell_buckets in aggregated.values() for (tb, _), _ in cell_buckets]
    epoch_offset = min(all_buckets) * BUCKET_DAYS if all_buckets else 0

    print(f"  {len(sorted_cells)} grid cells, {len(constellation_set)} constellations")

    # ── Encode STAC1 ─────────────────────────────────────────────────
    buf = bytearray()

    # Header
    buf.extend(b"STAC1")
    buf.append(GRID_RES)  # 10 = 0.1 degrees
    buf.append(BUCKET_DAYS)
    buf.extend(struct.pack("<H", epoch_offset))
    buf.append(len(constellation_set))

    # Num cells (uvarint)
    buf.extend(encode_uvarint(len(sorted_cells)))

    # Constellation table (null-terminated strings)
    for name in constellation_set:
        buf.extend(name.encode("utf-8"))
        buf.append(0)

    # Cell records
    prev_gx, prev_gy = 0, 0
    for (gx, gy), bucket_list in sorted_cells:
        dx = gx - prev_gx
        dy = gy - prev_gy
        prev_gx, prev_gy = gx, gy

        buf.extend(encode_svarint(dx))
        buf.extend(encode_svarint(dy))
        buf.extend(encode_uvarint(len(bucket_list)))

        for (time_offset, const_idx), count in bucket_list:
            buf.extend(encode_uvarint(time_offset))
            if count >= 15:
                packed = (const_idx << 4) | 0x0F
                buf.append(packed)
                buf.extend(encode_uvarint(count))
            else:
                packed = (const_idx << 4) | (count & 0x0F)
                buf.append(packed)

    with open(args.output, "wb") as f:
        f.write(buf)

    print(f"  Written {len(buf)} bytes to {args.output}")


def verify(path: str):
    """Decode a STAC1 file and print summary."""
    with open(path, "rb") as f:
        data = f.read()

    magic = data[:5]
    assert magic == b"STAC1", f"Bad magic: {magic}"

    grid_res = data[5] / 100
    bucket_days = data[6]
    epoch_offset = struct.unpack("<H", data[7:9])[0]
    num_constellations = data[9]

    pos = 10
    num_cells, pos = decode_uvarint(data, pos)

    constellations = []
    for _ in range(num_constellations):
        name = bytearray()
        while data[pos] != 0:
            name.append(data[pos])
            pos += 1
        pos += 1
        constellations.append(name.decode("utf-8"))

    # Read cells
    gx, gy = 0, 0
    total_images = 0
    top_cells = []
    min_bucket = float("inf")
    max_bucket = 0

    for _ in range(num_cells):
        dx, pos = decode_svarint(data, pos)
        dy, pos = decode_svarint(data, pos)
        gx += dx
        gy += dy

        n_buckets, pos = decode_uvarint(data, pos)
        cell_total = 0

        for _ in range(n_buckets):
            time_offset, pos = decode_uvarint(data, pos)
            packed = data[pos]
            pos += 1
            count = packed & 0x0F
            if count == 15:
                count, pos = decode_uvarint(data, pos)

            cell_total += count
            min_bucket = min(min_bucket, time_offset)
            max_bucket = max(max_bucket, time_offset)

        total_images += cell_total
        top_cells.append((gx * grid_res, gy * grid_res, cell_total))

    top_cells.sort(key=lambda x: -x[2])

    start_date = date(2020, 1, 1).toordinal() + min_bucket * bucket_days
    end_date = date(2020, 1, 1).toordinal() + max_bucket * bucket_days

    print(f"STAC1: {num_cells} cells, {len(constellations)} constellations, {total_images} images")
    print(f"  Constellations: {', '.join(constellations)}")
    print(f"  Date range: {date.fromordinal(start_date)} to {date.fromordinal(end_date)}")
    print(f"  Top cells:")
    for lon, lat, count in top_cells[:5]:
        print(f"    ({lat:.1f}, {lon:.1f}) = {count} images")


if __name__ == "__main__":
    main()
