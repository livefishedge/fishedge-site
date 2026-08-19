#!/usr/bin/env python3
"""Build a provenance-preserving, survey-first USEC-MD bathymetry composite.

The output is numeric GeoTIFF data plus cached visualization/provenance tiles.
Priority is explicit: Okeanos survey > NOS/BAG > BlueTopo > NCEI mosaic.
"""
import json, math, sys
from pathlib import Path
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds, Affine
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds as window_from_bounds
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = Path('/home/gzheng/.openclaw/workspace-cto/bathy-research')
OUT = ROOT / 'dashboard/data/bathy/survey_first'
R = 6378137.0
DEPTH_COLORS = np.array([[3,1,7],[22,10,70],[49,32,154],[21,94,208],[8,167,211],[24,208,203]], dtype=np.float32)
PROV_COLORS = {1:(31,80,160), 2:(15,175,190), 3:(240,150,40), 4:(240,225,70)}

REGIONS = {
  'baltimore': {
    'bbox': (-74.30, 37.45, -73.10, 38.65),
    'sources': [
      ('ex1302', RESEARCH/'canyon_products/ex1302_01_raw.tif', 4, .95, 'Okeanos EX1302 raw/processed survey'),
      ('ex1903l2', RESEARCH/'canyon_products/ex1903_north_raw.tif', 4, .95, 'Okeanos EX1903L2 North raw/processed survey'),
      ('bag', RESEARCH/'ncei_bag_wm.tif', 3, .70, 'NOS BAG survey mosaic'),
      ('bluetopo', RESEARCH/'bluetopo_elevation_wm.tif', 2, .48, 'NOAA BlueTopo compilation'),
      ('multibeam', RESEARCH/'ncei_multibeam_wm.tif', 1, .32, 'NCEI multibeam mosaic'),
    ]
  },
  'hudson': {
    'bbox': (-72.80, 38.90, -71.10, 40.15),
    'sources': [
      ('ex1303', RESEARCH/'canyon_products/new_wm/ex1303_hudson_30m_wm.tif', 4, .95, 'Okeanos EX1303 Hudson Canyon'),
      ('ex1404l3', RESEARCH/'canyon_products/new_wm/ex1404l3_hudson_15m_wm.tif', 4, .95, 'Okeanos EX1404L3 Hudson Canyon'),
      ('bluetopo', RESEARCH/'bluetopo_elevation_wm.tif', 2, .48, 'NOAA BlueTopo compilation'),
    ]
  }
}

def wm(lon, lat):
    return lon * math.pi * R / 180, math.log(math.tan((90 + lat) * math.pi / 360)) * R

def tile_bounds(z,x,y):
    n=2**z
    return (x/n*2*math.pi*R-math.pi*R, (1-2*(y+1)/n)*math.pi*R,
            (x+1)/n*2*math.pi*R-math.pi*R, (1-2*y/n)*math.pi*R)

def load_source(path, transform, shape):
    with rasterio.open(path) as src:
        dst=np.full(shape, np.nan, dtype='float32')
        reproject(rasterio.band(src,1), dst, src_transform=src.transform, src_crs=src.crs,
                  dst_transform=transform, dst_crs=CRS.from_epsg(3857),
                  src_nodata=src.nodata, dst_nodata=np.nan,
                  resampling=Resampling.bilinear)
    valid=np.isfinite(dst) & (dst < -0.001) & (dst > -12000)
    return dst, valid

