#!/usr/bin/env python3
"""
Fetch historical DOT price data from Binance or Kraken.

This script fetches OHLCV candle data and saves it in a format
compatible with the pUSD simulation framework.

Usage:
    python fetch_dot_prices.py
    python fetch_dot_prices.py --start-date 2024-01-01 --interval 1h
    python fetch_dot_prices.py --source kraken --format csv
"""

import argparse
import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import requests


# =============================================================================
# Constants
# =============================================================================

BINANCE_BASE_URL = "https://api.binance.us/api/v3/klines"

BINANCE_INTERVALS = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
}

INTERVAL_MINUTES = {
    "5m": 5,
    "15m": 15,
    "1h": 60,
    "4h": 240,
    "1d": 1440,
}


# =============================================================================
# Binance Fetcher
# =============================================================================


def fetch_binance(
    start_date: datetime,
    end_date: datetime,
    interval: str,
    verbose: bool = False,
) -> list[dict[str, Any]]:
    """Fetch OHLCV data from Binance."""

    start_ms = int(start_date.timestamp() * 1000)
    end_ms = int(end_date.timestamp() * 1000)

    interval_ms = INTERVAL_MINUTES[interval] * 60 * 1000
    expected_candles = (end_ms - start_ms) // interval_ms
    total_batches = (expected_candles // 1000) + 1

    print(f"Fetching DOT/USDT from Binance...")
    print(f"  Interval: {interval}")
    print(f"  Range: {start_date.date()} to {end_date.date()}")
    print(f"  Expected candles: ~{expected_candles}")
    print()

    all_candles = []
    current_start = start_ms
    batch_num = 0

    while current_start < end_ms:
        batch_num += 1

        params = {
            "symbol": "DOTUSDT",
            "interval": BINANCE_INTERVALS[interval],
            "startTime": current_start,
            "endTime": end_ms,
            "limit": 1000,
        }

        for attempt in range(3):
            try:
                response = requests.get(BINANCE_BASE_URL, params=params, timeout=30)
                response.raise_for_status()
                data = response.json()
                break
            except requests.RequestException as e:
                if attempt < 2:
                    wait_time = 2 ** attempt
                    print(f"  Retry {attempt + 1}/3 after {wait_time}s: {e}")
                    time.sleep(wait_time)
                else:
                    raise RuntimeError(f"Failed to fetch batch {batch_num}: {e}")

        if not data:
            break

        candles = []
        for candle in data:
            candles.append({
                "timestamp": candle[0] // 1000,  # Convert to Unix seconds
                "open": float(candle[1]),
                "high": float(candle[2]),
                "low": float(candle[3]),
                "close": float(candle[4]),
                "volume": float(candle[5]),
                "price": float(candle[4]),  # Close price as canonical price
            })

        all_candles.extend(candles)

        if verbose:
            print(f"  Batch {batch_num}/{total_batches}: {len(candles)} candles")
        else:
            print(f"  Fetching batch {batch_num}/{total_batches} ({len(candles)} candles)... OK")

        # Move to next batch
        if candles:
            current_start = (candles[-1]["timestamp"] * 1000) + interval_ms
        else:
            break

        # Rate limiting
        time.sleep(0.2)

    return all_candles


# =============================================================================
# Validation & Output
# =============================================================================


def validate_candles(
    candles: list[dict[str, Any]],
    start_date: datetime,
    end_date: datetime,
    interval: str,
) -> dict[str, Any]:
    """Validate candle data and check for gaps."""

    if not candles:
        return {
            "valid": False,
            "total_candles": 0,
            "expected_candles": 0,
            "gaps": [],
            "coverage": 0.0,
            "candles": [],
        }

    interval_seconds = INTERVAL_MINUTES[interval] * 60
    start_ts = int(start_date.timestamp())
    end_ts = int(end_date.timestamp())

    expected_candles = (end_ts - start_ts) // interval_seconds

    # Sort by timestamp
    candles.sort(key=lambda x: x["timestamp"])

    # Remove duplicates
    seen = set()
    unique_candles = []
    for c in candles:
        if c["timestamp"] not in seen:
            seen.add(c["timestamp"])
            unique_candles.append(c)

    # Check for gaps
    gaps = []
    for i in range(1, len(unique_candles)):
        expected_ts = unique_candles[i - 1]["timestamp"] + interval_seconds
        actual_ts = unique_candles[i]["timestamp"]

        if actual_ts > expected_ts + interval_seconds:
            gap_start = datetime.fromtimestamp(expected_ts)
            gap_end = datetime.fromtimestamp(actual_ts)
            missing_candles = (actual_ts - expected_ts) // interval_seconds
            gaps.append({
                "start": gap_start.isoformat(),
                "end": gap_end.isoformat(),
                "missing_candles": missing_candles,
            })

    coverage = len(unique_candles) / expected_candles if expected_candles > 0 else 0

    return {
        "valid": coverage >= 0.95,
        "total_candles": len(unique_candles),
        "expected_candles": expected_candles,
        "gaps": gaps,
        "coverage": coverage,
        "candles": unique_candles,
    }


def save_json(
    candles: list[dict[str, Any]],
    filepath: Path,
    interval: str,
    source: str,
    start_date: datetime,
    end_date: datetime,
) -> None:
    """Save candles to JSON format for simulation."""

    output = {
        "asset": "DOT",
        "quote": "USD",
        "interval": interval,
        "source": source,
        "start_date": start_date.date().isoformat(),
        "end_date": end_date.date().isoformat(),
        "data_points": len(candles),
        "data": candles,
    }

    with open(filepath, "w") as f:
        json.dump(output, f, indent=2)


def save_csv(
    candles: list[dict[str, Any]],
    filepath: Path,
) -> None:
    """Save candles to CSV format for analysis."""

    with open(filepath, "w") as f:
        f.write("timestamp,datetime,open,high,low,close,volume\n")
        for c in candles:
            dt = datetime.fromtimestamp(c["timestamp"]).isoformat()
            f.write(f"{c['timestamp']},{dt},{c['open']},{c['high']},{c['low']},{c['close']},{c['volume']}\n")


# =============================================================================
# Main
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Fetch historical DOT price data for backtesting"
    )
    parser.add_argument(
        "--start-date",
        type=str,
        help="Start date (YYYY-MM-DD). Default: 1 year ago",
    )
    parser.add_argument(
        "--end-date",
        type=str,
        help="End date (YYYY-MM-DD). Default: today",
    )
    parser.add_argument(
        "--interval",
        type=str,
        default="15m",
        choices=["5m", "15m", "1h", "4h", "1d"],
        help="Candle interval. Default: 15m",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./backtesting/data",
        help="Output directory. Default: ./backtesting/data",
    )
    parser.add_argument(
        "--format",
        type=str,
        default="both",
        choices=["json", "csv", "both"],
        help="Output format. Default: both",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print detailed progress",
    )

    args = parser.parse_args()

    # Parse dates
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    if args.end_date:
        end_date = datetime.strptime(args.end_date, "%Y-%m-%d")

    start_date = end_date - timedelta(days=365)
    if args.start_date:
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d")

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Fetch data
    start_time = time.time()
    candles = fetch_binance(start_date, end_date, args.interval, args.verbose)

    # Validate
    print()
    print("Validation:")
    validation = validate_candles(candles, start_date, end_date, args.interval)

    print(f"  Total candles: {validation['total_candles']}")
    print(f"  Expected candles: {validation['expected_candles']}")
    print(f"  Coverage: {validation['coverage']:.1%}")
    print(f"  Gaps detected: {len(validation['gaps'])}")

    if validation['gaps'] and args.verbose:
        for gap in validation['gaps'][:5]:
            print(f"    - {gap['start']} to {gap['end']} ({gap['missing_candles']} missing)")
        if len(validation['gaps']) > 5:
            print(f"    ... and {len(validation['gaps']) - 5} more gaps")

    if not validation['valid']:
        print()
        print(f"WARNING: Data coverage is below 95% ({validation['coverage']:.1%})")

    # Save output
    print()
    print("Output:")

    clean_candles = validation['candles']
    filename_base = f"dot_usd_{args.interval}_{start_date.date()}_{end_date.date()}"

    if args.format in ("json", "both"):
        json_path = output_dir / f"{filename_base}.json"
        save_json(clean_candles, json_path, args.interval, "binance", start_date, end_date)
        print(f"  JSON: {json_path}")

    if args.format in ("csv", "both"):
        csv_path = output_dir / f"{filename_base}.csv"
        save_csv(clean_candles, csv_path)
        print(f"  CSV:  {csv_path}")

    elapsed = time.time() - start_time
    print()
    print(f"Done in {elapsed:.1f}s")

    return 0 if validation['valid'] else 1


if __name__ == "__main__":
    exit(main())
