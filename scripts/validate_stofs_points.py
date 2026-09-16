#!/usr/bin/env python3
"""Compare exact STOFS HTP verification points with CO-OPS predictions.

This is a diagnostic only. It does not modify the regional offshore field.
It reports the best hourly lag so a timezone error cannot be hidden in RMSE.
"""
import argparse, datetime as dt, json, math
from pathlib import Path
import numpy as np
from scipy.io import netcdf_file

def epoch(t): return int(t.timestamp()*1000)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("points",type=Path); ap.add_argument("payload",type=Path); ap.add_argument("--output",type=Path,required=True); ap.add_argument("--datum-offsets",type=Path); a=ap.parse_args()
    d=netcdf_file(a.points,mmap=False); p=json.loads(a.payload.read_text())
    base=dt.datetime.strptime(d.variables["time"].units.decode().split("since ",1)[1][:19],"%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    ts=[epoch(base+dt.timedelta(seconds=float(x))) for x in d.variables["time"].data]
    names=[b"".join(row).decode(errors="ignore").strip() for row in d.variables["station_name"].data]
    xs=d.variables["x"].data; ys=d.variables["y"].data; z=d.variables["zeta"].data
    offsets=json.loads(a.datum_offsets.read_text()) if a.datum_offsets else {}; rows=[]
    for station in p["tides"]["stations"]:
        i=int(np.argmin((xs-float(station["lon"]))**2+(ys-float(station["lat"]))**2)); obs={int(q["t"]):float(q["v"]) for q in p["tides"]["curves"].get(station["id"],[])}
        pairs=[(ts[j],float(z[j,i]),obs[ts[j]]) for j in range(len(ts)) if ts[j] in obs and np.isfinite(z[j,i]) and z[j,i]>-9000]
        if len(pairs)<4: rows.append({"id":station["id"],"samples":len(pairs),"status":"insufficient"}); continue
        offset=offsets.get(station["id"],0.0); offset=offset.get("msl_minus_mllw_ft",0.0) if isinstance(offset,dict) else offset
        model=np.array([x[1] for x in pairs])+float(offset); meas=np.array([x[2] for x in pairs]); lags=[]
        for lag in range(-12,13):
            shifted=np.roll(model,lag); valid=np.arange(len(model))>=abs(lag)
            lags.append((float(np.corrcoef(shifted[valid],meas[valid])[0,1]),lag))
        corr,lag=max(lags)
        rows.append({"id":station["id"],"name":station["name"],"point_name":names[i],"samples":len(pairs),"rmse_ft":round(float(np.sqrt(np.mean((meas-model)**2))),4),"bias_ft":round(float(np.mean(meas-model)),4),"best_lag_hours":lag,"zero_lag_correlation":round(float(np.corrcoef(model,meas)[0,1]),4),"best_correlation":round(corr,4)})
    result={"source":"NOAA STOFS points.htp.nc","time_basis":"UTC from NetCDF units","stations":rows,"timezone_hypothesis":"pass if best_lag_hours is approximately +/-4"}
    a.output.write_text(json.dumps(result,indent=2)+"\n"); print(json.dumps(result,indent=2))
if __name__=="__main__": main()
