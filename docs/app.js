// app.js - renders VO2 charts and replaces the Marathon shape graph with Runalyze-style tables per user.
// Expects files: data/<user>_vo2.json, data/<user>_marathon.json, data/<user>_prognosis.json

const errorsEl = document.getElementById('errors');
const statusEl = document.getElementById('status');
const marathonTablesContainer = document.getElementById('marathonTablesContainer');

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

// utilities for dates / maps
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

// simple Chart creation/update
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

// Helper to match prognosis entries to target distances
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
  // fallback: match by label substring
  const look = String(targetMi).split('.')[0];
  for(const e of entries){
    if(!e) continue;
    const lbl = (e.distance_label || '').toLowerCase().replace(/\u00a0/g,' ');
    if(lbl.includes(String(targetMi)) || lbl.includes(look)) return e;
  }
  return null;
}

// Table model (copied from the Runalyze snippet you provided)
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

// users to show tables for
const USERS = ['kristin','aaron'];

let vo2Chart = null;

async function loadAndRender(){
  showError('');
  showStatus('Loading…');

  try{
    // fetch all data
    const fetches = [];
    for(const u of USERS){
      fetches.push(fetchJSON(`data/${u}_vo2.json`).catch(e=>{ showError(e.message); return null; }));
      fetches.push(fetchJSON(`data/${u}_marathon.json`).catch(e=>{ showError(e.message); return null; }));
      fetches.push(fetchJSON(`data/${u}_prognosis.json`).catch(()=> null));
    }
    const results = await Promise.all(fetches);

    // split back into objects per user
    const usersData = {};
    for(let i=0;i<USERS.length;i++){
      const u = USERS[i];
      usersData[u] = {
        vo2: results[i*3 + 0],
        marathon: results[i*3 + 1],
        prognosis: results[i*3 + 2]
      };
    }

    // Render VO2 chart (shared across users)
    const last30 = getLastNDates(30);
    const vo2Datasets = [];
    for(const u of USERS){
      const uMap = vo2ToMap(usersData[u].vo2);
      const ser = buildSeries(uMap, last30);
      const label = u.charAt(0).toUpperCase() + u.slice(1) + ' VO₂';
      const color = u === USERS[0] ? 'rgba(75,192,192,1)' : 'rgba(255,99,132,1)';
      vo2Datasets.push({ label, data: ser, borderColor: color, backgroundColor: color.replace('1)', '0.12)'), tension:0.25, pointRadius:3, spanGaps:true });
    }
    const vo2Data = { labels: last30, datasets: vo2Datasets };
    const vo2Opts = { responsive:true, plugins:{legend:{display:true}}, scales:{ x:{ type:'category'}, y:{ beginAtZero:false } }, maintainAspectRatio:false};
    const vo2Ctx = document.getElementById('vo2Chart').getContext('2d');
    vo2Chart = createOrUpdateChart(vo2Ctx, vo2Data, vo2Opts, vo2Chart);

    // Build and render the Runalyze-style tables — one per user
    marathonTablesContainer.innerHTML = ''; // clear
    for(const u of USERS){
      const data = usersData[u];
      const marMap = marathonToMap(data.marathon);
      const prog = data.prognosis;
      const latest = findLatestValue(marMap);
      const currentPct = latest ? (latest.value * 100) : null; // e.g. 65.12

      // table header per user
      const userTitle = `<div class="user-block"><div class="user-title">${u.charAt(0).toUpperCase()+u.slice(1)}</div><div class="small">Latest marathon shape: ${currentPct !== null ? (currentPct.toFixed(1)+'%') : 'N/A'} ${latest ? '('+latest.date+')' : ''}</div></div>`;

      // build rows
      const rows = RUNALYZE_ROWS.map(r => {
        const required = r.requiredPct;
        const weekly = r.weekly;
        const longRun = r.longRun;
        // Achieved percent = currentPct / requiredPct * 100
        let achievedText = '-';
        let achievedNum = null;
        let achievedIcon = '';
        if(currentPct !== null && required){
          achievedNum = Math.round((currentPct / required) * 100); // e.g. 890
          achievedText = `${achievedNum}%`;
          achievedIcon = (achievedNum >= 100) ? `<span class="plus">✔</span>` : `<span class="minus">✖</span>`;
        }

        // find prognosis entry for this target
        let progText = '-';
        if (prog){
          // prognosis JSON may be shape { meta: ..., entries: [...] } or array
          const entries = Array.isArray(prog.entries) ? prog.entries : (Array.isArray(prog) ? prog : (prog.entries || []));
          const match = findPrognosisEntry(entries, r.mi, 0.4);
          if(match && match.time) progText = match.time;
        }

        // Optimum column we don't have reliably; leave '-' unless present in prognosis as 'optimum' (not present in current feed)
        const optimumText = '-';

        return `<tr class="r">
          <td class="b right-separated">${r.label}</td>
          <td>${required}%</td>
          <td>${weekly}</td>
          <td class="right-separated">${longRun}</td>
          <td>${achievedText}</td>
          <td>${achievedIcon}</td>
          <td class="left-separated small hidden-mobile">${progText}</td>
          <td class="hidden-mobile">${optimumText}</td>
        </tr>`;
      });

      const tableHtml = `
        ${userTitle}
        <table class="rz-table" aria-label="${u} marathon requirements">
          <thead>
            <tr>
              <th class="right-separated"></th>
              <th colspan="3" class="right-separated">Required</th>
              <th colspan="2"></th>
              <th class="left-separated hidden-mobile">Prognosis</th>
              <th class="hidden-mobile">Optimum</th>
            </tr>
            <tr>
              <th class="right-separated">Distance</th>
              <th>Marathon Shape</th>
              <th>Weekly mileage</th>
              <th class="right-separated">Long Run</th>
              <th colspan="2">Achieved</th>
              <th class="left-separated hidden-mobile">Prognosis</th>
              <th class="hidden-mobile">Optimum</th>
            </tr>
          </thead>
          <tbody>
            ${rows.join('\n')}
          </tbody>
        </table>
      `;

      const wrapper = document.createElement('div');
      wrapper.innerHTML = tableHtml;
      marathonTablesContainer.appendChild(wrapper);
    }

    showError('');
    showStatus('');
  }catch(err){
    showError(err.message);
    showStatus('');
    console.error(err);
  }
}

window.addEventListener('load', loadAndRender);