def harmonize(arrays, masks, infos):
    """Put every source on one local vertical level before precedence selection.

    The old implementation made a reference mosaic from the first survey and
    left the other equal-priority survey untouched.  That creates a step at a
    survey-footprint edge even when the two rasters overlap.  Solve offsets
    between sources of the same priority first, using robust overlap medians,
    then anchor lower-priority sources to the harmonized strongest tier.
    """
    offsets={i[0]: 0.0 for i in infos}

    def robust_offset(reference, candidate, overlap):
        d=reference[overlap]-candidate[overlap]
        d=d[np.isfinite(d) & (np.abs(d)<200)]
        if d.size < 100:
            return 0.0
        # Trim extreme terrain/geolocation mismatches before taking the
        # median.  This estimates the vertical datum/level bias, not canyon
        # morphology, and is stable against a few bad overlap cells.
        lo,hi=np.percentile(d,[5,95])
        trimmed=d[(d>=lo)&(d<=hi)]
        return float(np.median(trimmed if trimmed.size else d))

    priorities=sorted({i[2] for i in infos}, reverse=True)
    ref=np.full(arrays[0].shape,np.nan,dtype='float32')
    for priority in priorities:
        members=[k for k,i in enumerate(infos) if i[2] == priority]
        if not members:
            continue
        # The first source is the deterministic anchor for an evidence tier.
        anchor=members[0]
        for k in members[1:]:
            overlap=masks[anchor] & masks[k]
            off=robust_offset(arrays[anchor],arrays[k],overlap)
            arrays[k][masks[k]] += off
            # A constant datum shift is not enough when the two survey
            # surfaces retain a broad, spatially varying ramp. Estimate that
            # residual only from shared cells and at a kilometer-scale blur;
            # this cannot chase individual soundings or canyon channels.
            if overlap.sum() >= 10000:
                residual=arrays[anchor]-arrays[k]
                support=overlap.astype('float32')
                residual=np.where(overlap,residual,0.0).astype('float32')
                smooth_residual=gaussian_filter(residual, sigma=25, mode='nearest')
                smooth_support=gaussian_filter(support, sigma=25, mode='nearest')
                local=np.divide(smooth_residual, smooth_support,
                                out=np.full_like(smooth_residual,np.nan),
                                where=smooth_support > 0.15)
                correction=local
                apply=masks[k] & np.isfinite(correction) & (smooth_support > 0.15)
                arrays[k][apply] += correction[apply]
            offsets[infos[k][0]]=round(off,4)

        # Add this tier to the reference only after its members share a level.
        for k in members:
            take=masks[k] & ~np.isfinite(ref)
            ref[take]=arrays[k][take]

        # Lower tiers are aligned to the harmonized strongest available
        # reference, but never alter the reference itself.
        for k,i in enumerate(infos):
            if i[2] >= priority or offsets[i[0]] != 0.0:
                continue
            overlap=masks[k] & np.isfinite(ref)
            off=robust_offset(ref,arrays[k],overlap)
            arrays[k][masks[k]] += off
            offsets[i[0]]=round(off,4)
    return offsets

