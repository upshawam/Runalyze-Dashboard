// app.js - show marathon-shape progress for the past month and VO2 trend
// Replace existing docs/app.js with this file.

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

// Convert trend JSON into [{x: Date, y: number}, ...]
function trendToPoints(trendObj) {
  if (!trendObj) return [];
  const obj = trendObj.data || trendObj.trend || trendObj;

  const entries = Object.entries(obj).map(([k, v]) => {
    let x = null;
    if (/^\d+$/.test(k)) {
      let n = Number(k);
      if (n < 1e12) n = n * 1000;
      x = new Date(n);
    } else {
      const parsed = Date.parse(k);
      x = isNaN(parsed) ? null : new Date(parsed);
    }

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

function filterLastNDays(points, n) {
  if (!points || points.length === 0) return [];
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - n + 1);
  return points.filter(p => p.x >= start && p.x <= end);
}

const ctxM = document.getElementById('chartMarathon').getContext('2d');
const ctxV = document.getElementById('chartVo2').getContext('2d');

const chartM = new Chart(ctxM, {
  type: 'line',
  data: { datasets: [] },
  options: {
    parsing: false,
    scales: {
      x: { type: 'time', time: { unit: 'day', tooltipFormat: 'DD LLL yyyy' }, ticks: { maxRotation:0, autoSkip:true } },
      y: { beginAtZero: false }
    },
    elements: { point: { radius: 3 }, line: { borderWidth: 2 } },
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
    elements: { point: { radius: 3 }, line: { borderWidth: 2 } },
    plugins: { legend: { display: true } },
    responsive: true,
    maintainAspectRatio: false
  }
});

function latestPoint(points) {
  if (!points || points.length === 0) return null;
  return points[points.length - 1];
}

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
    const [mAraw, mBraw, vAraw, vBraw] = await Promise.all([
      fetchJSON(mAPath).catch(err => { showError(err.message); return null; }),
      fetchJSON(mBPath).catch(err => { showError(err.message); return null; }),
      fetchJSON(vAPath).catch(err => { showError(err.message); return null; }),
      fetchJSON(vBPath).catch(err => { showError(err.message); return null; })
    ]);

    const mApointsAll = mAraw ? trendToPoints(mAraw) : [];
    const mBpointsAll = mBraw ? trendToPoints(mBraw) : [];
    const mApoints = filterLastNDays(mApointsAll, 30);
    const mBpoints = filterLastNDays(mBpointsAll, 30);

    // Ensure datasets use visible line settings and no full fill to avoid obscuring thin lines
    const dsM = [];
    if (mApoints.length) dsM.push({
      label: `${a} (30d)`,
      data: mApoints,
      borderColor: 'steelblue',
      backgroundColor: 'transparent',
      tension: 0.2,
      fill: false,
      pointRadius: 3,
      borderWidth: 2,
      showLine: true
    });
    if (mBpoints.length) dsM.push({
      label: `${b} (30d)`,
      data: mBpoints,
      borderColor: 'orange',
      backgroundColor: 'transparent',
      tension: 0.2,
      fill: false,
      pointRadius: 3,
      borderWidth: 2,
      showLine: true
    });
    chartM.data.datasets = dsM;

    const dsV = [];
    if (vAraw && (vAraw.trend || vAraw)) {
      const pts = trendToPoints(vAraw.trend || vAraw);
      dsV.push({ label: a, data: pts, borderColor: 'green', backgroundColor: 'transparent', fill:false, tension:0.1, borderWidth:2, pointRadius:3 });
    }
    if (vBraw && (vBraw.trend || vBraw)) {
      const pts = trendToPoints(vBraw.trend || vBraw);
      dsV.push({ label: b, data: pts, borderColor: 'purple', backgroundColor: 'transparent', fill:false, tension:0.1, borderWidth:2, pointRadius:3 });
    }
    chartV.data.datasets = dsV;

    // Force x-axis range for marathon to last 30 days to avoid collapsed domain
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 30 + 1);
    if (chartM.options && chartM.options.scales && chartM.options.scales.x) {
      chartM.options.scales.x.min = start;
      chartM.options.scales.x.max = end;
    }

    // status quick summary
    const mAlatest = latestPoint(mApoints);
    const mBlatest = latestPoint(mBpoints);
    const vAlatest = latestPoint(trendToPoints(vAraw ? (vAraw.trend || vAraw) : null));
    const vBlatest = latestPoint(trendToPoints(vBraw ? (vBraw.trend || vBraw) : null));

    let statusText = '';
    if (mAlatest) statusText += `${a} marathon(30d): ${mAlatest.y.toFixed(3)} `;
    if (mBlatest) statusText += `${b} marathon(30d): ${mBlatest.y.toFixed(3)} `;
    if (vAlatest) statusText += `${a} VO2: ${vAlatest.y.toFixed(2)} `;
    if (vBlatest) statusText += `${b} VO2: ${vBlatest.y.toFixed(2)} `;
    showStatus(statusText || 'Loaded');

    // Force resize, then update only if datasets present
    chartM.resize();
    chartV.resize();
    if (chartM.data.datasets && chartM.data.datasets.length) chartM.update();
    if (chartV.data.datasets && chartV.data.datasets.length) chartV.update();

    // Debug log (optional)
    console.log('Marathon 30d points', a, mApoints.length, b, mBpoints.length);
    console.log('VO2 points', a, vAlatest ? 'has' : 'none', b, vBlatest ? 'has' : 'none');

  } catch (e) {
    showError('Unexpected error: ' + e.message);
    showStatus('Error');
    console.error(e);
  }
}

refreshBtn.addEventListener('click', loadAndRender);
window.addEventListener('load', loadAndRender);
