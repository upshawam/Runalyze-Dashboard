// docs/app.js - reordered columns: Distance, Achieved, Icon, Prognosis, Optimum, Marathon Shape, Weekly mileage, Long Run
// Weekly column gets class "weekly-col"; Prognosis/Optimum get "hidden-mobile" so CSS controls their sizing/hiding.

// Changes: VO2 chart now shows a rolling last-2-month window (UTC).
// Additionally the chart top is set a few percent above the highest plotted point so the top marker isn't flush with the edge.

const USERS = ['kristin','aaron'];
const DATA_FILES = ['vo2','marathon','prognosis','marathon_requirements'];

const nowTag = () => '?t=' + Date.now();
const el = id => document.getElementById(id);
const fetchJSON = async p => {
  const r = await fetch(p + nowTag());
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};
const isoToKey = iso => { const d=new Date(iso); if(isNaN(d)) return null; return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; };

// generate an array of YYYY-MM-DD strings covering the range [today - months, today] in UTC inclusive
const lastDatesForMonths = (months) => {
  const out = [];
  const now = new Date();
  // end = today's UTC date (time zeroed to UTC date)
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // start = end shifted back by `months` UTC months
  const start = new Date(end.getTime());
  start.setUTCMonth(start.getUTCMonth() - months);
  // iterate from start to end inclusive, advancing by 1 day (UTC)
  for(let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)){
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${yyyy}-${mm}-${dd}`);
    // Note: setUTCDate mutates d in place; loop will advance correctly
  }
  return out;
};

const vo2Map = v => { if(!v) return {}; if(v.trend && typeof v.trend==='object') return v.trend; if(Array.isArray(v.values)) return v.values.reduce((m,it)=>{ const k=isoToKey(it[0]); if(k) m[k]=it[1]; return m; },{}); return {}; };
const findLatest = m => { const keys=Object.keys(m).sort(); for(let i=keys.length-1;i>=0;i--){ const v=m[keys[i]]; if(v!=null && !isNaN(Number(v))) return {date:keys[i], value:Number(v)}; } return null; };
const nbspMi = s => (s||'').toString().replace(/(\d[\d,\.]*)\s*mi/gi,'$1\u00a0mi');
const fmtTs = ts => { if(!ts) return ''; const d=new Date(ts); if(isNaN(d)) return ts; return d.toISOString().slice(0,19).replace('T',' '); };
const isMarathonGoal = r => { if(!r) return false; if(typeof r.required_pct==='number' && r.required_pct===100) return true; if(typeof r.requiredPct==='number' && r.requiredPct===100) return true; if(Array.isArray(r) && r.length===0) return false; return false; };

// format an ISO timestamp into America/Chicago (Central Time) in 24-hour form and try to include short zone (CST/CDT)
// falls back to the raw ISO string on error
function formatToCST(iso) {
  if(!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short'
    });
    return fmt.format(d);
  } catch (e) {
    return iso;
  }
}

// human-friendly elapsed time (returns e.g. "3 minutes ago", "2 hours ago", "1 day 3 hours ago")
function elapsedSince(iso) {
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return '';
  let diff = Math.floor((Date.now() - d.getTime()) / 1000); // seconds
  if (diff < 0) diff = 0;
  const days = Math.floor(diff / 86400);
  diff -= days * 86400;
  const hours = Math.floor(diff / 3600);
  diff -= hours * 3600;
  const minutes = Math.floor(diff / 60);
  const seconds = diff - minutes * 60;

  if (days > 0) {
    return days === 1 ? `1 day ${hours}h ago` : `${days} days ${hours}h ago`;
  }
  if (hours > 0) {
    return hours === 1 ? `1 hour ${minutes}m ago` : `${hours} hours ${minutes}m ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? `1 minute ago` : `${minutes} minutes ago`;
  }
  return `${seconds} second${seconds===1 ? '' : 's'} ago`;
}

