// docs/app.js
// Compact app with dynamic column width measurement to size columns to header/value width.

const USERS = ['kristin','aaron'];
const DATA_FILES = ['vo2','marathon','prognosis','marathon_requirements'];

const nowTag = () => '?t=' + Date.now();
const el = id => document.getElementById(id);
const fetchJSON = async p => {
  const r = await fetch(p + nowTag());
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

const isoToKey = iso => {
  const d = new Date(iso);
  if(isNaN(d)) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
};
const lastNDates = n => {
  const out = []; const now = new Date();
  for(let i=n-1;i>=0;i--){
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`);
  }
  return out;
};

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

const nbspMi = s => (s||'').toString().replace(/(\d[\d,\.]*)\s*mi/gi, '$1\u00a0mi');
const fmtTs = ts => { if(!ts) return ''; const d=new Date(ts); if(isNaN(d)) return ts; return d.toISOString().slice(0,19).replace('T',' '); };

const isMarathonGoal = r => {
  if(!r) return false;
  if(typeof r.required_pct === 'number' && r.required_pct === 100) return true;
  if(typeof r.requiredPct === 'number' && r.requiredPct === 100) return true;
  if(typeof r.distance_mi === 'number' && Math.abs(r.distance_mi - 26.2) < 0.2) return true;
  if(typeof r.mi === 'number' && Math.abs(r.mi - 26.2) < 0.2) return true;
  const lbl = (r.distance_label || r.label || '').toString();
  return /\b26[.,]?2\b/.test(lbl) || /\b26\b/.test(lbl);
};

// measure natural widths by rendering an off-screen table (table-layout:auto) and returning px widths for each column
function measureColumnWidths(headerHtml, rowsHtml){
  // build temp table markup
  const tmpTable = document.createElement('table');
  tmpTable.className = 'rz-table';
  tmpTable.style.position = 'absolute';
  tmpTable.style.left = '-9999px';
  tmpTable.style.top = '0';
  tmpTable.style.visibility = 'hidden';
  tmpTable.style.tableLayout = 'auto'; // force auto for natural sizing
  tmpTable.innerHTML = `<thead>${headerHtml}</thead><tbody>${rowsHtml}</tbody>`;

  document.body.appendChild(tmpTable);

  // find label-row header cells (these correspond to columns)
  const headerRow = tmpTable.querySelector('thead tr.label-row');
  const firstBodyRow = tmpTable.querySelector('tbody tr');

  // fallback static widths if measuring fails
  const fallback = [140,80,200,100,80,28,160,120];

  if(!headerRow){
    document.body.removeChild(tmpTable);
    return fallback;
  }

  const headerCells = Array.from(headerRow.children);
  const bodyCells = firstBodyRow ? Array.from(firstBodyRow.children) : [];

  // compute widths by taking the computed width per column (header or body whichever is max)
  const widths = headerCells.map((th,i) => {
    const w1 = Math.ceil(th.getBoundingClientRect().width || 0);
    const w2 = bodyCells[i] ? Math.ceil(bodyCells[i].getBoundingClientRect().width || 0) : 0;
    // add a small padding fudge to avoid truncation (6px)
    return Math.max(40, Math.max(w1,w2) + 6);
  });

  document.body.removeChild(tmpTable);

  // ensure we return at least 8 columns; pad with fallback if necessary
  while(widths.length < fallback.length) widths.push(fallback[widths.length] || 80);

  // clamp wide columns (prevent absurdly wide columns by capping)
  const cap = 480;
  return widths.map(w => Math.min(w, cap));
}

// build a colgroup string from px widths (mark hidden-mobile cols)
function buildColgroup(widths){
  // mapping: 0 Distance,1 MarathonShape,2 Weekly,3 LongRun,4 Achieved,5 Icon,6 Prognosis,7 Optimum
  const classes = ['', '', '', '', '', '', 'hidden-mobile', 'hidden-mobile'];
  return '<colgroup>' + widths.map((w,i) => `<col style="width:${w}px"${classes[i] ? ` class="${classes[i]}"` : ''} />`).join('') + '</colgroup>';
}

/* Chart helper */
let vo2Chart = null;
function drawVo2(ctx, labels, datasets){
  const data = { labels, datasets };
  const opts = { responsive:true, plugins:{legend:{display:true}}, scales:{x:{type:'category'}, y:{beginAtZero:false}}, maintainAspectRatio:false };
  if(vo2Chart){ vo2Chart.data = data; vo2Chart.options = opts; vo2Chart.update(); return; }
  vo2Chart = new Chart(ctx, { type:'line', data, options:opts });
}

async function loadAndRender(){
  const errEl = el('errors');
  try{
    if(errEl) errEl.textContent = '';

    // fetch all data in parallel
    const promises = [];
    USERS.forEach(u => DATA_FILES.forEach(f => promises.push(fetchJSON(`data/${u}_${f}.json`).catch(()=>null))));
    const results = await Promise.all(promises);

    const users = {};
    for(let i=0;i<USERS.length;i++){
      const base = i*DATA_FILES.length;
      users[USERS[i]] = {
        vo2: results[base],
        marathon: results[base+1],
        prognosis: results[base+2],
        requirements: results[base+3]
      };
    }

    // VO2 chart
    const last30 = lastNDates(30);
    const datasets = USERS.map((u,idx) => {
      const map = vo2Map(users[u].vo2);
      const data = last30.map(d => (map[d] == null) ? null : Number(map[d]));
      const color = idx===0 ? 'rgba(75,192,192,1)' : 'rgba(255,99,132,1)';
      return { label: u[0].toUpperCase()+u.slice(1)+' VO₂', data, borderColor: color, backgroundColor: color.replace('1)','0.12)'), tension:0.25, pointRadius:3, spanGaps:true };
    });
    drawVo2(el('vo2Chart').getContext('2d'), last30, datasets);

    // build tables
    const tablesEl = el('tables');
    tablesEl.innerHTML = '';

    USERS.forEach(u => {
      const d = users[u];
      const marMap = (d.marathon && typeof d.marathon === 'object') ? d.marathon : {};
      const latest = findLatest(marMap);
      const currentPct = latest ? latest.value * 100 : null;

      // determine last-updated
      const metaCandidates = [d.marathon, d.requirements, d.prognosis];
      let lastUpdated = null;
      for(const c of metaCandidates){
        if(c && typeof c === 'object'){
          if(c._meta && c._meta.last_updated){ lastUpdated = c._meta.last_updated; break; }
          if(c.meta && c.meta.last_updated){ lastUpdated = c.meta.last_updated; break; }
        }
      }

      const header = `<div class="user-block user-${u}">
        <div><div class="user-title">${u[0].toUpperCase()+u.slice(1)}</div><div class="small">Latest marathon shape: ${currentPct!==null ? (Math.round(currentPct*100)/100) : 'N/A'}</div></div>
        ${ lastUpdated ? `<div class="user-meta">Last updated: ${fmtTs(lastUpdated)}</div>` : '' }
      </div>`;

      // rows: prefer parsed requirements
      const req = d.requirements;
      let rows = [];
      if(req && Array.isArray(req.entries) && req.entries.length){
        rows = req.entries.map(r => {
          const isGoal = isMarathonGoal(r);
          return {
            label: nbspMi(r.distance_label || (r.distance_mi ? `${r.distance_mi} mi` : '-')),
            required: (r.required_pct!=null) ? `${r.required_pct}%` : '-',
            weekly: nbspMi(r.weekly || '-'),
            longRun: nbspMi(r.long_run || '-'),
            achieved: (r.achieved_pct!=null) ? `${r.achieved_pct}%` : '-',
            icon: r.achieved_ok ? '<i class="fa-solid fa-check plus" aria-hidden="true"></i>' : '<i class="fa-solid fa-xmark minus" aria-hidden="true"></i>',
            prog: r.prognosis_time || '-',
            opt: (r.optimum_time && (r.achieved_pct==null || r.achieved_pct<100)) ? r.optimum_time : '-',
            goal: isGoal
          };
        });
      } else {
        // fallback rows (same order)
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
            label: nbspMi(r.label),
            required: `${r.p}%`,
            weekly: r.weekly,
            longRun: r.long,
            achieved,
            icon: ok ? '<i class="fa-solid fa-check plus" aria-hidden="true"></i>' : '<i class="fa-solid fa-xmark minus" aria-hidden="true"></i>',
            prog: '-', opt: '-', goal: (r.p === 100)
          };
        });
        // try to fill prognosis from d.prognosis.entries (best-effort)
        if(d.prognosis && Array.isArray(d.prognosis.entries)){
          rows = rows.map(row=>{
            const match = d.prognosis.entries.find(e=>{
              if(typeof e.distance_mi === 'number') return Math.abs(e.distance_mi - parseFloat(row.label)) < 0.5;
              const lbl = (e.distance_label||'').toString();
              return lbl && lbl.includes(row.label.split('\u00a0')[0]);
            });
            if(match && match.time) row.prog = match.time;
            return row;
          });
        }
      }

      // headerHtml and rowsHtml used for measuring natural widths
      const headerHtml = `
        <tr class="group-row">
          <th></th><th colspan="3">Required</th><th colspan="2"></th><th colspan="2" class="hidden-mobile"></th>
        </tr>
        <tr class="label-row">
          <th>Distance</th><th>Marathon Shape</th><th>Weekly mileage</th><th>Long Run</th><th>Achieved</th><th></th><th class="hidden-mobile">Prognosis</th><th class="hidden-mobile">Optimum</th>
        </tr>`;

      const rowsHtml = rows.map(r => `
        <tr class="r${r.goal ? ' marathon-goal top-separated bottom-separated' : ''}">
          <td class="nowrap-mi">${r.label}</td>
          <td>${r.required}</td>
          <td>${r.weekly}</td>
          <td>${r.longRun}</td>
          <td class="center">${r.achieved}</td>
          <td class="center">${r.icon}</td>
          <td class="left-separated hidden-mobile">${r.prog}</td>
          <td class="hidden-mobile">${r.opt}</td>
        </tr>`).join('');

      // measure natural widths and produce colgroup
      const widths = measureColumnWidths(headerHtml, rowsHtml);
      const colgroup = buildColgroup(widths);

      const tableHtml = `
        ${header}
        <table class="rz-table" aria-label="${u} marathon requirements">
          ${colgroup}
          <thead>${headerHtml}</thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;

      const wrapper = document.createElement('div');
      wrapper.className = `user-table user-${u}`;
      wrapper.innerHTML = tableHtml;
      tablesEl.appendChild(wrapper);
    });

  }catch(err){
    if(el('errors')) el('errors').textContent = err.message || String(err);
    console.error(err);
  }
}

window.addEventListener('load', loadAndRender);
