// FishEdge — Upcoming tournaments
// Source of truth for tournament calendar. Edit this file to add/remove events.
// Rendered into the landing page dynamically.

const TOURNAMENTS = [
  {
    name: "White Marlin Open",
    dates: "August 3–8, 2026",
    location: "Ocean City, Maryland",
    region: "usec_md",
    featured: true,
    url: "https://whitemarlinopen.com/"
  },
  {
    name: "MidAtlantic",
    dates: "August 16–21, 2026",
    location: "Cape May, New Jersey",
    region: "usec_md",
    featured: true,
    url: "https://www.midatlanticfishing.com/"
  }
];

function renderTournaments() {
  const list = document.getElementById("tournament-list");
  if (!list) return;

  const today = new Date();
  const upcoming = TOURNAMENTS.filter(t => {
    // Parse last date from "August 3–8, 2026"
    const last = t.dates.match(/(\w+) (\d+)[–-](\d+), (\d+)/);
    if (!last) return true;
    const [, month, , endDay, year] = last;
    const monthIdx = new Date(`${month} 1, ${year}`).getMonth();
    const endDate = new Date(parseInt(year), monthIdx, parseInt(endDay));
    return endDate >= today;
  });

  if (upcoming.length === 0) {
    list.innerHTML = '<p style="color:var(--fg-muted)">No upcoming tournaments listed. Check back soon.</p>';
    return;
  }

  list.innerHTML = upcoming.map(t => `
    <div class="tournament">
      <h3>${t.name}</h3>
      <p class="meta">${t.dates} · ${t.location}</p>
      ${t.featured ? '<span class="featured">FEATURED</span>' : ''}
      ${t.url ? `<p style="margin-top:10px"><a href="${t.url}" target="_blank" rel="noopener">Official site ↗</a></p>` : ''}
    </div>
  `).join("");
}

document.addEventListener("DOMContentLoaded", renderTournaments);