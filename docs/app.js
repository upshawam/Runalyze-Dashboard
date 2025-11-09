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

// Return points from last n days (inclusive)
function filterLastNDays(points, n) {
  if (!points || points.length === 0) return [];
  const end = new Date(); // now
  const start = new Date(end);
  start.setDate(end.getDate() - n + 1); // include today as part of n days
  return points.filter(p => p.x >= start && p.x <= end);
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
      x: {
        type: 'time',
        time: { unit: 'day', tooltipFormat: 'DD LLL yyyy' },
        ticks: { maxRotation: 0, autoSkip: true }
      },
      y: { beginAtZero: false }
    },
    elements: { point: { radius: 3 } },
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
    elements: { point: { radius: 2 } },
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

    // Marathon: convert and show only last 30 days (progress graph)
    const mApointsAll = mAraw ? trendToPoints(mAraw) : [];
    const mBpointsAll = mBraw ? trendToPoints(mBraw) : [];
    const mApoints = filterLastNDays(mApointsAll, 30);
    const mBpoints = filterLastNDays(mBpointsAll, 30);

    // Build datasets for marathon (last 30 days)
    const dsM = [];
    if (mApoints.length) dsM.push({
      label: `${a} (30d)`,
      data: mApoints,
      borderColor: 'steelblue',
      backgroundColor: 'rgba(70,130,180,0.08)',
      tension: 0.2,
      fill: true,
      pointRadius: 3
    });
    if (mBpoints.length) dsM.push({
      label: `${b} (30d)`,
      data: mBpoints,
      borderColor: 'orange',
      backgroundColor: 'rgba(255,165,0,0.08)',
      tension: 0.2,
      fill: true,
      pointRadius: 3
    });
    chartM.data.datasets = dsM;

    // VO2: keep the trend series (full available range)
    const dsV = [];
    if (vAraw && (vAraw.trend || vAraw)) {
      const pts = trendToPoints(vAraw.trend || vAraw);
      dsV.push({ label: a, data: pts, borderColor: 'green', fill:false, tension:0.1 });
    }
    if (vBraw && (vBraw.trend || vBraw)) {
      const pts = trendToPoints(vBraw.trend || vBraw);
      dsV.push({ label: b, data: pts, borderColor: 'purple', fill:false, tension:0.1 });
    }
    chartV.data.datasets = dsV;

    // Show simple summary (current values) in status for quick confirmation
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

    // Debug logs
    console.log('Marathon 30d points', a, mApoints.length, b, mBpoints.length);
    console.log('VO2 points', a, vAlatest ? 'has' : 'none', b, vBlatest ? 'has' : 'none');

    // Update charts
    try { chartM.update(); } catch (e) { showError('ChartM update error: ' + e.message); console.error(e); }
    try { chartV.update(); } catch (e) { showError('ChartV update error: ' + e.message); console.error(e); }

  } catch (e) {
    showError('Unexpected error: ' + e.message);
    showStatus('Error');
    console.error(e);
  }
}

// Wire up button and initial load
refreshBtn.addEventListener('click', loadAndRender);
window.addEventListener('load', loadAndRender);