def write_tiles(region, data, prov, transform, max_zoom=13):
    out=OUT/region/'tiles'; out.mkdir(parents=True,exist_ok=True)
    h,w=data.shape; left=transform.c; top=transform.f; right=left+w*transform.a; bottom=top+h*transform.e
    for z in range(5,max_zoom+1):
        n=2**z; minx=max(0,int(math.floor((left+math.pi*R)/(2*math.pi*R)*n))); maxx=min(n-1,int(math.floor((right+math.pi*R)/(2*math.pi*R)*n)))
        miny=max(0,int(math.floor((1-top/(math.pi*R))/2*n))); maxy=min(n-1,int(math.floor((1-bottom/(math.pi*R))/2*n)))
        for x in range(minx,maxx+1):
            for y in range(miny,maxy+1):
                b=tile_bounds(z,x,y); win=window_from_bounds(*b, transform=transform)
                # Array-space sampling avoids silently turning out-of-bounds into zero.
                r0=max(0,int(math.floor(win.row_off))); c0=max(0,int(math.floor(win.col_off)))
                r1=min(h,int(math.ceil(win.row_off+win.height))); c1=min(w,int(math.ceil(win.col_off+win.width)))
                if r1<=r0 or c1<=c0: continue
                sub=data[r0:r1,c0:c1]; ps=prov[r0:r1,c0:c1]
                # Reproject into the tile's actual geographic extent. Do not
                # stretch a clipped edge window across the whole tile: that
                # creates zoom-dependent displacement/distortion at footprints.
                src_transform=transform * Affine.translation(c0,r0)
                dst_transform=from_bounds(*b,256,256)
                a=np.full((256,256),np.nan,dtype='float32')
                p=np.zeros((256,256),dtype='uint8')
                reproject(sub,a,src_transform=src_transform,src_crs=CRS.from_epsg(3857),
                          dst_transform=dst_transform,dst_crs=CRS.from_epsg(3857),
                          src_nodata=np.nan,dst_nodata=np.nan,resampling=Resampling.bilinear)
                reproject(ps,p,src_transform=src_transform,src_crs=CRS.from_epsg(3857),
                          dst_transform=dst_transform,dst_crs=CRS.from_epsg(3857),
                          src_nodata=0,dst_nodata=0,resampling=Resampling.nearest)
                valid=np.isfinite(a); safe=np.where(valid,a,-2500.0)
                q=np.clip((safe+2500)/2500,0,1)*5; lo=np.floor(q).astype(int); hi=np.minimum(lo+1,5); f=(q-lo)[...,None]
                rgb=(DEPTH_COLORS[lo]*(1-f)+DEPTH_COLORS[hi]*f).astype('uint8'); rgba=np.concatenate([rgb,(np.isfinite(a).astype('uint8')*255)[...,None]],axis=2)
                d=out/'depth'/str(z)/str(x); d.mkdir(parents=True,exist_ok=True); Image.fromarray(rgba,'RGBA').save(d/f'{y}.png',optimize=True)
                if z <= 10:
                    pc=np.zeros((256,256,4),dtype='uint8')
                    for code,color in PROV_COLORS.items(): pc[p==code,:3]=color; pc[p==code,3]=210
                    d=out/'provenance'/str(z)/str(x); d.mkdir(parents=True,exist_ok=True); Image.fromarray(pc,'RGBA').save(d/f'{y}.png',optimize=True)