/* draw VO2 */
let vo2Chart = null;
function drawVo2(ctx, labels, datasets){
  const data = { labels, datasets };

  // compute highest numeric value across all datasets (ignore nulls)
  let maxVal = null;
  datasets.forEach(ds => {
    if (!Array.isArray(ds.data)) return;
    ds.data.forEach(v => {
      if (v != null && !isNaN(Number(v))) {
        const num = Number(v);
        if (maxVal === null || num > maxVal) maxVal = num;
      }
    });
  });

  // add a small headroom above the max so points don't sit at the very top.
  // use ~6% headroom and round up to 2 decimals for a tidy axis tick.
  let suggestedTop = undefined;
  if (maxVal !== null) {
    suggestedTop = Math.ceil((maxVal * 1.06) * 100) / 100;
  }

  const opts = {
    responsive: true,
    plugins: { legend: { display: true } },
    scales: {
      x: { type: 'category' },
      y: Object.assign({ beginAtZero: false }, (suggestedTop ? { suggestedMax: suggestedTop } : {}))
    },
    maintainAspectRatio: false
  };

  if(vo2Chart){
    vo2Chart.data = data;
    vo2Chart.options = opts;
    vo2Chart.update();
    return;
  }
  vo2Chart = new Chart(ctx, { type: 'line', data, options: opts });
}

