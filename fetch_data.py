#!/usr/bin/env python3
"""Pulls live sentiment data and writes data.json for the dashboard.

Source: CNN Fear & Greed Index public API (production.dataviz.cnn.io) for
the five sentiment factors, and Yahoo Finance for the S&P 500 index level.
"""

import json
import ssl
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


def fetch_sp500_price():
    last_error = None
    for url in SP500_URLS:
        for attempt in range(3):
            try:
                payload = fetch_json(url, accept_json=False)
                return round(payload["chart"]["result"][0]["meta"]["regularMarketPrice"], 2)
            except Exception as exc:  # noqa: BLE001 - retry/fall through to next mirror
                last_error = exc
                time.sleep(2 * (attempt + 1))
    print(f"Warning: could not fetch S&P 500 price ({last_error}); reusing last known value")
    return None


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
    main()
