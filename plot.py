#!/usr/bin/env python3
"""
Plot oracle simulation results from a .simdata file using Plotly.

Usage:
    python3 plot.py                          # reads output.simdata
    python3 plot.py path/to/file.simdata     # reads specified file
    python3 plot.py --downsample 100         # keep every 100th point (for large files)
    python3 plot.py --export plot.html        # save to HTML instead of opening browser
"""

import json
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path

import plotly.graph_objects as go
from plotly.subplots import make_subplots

COLORS = ['#2962FF', '#FF6D00', '#00C853', '#D500F9', '#FF1744', '#00E5FF', '#FFEA00', '#69F0AE']
REAL_COLOR = '#888888'


def load_simdata(path: str) -> dict:
    print(f"Loading {path}...")
    with open(path) as f:
        data = json.load(f)
    assert data["version"] == 1, f"Unsupported .simdata version: {data['version']}"
    n_scenarios = len(data["scenarios"])
    n_blocks = len(data["scenarios"][0]["timestamps"])
    print(f"  {n_scenarios} scenario(s), {n_blocks:,} blocks each")
    return data


def timestamps_to_dates(ts: list[int]) -> list[datetime]:
    return [datetime.fromtimestamp(t, tz=timezone.utc) for t in ts]


def downsample(arr: list, factor: int) -> list:
    if factor <= 1:
        return arr
    return arr[::factor]


def auto_downsample_factor(n_points: int, target: int = 20_000) -> int:
    """Pick a downsample factor to keep ~target points."""
    if n_points <= target:
        return 1
    return max(1, n_points // target)


def build_figure(data: dict, ds_factor: int = 0) -> go.Figure:
    scenarios = data["scenarios"]
    n_scenarios = len(scenarios)

    # Use first scenario's timestamps (all share the same time axis)
    raw_ts = scenarios[0]["timestamps"]
    n_points = len(raw_ts)

    # Auto-downsample if not specified
    if ds_factor == 0:
        ds_factor = auto_downsample_factor(n_points)
    if ds_factor > 1:
        print(f"  Downsampling {n_points:,} -> ~{n_points // ds_factor:,} points (every {ds_factor}th)")

    dates = downsample(timestamps_to_dates(raw_ts), ds_factor)

    fig = make_subplots(
        rows=2, cols=1,
        shared_xaxes=True,
        vertical_spacing=0.06,
        row_heights=[0.7, 0.3],
        subplot_titles=("Price (USDT)", "Deviation (%)"),
    )

    # Real price (same across all scenarios, use first)
    real_prices = downsample(scenarios[0]["realPrices"], ds_factor)
    fig.add_trace(
        go.Scattergl(
            x=dates, y=real_prices,
            name="Real Price",
            line=dict(color=REAL_COLOR, width=1),
            legendgroup="real",
        ),
        row=1, col=1,
    )

    # Per-scenario oracle price + deviation
    for i, sc in enumerate(scenarios):
        color = COLORS[i % len(COLORS)]
        label = sc["config"].get("label", f"Scenario {i}")
        summary = sc["summary"]

        oracle_prices = downsample(sc["oraclePrices"], ds_factor)
        deviation_pcts = downsample(sc["deviationPcts"], ds_factor)

        hover_label = (
            f"{label}<br>"
            f"mean dev: {summary['meanDeviationPct']:.4f}%<br>"
            f"max dev: {summary['maxDeviationPct']:.2f}%<br>"
            f"convergence: {summary['convergenceRate'] * 100:.2f}%"
        )

        fig.add_trace(
            go.Scattergl(
                x=dates, y=oracle_prices,
                name=f"Oracle: {label}",
                line=dict(color=color, width=1.5),
                legendgroup=f"oracle_{i}",
                hovertemplate=f"{label}<br>price: %{{y:.4f}}<extra></extra>",
            ),
            row=1, col=1,
        )

        fig.add_trace(
            go.Scattergl(
                x=dates, y=deviation_pcts,
                name=f"Deviation: {label}",
                line=dict(color=color, width=1),
                legendgroup=f"oracle_{i}",
                hovertemplate=f"{label}<br>deviation: %{{y:.4f}}%<extra></extra>",
            ),
            row=2, col=1,
        )

    # Build title with summary info
    if n_scenarios == 1:
        sc = scenarios[0]
        s = sc["summary"]
        title_text = (
            f"Oracle Simulation — {sc['config'].get('label', '')}"
            f" | {s['totalBlocks']:,} blocks"
            f" | mean dev {s['meanDeviationPct']:.4f}%"
            f" | max dev {s['maxDeviationPct']:.2f}%"
            f" | convergence {s['convergenceRate'] * 100:.2f}%"
        )
    else:
        title_text = f"Oracle Simulation — {n_scenarios} scenarios"

    fig.update_layout(
        title=dict(text=title_text, font=dict(size=14)),
        template="plotly_dark",
        height=800,
        hovermode="x unified",
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="left",
            x=0,
        ),
        xaxis2=dict(title="Time (UTC)"),
        yaxis=dict(title="Price (USDT)"),
        yaxis2=dict(title="Deviation (%)"),
        margin=dict(t=80, b=40, l=60, r=20),
    )

    # Add range slider on bottom x-axis for navigation
    fig.update_xaxes(rangeslider=dict(visible=True, thickness=0.04), row=2, col=1)

    return fig


def build_summary_table(data: dict) -> str:
    """Build a text summary table for multi-scenario comparisons."""
    lines = ["Scenario Summary:", "-" * 90]
    header = f"{'Label':<30} {'Blocks':>10} {'Mean Dev%':>10} {'Max Dev%':>10} {'Conv%':>10} {'Epsilon':>12}"
    lines.append(header)
    lines.append("-" * 90)
    for sc in data["scenarios"]:
        s = sc["summary"]
        label = sc["config"].get("label", "?")[:30]
        lines.append(
            f"{label:<30} {s['totalBlocks']:>10,} {s['meanDeviationPct']:>10.4f} "
            f"{s['maxDeviationPct']:>10.2f} {s['convergenceRate'] * 100:>10.2f} "
            f"{s['epsilon']:>12.8f}"
        )
    lines.append("-" * 90)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Plot oracle sim results with Plotly")
    parser.add_argument("simdata", nargs="?", default="output.simdata", help="Path to .simdata file")
    parser.add_argument("--downsample", type=int, default=0, help="Keep every Nth point (0 = auto)")
    parser.add_argument("--export", type=str, default=None, help="Export to HTML file instead of opening browser")
    parser.add_argument("--no-summary", action="store_true", help="Skip printing summary table")
    args = parser.parse_args()

    path = Path(args.simdata)
    if not path.exists():
        print(f"Error: {path} not found", file=sys.stderr)
        sys.exit(1)

    data = load_simdata(str(path))

    if not args.no_summary:
        print(build_summary_table(data))
        print()

    fig = build_figure(data, ds_factor=args.downsample)

    if args.export:
        fig.write_html(args.export, include_plotlyjs=True)
        print(f"Exported to {args.export}")
    else:
        fig.show()


if __name__ == "__main__":
    main()