async function loadAndRender(){
  try{
    if(el('errors')) el('errors').textContent = '';
    // fetch all data
    const fetches = [];
    USERS.forEach(u => DATA_FILES.forEach(f => fetches.push(fetchJSON(`data/${u}_${f}.json`).catch(()=>null))));
    const results = await Promise.all(fetches);

    // assemble per-user
    const users = {};
    for(let i=0;i<USERS.length;i++){
      const base = i*DATA_FILES.length;
      users[USERS[i]] = { vo2: results[base], marathon: results[base+1], prognosis: results[base+2], requirements: results[base+3] };
    }

    // VO2 chart - rolling last 2 months
    const lastTwoMonths = lastDatesForMonths(2);
    const datasets = USERS.map((u,idx) => {
      const map = vo2Map(users[u].vo2);
      // only keep values inside the two-month window; map to null when missing
      const data = lastTwoMonths.map(d => (map[d]==null)? null : Number(map[d]));
      const color = idx===0 ? 'rgba(75,192,192,1)' : 'rgba(255,99,132,1)';
      return { label: u[0].toUpperCase()+u.slice(1)+' VO₂', data, borderColor: color, backgroundColor: color.replace('1)','0.12)'), tension:0.25, pointRadius:3, spanGaps:true };
    });
    drawVo2(el('vo2Chart').getContext('2d'), lastTwoMonths, datasets);

    // build tables
    const tablesEl = el('tables');
    tablesEl.innerHTML = '';
    USERS.forEach(u => {
      const d = users[u];
      const marMap = (d.marathon && typeof d.marathon==='object') ? d.marathon : {};
      const latest = findLatest(marMap);
      const currentPct = latest ? latest.value * 100 : null;

      // last-updated pick
      const metaCandidates = [d.marathon,d.requirements,d.prognosis];
      let lastUpdated = null;
      for(const c of metaCandidates){
        if(c && typeof c === 'object'){
          if(c._meta && c._meta.last_updated){ lastUpdated = c._meta.last_updated; break; }
          if(c.meta && c.meta.last_updated){ lastUpdated = c.meta.last_updated; break; }
        }
      }

      const header = `<div class="user-block user-${u}"><div><div class="user-title">${u[0].toUpperCase()+u.slice(1)}</div><div class="small">Latest marathon shape: ${currentPct!==null ? (Math.round(currentPct*100)/100) : '-'}</div></div></div>`;

      // rows: parsed or fallback
      const req = d.requirements;
      let rows = [];
      if(req && Array.isArray(req.entries) && req.entries.length){
        rows = req.entries.map(r => ({
          // NEW ORDER: Distance, Achieved, Icon, Prognosis, Optimum, Marathon Shape, Weekly, LongRun
          distance: nbspMi(r.distance_label || (r.distance_mi ? `${r.distance_mi} mi` : '-')),
          achieved: (r.achieved_pct!=null) ? `${r.achieved_pct}%` : '-',
          icon: r.achieved_ok ? '<i class="fa-solid fa-check plus" aria-hidden="true"></i>' : '<i class="fa-solid fa-xmark minus" aria-hidden="true"></i>',
          prog: r.prognosis_time || '-',
          opt: (r.optimum_time && (r.achieved_pct==null || r.achieved_pct<100)) ? r.optimum_time : '-',
          shape: (r.required_pct!=null) ? `${r.required_pct}%` : '-',
          weekly: nbspMi(r.weekly || '-'),
          longRun: nbspMi(r.long_run || '-'),
          goal: isMarathonGoal(r)
        }));
      } else {
        const FALLBACK = [
          {mi:3.1,label:'3,1 mi',p:7,weekly:'ca. 5 mi',long:'-'},
          {mi:6.2,label:'6,2 mi',p:17,weekly:'ca. 11 mi',long:'-'},
          {mi:10,label:'10,0 mi',p:31,weekly:'ca. 19 mi',long:'-'},
          {mi:13.1,label:'13,1 mi',p:43,weekly:'ca. 25 mi',long:'ca. 11 mi'},
          {mi:26.2,label:'26,2 mi',p:100,weekly:'ca. 44 mi',long:'ca. 18 mi'},
          {mi:31.1,label:'31,1 mi',p:123,weekly:'ca. 47 mi',long:'ca. 20 mi'},
          {mi:62.1,label:'62,1 mi',p:288,weekly:'ca. 64 mi',long:'ca. 31 mi'},
          {mi:100,label:'100,0 mi',p:518,weekly:'ca. 114 mi',long:'ca. 39 mi'}
        ];
        rows = FALLBACK.map(r=>{
          const achieved = currentPct!==null && r.p ? `${Math.round((currentPct / r.p)*100)}%` : '-';
          const ok = achieved !== '-' && parseInt(achieved) >= 100;
          return {
            distance: nbspMi(r.label),
            achieved,
            icon: ok ? '<i class="fa-solid fa-check plus" aria-hidden="true"></i>' : '<i class="fa-solid fa-xmark minus" aria-hidden="true"></i>',
            prog: '-', opt: '-',
            shape: `${r.p}%`,
            weekly: r.weekly,
            longRun: r.long,
            goal: (r.p === 100)
          };
        });
        // try fill prognosis from d.prognosis.entries
        if(d.prognosis && Array.isArray(d.prognosis.entries)){
          rows = rows.map(row=>{
            const match = d.prognosis.entries.find(e=>{
              if(typeof e.distance_mi === 'number') return Math.abs(e.distance_mi - parseFloat(row.distance)) < 0.5;
              const lbl = (e.distance_label||'').toString();
              return lbl && lbl.includes(row.distance.split('\u00a0')[0]);
            });
            if(match && match.time) row.prog = match.time;
            return row;
          });
        }
      }

      // render rows in NEW ORDER
      const rowsHtml = rows.map(r => `
        <tr class="r${r.goal ? ' marathon-goal top-separated bottom-separated' : ''}">
          <td class="nowrap-mi">${r.distance}</td>
          <td class="center">${r.achieved}</td>
          <td class="center icon-col" aria-hidden="true">${r.icon}</td>

          <td class="left-separated hidden-mobile">${r.prog}</td>
          <td class="hidden-mobile">${r.opt}</td>

          <td>${r.shape}</td>
          <td class="weekly-col">${r.weekly}</td>
          <td>${r.longRun}</td>
        </tr>`).join('');

      const tableHtml = `
        ${header}
        <table class="rz-table" aria-label="${u} marathon requirements">
          <thead>
            <tr class="group-row">
              <th></th><th></th><th></th><th></th><th></th>
              <th colspan="3">Required</th>
            </tr>
            <tr class="label-row">
              <th>Distance</th>
              <th>Achieved</th>
              <th></th>
              <th class="hidden-mobile">Prognosis</th>
              <th class="hidden-mobile">Optimum</th>
              <th>Marathon Shape</th>
              <th class="weekly-col">Weekly mileage</th>
              <th>Long Run</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;

      const wrapper = document.createElement('div');
      wrapper.className = `user-table user-${u}`;
      wrapper.innerHTML = tableHtml;

      // Append a "Last updated" string in Central Time (America/Chicago) if we found a _meta timestamp.
      if(lastUpdated){
        const userBlock = wrapper.querySelector('.user-block');
        if(userBlock){
          const metaDiv = document.createElement('div');
          metaDiv.className = 'user-meta';
          metaDiv.textContent = `Last updated: ${formatToCST(lastUpdated)} — ${elapsedSince(lastUpdated)}`;
          userBlock.appendChild(metaDiv);
        }
      }

      tablesEl.appendChild(wrapper);
    });

  }catch(err){
    if(el('errors')) el('errors').textContent = err.message || String(err);
    console.error(err);
  }
}

window.addEventListener('load', loadAndRender);
