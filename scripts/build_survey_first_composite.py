#!/usr/bin/env python3
"""Build a provenance-preserving, survey-first USEC-MD bathymetry composite.

The output is numeric GeoTIFF data plus cached visualization/provenance tiles.
Priority is explicit: Okeanos survey > NOS/BAG > BlueTopo > NCEI mosaic.
"""
import json, math, sys
from pathlib import Path
import numpy as np
import cv2
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds, Affine
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds as window_from_bounds
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = Path('/home/gzheng/.openclaw/workspace-cto/bathy-research')
USEC_MD = Path('/home/gzheng/.openclaw/workspace-cto/data/ncei_extract/usec_md')
OUT = ROOT / 'dashboard/data/bathy/survey_first'
R = 6378137.0
DEPTH_COLORS = np.array([[3,1,7],[22,10,70],[49,32,154],[21,94,208],[8,167,211],[24,208,203]], dtype=np.float32)
PROV_COLORS = {1:(31,80,160), 2:(15,175,190), 3:(240,150,40), 4:(240,225,70)}

REGIONS = {
  'usec_md': {
    # USEC-MD working area: Virginia/North Carolina shelf through the New
    # York Bight and Hudson Canyon. This is an area, not a point target.
    'bbox': (-76.50, 35.50, -71.50, 40.50),
    'resolution_m': 90.0,
    'sources': [
      # Survey-first sources. The regional transit and west products are
      # retained alongside the individual canyon surveys; precedence and
      # crossover adjustment decide where they overlap.
      ('ex1302_01', RESEARCH/'canyon_products/ex1302_01_raw.tif', 4, .95, 'Okeanos EX1302 survey patch 01'),
      ('ex1302_02', RESEARCH/'canyon_products/ex1302_02_raw.tif', 4, .95, 'Okeanos EX1302 survey patch 02'),
      ('ex1903l2_north', RESEARCH/'canyon_products/ex1903_north_raw.tif', 4, .95, 'Okeanos EX1903L2 North survey'),
      ('ex1404l2', RESEARCH/'okeanos/ex1404l2_25m.tif', 4, .95, 'Okeanos EX1404L2 survey'),
      ('ex1303_hudson', RESEARCH/'canyon_products/new_wm/ex1303_hudson_30m_wm.tif', 4, .95, 'Okeanos EX1303 Hudson Canyon'),
      ('ex1404l3_hudson', RESEARCH/'canyon_products/new_wm/ex1404l3_hudson_15m_wm.tif', 4, .95, 'Okeanos EX1404L3 Hudson Canyon'),
      ('ex1404l3_west', RESEARCH/'canyon_products/new_wm/ex1404l3_west_50m_wm.tif', 4, .95, 'Okeanos EX1404L3 western USEC survey'),
      ('ex2203_transit3', RESEARCH/'canyon_products/new_wm/ex2203_t3_25m_wm.tif', 4, .95, 'Okeanos EX2203 TRANSIT3 regional survey'),
      ('usgs_reson7160_washington_accomac', RESEARCH/'usgs_reson7160/wm/washington_accomac_25m_wm.tif', 4, .90, 'USGS Reson 7160 Washington-Accomac survey'),
      ('usgs_reson7160_norfolk', RESEARCH/'usgs_reson7160/wm/norfolk_25m_wm.tif', 4, .90, 'USGS Reson 7160 Norfolk Canyon survey'),
      ('usgs_reson7160_keller', RESEARCH/'usgs_reson7160/wm/keller_25m_wm.tif', 4, .90, 'USGS Reson 7160 Keller Canyon survey'),
      # Fallback surfaces, ordered by evidence tier.
      ('bag', USEC_MD/'nos_bag_mosaic.vrt', 3, .70, 'NOS BAG survey mosaic'),
      ('bluetopo', RESEARCH/'bluetopo_elevation_wm.tif', 2, .48, 'NOAA BlueTopo compilation'),
      ('multibeam', USEC_MD/'multibeam_mosaic_combined/color_work/multibeam.vrt', 1, .32, 'NCEI multibeam mosaic'),
      ('dem_global', USEC_MD/'dem_global_mosaic.vrt', 0, .18, 'NOAA global DEM low-priority background'),
    ]
  },
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

def correct_scan_seams(arr, valid):
    """Correct only long, sharp scan-edge steps; preserve morphology.

    A real canyon wall is not treated as an artifact merely because it is
    steep. The gate requires a long straight edge in the raster plus a stable
    cross-edge level jump. The correction is confined to a narrow ramp around
    that edge, leaving the terrain on either side unchanged.
    """
    h,w=arr.shape; scale=max(1,int(round(max(h,w)/1200)))
    sh=max(1,h//scale); sw=max(1,w//scale)
    small=np.full((sh,sw),0.0,dtype='float32')
    small_valid=cv2.resize(valid.astype('uint8'),(sw,sh),interpolation=cv2.INTER_AREA)>0.5
    small_values=cv2.resize(np.where(valid,arr,0.0).astype('float32'),(sw,sh),interpolation=cv2.INTER_AREA)
    small[small_valid]=small_values[small_valid]
    finite=small[small_valid]
    if finite.size < 1000: return arr,0
    lo,hi=np.percentile(finite,[2,98])
    image=np.clip((small-lo)/(hi-lo+1e-6)*255,0,255).astype('uint8')
    image[~small_valid]=0
    edges=cv2.Canny(image,30,90)
    lines=cv2.HoughLinesP(edges,1,np.pi/180,threshold=50,
                          minLineLength=max(150,min(sh,sw)//6),maxLineGap=25)
    if lines is None: return arr,0
    out=np.array(arr,copy=True); corrected=0
    for q in lines[:,0]:
        x1,y1,x2,y2=(int(v*scale) for v in q)
        length=float(np.hypot(x2-x1,y2-y1))
        if length < 150*scale: continue
        tx=(x2-x1)/length; ty=(y2-y1)/length
        nx=-ty; ny=tx
        minus=[]; plus=[]
        for t in np.linspace(.08,.92,80):
            x=x1+t*(x2-x1); y=y1+t*(y2-y1)
            for d in (12,18,24):
                for side,bag in ((-1,minus),(1,plus)):
                    xx=int(round(x+side*nx*d)); yy=int(round(y+side*ny*d))
                    if 0<=xx<w and 0<=yy<h and valid[yy,xx] and np.isfinite(arr[yy,xx]): bag.append(float(arr[yy,xx]))
        if len(minus)<100 or len(plus)<100: continue
        step=float(np.median(minus)-np.median(plus))
        if abs(step)<8.0 or abs(step)>120.0: continue
        width=30.0
        xlo=max(0,int(min(x1,x2)-width)); xhi=min(w,int(max(x1,x2)+width+1))
        ylo=max(0,int(min(y1,y2)-width)); yhi=min(h,int(max(y1,y2)+width+1))
        X,Y=np.meshgrid(np.arange(xlo,xhi,dtype='float32'),np.arange(ylo,yhi,dtype='float32'))
        signed=(X-x1)*ny-(Y-y1)*nx
        along=(X-x1)*tx+(Y-y1)*ty
        band=(np.abs(signed)<=width)&(along>=-width)&(along<=length+width)
        alpha=np.clip(1-np.abs(signed)/width,0,1)
        # Bring the plus side to the minus-side level, tapering to zero
        # within the seam corridor rather than altering either survey interior.
        corr=np.where(signed>=0,step*alpha,0.0)
        sub=out[ylo:yhi,xlo:xhi]; vm=valid[ylo:yhi,xlo:xhi]&band
        sub[vm]+=corr[vm].astype('float32'); out[ylo:yhi,xlo:xhi]=sub
        corrected+=1
    return out,corrected

def harmonize(arrays, masks, infos):
    """Solve a crossover/block vertical adjustment before precedence selection.

    Each overlapping source pair supplies an equation for the relative level
    between the two surfaces.  Solving the connected overlap graph together
    prevents the result from depending on whichever raster happened to be
    listed first.  BlueTopo is used as the anchor when it has valid overlap;
    otherwise the first connected survey is the local datum anchor.  A smooth
    residual correction is then applied only where crossover support exists.
    """

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

    # Regional grids can contain tens of millions of cells. Crossover
    # statistics do not need every cell: use a deterministic capped sample
    # for pairwise robust offsets, while retaining the full masks for the
    # final precedence composite.
    large_grid = arrays[0].size > 20_000_000
    edges=[]
    for i in range(len(infos)):
        for j in range(i+1,len(infos)):
            overlap=masks[i] & masks[j]
            if int(overlap.sum()) < 10000: continue
            idx=np.flatnonzero(overlap)
            if idx.size > 500_000:
                idx=idx[::int(np.ceil(idx.size/500_000))]
            ai=arrays[i].ravel()[idx]; aj=arrays[j].ravel()[idx]
            d=ai-aj
            d=d[np.isfinite(d) & (np.abs(d)<200)]
            if d.size < 10000: continue
            lo,hi=np.percentile(d,[5,95]); trimmed=d[(d>=lo)&(d<=hi)]
            if trimmed.size < 1000: continue
            med=float(np.median(trimmed)); spread=float(np.std(trimmed))
            weight=np.sqrt(min(float(trimmed.size),500000.0)/500000.0) / max(spread,1.0)
            edges.append((i,j,med,weight,overlap))

    if not edges:
        return {i[0]:0.0 for i in infos}
    anchor=next((i for i,x in enumerate(infos) if x[0]=='bluetopo' and any(e[0]==i or e[1]==i for e in edges)), edges[0][0])
    A=[]; y=[]
    for i,j,d,weight,_ in edges:
        row=np.zeros(len(infos),dtype='float64'); row[i]=-weight; row[j]=weight
        A.append(row); y.append(weight*d)
    row=np.zeros(len(infos),dtype='float64'); row[anchor]=100.0; A.append(row); y.append(0.0)
    solution=np.linalg.lstsq(np.asarray(A),np.asarray(y),rcond=None)[0]
    offsets={infos[i][0]:round(float(solution[i]),4) for i in range(len(infos))}
    for i in range(len(infos)):
        arrays[i][masks[i]] += solution[i]

    # Apply only a low-frequency crossover residual where multiple sources
    # actually support the correction. This captures a broad survey ramp or
    # block bias without following individual canyon morphology.
    if large_grid:
        # At regional scale the source-wide block adjustment is the reliable
        # estimate. A full-resolution Gaussian residual would be both
        # needlessly expensive and too easy to mistake for morphology.
        return offsets
    for i in range(len(infos)):
        residual_sum=np.zeros(arrays[i].shape,dtype='float32')
        support_sum=np.zeros(arrays[i].shape,dtype='float32')
        for j in range(len(infos)):
            if i==j: continue
            overlap=masks[i]&masks[j]
            if int(overlap.sum()) < 10000: continue
            d=np.where(overlap,arrays[j]-arrays[i],0.0).astype('float32')
            support=overlap.astype('float32')
            residual_sum += gaussian_filter(d,sigma=25,mode='nearest')
            support_sum += gaussian_filter(support,sigma=25,mode='nearest')
        local=np.divide(residual_sum,support_sum,out=np.full_like(residual_sum,np.nan),where=support_sum>0.15)
        apply=masks[i]&np.isfinite(local)&(support_sum>0.15)
        arrays[i][apply] += local[apply]
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
    cfg=REGIONS[region]; w,s,e,n=cfg['bbox']; left,bottom=wm(w,s); right,top=wm(e,n); res=float(cfg.get('resolution_m',30.0))
    width=int(math.ceil((right-left)/res)); height=int(math.ceil((top-bottom)/res)); transform=from_bounds(left,bottom,right,top,width,height)
    arrays=[]; masks=[]; raw_masks=[]; infos=[]
    for name,path,priority,confidence,label in cfg['sources']:
        if not path.exists(): print('SKIP missing',path); continue
        a,m=load_source(path,transform,(height,width))
        if priority == 4:
            a,seam_count=correct_scan_seams(a,m)
            print(name,'valid',int(m.sum()),'scan_seams_corrected',seam_count,flush=True)
        arrays.append(a); masks.append(m); raw_masks.append(m.copy()); infos.append((name,path,priority,confidence,label)); print(name,'valid',int(m.sum()),flush=True)
    offsets=harmonize(arrays,masks,infos)
    composite=np.full((height,width),np.nan,dtype='float32'); prov=np.zeros((height,width),dtype='uint8'); conf=np.zeros((height,width),dtype='float32'); conflict=np.zeros((height,width),dtype='float32'); owner=np.full((height,width),-1,dtype='int16')
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
        for pos,i in enumerate(members):
            owner[take & (winner_index == pos)] = i
        handled.update(members)
    for i in order:
        if i in handled:
            continue
        take=masks[i] & ~np.isfinite(composite); composite[take]=arrays[i][take]; prov[take]=infos[i][2]; conf[take]=infos[i][3]; owner[take]=i

    # Remove edge steps for every source, not just the two Okeanos surveys.
    # Use seam-line leveling rather than pixel blending: estimate the local
    # cross-edge vertical bias, subtract that bias from the source fringe,
    # and ramp the correction to zero over 50 m.  This is the standard
    # survey-mosaic treatment for a strip/swath level step and preserves the
    # source's slopes, ridges, fans, and channels.
    def normalized_blur(values, valid, sigma=25.0):
        support=valid.astype('float32')
        smooth_support=gaussian_filter(support, sigma=sigma, mode='nearest')
        smooth_values=gaussian_filter(np.where(valid,values,0.0).astype('float32'), sigma=sigma, mode='nearest')
        return np.divide(smooth_values, smooth_support,
                         out=np.full_like(smooth_values,np.nan), where=smooth_support > 0.15)

    for i,info in enumerate(infos):
        raw=raw_masks[i]
        dist=distance_transform_edt(raw)
        alternate=np.full(composite.shape,np.nan,dtype='float32')
        for j in sorted([j for j in order if j != i],key=lambda k: infos[k][2],reverse=True):
            take=masks[j] & np.isfinite(arrays[j]) & ~np.isfinite(alternate)
            alternate[take]=arrays[j][take]
        feather_cells=50.0 / res
        near=raw & (owner == i) & (dist <= feather_cells) & np.isfinite(alternate)
        if not near.any(): continue
        # Estimate a smoothly varying local level difference from a slightly
        # wider diagnostic ring, but modify only the 50 m source fringe.
        # Gaussian normalization avoids treating nodata as zero.
        sample=raw & (owner == i) & (dist <= 8.0) & np.isfinite(alternate)
        delta=np.where(sample,arrays[i]-alternate,0.0).astype('float32')
        local_bias=normalized_blur(delta,sample,sigma=2.0)
        # At the first valid source cell apply the full level correction; at
        # the inner edge of the 50 m corridor it is exactly zero.  No source
        # morphology is blended or filtered.
        u=np.clip((dist-1.0)/(feather_cells-1.0),0.0,1.0)
        fade=1.0-(u*u*(3.0-2.0*u))
        valid=near & np.isfinite(local_bias)
        corrected=composite-np.where(np.isfinite(local_bias),local_bias,0.0)*fade
        composite[valid]=corrected[valid]
        print(info[0],'edge_level_corrected_cells',int(valid.sum()),'transition_m',50,flush=True)
    for i in range(len(arrays)):
        overlap=np.isfinite(composite)&masks[i]; conflict[overlap]=np.maximum(conflict[overlap],np.abs(composite[overlap]-arrays[i][overlap]))
    target=OUT/region; target.mkdir(parents=True,exist_ok=True)
    profile={'driver':'GTiff','height':height,'width':width,'count':4,'dtype':'float32','crs':'EPSG:3857','transform':transform,'nodata':None,'tiled':True,'compress':'deflate','BIGTIFF':'IF_SAFER'}
    with rasterio.open(target/'composite.tif','w',**profile) as dst:
        dst.write(composite,1); dst.write(prov.astype('float32'),2); dst.write(conf,3); dst.write(conflict,4)
        dst.set_band_description(1,'elevation_harmonized_m'); dst.set_band_description(2,'source_priority'); dst.set_band_description(3,'confidence'); dst.set_band_description(4,'max_overlap_conflict_m')
    meta={'region':region,'bbox_wsen':cfg['bbox'],'resolution_m':res,'shape':[height,width],'offsets_m':offsets,'vertical_adjustment_method':'pairwise robust crossover graph with low-frequency overlap residuals','vertical_anchor':'BlueTopo when valid overlap exists; otherwise first connected survey','edge_transition_m':50,'edge_blend_cells':50.0/res,'sources':[{'name':i[0],'priority':i[2],'confidence':i[3],'label':i[4],'path':str(i[1])} for i in infos]}
    (target/'metadata.json').write_text(json.dumps(meta,indent=2)); write_tiles(region,composite,prov,transform)
    print(json.dumps({'region':region,'shape':[height,width],'valid':int(np.isfinite(composite).sum()),'sources':meta['sources'],'offsets':offsets},indent=2))

if __name__=='__main__':
    for r in sys.argv[1:] or REGIONS: build(r)
