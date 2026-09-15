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
    html.push(`<a class="card" href="/dashboard/trip-planner/briefing-viewer?date=${date}&region=usec_md&from=planner"><div class="card-map"><span>JSON GRID</span><b>Wind · Waves · Swell · SST · Currents</b></div><div class="label"><span>Day ${i+1} · ${label(date)}</span><small>Open full map →</small></div></a>`);
  }
  cards.innerHTML=html.join('');
})();
