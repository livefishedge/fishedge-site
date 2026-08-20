(function(){
  'use strict';
  const root='https://data.fishedge.live/usec_md/briefing/';
  const cards=document.getElementById('cards');
  const now=new Date();
  const iso=d=>d.toISOString().slice(0,10);
  const label=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  document.getElementById('stamp').textContent='Run: '+now.toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'});
  const html=[];
  for(let i=0;i<7;i++){
    const d=new Date(now.getTime()+i*86400000), date=iso(d);
    html.push(`<a class="card" href="/planner/viewer.html?date=${date}&region=usec_md"><img loading="lazy" src="${root}raster_${date}.png" alt="Open-Meteo forecast for ${date}" onerror="this.src='${root}cmems_raster_${date}.png'"><div class="label"><span>Day ${i+1} · ${label(date)}</span><small>Open viewer →</small></div></a>`);
  }
  cards.innerHTML=html.join('');
})();
