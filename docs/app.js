// app.js - Dashboard rendering (VO2, Marathon % to 100, Prognosis table + projection)
// Assumes Chart.js is loaded on the page (chart.umd.min.js)

const errorsEl = document.getElementById('errors');
const statusEl = document.getElementById('status'); // hidden visually
const marPctEl = document.getElementById('marathonPct');
const progTbody = document.querySelector('#prognosisTable tbody');
const marProgressBar = document.getElementById('marProgressBar');
const marOverflow = document.getElementById('marOverflow');
const marProjectionEl = document.getElementById('marProjection');

function showError(msg){ errorsEl.textContent = msg || ''; if(msg) console.error(msg); }
function showStatus(msg){ if(statusEl) statusEl.textContent = msg || ''; }

async function fetchJSON(path){
  try{
    const r = await fetch(path + '?t=' + Date.now());
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  }catch(e){
    throw new Error(`Fetch ${path} failed: ${e.message}`);
  }
}

function isoToDateKey(iso){
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function getLastNDates(n){
  const out = [];
  const now = new Date();
  for(let i = n-1; i >= 0; i--){
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
    out.push(key);
  }
  return out;
}

function vo2ToMap(vo2json){
  if(!vo2json) return {};
  if(vo2json.trend && typeof vo2json.trend === 'object') return vo2json.trend;
  if(Array.isArray(vo2json.values)){
    const m = {};
    for(const it of vo2json.values){
      if(!it || !it[0]) continue;
      const k = isoToDateKey(it[0]);
      if(k) m[k] = it[1];
    }
    return m;
  }
  if(typeof vo2json === 'object') return vo2json;
  return {};
}
function marathonToMap(mjson){
  if(!mjson) return {};
  if(typeof mjson === 'object') return mjson;
  return {};
}
function buildSeries(map, labels){
  return labels.map(d => {
    const v = map[d];
    return (v === null || v === undefined) ? null : Number(v);
  });
}
function findLatestValue(map){
  const keys = Object.keys(map).sort();
  for(let i = keys.length-1; i >=0; i--){
    const k = keys[i];
    const v = map[k];
    if(v !== null && v !== undefined && !Number.isNaN(Number(v))) return { date: k, value: Number(v) };
  }
  return null;
}

// Chart helpers
function createOrUpdateChart(ctx, data, options, existing){
  if(existing){
    existing.data = data;
    existing.options = options || existing.options;
    existing.resize();
    existing.update();
    return existing;
  }
  return new Chart(ctx, { type:'line', data, options });
}

// percent helpers & projection (regression)
function toPercentSeries(arr){
  return arr.map(v => (v === null || v === undefined) ? null : Number(v * 100));
}

function buildPointsFromSeries(labels, percSeries) {
  return labels.map((lab, i) => {
    const val = percSeries[i];
    if (val === null || val === undefined) return null;
    const [y,m,d] = lab.split('-').map(Number);
    const date = new Date(Date.UTC(y, m-1, d));
    return { x: date, y: val };
  }).filter(Boolean);
}

// linear regression in percent/day (require at least 3 points)
function linearRegressionDays(points) {
  if (!points || points.length < 3) return null;
  const pts = points.map(p => ({ x: p.x.getTime(), y: p.y }));
  const first = pts[0].x;
  const xs = pts.map(p => (p.x - first) / (1000 * 60 * 60 * 24)); // days
  const ys = pts.map(p => p.y);
  const n = xs.length;
  const meanX = xs.reduce((a,b)=>a+b,0)/n;
  const meanY = ys.reduce((a,b)=>a+b,0)/n;
  let num = 0, den = 0;
  for (let i=0;i<n;i++){ num += (xs[i]-meanX)*(ys[i]-meanY); den += (xs[i]-meanX)*(xs[i]-meanX); }
  if (den === 0) return null;
  const slope = num/den; // percent per day
  const intercept = meanY - slope * meanX;
  return { slope, intercept, firstMs:first, lastXMs: pts[pts.length-1].x, lastY: pts[pts.length-1].y };
}

function estimateReachDate(percentPoints, target = 100){
  const reg = linearRegressionDays(percentPoints);
  if (!reg || typeof reg.slope !== 'number' || reg.slope <= 0) return null;
  const daysNeeded = (target - reg.lastY) / reg.slope;
  if (daysNeeded < 0) return null;
  const ms = reg.lastXMs + daysNeeded * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

// find first date where percent >= target; interpolate between samples if needed
function findDateReachedFromLabels(labels, percSeries, target = 100){
  // build chronological entries
  const entries = labels.map((lab,i) => ({ label: lab, percent: percSeries[i] }))
                        .filter(e => e.percent !== null && !Number.isNaN(e.percent));
  for (let i = 0; i < entries.length; i++){
    if (entries[i].percent >= target) {
      if (i > 0 && entries[i-1].percent < target) {
        const p0 = entries[i-1], p1 = entries[i];
        const p0v = p0.percent, p1v = p1.percent;
        const frac = (target - p0v) / (p1v - p0v);
        const date0 = new Date(p0.label + 'T00:00:00Z');
        const date1 = new Date(p1.label + 'T00:00:00Z');
        const ms = date0.getTime() + frac * (date1.getTime() - date0.getTime());
        return new Date(ms);
      }
      return new Date(entries[i].label + 'T00:00:00Z');
    }
  }
  return null;
}

function latestNonNull(series){
  for (let i = series.length - 1; i >= 0; i--){
    const v = series[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) return v;
  }
  return null;
}

const userA = 'kristin';
const userB = 'aaron';

let vo2Chart = null;
let marathonChart = null;

async function loadAndRender(){
  showError('');
  showStatus('Loading…');

  try{
    const [vo2Ajson, vo2Bjson, marAjson, marBjson, progAjson, progBjson] = await Promise.all([
      fetchJSON(`data/${userA}_vo2.json`).catch(e=>{ showError(e.message); return null; }),
      fetchJSON(`data/${userB}_vo2.json`).catch(e=>{ showError(e.message); return null; }),
      fetchJSON(`data/${userA}_marathon.json`).catch(e=>{ showError(e.message); return null; }),
      fetchJSON(`data/${userB}_marathon.json`).catch(e=>{ showError(e.message); return null; }),
      fetchJSON(`data/${userA}_prognosis.json`).catch(()=> null),
      fetchJSON(`data/${userB}_prognosis.json`).catch(()=> null)
    ]);

    const vo2Amap = vo2ToMap(vo2Ajson);
    const vo2Bmap = vo2ToMap(vo2Bjson);
    const marAmap = marathonToMap(marAjson);
    const marBmap = marathonToMap(marBjson);

    const last30 = getLastNDates(30);

    const vo2ASeries = buildSeries(vo2Amap, last30);
    const vo2BSeries = buildSeries(vo2Bmap, last30);
    const marASeries = buildSeries(marAmap, last30);
    const marBSeries = buildSeries(marBmap, last30);

    const latestMarA = findLatestValue(marAmap);
    const latestMarB = findLatestValue(marBmap);

    const nameA = userA.charAt(0).toUpperCase() + userA.slice(1);
    const nameB = userB.charAt(0).toUpperCase() + userB.slice(1);

    // convert marathon to percent (value*100)
    const marAPerc = toPercentSeries(marASeries);
    const marBPerc = toPercentSeries(marBSeries);

    // latest numeric percent
    const latestA = latestNonNull(marAPerc);
    const latestB = latestNonNull(marBPerc);

    // update badge text
    const latestArounded = latestA !== null ? Math.round(latestA) : null;
    const latestBrounded = latestB !== null ? Math.round(latestB) : null;
    marPctEl.textContent = `${nameA}: ${latestArounded !== null ? latestArounded + '%' : '--%'}   ${nameB}: ${latestBrounded !== null ? latestBrounded + '%' : '--%'}`;

    // progress bar: cap width at 100% visually; compute average display value if both present
    const displayVal = (latestA !== null && latestB !== null) ? ((latestA + latestB)/2) : (latestA !== null ? latestA : (latestB !== null ? latestB : 0));
    if (marProgressBar) marProgressBar.style.width = Math.min(100, Math.max(0, Math.round(displayVal))) + '%';

    // overflow indicator (show maximum overflow)
    if (marOverflow){
      const overA = latestA !== null ? Math.max(0, Math.round(latestA) - 100) : 0;
      const overB = latestB !== null ? Math.max(0, Math.round(latestB) - 100) : 0;
      const overText = (overA > 0 || overB > 0) ? `+${Math.max(overA, overB)}%` : '';
      if (overText){ marOverflow.textContent = overText; marOverflow.style.display = 'block'; }
      else { marOverflow.style.display = 'none'; }
    }

    // compute projection or reached date
    const ptsA_recent = buildPointsFromSeries(last30.slice(-14), marAPerc.slice(-14));
    const ptsB_recent = buildPointsFromSeries(last30.slice(-14), marBPerc.slice(-14));
    let projText = 'Projected: no upward trend';
    // if already >=100 find reached date
    if ((latestA !== null && latestA >= 100) || (latestB !== null && latestB >= 100)) {
      const reachedA = findDateReachedFromLabels(last30, marAPerc, 100);
      const reachedB = findDateReachedFromLabels(last30, marBPerc, 100);
      let bestDate = null;
      if (reachedA) bestDate = reachedA;
      if (reachedB && (!bestDate || reachedB < bestDate)) bestDate = reachedB;
      if (bestDate) projText = `Reached: ${bestDate.toISOString().slice(0,10)}`;
      else projText = 'Reached: date unknown';
    } else {
      const estA = estimateReachDate(ptsA_recent, 100);
      const estB = estimateReachDate(ptsB_recent, 100);
      // pick earliest estimate if both exist
      let best = null;
      if (estA) best = estA;
      if (estB && (!best || estB < best)) best = estB;
      if (best) projText = `Projected to reach 100% around ${best.toISOString().slice(0,10)}`;
    }
    if (marProjectionEl) marProjectionEl.textContent = projText;

    // build target line and dynamic y-axis max
    const allPercents = marAPerc.concat(marBPerc).filter(v => v !== null && !Number.isNaN(v));
    const maxObservedPercent = allPercents.length ? Math.max(...allPercents) : 100;
    const yMax = Math.max(100, Math.ceil(maxObservedPercent * 1.05));

    const targetLine = last30.map(()=>100);

    // build chart payloads
    const vo2Data = {
      labels: last30,
      datasets: [
        { label: `${nameA} VO₂`, data: vo2ASeries, borderColor:'rgba(75,192,192,1)', backgroundColor:'rgba(75,192,192,0.12)', tension:0.25, pointRadius:3, spanGaps:true },
        { label: `${nameB} VO₂`, data: vo2BSeries, borderColor:'rgba(255,99,132,1)', backgroundColor:'rgba(255,99,132,0.12)', tension:0.25, pointRadius:3, spanGaps:true }
      ]
    };
    const vo2Opts = { responsive:true, plugins:{legend:{display:true}}, scales:{ x:{ type:'category' }, y:{ beginAtZero:false } }, maintainAspectRatio:false };

    const marData = {
      labels: last30,
      datasets: [
        { label: `${nameA} %`, data: marAPerc, borderColor:'rgba(20,115,220,1)', backgroundColor:'rgba(20,115,220,0.06)', tension:0.2, pointRadius:3, spanGaps:true, fill:false },
        { label: `${nameB} %`, data: marBPerc, borderColor:'rgba(255,140,0,1)', backgroundColor:'rgba(255,140,0,0.06)', tension:0.2, pointRadius:3, spanGaps:true, fill:false },
        { label: 'Target 100%', data: targetLine, borderColor:'rgba(0,0,0,0.45)', borderDash:[6,4], pointRadius:0, fill:false, tension:0 }
      ]
    };
    const marOpts = {
      responsive:true,
      plugins:{legend:{display:true}},
      scales:{ x:{ type:'category' }, y:{ min:0, max: yMax, title:{ display:true, text:'Percent (100% target)' } } },
      maintainAspectRatio:false
    };

    // update or create charts
    const vo2Ctx = document.getElementById('vo2Chart').getContext('2d');
    const marCtx = document.getElementById('marathonChart').getContext('2d');

    vo2Chart = createOrUpdateChart(vo2Ctx, vo2Data, vo2Opts, vo2Chart);
    marathonChart = createOrUpdateChart(marCtx, marData, marOpts, marathonChart);

    // Render prognosis table for standard targets
    renderPrognosisTable(progAjson, progBjson);

    showError('');
    showStatus('');
  }catch(err){
    showError(err.message);
    showStatus('');
    console.error(err);
  }
}

/*
 Render prognosis table specifically for these targets:
  5k  -> ~3.11 mi
  10k -> ~6.21 mi
  Half Marathon -> ~13.11 mi
  Marathon -> ~26.22 mi
*/
function renderPrognosisTable(progA, progB){
  const aEntries = Array.isArray(progA && progA.entries ? progA.entries : progA) ? (progA.entries || progA) : [];
  const bEntries = Array.isArray(progB && progB.entries ? progB.entries : progB) ? (progB.entries || progB) : [];

  const targets = [
    { id: '5k', mi: 3.11, label: '5k' },
    { id: '10k', mi: 6.21, label: '10k' },
    { id: 'half', mi: 13.11, label: 'Half' },
    { id: 'full', mi: 26.22, label: 'Marathon' }
  ];

  function findMatch(entries, target){
    if(!Array.isArray(entries)) return null;
    const tol = 0.35;
    let best = null;
    for(const e of entries){
      if(e && typeof e.distance_mi === 'number'){
        const diff = Math.abs(e.distance_mi - target.mi);
        if(diff <= tol){
          if(!best || diff < Math.abs(best.distance_mi - target.mi)) best = e;
        }
      }
    }
    if(best) return best;
    const look = String(target.mi).split('.')[0];
    for(const e of entries){
      if(!e) continue;
      const lbl = (e.distance_label || '').toLowerCase().replace(/\u00a0/g,' ');
      if(lbl.includes(String(target.mi)) || lbl.includes(look) || lbl.includes(target.id)) return e;
    }
    return null;
  }

  const rows = targets.map(t => {
    const a = findMatch(aEntries, t);
    const b = findMatch(bEntries, t);
    const aText = a ? `${a.time || '-'} / ${a.pace || '-'}` : '-';
    const bText = b ? `${b.time || '-'} / ${b.pace || '-'}` : '-';
    const friendly = (t.id === 'half') ? 'Half (13.1 mi)' : (t.id === 'full' ? 'Marathon (26.2 mi)' : t.id.toUpperCase());
    return `<tr><td>${friendly}</td><td>${aText}</td><td>${bText}</td></tr>`;
  });

  progTbody.innerHTML = rows.join('\n');
}

window.addEventListener('load', loadAndRender);
