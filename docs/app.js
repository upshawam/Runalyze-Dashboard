// app.js - loads JSON from data/<user>_*.json, converts to Chart.js points, and displays charts

const statusEl = document.getElementById('status');
const errorsEl = document.getElementById('errors');
const refreshBtn = document.getElementById('refreshBtn');

function showStatus(text) { statusEl.textContent = text; }
function showError(msg) {
  const el = document.createElement('div');
  el.className = 'error';
  el.textContent = msg;
  errorsEl.appendChild(el);
  console.error(msg);
}

async function fetchJSON(path) {
  try {
    const r = await fetch(path + '?t=' + Date.now());
    if (!r.ok) {
      const text = await r.text().catch(()=> '');
      throw new Error(`${r.status} ${r.statusText} - ${text.slice(0,200)}`);
    }
    return await r.json();
  } catch (e) {
    throw new Error(`Fetch ${path} failed: ${e.message}`);
  }
}

// Convert trend JSON (various shapes) into [{x: <Date>, y: <number>}...]
function trendToPoints(trendObj) {
  if (!trendObj) return [];
  const obj = trendObj.data || trendObj.trend || trendObj;

  const entries = Object.entries(obj).map(([k, v]) => {
    // Normalize x -> Date object
    let x = null;
    if (/^\d+$/.test(k)) {
      let n = Number(k);
      if (n < 1e12) n = n * 1000; // seconds -> ms
      x = new Date(n);
    } else {
      const parsed = Date.parse(k);
      x = isNaN(parsed) ? null : new Date(parsed);
    }

    // Normalize y
    let y = null;
    if (typeof v === 'number') y = v;
    else if (v && typeof v === 'object') {
      if (typeof v.value === 'number') y = v.value;
      else if (typeof v.y === 'number') y = v.y;
      else if (Array.isArray(v) && typeof v[0] === 'number') y = v[0];
      else {
        const num = Object.values(v).find(a => typeof a === 'number');
        if (typeof num === 'number') y = num;
      }
    }

    return { x, y };
  }).filter(pt => pt.y !== null && pt.x !== null);

  entries.sort((a, b) => a.x - b.x);
  return entries;
}

// Create charts
const ctxM = document.getElementById('chartMarathon').getContext('2d');
const ctxV = document.getElementById('chartVo2').getContext('2d');

const chartM = new Chart(ctxM, {
  type: 'line',
  data: { datasets: [] },
  options: {
    parsing: false,
    scales: {
      x: { type: 'time', time: { unit: 'day' } },
      y: { beginAtZero: true }
    },
    plugins: { legend: { display: true } },
    responsive: true,
    maintainAspectRatio: false
  }
});

const chartV = new Chart(ctxV, {
  type: 'line',
  data: { datasets: [] },
  options: {
    parsing: false,
    scales: { x: { type: 'time', time: { unit: 'day' } } },
    plugins: { legend: { display: true } },
    responsive: true,
    maintainAspectRatio: false
  }
});

async function loadAndRender() {
  errorsEl.innerHTML = '';
  showStatus('Loading…');

  const a = (document.getElementById('userA').value || 'kristin').trim();
  const b = (document.getElementById('userB').value || 'aaron').trim();

  const mAPath = `data/${a}_marathon.json`;
  const mBPath = `data/${b}_marathon.json`;
  const vAPath = `data/${a}_vo2.json`;
  const vBPath = `data/${b}_vo2.json`;

  try {
    const [mA, mB, vA, vB] = await Promise.all([
      fetchJSON(mAPath).catch(err => { showError(err.message); return null; }),
      fetchJSON(mBPath).catch(err => { showError(err.message); return null; }),
      fetchJSON(vAPath).catch(err => { showError(err.message); return null; }),
      fetchJSON(vBPath).catch(err => { showError(err.message); return null; })
    ]);

    // Build datasets
    const dsM = [];
    if (mA) dsM.push({ label: a, data: trendToPoints(mA), borderColor: 'steelblue', fill: false });
    if (mB) dsM.push({ label: b, data: trendToPoints(mB), borderColor: 'orange', fill: false });
    chartM.data.datasets = dsM;

    const dsV = [];
    if (vA && vA.trend) dsV.push({ label: a, data: trendToPoints(vA.trend), borderColor: 'green', fill:false });
    if (vB && vB.trend) dsV.push({ label: b, data: trendToPoints(vB.trend), borderColor: 'purple', fill:false });
    chartV.data.datasets = dsV;

    // Debug logs
    console.log('chartM datasets:', chartM.data.datasets);
    console.log('chartV datasets:', chartV.data.datasets);
    chartM.data.datasets.forEach(d=>console.log(d.label, 'points', d.data.length, d.data.slice(0,3)));
    chartV.data.datasets.forEach(d=>console.log(d.label, 'points', d.data.length, d.data.slice(0,3)));

    // Safely update charts
    try { chartM.update(); } catch (e) { showError('ChartM update error: ' + e.message); console.error(e); }
    try { chartV.update(); } catch (e) { showError('ChartV update error: ' + e.message); console.error(e); }

    if ((!mA && !mB) && (!vA && !vB)) showStatus('No data found for selected users.');
    else showStatus('Loaded');
  } catch (e) {
    showError('Unexpected error: ' + e.message);
    showStatus('Error');
    console.error(e);
  }
}

// Wire up button and initial load
refreshBtn.addEventListener('click', loadAndRender);
window.addEventListener('load', loadAndRender);