def build(region):
    cfg=REGIONS[region]; w,s,e,n=cfg['bbox']; left,bottom=wm(w,s); right,top=wm(e,n); res=30.0
    width=int(math.ceil((right-left)/res)); height=int(math.ceil((top-bottom)/res)); transform=from_bounds(left,bottom,right,top,width,height)
    arrays=[]; masks=[]; infos=[]
    for name,path,priority,confidence,label in cfg['sources']:
        if not path.exists(): print('SKIP missing',path); continue
        a,m=load_source(path,transform,(height,width)); arrays.append(a); masks.append(m); infos.append((name,path,priority,confidence,label)); print(name,'valid',int(m.sum()),flush=True)
    offsets=harmonize(arrays,masks,infos)
    composite=np.full((height,width),np.nan,dtype='float32'); prov=np.zeros((height,width),dtype='uint8'); conf=np.zeros((height,width),dtype='float32'); conflict=np.zeros((height,width),dtype='float32')
    # Highest evidence wins. Equal-priority survey patches are feathered by
    # distance from their footprint edges so a patch boundary cannot become a
    # visible diagonal step. A patch dominates in its interior; only the
    # shared footprint transition is blended.
    order=sorted(range(len(infos)),key=lambda i: infos[i][2],reverse=True)
    handled=set()
    for priority in sorted({i[2] for i in infos}, reverse=True):
        members=[i for i in order if infos[i][2] == priority]
        if len(members) < 2:
            continue
        union=np.zeros(composite.shape,dtype=bool)
        weights=[]
        for i in members:
            union |= masks[i]
            weights.append(distance_transform_edt(masks[i]).astype('float32'))
        denom=np.zeros(composite.shape,dtype='float32')
        lowpasses=[]
        for i,weight in zip(members,weights):
            valid=masks[i]
            denom[valid] += weight[valid]
            # Only the broad terrain level is blended. Fine morphology stays
            # with the locally dominant survey, avoiding doubled ridges and
            # parallel ghost bands where the two surfaces disagree.
            support=valid.astype('float32')
            smooth_support=gaussian_filter(support, sigma=12, mode='nearest')
            smooth_values=gaussian_filter(np.where(valid,arrays[i],0.0).astype('float32'), sigma=12, mode='nearest')
            lowpasses.append(np.divide(smooth_values,smooth_support,
                                       out=np.array(arrays[i],copy=True),
                                       where=smooth_support > 0.15))
        blended=np.zeros(composite.shape,dtype='float32')
        low_denom=np.zeros(composite.shape,dtype='float32')
        winner=np.zeros(composite.shape,dtype='uint8')
        winner_weight=np.full(composite.shape,-1.0,dtype='float32')
        winner_index=np.full(composite.shape,-1,dtype='int16')
        for pos,(i,weight,lowpass) in enumerate(zip(members,weights,lowpasses)):
            valid=masks[i] & np.isfinite(lowpass)
            blended[valid] += weight[valid] * lowpass[valid]
            low_denom[valid] += weight[valid]
            better=masks[i] & (weight > winner_weight)
            winner[better]=np.uint8(infos[i][2])
            winner_weight[better]=weight[better]
            winner_index[better]=pos
        blended=np.divide(blended,low_denom,out=np.full_like(blended,np.nan),where=low_denom>0)
        take=union & (denom > 0) & ~np.isfinite(composite)
        # Restore the dominant source's fine-scale residual after low-pass
        # blending. This is a seam-leveling operation, not a raster average.
        for pos,(i,lowpass) in enumerate(zip(members,lowpasses)):
            detail=arrays[i]-lowpass
            use=take & (winner_index==pos) & np.isfinite(detail)
            blended[use] += detail[use]
        composite[take]=blended[take]
        prov[take]=winner[take]
        conf[take]=max(infos[i][3] for i in members)
        handled.update(members)
    for i in order:
        if i in handled:
            continue
        take=masks[i] & ~np.isfinite(composite); composite[take]=arrays[i][take]; prov[take]=infos[i][2]; conf[take]=infos[i][3]
    for i in range(len(arrays)):
        overlap=np.isfinite(composite)&masks[i]; conflict[overlap]=np.maximum(conflict[overlap],np.abs(composite[overlap]-arrays[i][overlap]))
    target=OUT/region; target.mkdir(parents=True,exist_ok=True)
    profile={'driver':'GTiff','height':height,'width':width,'count':4,'dtype':'float32','crs':'EPSG:3857','transform':transform,'nodata':None,'tiled':True,'compress':'deflate','BIGTIFF':'IF_SAFER'}
    with rasterio.open(target/'composite.tif','w',**profile) as dst:
        dst.write(composite,1); dst.write(prov.astype('float32'),2); dst.write(conf,3); dst.write(conflict,4)
        dst.set_band_description(1,'elevation_harmonized_m'); dst.set_band_description(2,'source_priority'); dst.set_band_description(3,'confidence'); dst.set_band_description(4,'max_overlap_conflict_m')
    meta={'region':region,'bbox_wsen':cfg['bbox'],'resolution_m':res,'shape':[height,width],'offsets_m':offsets,'sources':[{'name':i[0],'priority':i[2],'confidence':i[3],'label':i[4],'path':str(i[1])} for i in infos]}
    (target/'metadata.json').write_text(json.dumps(meta,indent=2)); write_tiles(region,composite,prov,transform)
    print(json.dumps({'region':region,'shape':[height,width],'valid':int(np.isfinite(composite).sum()),'sources':meta['sources'],'offsets':offsets},indent=2))

if __name__=='__main__':
    for r in sys.argv[1:] or REGIONS: build(r)
