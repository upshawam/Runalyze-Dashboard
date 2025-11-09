// app.js - compact table adjustments + ensure 100% marathon row has top+bottom divider
// No behavior change: builds the same table as before; styling moved to style.css

const ERR_EL = document.getElementById('errors') || { textContent: '' };
const TABLES_EL = document.getElementById('tables');

function showError(msg){
  if (ERR_EL) ERR_EL.textContent = msg || '';
  if(msg) console.error(msg);
}

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

let vo2Chart = null;
const USERS = ['kristin','aaron'];

const RUNALYZE_ROWS = [
  { mi: 3.1, label: '3,1 mi', requiredPct: 7, weekly: 'ca. 5 mi', longRun: '-' },
  { mi: 6.2, label: '6,2 mi', requiredPct: 17, weekly: 'ca. 11 mi', longRun: '-' },
  { mi: 10.0, label: '10,0 mi', requiredPct: 31, weekly: 'ca. 19 mi', longRun: '-' },
  { mi: 13.1, label: '13,1 mi', requiredPct: 43, weekly: 'ca. 25 mi', longRun: 'ca. 11 mi' },
  { mi: 26.2, label: '26,2 mi', requiredPct: 100, weekly: 'ca. 44 mi', longRun: 'ca. 18 mi' },
  { mi: 31.1, label: '31,1 mi', requiredPct: 123, weekly: 'ca. 47 mi', longRun: 'ca. 20 mi' },
  { mi: 62.1, label: '62,1 mi', requiredPct: 288, weekly: 'ca. 64 mi', longRun: 'ca. 31 mi' },
  { mi: 100.0, label: '100,0 mi', requiredPct: 518, weekly: 'ca. 114 mi', longRun: 'ca. 39 mi' }
];

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

function findPrognosisEntry(entries, targetMi, tol = 0.35){
  if(!Array.isArray(entries)) return null;
  let best = null;
  for(const e of entries){
    if(!e) continue;
    if(typeof e.distance_mi === 'number'){
      const diff = Math.abs(e.distance_mi - targetMi);
      if(diff <= tol){
        if(!best || diff < Math.abs(best.distance_mi - targetMi)) best = e;
      }
    }
  }
  if(best) return best;
  const look = String(targetMi).split('.')[0];
  for(const e of entries){
    if(!e) continue;
    const lbl = (e.distance_label || '').toLowerCase().replace(/\u00a0/g,' ');
    if(lbl.includes(String(targetMi)) || lbl.includes(look)) return e;
  }
  return null;
}

function formatTimestamp(ts){
  if(!ts) return '';
  try{
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return ts;
    return d.toISOString().slice(0,19).replace('T',' ');
  }catch(e){
    return ts;
  }
}
function nbspMi(text){
  if(!text || typeof text !== 'string') return text;
  return text.replace(/(\d[\d,\.]*)\s*mi/gi, '$1\u00a0mi');
}

/* Return true if row should be highlighted as marathon-goal (100% / 26.2) */
function isMarathonGoalRow(r){
  if(!r) return false;
  if(typeof r.required_pct === 'number' && r.required_pct === 100) return true;
  if(typeof r.requiredPct === 'number' && r.requiredPct === 100) return true;
  if(typeof r.distance_mi === 'number' && Math.abs(r.distance_mi - 26.2) < 0.2) return true;
  if(typeof r.mi === 'number' && Math.abs(r.mi - 26.2) < 0.2) return true;
  const lbl = (r.distance_label || r.label || '').toString().toLowerCase();
  if(lbl.includes('26,2') || lbl.includes('26.2') || /\b26\b/.test(lbl)) return true;
  return false;
}

