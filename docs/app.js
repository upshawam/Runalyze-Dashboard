// --- replace the existing projection/header block with this ---
// projections
const projMap = computeProjectionsFromSeries(marSeries);
// recommended single date (median)
const rec = pickRecommendedDate(projMap);

// If any window already reached 100% earlier than 'rec', prefer showing "Reached: YYYY-MM-DD"
function firstReachedDate(seriesObj){
  const dates = Object.keys(seriesObj).sort();
  const values = dates.map(d => seriesObj[d]);
  const reached = findDateReachedFromLabels(dates, values, 100);
  return reached;
}
const reachedDate = firstReachedDate(marSeries);

// Decide single-line display
let projSingleText = '';
if (reachedDate) {
  projSingleText = `Reached: ${reachedDate.toISOString().slice(0,10)}`;
} else if (rec) {
  projSingleText = `Projected 100%: ${rec.toISOString().slice(0,10)}`;
} else {
  projSingleText = 'Projected 100%: No upward trend';
}

// Build header showing only the single projected date line
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
