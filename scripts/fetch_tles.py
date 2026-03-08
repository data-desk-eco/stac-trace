# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""Fetch TLE data for Earth observation satellite constellations from CelesTrak."""

import json
import re
import httpx

# ── Satellite catalog ────────────────────────────────────────────────
# Maps name prefixes to operator metadata. CelesTrak names are like
# "WORLDVIEW-3", "PLEIADES-NEO 4", "ICEYE-X1", etc.

CATALOG = {
    # Maxar
    "WORLDVIEW": {"operator": "maxar", "constellation": "worldview", "resolution_m": 0.3},
    "LEGION": {"operator": "maxar", "constellation": "legion", "resolution_m": 0.3},
    # Airbus
    "PLEIADES-NEO": {"operator": "airbus", "constellation": "pleiades-neo", "resolution_m": 0.3},
    "PLEIADES": {"operator": "airbus", "constellation": "pleiades", "resolution_m": 0.5},
    "SPOT": {"operator": "airbus", "constellation": "spot", "resolution_m": 1.5},
    # Planet
    "SKYSAT": {"operator": "planet", "constellation": "skysat", "resolution_m": 0.5},
    # ICEYE
    "ICEYE": {"operator": "iceye", "constellation": "iceye", "resolution_m": 0.25},
    # Capella
    "CAPELLA": {"operator": "capella", "constellation": "capella", "resolution_m": 0.3},
    # Satellogic
    "NEWSAT": {"operator": "satellogic", "constellation": "newsat", "resolution_m": 0.7},
    "NUSAT": {"operator": "satellogic", "constellation": "newsat", "resolution_m": 0.7},
    # Government reference
    "LANDSAT": {"operator": "government", "constellation": "landsat", "resolution_m": 15.0},
    "SENTINEL-2": {"operator": "government", "constellation": "sentinel-2", "resolution_m": 10.0},
}

OPERATOR_COLORS = {
    "maxar": "#e05555",
    "airbus": "#5588cc",
    "planet": "#44aa77",
    "iceye": "#cc9944",
    "capella": "#cc9944",
    "satellogic": "#9977bb",
    "government": "#cccc44",
    "other": "#778899",
}

CELESTRAK_GROUPS = [
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=tle",
]


def parse_tles(text: str) -> list[dict]:
    """Parse TLE text into list of {name, line1, line2} dicts."""
    lines = [l.rstrip() for l in text.strip().splitlines() if l.strip()]
    tles = []
    i = 0
    while i + 2 < len(lines):
        # TLE format: name line, then two element lines starting with 1/2
        if lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
            tles.append({
                "name": lines[i].strip(),
                "line1": lines[i + 1],
                "line2": lines[i + 2],
            })
            i += 3
        else:
            i += 1
    return tles


def match_satellite(name: str) -> dict | None:
    """Match a satellite name to our catalog. Returns metadata or None."""
    upper = name.upper()
    # Try longest prefixes first (PLEIADES-NEO before PLEIADES)
    for prefix in sorted(CATALOG.keys(), key=len, reverse=True):
        if upper.startswith(prefix):
            return CATALOG[prefix]
    return None


def extract_norad_id(line1: str) -> int:
    """Extract NORAD catalog number from TLE line 1."""
    return int(line1[2:7].strip())


def main():
    all_tles: list[dict] = []
    seen_ids: set[int] = set()

    with httpx.Client(timeout=30, follow_redirects=True) as client:
        for url in CELESTRAK_GROUPS:
            print(f"Fetching {url.split('GROUP=')[1].split('&')[0]}...")
            resp = client.get(url)
            resp.raise_for_status()
            tles = parse_tles(resp.text)
            print(f"  Got {len(tles)} TLEs")
            all_tles.extend(tles)

    # Filter to known EO constellations and build metadata
    satellites = {}
    tle_lines = []

    for tle in all_tles:
        norad_id = extract_norad_id(tle["line1"])
        if norad_id in seen_ids:
            continue
        seen_ids.add(norad_id)

        meta = match_satellite(tle["name"])
        if meta is None:
            continue

        satellites[str(norad_id)] = {
            "name": tle["name"],
            "norad_id": norad_id,
            "operator": meta["operator"],
            "constellation": meta["constellation"],
            "color": OPERATOR_COLORS.get(meta["operator"], OPERATOR_COLORS["other"]),
            "resolution_m": meta["resolution_m"],
        }
        tle_lines.extend([tle["name"], tle["line1"], tle["line2"]])

    # Write outputs
    with open("data/tles.txt", "w") as f:
        f.write("\n".join(tle_lines) + "\n")

    with open("data/satellites.json", "w") as f:
        json.dump(satellites, f, indent=2)

    # Summary
    by_operator = {}
    for sat in satellites.values():
        by_operator.setdefault(sat["operator"], []).append(sat["name"])

    print(f"\n{len(satellites)} satellites matched:")
    for op, sats in sorted(by_operator.items()):
        print(f"  {op}: {len(sats)} ({', '.join(sats[:3])}{'...' if len(sats) > 3 else ''})")


if __name__ == "__main__":
    main()