async function loadAndRender(){
  showError('');
  try{
    // fetch data
    const allFetches = [];
    for(const u of USERS){
      allFetches.push(fetchJSON(`data/${u}_vo2.json`).catch(()=>null));
      allFetches.push(fetchJSON(`data/${u}_marathon.json`).catch(()=>null));
      allFetches.push(fetchJSON(`data/${u}_prognosis.json`).catch(()=>null));
      allFetches.push(fetchJSON(`data/${u}_marathon_requirements.json`).catch(()=>null));
    }
    const results = await Promise.all(allFetches);

    const usersData = {};
    for(let i=0;i<USERS.length;i++){
      const u = USERS[i];
      usersData[u] = {
        vo2: results[i*4 + 0],
        marathon: results[i*4 + 1],
        prognosis: results[i*4 + 2],
        requirements: results[i*4 + 3]
      };
    }

    // VO2 chart (unchanged)
    const last30 = getLastNDates(30);
    const vo2Datasets = [];
    for(const u of USERS){
      const map = vo2ToMap(usersData[u].vo2);
      const ser = buildSeries(map, last30);
      const label = u.charAt(0).toUpperCase() + u.slice(1) + ' VO₂';
      const color = u === USERS[0] ? 'rgba(75,192,192,1)' : 'rgba(255,99,132,1)';
      vo2Datasets.push({ label, data: ser, borderColor: color, backgroundColor: color.replace('1)', '0.12)'), tension:0.25, pointRadius:3, spanGaps:true });
    }
    const vo2Data = { labels: last30, datasets: vo2Datasets };
    const vo2Opts = { responsive:true, plugins:{legend:{display:true}}, scales:{ x:{ type:'category'}, y:{ beginAtZero:false } }, maintainAspectRatio:false};
    const vo2Ctx = document.getElementById('vo2Chart').getContext('2d');
    vo2Chart = createOrUpdateChart(vo2Ctx, vo2Data, vo2Opts, vo2Chart);

    // Build tables per user
    TABLES_EL.innerHTML = '';
    for(const u of USERS){
      const data = usersData[u];
      const marMap = marathonToMap(data.marathon);
      const prog = data.prognosis;
      const req = data.requirements;
      const latest = findLatestValue(marMap);
      const currentPct = latest ? (latest.value * 100) : null;

      // last-updated selection
      let lastUpdated = null;
      if(data.marathon && typeof data.marathon === 'object'){
        if(data.marathon._meta && data.marathon._meta.last_updated) lastUpdated = data.marathon._meta.last_updated;
        else if(data.marathon.meta && data.marathon.meta.last_updated) lastUpdated = data.marathon.meta.last_updated;
      }
      if(!lastUpdated && req && typeof req === 'object'){
        if(req._meta && req._meta.last_updated) lastUpdated = req._meta.last_updated;
        else if(req.meta && req.meta.last_updated) lastUpdated = req.meta.last_updated;
      }
      if(!lastUpdated && prog && typeof prog === 'object'){
        if(prog._meta && prog._meta.last_updated) lastUpdated = prog._meta.last_updated;
        else if(prog.meta && prog.meta.last_updated) lastUpdated = prog.meta.last_updated;
      }

      const lastUpdatedText = lastUpdated ? `<div class="user-meta">Last updated: ${formatTimestamp(lastUpdated)}</div>` : '';

      const userHeader = `
        <div class="user-block user-${u}">
          <div>
            <div class="user-title">${u.charAt(0).toUpperCase()+u.slice(1)}</div>
            <div class="small">Latest marathon shape: ${currentPct !== null ? (Math.round(currentPct*100)/100) : 'N/A'}</div>
          </div>
          ${lastUpdatedText}
        </div>
      `;

      // Build rows
      let rowsHtml = '';
      if(req && Array.isArray(req.entries) && req.entries.length){
        for(const r of req.entries){
          let label = r.distance_label || (r.distance_mi ? `${r.distance_mi} mi` : '-');
          label = nbspMi(label);
          const required = (r.required_pct !== null && r.required_pct !== undefined) ? `${r.required_pct}%` : '-';
          const weekly = nbspMi(r.weekly || '-');
          const longRun = nbspMi(r.long_run || '-');
          const achievedNum = (r.achieved_pct !== null && r.achieved_pct !== undefined) ? `${r.achieved_pct}%` : '-';
          const iconHtml = r.achieved_ok ? `<i class="fa-solid fa-check plus" aria-hidden="true"></i>` : `<i class="fa-solid fa-xmark minus" aria-hidden="true"></i>`;
          const progTime = r.prognosis_time || '-';
          let optimumText = '-';
          if(r.optimum_time && (r.achieved_pct === null || r.achieved_pct < 100)){
            optimumText = r.optimum_time;
          }
          const special = isMarathonGoalRow(r) ? ' top-separated bottom-separated' : '';
          rowsHtml += `<tr class="r${special}">
            <td class="nowrap-mi">${label}</td>
            <td>${required}</td>
            <td>${weekly}</td>
            <td>${longRun}</td>
            <td class="center">${achievedNum}</td>
            <td class="center">${iconHtml}</td>
            <td class="left-separated hidden-mobile">${progTime}</td>
            <td class="hidden-mobile">${optimumText}</td>
          </tr>`;
        }
      } else {
        for(const r of RUNALYZE_ROWS){
          const label = nbspMi(r.label);
          let achievedText = '-';
          let achievedIcon = `<i class="fa-solid fa-xmark minus" aria-hidden="true"></i>`;
          if(currentPct !== null && r.requiredPct){
            const achievedNum = Math.round((currentPct / r.requiredPct) * 100);
            achievedText = `${achievedNum}%`;
            if(achievedNum >= 100) achievedIcon = `<i class="fa-solid fa-check plus" aria-hidden="true"></i>`;
          }
          let progText = '-';
          if(prog){
            const entries = Array.isArray(prog.entries) ? prog.entries : (Array.isArray(prog) ? prog : (prog.entries || []));
            const match = findPrognosisEntry(entries, r.mi, 0.4);
            if(match && match.time) progText = match.time;
          }
          const optimumText = (achievedText && achievedText !== '-' && parseInt(achievedText) < 100) ? (progText || '-') : '-';
          const special = isMarathonGoalRow(r) ? ' top-separated bottom-separated' : '';
          rowsHtml += `<tr class="r${special}">
            <td class="nowrap-mi">${label}</td>
            <td>${r.requiredPct}%</td>
            <td>${r.weekly}</td>
            <td>${r.longRun}</td>
            <td class="center">${achievedText}</td>
            <td class="center">${achievedIcon}</td>
            <td class="left-separated hidden-mobile">${progText}</td>
            <td class="hidden-mobile">${optimumText}</td>
          </tr>`;
        }
      }

      // fixed col widths to avoid overly wide columns
      const colgroup = `<colgroup>
          <col style="width:14%" />
          <col style="width:10%" />
          <col style="width:24%" />
          <col style="width:12%" />
          <col style="width:8%" />
          <col style="width:3%" />
          <col style="width:16%" class="hidden-mobile" />
          <col style="width:13%" class="hidden-mobile" />
        </colgroup>`;

      const tableHtml = `
        <table class="rz-table" aria-label="${u} marathon requirements">
          ${colgroup}
          <thead>
            <tr class="group-row">
              <th></th>
              <th colspan="3">Required</th>
              <th colspan="2"></th>
              <th colspan="2" class="hidden-mobile"></th>
            </tr>
            <tr class="label-row">
              <th>Distance</th>
              <th>Marathon Shape</th>
              <th>Weekly mileage</th>
              <th>Long Run</th>
              <th>Achieved</th>
              <th></th>
              <th class="hidden-mobile">Prognosis</th>
              <th class="hidden-mobile">Optimum</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      `;

      const wrapper = document.createElement('div');
      wrapper.className = `user-table user-${u}`;
      wrapper.innerHTML = userHeader + tableHtml;
      TABLES_EL.appendChild(wrapper);
    }
  }catch(err){
    showError(err.message || String(err));
    console.error(err);
  }
}

window.addEventListener('load', loadAndRender);
