#!/usr/bin/env python3
"""
Process raw crime FIR data into aggregated heatmap-ready JSON.

Usage:
    python process_crime_data.py [--date YYYY-MM-DD] [--crime_type TYPE]

Outputs JSON on stdout with structure:
{
  "points": [
     {"lat": 28.63, "lon": 77.21, "count": 3, "avg_intensity": 0.83, "date": "2025-01-15", "crime_type": "Theft"}
  ],
  "meta": {
     "dates": [...],
     "crime_types": [...]
  }
}
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

DATA_PATH = Path(__file__).resolve().parent / "crime_dataset.csv"


def load_dataset() -> pd.DataFrame:
  """Load and clean the raw CSV data."""
  df = pd.read_csv(DATA_PATH)

  # Normalize column names for safety
  df.columns = [col.strip().lower() for col in df.columns]

  # Coerce numeric fields
  df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
  df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
  df["intensity"] = pd.to_numeric(df.get("intensity"), errors="coerce")
  df["crime_type"] = df.get("crime_type", pd.Series(dtype=str)).astype(str).str.strip()

  # Parse date/time fields
  df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
  df["time"] = pd.to_datetime(df["time"], format="%H:%M", errors="coerce").dt.time

  # Drop rows without essential coordinates or date
  df = df.dropna(subset=["lat", "lon", "date"])
  df = df[df["crime_type"].str.lower() != "general"]
  df = df[df["crime_type"].str.len() > 0]

  # Replace missing intensity with 1.0 baseline
  df["intensity"] = df["intensity"].fillna(1.0)

  # Deduplicate exact duplicates by keeping the latest time entry
  df = df.sort_values(["lat", "lon", "date", "time"]).drop_duplicates(
      subset=["lat", "lon", "date", "crime_type"], keep="last"
  )

  return df.reset_index(drop=True)


def aggregate(df: pd.DataFrame) -> pd.DataFrame:
  """
  Aggregate crimes by location (latitude, longitude).
  Returns a DataFrame with lat, lon, totals, and dominant crime per coordinate.
  """
  if df.empty:
    return pd.DataFrame(
        columns=[
            "lat",
            "lon",
            "count",
            "avg_intensity",
            "normalized_count",
            "dominant_crime",
            "latest_date",
        ]
    )

  base = (
      df.groupby(["lat", "lon"])
      .agg(
          count=("crime_type", "size"),
          avg_intensity=("intensity", "mean"),
      )
      .reset_index()
  )

  latest_dates = (
      df.groupby(["lat", "lon"])["date"]
      .max()
      .reset_index(name="latest_date")
  )

  dominant = (
      df.groupby(["lat", "lon", "crime_type"])
      .size()
      .reset_index(name="crime_count")
      .sort_values(["lat", "lon", "crime_count"], ascending=[True, True, False])
      .drop_duplicates(subset=["lat", "lon"])
      .rename(columns={"crime_type": "dominant_crime"})
  )

  aggregated = (
      base.merge(latest_dates, on=["lat", "lon"], how="left")
      .merge(dominant, on=["lat", "lon"], how="left")
  )

  max_count = aggregated["count"].max()
  aggregated["normalized_count"] = aggregated["count"] / max(max_count, 1)

  return aggregated


def build_response(full_df: pd.DataFrame, aggregated: pd.DataFrame) -> dict:
  """Compose the JSON response payload."""
  points = [
      {
          "lat": row.lat,
          "lon": row.lon,
          "count": int(row.count),
          "avg_intensity": round(float(row.avg_intensity), 3),
          "normalized_count": round(float(row.normalized_count), 3),
          "date": row.latest_date.isoformat() if pd.notna(row.latest_date) else None,
          "crime_type": row.dominant_crime or "Unknown",
      }
      for row in aggregated.itertuples()
  ]

  meta = {
      "dates": sorted(
          {d.isoformat() for d in full_df["date"].dropna().unique()}
      ),
      "crime_types": sorted(
          {str(c) for c in full_df["crime_type"].dropna().unique()}
      ),
  }

  return {"points": points, "meta": meta}


def main():
  parser = argparse.ArgumentParser(description="Aggregate crime data for heatmap visualisation.")
  parser.add_argument("--date", dest="date", help="Filter by ISO date (YYYY-MM-DD)")
  parser.add_argument("--crime_type", dest="crime_type", help="Filter by crime type (case sensitive)")
  args = parser.parse_args()

  df = load_dataset()
  filtered_df = df.copy()
  if args.date:
    try:
      requested_date = pd.to_datetime(args.date).date()
      filtered_df = filtered_df[filtered_df["date"] == requested_date]
    except Exception:  # noqa: BLE001
      filtered_df = filtered_df.iloc[0:0]
  if args.crime_type:
    filtered_df = filtered_df[filtered_df["crime_type"].str.lower() == args.crime_type.lower()]

  aggregated = aggregate(filtered_df)
  response = build_response(df, aggregated)
  json.dump(response, sys.stdout, ensure_ascii=False)
  sys.stdout.write("\n")


if __name__ == "__main__":
  main()


