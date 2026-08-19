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
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds as window_from_bounds
from PIL import Image

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
    """Estimate robust offsets against the strongest available survey source."""
    ref=np.full(arrays[0].shape,np.nan,dtype='float32')
    for a,m,i in zip(arrays,masks,infos):
        if i[2] == 4: ref[m & ~np.isfinite(ref)] = a[m & ~np.isfinite(ref)]
    offsets={}
    for a,m,i in zip(arrays,masks,infos):
        if i[2] == 4: offsets[i[0]]=0.0; continue
        overlap=m & np.isfinite(ref)
        d=ref[overlap]-a[overlap]
        d=d[np.isfinite(d) & (np.abs(d)<200)]
        off=float(np.median(d)) if d.size >= 100 else 0.0
        offsets[i[0]]=round(off,4)
        a[m] += off
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
                yy=np.linspace(0,sub.shape[0]-1,256).astype(int); xx=np.linspace(0,sub.shape[1]-1,256).astype(int)
                a=sub[np.ix_(yy,xx)]; p=ps[np.ix_(yy,xx)]
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
    # Highest evidence wins. For equal evidence, finer source resolution is preferred by order in config.
    order=sorted(range(len(infos)),key=lambda i: infos[i][2],reverse=True)
    for i in order:
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
