#!/usr/bin/env python3
"""Fetch NOAA CO-OPS station datum offsets for validation only."""
import argparse, json
from pathlib import Path
import requests

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("stations", nargs="+", help="CO-OPS station IDs")
    ap.add_argument("--output", required=True, type=Path); a=ap.parse_args()
    out={}
    for sid in a.stations:
        url=f"https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{sid}/datums.json?units=english"
        r=requests.get(url, timeout=30); r.raise_for_status()
        vals={x["name"]:float(x["value"]) for x in r.json().get("datums",[])}
        if "MSL" not in vals or "MLLW" not in vals: raise SystemExit(f"missing MSL/MLLW datum for {sid}")
        out[str(sid)]={"msl_minus_mllw_ft": vals["MSL"]-vals["MLLW"], "source": url}
    a.output.parent.mkdir(parents=True, exist_ok=True); a.output.write_text(json.dumps(out,indent=2)+"\n")
    print(json.dumps(out,indent=2))
if __name__=="__main__": main()
