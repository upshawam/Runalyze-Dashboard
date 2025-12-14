// docs/app.js - corrected ordering so computeProjectionsFromSeries (and helpers) are defined
// before they are used. Includes multi-window projections and reordered columns.
// Replace your docs/app.js with this file and reload the page.

const USERS = ['kristin','aaron'];
const DATA_FILES = ['vo2','marathon','prognosis','marathon_requirements','training_paces'];
const PROJECTION_WINDOWS = [7, 14, 30, 60];

const nowTag = () => '?t=' + Date.now();
const el = id => document.getElementById(id);
const fetchJSON = async p => {
  const r = await fetch(p + nowTag());
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

const isoToKey = iso => { const d=new Date(iso); if(isNaN(d)) return null; return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; };
const lastNDates = n => { const out=[]; const now=new Date(); for(let i=n-1;i>=0;i--){ const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())); d.setUTCDate(d.getUTCDate()-i); out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`); } return out; };
const nbspMi = s => (s||'').toString().replace(/(\d[\d,\.]*)\s*mi/gi,'$1\u00a0mi');
const fmtTs = ts => { if(!ts) return ''; const d=new Date(ts); if(isNaN(d)) return ts; return d.toISOString().slice(0,19).replace('T',' '); };

// VO2 helper (map input shapes to date->value)
const vo2Map = v => {
  if(!v) return {};
  if(v.trend && typeof v.trend === 'object') return v.trend;
  if(Array.isArray(v.values)) return v.values.reduce((m,it)=>{ const k=isoToKey(it[0]); if(k) m[k]=it[1]; return m; },{});
  return (typeof v === 'object') ? v : {};
};

const findLatest = m => {
  const keys = Object.keys(m).sort();
  for(let i=keys.length-1;i>=0;i--){
    const v = m[keys[i]];
    if(v != null && !isNaN(Number(v))) return { date: keys[i], value: Number(v) };
  }
  return null;
};

// --- Regression + projection helpers (defined before usage) ---

// linear least-squares on numeric x,y arrays
function linearRegression(x, y){
  if(!x.length || x.length !== y.length) return null;
  const n = x.length;
  let sumX=0, sumY=0, sumXY=0, sumXX=0;
  for(let i=0;i<n;i++){
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i]*y[i];
    sumXX += x[i]*x[i];
  }
  const meanX = sumX/n;
  const meanY = sumY/n;
  const denom = (sumXX - n*meanX*meanX);
  if(Math.abs(denom) < 1e-12) return { slope: 0, intercept: meanY };
  const slope = (sumXY - n*meanX*meanY) / denom;
  const intercept = meanY - slope*meanX;
  return { slope, intercept };
}

// build numeric arrays for regression: x = days since epoch, y = percent (value*100)
function buildXY(labels, values){
  const msPerDay = 1000*60*60*24;
  const x = [], y = [];
  for(let i=0;i<labels.length;i++){
    const dt = new Date(labels[i] + 'T00:00:00Z');
    if(isNaN(dt)) continue;
    const xi = dt.getTime()/msPerDay;
    const vi = values[i];
    if(vi == null || isNaN(Number(vi))) continue;
    x.push(xi);
    y.push(Number(vi) * 100);
  }
  return { x, y };
}

// Detect crossing inside a slice and interpolate date (returns Date or null)
function findDateReachedFromLabels(labels, values, threshold = 100){
  for(let i=0;i<labels.length;i++){
    const cur = Number(values[i]);
    if(isNaN(cur)) continue;
    const curPct = cur * 100;
    if(curPct >= threshold){
      if(i === 0) return new Date(labels[0] + 'T00:00:00Z');
      const prev = Number(values[i-1]);
      const prevPct = prev * 100;
      const frac = (threshold - prevPct) / (curPct - prevPct);
      const f = Math.max(0, Math.min(1, frac));
      const d0 = new Date(labels[i-1] + 'T00:00:00Z').getTime();
      const d1 = new Date(labels[i] + 'T00:00:00Z').getTime();
      const t = Math.round(d0 + (d1 - d0) * f);
      return new Date(t);
    }
  }
  return null;
}

// Estimate reach date using regression; returns Date or null if slope <= 0 or insufficient data
function estimateReachDate(labels, values, threshold = 100){
  const { x, y } = buildXY(labels, values);
  if(x.length < 2) return null;
  const reg = linearRegression(x, y);
  if(!reg) return null;
  const slope = reg.slope;
  const intercept = reg.intercept;
  if(slope <= 0) return null;
  const targetX = (threshold - intercept) / slope;
  if(!isFinite(targetX)) return null;
  const msPerDay = 1000*60*60*24;
  return new Date(Math.round(targetX * msPerDay));
}

// Use the last windowDays samples from sortedDates/sortedValues to compute reach date
function projectionForWindow(sortedDates, sortedValues, windowDays){
  const N = sortedDates.length;
  if(N === 0) return null;
  const L = Math.min(windowDays, N);
  const sliceDates = sortedDates.slice(N - L);
  const sliceValues = sortedValues.slice(N - L);
  const reached = findDateReachedFromLabels(sliceDates, sliceValues, 100);
  if(reached) return reached;
  return estimateReachDate(sliceDates, sliceValues, 100);
}

// Compute projections for all windows given a series object {date: value}
function computeProjectionsFromSeries(seriesObj){
  const dates = Object.keys(seriesObj).sort();
  const values = dates.map(d => seriesObj[d]);
  const out = {};
  for(const w of PROJECTION_WINDOWS){
    out[w] = projectionForWindow(dates, values, w);
  }
  return out;
}

// Median-based recommended date
function pickRecommendedDate(projMap){
  const dates = PROJECTION_WINDOWS.map(w => projMap[w]).filter(Boolean).map(d => d.getTime()).sort((a,b)=>a-b);
  if(!dates.length) return null;
  const mid = Math.floor((dates.length - 1) / 2);
  return new Date(dates[mid]);
}

function formatProjMap(projMap){
  return PROJECTION_WINDOWS.map(w => {
    const dt = projMap[w];
    return `${w}d: ${dt ? dt.toISOString().slice(0,10) : '—'}`;
  }).join(', ');
}

// Return true if a row represents the marathon goal (26.2 / 100%)
function isMarathonGoal(r){
  if(!r) return false;
  if(typeof r.required_pct === 'number' && r.required_pct === 100) return true;
  if(typeof r.requiredPct === 'number' && r.requiredPct === 100) return true;
  if(typeof r.distance_mi === 'number' && Math.abs(r.distance_mi - 26.2) < 0.2) return true;
  if(typeof r.mi === 'number' && Math.abs(r.mi - 26.2) < 0.2) return true;
  const lbl = (r.distance_label || r.label || '').toString().toLowerCase();
  if(lbl.includes('26,2') || lbl.includes('26.2') || /\b26\b/.test(lbl)) return true;
  return false;
}

// --- Chart helper (VO2) ---
let vo2Chart = null;
function drawVo2(ctx, labels, datasets){
  const data = { labels, datasets };
  const opts = { responsive:true, plugins:{legend:{display:true}}, scales:{x:{type:'category'}, y:{beginAtZero:false}}, maintainAspectRatio:false };
  if(vo2Chart){ vo2Chart.data = data; vo2Chart.options = opts; vo2Chart.update(); return; }
  vo2Chart = new Chart(ctx, { type:'line', data, options:opts });
}

// --- Chart helper (Paces) ---
let pacesChart = null;
function drawPaces(ctx, datasets){
  const data = { labels: ['Recovery', 'Aerobic', 'Long/Medium long', 'Marathon', 'Lactate threshold', 'VO2max'], datasets };
  const opts = { responsive:true, plugins:{legend:{display:true}}, scales:{y:{beginAtZero:true, title:{display:true, text:'% vVO2max'}}}, maintainAspectRatio:false };
  if(pacesChart){ pacesChart.data = data; pacesChart.options = opts; pacesChart.update(); return; }
  pacesChart = new Chart(ctx, { type:'bar', data, options:opts });
}

// --- Main: load data, compute projections, render chart/table ---
async function loadAndRender(){
  const errorsEl = el('errors');
  try{
    if(errorsEl) errorsEl.textContent = '';

    // fetch all data
    const fetches = [];
    USERS.forEach(u => DATA_FILES.forEach(f => fetches.push(fetchJSON(`data/${u}_${f}.json`).catch(()=>null))));
    const results = await Promise.all(fetches);

    // assemble per-user
    const users = {};
    for(let i=0;i<USERS.length;i++){
      const base = i * DATA_FILES.length;
      users[USERS[i]] = {
        vo2: results[base],
        marathon: results[base+1],
        prognosis: results[base+2],
        requirements: results[base+3],
        training_paces: results[base+4]
      };
    }

    // VO2 chart
    const last30 = lastNDates(30);
    const datasets = USERS.map((u, idx) => {
      const map = vo2Map(users[u].vo2);
      const data = last30.map(d => (map[d] == null) ? null : Number(map[d]));
      const color = idx === 0 ? 'rgba(75,192,192,1)' : 'rgba(255,99,132,1)';
      return { label: u[0].toUpperCase()+u.slice(1)+' VO₂', data, borderColor: color, backgroundColor: color.replace('1)', '0.12)'), tension:0.25, pointRadius:3, spanGaps:true };
    });
    drawVo2(el('vo2Chart').getContext('2d'), last30, datasets);

    // Paces chart
    const pacesDatasets = USERS.map((u, idx) => {
      const d = users[u];
      if(!d.training_paces || !d.training_paces.entries) return null;
      const data = d.training_paces.entries.map(p => parseInt(p.pct_max));
      const color = idx === 0 ? 'rgba(75,192,192,1)' : 'rgba(255,99,132,1)';
      return { label: u[0].toUpperCase()+u.slice(1)+' % vVO2max', data, backgroundColor: color.replace('1)', '0.6)'), borderColor: color, borderWidth: 1 };
    }).filter(Boolean);
    if(pacesDatasets.length) drawPaces(el('pacesChart').getContext('2d'), pacesDatasets);

    // build tables and compute projections
    const tablesEl = el('tables');
    tablesEl.innerHTML = '';

    USERS.forEach(u => {
      const d = users[u];
      const marSeries = (d.marathon && typeof d.marathon === 'object') ? d.marathon : {};
      const latest = findLatest(marSeries);
      const currentPct = latest ? latest.value * 100 : null;

      // pick last-updated meta
      const metaCandidates = [d.marathon, d.requirements, d.prognosis];
      let lastUpdated = null;
      for(const c of metaCandidates){
        if(c && typeof c === 'object'){
          if(c._meta && c._meta.last_updated){ lastUpdated = c._meta.last_updated; break; }
          if(c.meta && c.meta.last_updated){ lastUpdated = c.meta.last_updated; break; }
        }
      }

      // compute projections and recommended single date
      const projMap = computeProjectionsFromSeries(marSeries);
      const rec = pickRecommendedDate(projMap);

      // If already reached in series, prefer showing reached date
      function firstReachedDate(seriesObj){
        const dates = Object.keys(seriesObj).sort();
        const values = dates.map(d => seriesObj[d]);
        return findDateReachedFromLabels(dates, values, 100);
      }
      const reachedDate = firstReachedDate(marSeries);

      // choose single-line projection text
      let projSingleText = '';
      if (reachedDate) {
        projSingleText = `Reached: ${reachedDate.toISOString().slice(0,10)}`;
      } else if (rec) {
        projSingleText = `Projected 100%: ${rec.toISOString().slice(0,10)}`;
      } else {
        projSingleText = 'Projected 100%: No upward trend';
      }

      const header = `
        <div class="user-block user-${u}">
          <div>
            <div class="user-title">${u[0].toUpperCase()+u.slice(1)}</div>
            <div class="small">Latest marathon shape: ${currentPct!==null ? (Math.round(currentPct*100)/100) : 'N/A'}</div>
          </div>
          <div>
            ${ lastUpdated ? `<div class="user-meta">Last updated: ${fmtTs(lastUpdated)}</div>` : '' }
            <div class="small" style="margin-top:6px">${projSingleText}</div>
          </div>
        </div>`;

      // build rows (prefer parsed requirements)
      const req = d.requirements;
      let rows = [];
      if(req && Array.isArray(req.entries) && req.entries.length){
        rows = req.entries.map(r => ({
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
      tablesEl.appendChild(wrapper);
    });

    // build paces
    const pacesEl = el('paces');
    pacesEl.innerHTML = '';

    USERS.forEach(u => {
      const d = users[u];
      if(!d.training_paces || !d.training_paces.entries) return;

      const pacesHtml = d.training_paces.entries.map(p => `
        <tr>
          <td>${p.name}</td>
          <td>${p.pace_min} - ${p.pace_max}</td>
          <td>${p.pct_min ? `${p.pct_min}% - ${p.pct_max}% vVO2max` : `Up to ${p.pct_max}% vVO2max`}</td>
        </tr>`).join('');

      const paceTableHtml = `
        <div class="user-block user-${u}">
          <div class="user-title">${u[0].toUpperCase()+u.slice(1)} Training Paces</div>
        </div>
        <table class="rz-table">
          <thead>
            <tr>
              <th>Pace Type</th>
              <th>Pace Range</th>
              <th>% vVO2max</th>
            </tr>
          </thead>
          <tbody>${pacesHtml}</tbody>
        </table>`;

      const wrapper = document.createElement('div');
      wrapper.className = `user-paces user-${u}`;
      wrapper.innerHTML = paceTableHtml;
      pacesEl.appendChild(wrapper);
    });

    // build prognosis
    const prognosisEl = el('prognosis');
    prognosisEl.innerHTML = '';

    USERS.forEach(u => {
      const d = users[u];
      if(!d.prognosis || !d.prognosis.entries) return;

      const progHtml = d.prognosis.entries.filter(p => !p.distance_label.includes('1,86')).map(p => `
        <tr>
          <td>${p.distance_label || (p.distance_mi ? `${p.distance_mi} mi` : '-')}</td>
          <td>${p.time || '-'}</td>
          <td>${p.pace || '-'}</td>
        </tr>`).join('');

      const progTableHtml = `
        <div class="user-block user-${u}">
          <div class="user-title">${u[0].toUpperCase()+u.slice(1)} Prognosis</div>
        </div>
        <table class="rz-table">
          <thead>
            <tr>
              <th>Distance</th>
              <th>Time</th>
              <th>Pace</th>
            </tr>
          </thead>
          <tbody>${progHtml}</tbody>
        </table>`;

      const wrapper = document.createElement('div');
      wrapper.className = `user-prognosis user-${u}`;
      wrapper.innerHTML = progTableHtml;
      prognosisEl.appendChild(wrapper);
    });

  }catch(err){
    if(el('errors')) el('errors').textContent = err.message || String(err);
    console.error(err);
  }
}

window.addEventListener('load', loadAndRender);
