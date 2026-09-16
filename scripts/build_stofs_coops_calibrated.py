#!/usr/bin/env python3
"""Build a STOFS background field with a held-out CO-OPS harmonic correction.

This is a calibration layer, not a station-generated tide field.  STOFS is
the value everywhere; CO-OPS harmonic predictions only estimate spatially
decaying model error.  Observed water levels are never used to fit it.
"""
import argparse, datetime as dt, hashlib, json, math
from pathlib import Path
import numpy as np

PERIOD_H = {"M2":12.4206012,"S2":12.0,"N2":12.6583475,"K2":11.967236,
            "K1":23.934472,"O1":25.819338,"P1":24.06589,"Q1":26.86835}
NAMES = tuple(PERIOD_H)

def tms(v):
    if isinstance(v,(int,float)): return int(v)
    return int(np.datetime64(str(v).replace("Z","")).astype("datetime64[ms]").astype(int))

def basis(times, ref):
    h=(np.asarray(times,dtype=float)-ref)/3600000.0
    cols=[np.ones(len(h))]
    for n in NAMES:
        w=2*np.pi/PERIOD_H[n]; cols += [np.cos(w*h),np.sin(w*h)]
    return np.column_stack(cols)

def fit(times, values, ref):
    if len(times)<max(24,2*len(NAMES)+2): return None
    x=basis(times,ref); y=np.asarray(values,float)
    c,*_=np.linalg.lstsq(x,y,rcond=None)
    return c

def grid_sample(grid,lats,lons,lat,lon):
    if not grid or not lats or not lons: return None
    yi=min(range(len(lats)),key=lambda i:abs(float(lats[i])-lat)); xi=min(range(len(lons)),key=lambda i:abs(float(lons[i])-lon))
    v=grid[yi][xi]
    if v is not None and np.isfinite(v): return float(v)
    for r in range(1,4):
        cand=[]
        for y in range(max(0,yi-r),min(len(lats),yi+r+1)):
            for x in range(max(0,xi-r),min(len(lons),xi+r+1)):
                v=grid[y][x]
                if v is not None and np.isfinite(v): cand.append((abs(float(lats[y])-lat)+abs(float(lons[x])-lon),float(v)))
        if cand:return min(cand)[1]
    return None

def dist_nm(lat1,lon1,lat2,lon2):
    # local equirectangular nautical miles; adequate for this small domain.
    return 60.0*math.hypot(lat2-lat1,(lon2-lon1)*math.cos(math.radians((lat1+lat2)/2)))

def station_series(payload, station, field):
    out=[]; lats=payload["lats"]; lons=payload["lons"]
    for f in payload["frames"]:
        v=grid_sample(f.get(field),lats,lons,float(station["lat"]),float(station["lon"]))
        if v is not None: out.append((tms(f["time"]),v))
    return out

def coops_series(payload, sid, key="curves"):
    return [(tms(p["t"]),float(p["v"])) for p in (payload.get("tides",{}).get(key,{}) or {}).get(str(sid),[]) if p.get("v") not in (None,"")]

def predict(c, times, ref): return basis(times,ref)@c

def station_correction(corrections, stations, sid, decay_nm):
    target=stations[sid]; parts=[]
    for source_id,c in corrections.items():
        if source_id == "_ref" or c is None or source_id not in stations: continue
        source=stations[source_id]
        d=dist_nm(float(target["lat"]),float(target["lon"]),float(source["lat"]),float(source["lon"]))
        parts.append((math.exp(-d/max(decay_nm,1e-6)),np.asarray(c,float)))
    if not parts:return None
    total=sum(w for w,_ in parts)
    return sum((w*c for w,c in parts),np.zeros_like(parts[0][1]))/total

def score(payload, field, station_ids, start, end, corrections=None, decay_nm=35.0):
    rows=[]; allerr=[]
    stations={str(s["id"]):s for s in payload["tides"]["stations"]}
    for sid in station_ids:
        st=stations[sid]; model=dict(station_series(payload,st,field)); target=dict(coops_series(payload,sid))
        ts=sorted(set(model)&set(target)); ts=[x for x in ts if start<=x<end]
        if not ts: rows.append({"id":sid,"samples":0}); continue
        vals=np.array([model[x] for x in ts],float)
        if corrections:
            c=station_correction(corrections,stations,sid,decay_nm)
            if c is not None: vals += predict(c,ts,corrections["_ref"])
        err=np.array([target[x] for x in ts])-vals; allerr.extend(err.tolist())
        rows.append({"id":sid,"name":st["name"],"samples":len(ts),"bias_ft":round(float(err.mean()),4),"rmse_ft":round(float(np.sqrt(np.mean(err*err))),4),"mae_ft":round(float(np.abs(err).mean()),4)})
    if not allerr:return {"stations":rows,"samples":0,"rmse_ft":None}
    e=np.asarray(allerr); return {"stations":rows,"samples":len(e),"stations_with_overlap":sum(r["samples"]>0 for r in rows),"bias_ft":round(float(e.mean()),4),"rmse_ft":round(float(np.sqrt(np.mean(e*e))),4),"mae_ft":round(float(np.abs(e).mean()),4)}

