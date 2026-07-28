#!/usr/bin/env python3
"""Pulls live sentiment data and writes data.json for the dashboard.

Source: CNN Fear & Greed Index public API (production.dataviz.cnn.io) for
the five sentiment factors, and Yahoo Finance for the S&P 500 index level.
"""

import json
import ssl
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import certifi

CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
SP500_URLS = [
    "https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=1d",
    "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=1d",
]
SP500_HISTORY_URLS = [
    "https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1y&interval=1d",
    "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1y&interval=1d",
]
OUT_PATH = Path(__file__).parent / "data.json"
HISTORY_PATH = Path(__file__).parent / "history.json"

COMPONENTS = [
    {
        "id": "vix",
        "cnn_key": "market_volatility_vix",
        "name": "VIX Volatility",
        "unit": "index",
        "weight": 20,
        "description": "Low volatility usually reflects investor confidence.",
    },
    {
        "id": "putcall",
        "cnn_key": "put_call_options",
        "name": "Equity Put/Call Ratio",
        "unit": "ratio",
        "weight": 20,
        "description": "Low put demand indicates bullish positioning.",
    },
    {
        "id": "breadth",
        "cnn_key": "stock_price_breadth",
        "name": "Market Breadth",
        "unit": "advance/decline volume",
        "weight": 20,
        "description": "Measures participation beneath the headline index.",
    },
    {
        "id": "momentum",
        "cnn_key": "market_momentum_sp500",
        "name": "Price Momentum",
        "unit": "S&P 500 vs 125-day avg",
        "weight": 20,
        "description": "Strong price trends increase investor optimism.",
    },
    {
        "id": "credit",
        "cnn_key": "junk_bond_demand",
        "name": "Credit Conditions",
        "unit": "HY bond spread proxy",
        "weight": 20,
        "description": "Narrow credit spreads suggest risk appetite.",
    },
]


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def fetch_json(url, referer=None, accept_json=True):
    headers = {"User-Agent": USER_AGENT}
    if accept_json:
        headers["Accept"] = "application/json"
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
        return json.load(resp)


def fetch_raw():
    return fetch_json(CNN_URL, referer="https://www.cnn.com/markets/fear-and-greed")


def fetch_json_via_curl(url):
    """Yahoo Finance's endpoint 429s on urllib's TLS fingerprint but not curl's, so shell out."""
    result = subprocess.run(
        ["curl", "-s", "-A", USER_AGENT, url],
        capture_output=True, text=True, timeout=20, check=True,
    )
    return json.loads(result.stdout)


def fetch_sp500_price():
    last_error = None
    for url in SP500_URLS:
        for attempt in range(3):
            try:
                payload = fetch_json_via_curl(url)
                return round(payload["chart"]["result"][0]["meta"]["regularMarketPrice"], 2)
            except Exception as exc:  # noqa: BLE001 - retry/fall through to next mirror
                last_error = exc
                time.sleep(2 * (attempt + 1))
    print(f"Warning: could not fetch S&P 500 price ({last_error}); reusing last known value")
    return None


def fetch_sp500_history():
    last_error = None
    for url in SP500_HISTORY_URLS:
        for attempt in range(3):
            try:
                payload = fetch_json_via_curl(url)
                result = payload["chart"]["result"][0]
                timestamps = result["timestamp"]
                closes = result["indicators"]["quote"][0]["close"]
                return {
                    datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d"): round(close, 2)
                    for ts, close in zip(timestamps, closes)
                    if close is not None
                }
            except Exception as exc:  # noqa: BLE001 - retry/fall through to next mirror
                last_error = exc
                time.sleep(4 * (attempt + 1))
    print(f"Warning: could not fetch S&P 500 history ({last_error})")
    return {}


def backfill_history():
    """Rebuild history.json from CNN's own composite score history plus S&P 500 daily closes.

    We only have raw factor *values* historically (not 0-100 scores) for our
    5-factor composite, and reproducing CNN's internal score normalization
    isn't practical, so this uses CNN's own overall Fear & Greed score history
    as the composite proxy for backfilled dates. Same 0-100 scale, same source.
    """
    raw = fetch_raw()
    composite_history = raw["fear_and_greed_historical"]["data"][-HISTORY_POINTS:]
    sp500_by_date = fetch_sp500_history()

    sp500_dates_sorted = sorted(sp500_by_date)

    def nearest_sp500(date_str):
        if date_str in sp500_by_date:
            return sp500_by_date[date_str]
        earlier = [d for d in sp500_dates_sorted if d <= date_str]
        return sp500_by_date[earlier[-1]] if earlier else None

    by_date = {}
    for point in composite_history:
        date_str = datetime.fromtimestamp(point["x"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        by_date[date_str] = {
            "date": date_str,
            "optimism": round(point["y"]),
            "sp500": nearest_sp500(date_str),
        }

    history = [by_date[d] for d in sorted(by_date)]

    HISTORY_PATH.write_text(json.dumps(history, indent=2))
    print(f"Backfilled {HISTORY_PATH} — {len(history)} days")


def percentile_rank(history, latest_value):
    values = sorted(point["y"] for point in history)
    if not values:
        return None
    below = sum(1 for v in values if v <= latest_value)
    return round(100 * below / len(values))


HISTORY_POINTS = 180  # ~6 months of daily points, kept compact for the browser


def build_component(raw, spec):
    cat = raw[spec["cnn_key"]]
    history = cat.get("data", [])
    latest_value = history[-1]["y"] if history else None
    trimmed = history[-HISTORY_POINTS:]
    return {
        "id": spec["id"],
        "name": spec["name"],
        "value": round(latest_value, 2) if latest_value is not None else None,
        "unit": spec["unit"],
        "percentile": percentile_rank(history, latest_value) if latest_value is not None else None,
        "score": round(cat["score"], 1),
        "weight": spec["weight"],
        "description": spec["description"],
        "history": [
            {
                "date": datetime.fromtimestamp(point["x"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
                "value": round(point["y"], 3),
            }
            for point in trimmed
        ],
    }


def main():
    raw = fetch_raw()
    components = [build_component(raw, spec) for spec in COMPONENTS]
    composite = round(sum(c["score"] * c["weight"] for c in components) / sum(c["weight"] for c in components))

    now_et = datetime.now(ZoneInfo("America/New_York"))
    data = {
        "timestamp": now_et.strftime("%B %d, %Y %I:%M %p ET"),
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
        "composite": composite,
        "components": components,
    }

    OUT_PATH.write_text(json.dumps(data, indent=2))
    print(f"Wrote {OUT_PATH} — composite={composite}")

    sp500_price = fetch_sp500_price()
    append_history(now_et, composite, sp500_price)


def append_history(now_et, composite, sp500_price):
    history = json.loads(HISTORY_PATH.read_text()) if HISTORY_PATH.exists() else []
    today = now_et.strftime("%Y-%m-%d")

    if sp500_price is None and history:
        sp500_price = history[-1]["sp500"]

    entry = {"date": today, "optimism": composite, "sp500": sp500_price}
    if history and history[-1]["date"] == today:
        history[-1] = entry
    else:
        history.append(entry)

    HISTORY_PATH.write_text(json.dumps(history, indent=2))
    print(f"Wrote {HISTORY_PATH} — {len(history)} days")


if __name__ == "__main__":
    import sys
    if "--backfill" in sys.argv:
        backfill_history()
    else:
        main()