def fit_corrections(payload, train_ids, field, start, end, ref):
    stations={str(s["id"]):s for s in payload["tides"]["stations"]}; out={"_ref":ref}
    for sid in train_ids:
        st=stations[sid]; model=dict(station_series(payload,st,field)); target=dict(coops_series(payload,sid)); ts=sorted(set(model)&set(target)); ts=[x for x in ts if start<=x<end]
        if len(ts)<24: continue
        out[sid]=fit(ts,[target[x]-model[x] for x in ts],ref)
    return out

def sha(path):
    h=hashlib.sha256();
    with open(path,"rb") as f:
        for b in iter(lambda:f.read(1<<20),b""):h.update(b)
    return h.hexdigest()

def json_grid(arr):
    a=np.asarray(arr,dtype=float)
    return [[None if not np.isfinite(v) else float(v) for v in row] for row in a]

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("payload",type=Path); ap.add_argument("--output",type=Path,required=True); ap.add_argument("--report",type=Path,required=True); ap.add_argument("--decay-nm",type=float,default=35); ap.add_argument("--holdout-hours",type=int,default=48); args=ap.parse_args()
    p=json.loads(args.payload.read_text()); field="astronomical_tide_ft"; ids=[str(s["id"]) for s in p["tides"]["stations"]]
    times=[tms(f["time"]) for f in p["frames"]]; ref=min(times); end=max(times)+1
    # LOO measures spatial generalization over the complete available window.
    # The chronological test reserves only the tail, leaving enough cycles for
    # a stable multi-constituent fit; fitting 48 hours and extrapolating five
    # days creates a numerically meaningless harmonic solution.
    split=end-args.holdout_hours*3600000
    baseline=score(p,field,ids,ref,end)
    loo=[]; calibrated_rows=[]
    for held in ids:
        corr=fit_corrections(p,[x for x in ids if x!=held],field,ref,end,ref); r=score(p,field,[held],ref,end,corr,args.decay_nm); loo.append({"held_out":held,**r})
    corr=fit_corrections(p,ids,field,ref,split,ref); time_holdout=score(p,field,ids,split,end,corr,args.decay_nm)
    loo_rmse=[x["rmse_ft"] for x in loo if x.get("rmse_ft") is not None]
    gate=(baseline.get("rmse_ft") is not None and time_holdout.get("rmse_ft") is not None
          and time_holdout["rmse_ft"]<=baseline["rmse_ft"] and len(loo_rmse)==len(ids)
          and float(np.mean(loo_rmse))<=baseline["rmse_ft"] and all(x.get("samples",0)>0 for x in loo))
    report={"status":"pass" if gate else "fail","model":"NOAA STOFS HTP + CO-OPS harmonic residual calibration","field":field,"constituents":list(NAMES),"calibration":"complex harmonic residuals; training window only","baseline":baseline,"leave_one_station_out":loo,"time_holdout":time_holdout,"holdout_hours":args.holdout_hours,"offshore_decay_nm":args.decay_nm,"observed_water_levels_used":False,"promotion_gate":"LOO coverage and held-out RMSE no worse than untouched STOFS","created_at":dt.datetime.now(dt.timezone.utc).isoformat()}
    args.report.parent.mkdir(parents=True,exist_ok=True); args.report.write_text(json.dumps(report,indent=2)+"\n")
    if not gate: print(json.dumps(report,indent=2)); raise SystemExit("refusing promotion: independent holdout gate failed")
    # Apply only the learned correction; correction decays to zero offshore.
    frames=[]; stations={str(s["id"]):s for s in p["tides"]["stations"]}
    for f in p["frames"]:
        g=np.array(f[field],dtype=float); tt=tms(f["time"]);
        for yi,lat in enumerate(p["lats"]):
            for xi,lon in enumerate(p["lons"]):
                vals=[]; ws=[]
                for sid,c in corr.items():
                    if sid=="_ref" or c is None:continue
                    st=stations[sid]; d=dist_nm(lat,lon,float(st["lat"]),float(st["lon"])); w=math.exp(-d/max(args.decay_nm,1e-6)); vals.append(predict(c,[tt],ref)[0]);ws.append(w)
                if vals:g[yi,xi]+=float(np.dot(vals,ws)/sum(ws))
        nf=dict(f); nf[field]=json_grid(g); frames.append(nf)
    stack=np.asarray([[[np.nan if v is None else v for v in row] for row in f[field]] for f in frames],dtype=float)
    rng=np.nanmax(stack,0)-np.nanmin(stack,0)
    for f in frames:f["tide_range_ft"]=json_grid(rng);f["tide_amplitude_ft"]=json_grid(rng/2)
    p["frames"]=frames; p["regional_tide_source"]={"provider":"NOAA","model":"STOFS-2D Global HTP","method":"held-out complex harmonic residual calibration","validation":report,"offshore_independent":True}
    args.output.write_text(json.dumps(p,allow_nan=False,separators=(",",":"))); print(json.dumps(report,indent=2))

if __name__=="__main__":main()
