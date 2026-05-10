'use strict';

// ── Color palette ──────────────────────────────────────────────
const PALETTE = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#e91e63', '#00bcd4', '#cddc39',
];

// ── GPX Parser ─────────────────────────────────────────────────
function parseGPX(xmlText, filename) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPXファイルの解析に失敗しました');

  const nameEl = doc.querySelector('trk > name') || doc.querySelector('name');
  const name = nameEl?.textContent?.trim() || filename.replace(/\.gpx$/i, '');

  const trkpts = [...doc.querySelectorAll('trkpt')];
  if (trkpts.length === 0) throw new Error('トラックポイントが見つかりません');

  const points = trkpts.map(pt => {
    const timeEl = pt.querySelector('time');
    return {
      lat: parseFloat(pt.getAttribute('lat')),
      lng: parseFloat(pt.getAttribute('lon')),
      ele: parseFloat(pt.querySelector('ele')?.textContent ?? 0),
      time: timeEl ? new Date(timeEl.textContent).getTime() : null,
    };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lng));

  if (points.length === 0) throw new Error('有効なトラックポイントがありません');

  // タイムスタンプなしの場合は 10 秒間隔で割り当て
  if (points.every(p => p.time === null)) {
    const base = Date.now();
    points.forEach((p, i) => { p.time = base + i * 10_000; });
  }

  return {
    name,
    points,
    startTime: points[0].time,
    endTime: points[points.length - 1].time,
  };
}

// ── Interpolate lat/lng at absolute time t (ms) ────────────────
function interpolatePosition(points, t) {
  if (t <= points[0].time) return { lat: points[0].lat, lng: points[0].lng, idx: 0 };
  const last = points[points.length - 1];
  if (t >= last.time) return { lat: last.lat, lng: last.lng, idx: points.length - 1 };

  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const ratio = (b.time === a.time) ? 0 : (t - a.time) / (b.time - a.time);
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lng: a.lng + (b.lng - a.lng) * ratio,
    idx: lo,
  };
}

// ── Leaflet map ────────────────────────────────────────────────
const map = L.map('map').setView([35.68, 139.75], 10);

const baseLayers = {
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19, crossOrigin: 'anonymous',
  }),
  '国土地理院 標準地図': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    maxZoom: 18, crossOrigin: 'anonymous',
  }),
  '国土地理院 淡色地図': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    maxZoom: 18, crossOrigin: 'anonymous',
  }),
  '国土地理院 写真': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    maxZoom: 18, crossOrigin: 'anonymous',
  }),
};

baseLayers['国土地理院 標準地図'].addTo(map);
L.control.layers(baseLayers, {}, { position: 'topright', collapsed: false }).addTo(map);

// ── Auto-follow settings (persistent, not reset with tracks) ──
const afSettings = {
  centerMode: 'avg',   // 'avg' | 'track'
  centerTrackIdx: 0,
  inPct: 30,           // zoom in when span < inPct% of screen
  outPct: 80,          // zoom out when span > outPct% of screen
  allowZoom: true,
};

// ── App state ──────────────────────────────────────────────────
const state = {
  tracks: [],
  mode: 'time',       // 'time' | 'elapsed'
  globalStart: null,  // mode=time: 最小startTime(ms絶対値)
  duration: 0,        // 再生総時間(ms)
  currentTime: 0,     // 再生位置 0..duration
  speed: 60,
  playing: false,
  lastFrame: null,
  colorIdx: 0,
  cpMarkers: [],
  cpLine: null,
  cps: [],
  autoFollow: true,
  afLat: null, afLng: null, afZoom: null,
};

// ── Track management ───────────────────────────────────────────
function bearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
           - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function buildTrackMarkerIcon(track) {
  const c = track.color;
  const s = track.iconSize || 14;
  const shadow = `filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))`;
  let inner, w, h;

  if (track.iconType === 'image' && track.iconImage) {
    w = h = Math.round(s * 30 / 14);
    inner = `<div class="track-icon-inner" style="width:${w}px;height:${h}px;border-radius:50%;overflow:hidden;border:2px solid ${c};box-shadow:0 1px 5px rgba(0,0,0,.6)"><img src="${track.iconImage}" style="width:100%;height:100%;object-fit:cover;display:block"></div>`;
  } else {
    switch (track.iconType) {
      case 'square':
        w = h = s;
        inner = `<div class="track-icon-inner" style="width:${w}px;height:${h}px;background:${c};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.6)"></div>`;
        break;
      case 'triangle': {
        w = s + 2; h = s;
        inner = `<svg class="track-icon-inner" width="${w}" height="${h}" style="display:block;${shadow}"><polygon points="${w/2},1 ${w-1},${h-1} 1,${h-1}" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`;
        break;
      }
      case 'diamond':
        w = h = s;
        inner = `<svg class="track-icon-inner" width="${w}" height="${h}" style="display:block;${shadow}"><polygon points="${w/2},1 ${w-1},${h/2} ${w/2},${h-1} 1,${h/2}" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`;
        break;
      case 'arrow': {
        w = s; h = Math.round(s * 9 / 7);
        const ny = Math.round(s * 5 / 7);
        inner = `<svg class="track-icon-inner" width="${w}" height="${h}" style="display:block;${shadow};transform-origin:${w/2}px ${h/2}px"><polygon points="${w/2},0 ${w},${s} ${w/2},${ny} 0,${s}" fill="${c}" stroke="#fff" stroke-width="1.2"/></svg>`;
        break;
      }
      default: // circle
        w = h = s;
        inner = `<div class="track-icon-inner" style="width:${w}px;height:${h}px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.6)"></div>`;
    }
  }
  return L.divIcon({ className: '', html: inner, iconSize: [w, h], iconAnchor: [w/2, h/2] });
}

// ── 画像クロップ ───────────────────────────────────────────────
const cropState = {
  img: null,
  x: 0, y: 0,      // クロップ中心（画像ピクセル座標）
  r: 0,             // クロップ半径（画像ピクセル）
  maxR: 0,
  dragging: false,
  dragOx: 0, dragOy: 0,
};
let cropScale = 1;  // canvas px / image px

const cropCanvas  = document.getElementById('crop-canvas');
const cropPreview = document.getElementById('crop-preview');
const cropCtx     = cropCanvas.getContext('2d');
const prevCtx     = cropPreview.getContext('2d');

function drawCropCanvas() {
  const { img, x, y, r } = cropState;
  const cx = x * cropScale, cy = y * cropScale, cr = r * cropScale;
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(img, 0, 0, cropCanvas.width, cropCanvas.height);
  // 円の外側を暗くする（evenodd で穴あき）
  cropCtx.save();
  cropCtx.fillStyle = 'rgba(0,0,0,0.55)';
  cropCtx.beginPath();
  cropCtx.rect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.arc(cx, cy, cr, 0, Math.PI * 2, true);
  cropCtx.fill('evenodd');
  cropCtx.restore();
  // 破線の円枠
  cropCtx.save();
  cropCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  cropCtx.lineWidth = 2;
  cropCtx.setLineDash([5, 4]);
  cropCtx.beginPath();
  cropCtx.arc(cx, cy, cr, 0, Math.PI * 2);
  cropCtx.stroke();
  cropCtx.restore();
}

function updateCropPreview() {
  const { img, x, y, r } = cropState;
  const size = cropPreview.width;
  prevCtx.clearRect(0, 0, size, size);
  prevCtx.save();
  prevCtx.beginPath();
  prevCtx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  prevCtx.clip();
  prevCtx.drawImage(img, x - r, y - r, r * 2, r * 2, 0, 0, size, size);
  prevCtx.restore();
}

function applyCrop() {
  const { img, x, y, r } = cropState;
  const size = 80;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, x - r, y - r, r * 2, r * 2, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

function openCropDialog(img) {
  cropState.img = img;
  const maxPx = 320;
  const aspect = img.naturalWidth / img.naturalHeight;
  let cw, ch;
  if (aspect >= 1) { cw = maxPx; ch = Math.round(maxPx / aspect); }
  else             { ch = maxPx; cw = Math.round(maxPx * aspect); }
  cropCanvas.width  = cw; cropCanvas.height = ch;
  cropCanvas.style.width = cw + 'px'; cropCanvas.style.height = ch + 'px';
  cropScale       = cw / img.naturalWidth;
  cropState.maxR  = Math.min(img.naturalWidth, img.naturalHeight) / 2;
  cropState.r     = cropState.maxR * 0.8;
  cropState.x     = img.naturalWidth  / 2;
  cropState.y     = img.naturalHeight / 2;
  document.getElementById('crop-size').value = 80;
  drawCropCanvas();
  updateCropPreview();
  document.getElementById('crop-dialog').showModal();
}

// キャンバス座標変換
function canvasPt(e) {
  const rect = cropCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (cropCanvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (cropCanvas.height / rect.height),
  };
}

cropCanvas.addEventListener('mousedown', e => {
  const p = canvasPt(e);
  cropState.dragging = true;
  cropState.dragOx = p.x - cropState.x * cropScale;
  cropState.dragOy = p.y - cropState.y * cropScale;
  e.preventDefault();
});
cropCanvas.addEventListener('mousemove', e => {
  if (!cropState.dragging) return;
  const p = canvasPt(e);
  const r = cropState.r, img = cropState.img;
  cropState.x = Math.max(r, Math.min(img.naturalWidth  - r, (p.x - cropState.dragOx) / cropScale));
  cropState.y = Math.max(r, Math.min(img.naturalHeight - r, (p.y - cropState.dragOy) / cropScale));
  drawCropCanvas(); updateCropPreview();
});
document.addEventListener('mouseup', () => { cropState.dragging = false; });

// タッチ対応
cropCanvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const t = e.touches[0];
  cropCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: t.clientX, clientY: t.clientY }));
}, { passive: false });
cropCanvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0];
  cropCanvas.dispatchEvent(new MouseEvent('mousemove', { clientX: t.clientX, clientY: t.clientY }));
}, { passive: false });
cropCanvas.addEventListener('touchend', () => { cropState.dragging = false; });

// サイズスライダー
document.getElementById('crop-size').addEventListener('input', e => {
  const pct = parseInt(e.target.value) / 100;
  cropState.r = cropState.maxR * pct;
  const r = cropState.r, img = cropState.img;
  cropState.x = Math.max(r, Math.min(img.naturalWidth  - r, cropState.x));
  cropState.y = Math.max(r, Math.min(img.naturalHeight - r, cropState.y));
  drawCropCanvas(); updateCropPreview();
});

// 確定 / キャンセル
document.getElementById('crop-ok').addEventListener('click', () => {
  tsdPendingImage = applyCrop();
  showImageSection(true, tsdPendingImage);
  document.getElementById('crop-dialog').close();
});
document.getElementById('crop-cancel').addEventListener('click', () => {
  document.getElementById('crop-dialog').close();
});

// ── Global time recalculation ──────────────────────────────────
function recalcGlobalTimes() {
  if (!state.tracks.length) {
    state.globalStart = null;
    state.duration = 0;
    return;
  }
  if (state.mode === 'time') {
    state.globalStart = Math.min(...state.tracks.map(t => t.data.startTime));
    const globalEnd   = Math.max(...state.tracks.map(t => t.data.endTime));
    state.duration    = globalEnd - state.globalStart;
  } else {
    state.globalStart = null;
    state.duration = Math.max(0, ...state.tracks.map(t => t.data.endTime - t.userStartTime));
  }
  state.currentTime = Math.min(state.currentTime, state.duration);
}

function addTrack(data, filename) {
  const color = PALETTE[state.colorIdx % PALETTE.length];
  state.colorIdx++;

  // 正規化しない — 元のタイムスタンプをそのまま保持
  const track = {
    data, filename, color,
    displayName:   data.name,
    userStartTime: data.startTime,
    iconType:      'circle',
    iconImage:     null,     // 丸クリップ済み画像の data URL
    iconSize:      14,
    lineWeight:    4,
    trailDuration: 60_000,   // デフォルト1分
    ghostLine: null, activeLine: null, marker: null,
    cpTimes: null, cpTrailMarkers: {},
    _prevElapsed: null, _bubbleUntil: 0, _bubbleCpNum: null,
    _lastCpLabel: '', _cpLabelEl: null,
  };

  const latlngs = data.points.map(p => [p.lat, p.lng]);
  track.ghostLine  = L.polyline(latlngs, { color, weight: 2, opacity: 0.25 }).addTo(map);
  track.activeLine = L.polyline([], { color, weight: track.lineWeight, opacity: 0.9 }).addTo(map);
  track.marker     = L.marker([data.points[0].lat, data.points[0].lng], { icon: buildTrackMarkerIcon(track) }).addTo(map);
  track.marker.bindTooltip(track.displayName, { permanent: false, direction: 'top' });

  state.tracks.push(track);

  recalcGlobalTimes();

  // Fit map
  const bounds = L.latLngBounds(state.tracks.flatMap(t => t.data.points.map(p => [p.lat, p.lng])));
  map.fitBounds(bounds, { padding: [40, 40] });

  updateTrackList();
  updateSlider();
  renderFrame();
}

function removeTrack(idx) {
  const t = state.tracks.splice(idx, 1)[0];
  t.ghostLine.remove();
  t.activeLine.remove();
  t.marker.remove();
  Object.values(t.cpTrailMarkers).forEach(m => m.remove());
  t.cpTrailMarkers = {};

  if (state.tracks.length === 0) {
    state.currentTime = 0;
    pause();
  }
  recalcGlobalTimes();

  updateTrackList();
  updateSlider();
  updateTimeDisplay();
}

// ── Playback engine ────────────────────────────────────────────
function tick(timestamp) {
  if (!state.playing) return;

  if (state.lastFrame !== null) {
    const elapsed = timestamp - state.lastFrame;
    state.currentTime += elapsed * state.speed;

    if (state.currentTime >= state.duration) {
      state.currentTime = state.duration;
      state.playing = false;
      updatePlayBtn();
    }
  }
  state.lastFrame = timestamp;
  renderFrame();
  if (state.playing) requestAnimationFrame(tick);
}

// ── CP通過吹き出し ───────────────────────────────────────────────

function cptToMs(val) {
  const m = val && val.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000;
}

function refreshCPTrailMarkers(track) {
  for (const [num, val] of Object.entries(track.cpTimes || {})) {
    const cpMs = cptToMs(val);
    if (cpMs !== null && !track.cpTrailMarkers[num]) {
      const { lat, lng } = interpolatePosition(track.data.points, track.userStartTime + cpMs);
      track.cpTrailMarkers[num] = L.circleMarker([lat, lng], {
        radius: 5, color: '#fff', weight: 2,
        fillColor: track.color, fillOpacity: 1,
      }).addTo(map);
    }
  }
  for (const num of Object.keys(track.cpTrailMarkers)) {
    const val = track.cpTimes?.[num];
    if (!val || cptToMs(val) === null) {
      track.cpTrailMarkers[num].remove();
      delete track.cpTrailMarkers[num];
    }
  }
}

function updateTrackBubble(track, elapsed) {
  const now = Date.now();

  // CP通過検出（前フレームから前進した場合のみ）
  if (track._prevElapsed !== null && elapsed > track._prevElapsed) {
    let lastPassed = null;
    for (const [num, val] of Object.entries(track.cpTimes || {})) {
      const ms = cptToMs(val);
      if (ms !== null && ms > track._prevElapsed && ms <= elapsed) {
        if (!lastPassed || ms > lastPassed.ms) lastPassed = { num, ms };
      }
    }
    if (lastPassed) {
      track._bubbleUntil = now + 2000;
      track._bubbleCpNum = lastPassed.num;
    }
  } else if (track._prevElapsed !== null && elapsed < track._prevElapsed) {
    // 逆方向シーク → 吹き出し即消去
    track._bubbleUntil = 0;
  }
  track._prevElapsed = elapsed;

  // 表示制御
  if (now < track._bubbleUntil) {
    const cpNum = track._bubbleCpNum;
    const thisMs = cptToMs(track.cpTimes?.[cpNum]);
    const timeStr = track.cpTimes?.[cpNum] ?? fmtElapsed(Math.max(0, elapsed));

    // 全トラック中の同CP最速タイムを求めて差分を計算
    let diffStr = '';
    if (thisMs !== null) {
      let minMs = Infinity;
      for (const t of state.tracks) {
        const ms = cptToMs(t.cpTimes?.[cpNum]);
        if (ms !== null && ms < minMs) minMs = ms;
      }
      if (thisMs > minMs) diffStr = ` (+${fmtElapsed(thisMs - minMs)})`;
    }

    const prefix = String(cpNum).toUpperCase() === 'F' ? '' : 'CP';
    const labelText = `${prefix}${cpNum}:${timeStr}${diffStr}`;
    if (track._lastCpLabel !== labelText) {
      track._lastCpLabel = labelText;
      updateTrackList();  // 順位更新
    }

    const html = `<b>${labelText}</b>`;

    const tt = track.marker.getTooltip();
    if (!tt?.options.permanent) {
      track.marker.unbindTooltip();
      track.marker.bindTooltip(html, {
        permanent: true, direction: 'top',
        className: 'cp-bubble', offset: [0, -4],
      });
      track.marker.openTooltip();
    } else {
      track.marker.setTooltipContent(html);
    }
  } else {
    const tt = track.marker.getTooltip();
    if (tt?.options.permanent) {
      track.marker.unbindTooltip();
      track.marker.bindTooltip(track.displayName, { permanent: false, direction: 'top' });
    }
  }
}

function renderFrame() {
  if (!state.tracks.length || !state.duration) return;

  for (const track of state.tracks) {
    const absTime = state.mode === 'time'
      ? state.globalStart + state.currentTime
      : track.userStartTime + state.currentTime;
    const { lat, lng, idx } = interpolatePosition(track.data.points, absTime);
    track.marker.setLatLng([lat, lng]);

    // 軌跡（trail duration 考慮）
    let covered = [];
    if (track.trailDuration > 0) {
      const trailStart = absTime - track.trailDuration;
      const si = track.data.points.findIndex(p => p.time >= trailStart);
      if (si >= 0) {
        // トレイル窓がまだポイントにかかっている
        covered = track.data.points.slice(si, idx + 1).map(p => [p.lat, p.lng]);
        if (covered.length) covered.push([lat, lng]);
      }
      // si < 0 → trailStart がすべてのポイントより未来 = トレイル消滅、covered は空のまま
    } else {
      covered = track.data.points.slice(0, idx + 1).map(p => [p.lat, p.lng]);
      if (covered.length) covered.push([lat, lng]);
    }
    track.activeLine.setLatLngs(covered);

    // 矢印アイコンの向きを進行方向に回転
    if (track.iconType === 'arrow') {
      const next = track.data.points[Math.min(idx + 1, track.data.points.length - 1)];
      if (next) {
        const brng = bearing(lat, lng, next.lat, next.lng);
        const el = track.marker.getElement()?.querySelector('.track-icon-inner');
        if (el) el.style.transform = `rotate(${brng}deg)`;
      }
    }

    updateTrackBubble(track, absTime - track.userStartTime);

  }

  updateSlider();
  updateTimeDisplay();

  if (state.autoFollow) followMap();
}

// ヒステリシスあり自動追従ズーム計算
// 中心 (centerLat, centerLng) からのピクセル距離で span を計算するため、
// 中心が重心でない場合でも正しく動作する
function computeFollowZoom(positions, centerLat, centerLng, cw, ch, inPct, outPct, currentZoom) {
  if (!positions.length) return currentZoom ?? 12;

  // 中心から各ポイントへのピクセル距離の最大値 × 2 が必要キャンバスサイズ
  const spanMaxPct = z => {
    const cx = lngToTileX(centerLng, z);
    const cy = latToTileY(centerLat, z);
    let maxHX = 0, maxHY = 0;
    for (const p of positions) {
      maxHX = Math.max(maxHX, Math.abs(lngToTileX(p.lng, z) - cx) * 256);
      maxHY = Math.max(maxHY, Math.abs(latToTileY(p.lat, z) - cy) * 256);
    }
    return Math.max(2 * maxHX / cw, 2 * maxHY / ch) * 100;
  };

  const cz = currentZoom != null ? currentZoom : 12;
  const curPct = spanMaxPct(cz);

  // 安定域: ズーム変更なし
  if (curPct >= inPct && curPct <= outPct) return cz;

  if (curPct > outPct) {
    // 縮小: spanMaxPct <= outPct になる最高整数ズームを探す
    let z = Math.round(cz);
    while (z >= 1 && spanMaxPct(z) > outPct) z--;
    return Math.max(1, z);
  }

  // curPct < inPct: 拡大 - spanMaxPct >= inPct になる最低整数ズームを探す
  let z = Math.round(cz);
  while (z < 18 && spanMaxPct(z) < inPct) z++;
  while (z > 1  && spanMaxPct(z) > outPct) z--;
  return Math.min(18, z);
}

function followMap() {
  if (!state.tracks.length) return;
  const positions = state.tracks.map(track => {
    const absTime = state.mode === 'time'
      ? state.globalStart + state.currentTime
      : track.userStartTime + state.currentTime;
    const { lat, lng } = interpolatePosition(track.data.points, absTime);
    return { lat, lng };
  });

  // 初回: 現在のマップ状態からスムース状態を初期化
  if (state.afLat === null) {
    const c = map.getCenter();
    state.afLat = c.lat; state.afLng = c.lng; state.afZoom = map.getZoom();
  }

  // 目標中心を先に決定 (ズーム計算の基準点になる)
  let targetLat, targetLng;
  if (afSettings.centerMode === 'track') {
    const idx = Math.min(Math.max(0, afSettings.centerTrackIdx), positions.length - 1);
    targetLat = positions[idx].lat;
    targetLng = positions[idx].lng;
  } else {
    const lats = positions.map(p => p.lat);
    const lngs = positions.map(p => p.lng);
    targetLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    targetLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  }

  const sz = map.getSize();
  if (afSettings.allowZoom) {
    const targetZoom = computeFollowZoom(
      positions, targetLat, targetLng, sz.x, sz.y,
      afSettings.inPct, afSettings.outPct, state.afZoom
    );
    state.afZoom = state.afZoom * 0.85 + targetZoom * 0.15;
  } else {
    state.afZoom = map.getZoom();
  }
  state.afLat  = state.afLat  * 0.9  + targetLat * 0.1;
  state.afLng  = state.afLng  * 0.9  + targetLng * 0.1;
  map.setView([state.afLat, state.afLng], state.afZoom, { animate: false });
}

function play() {
  if (!state.tracks.length) return;
  if (state.currentTime >= state.duration) state.currentTime = 0;
  state.playing = true;
  state.lastFrame = null;
  updatePlayBtn();
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  state.lastFrame = null;
  updatePlayBtn();
}

function reset() {
  pause();
  state.currentTime = 0;
  renderFrame();
}

function seek(ms) {
  state.currentTime = Math.max(0, Math.min(ms, state.duration));
  renderFrame();
}

// ── UI helpers ─────────────────────────────────────────────────
const btnPlay    = document.getElementById('btn-play');
const btnReset   = document.getElementById('btn-reset');
const slider     = document.getElementById('slider');
const timeDisp   = document.getElementById('time-display');
const speedSel   = document.getElementById('speed');
const trackList  = document.getElementById('track-list');
const emptyHint  = document.getElementById('empty-hint');
const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('file-input');

function updatePlayBtn() {
  btnPlay.textContent = state.playing ? '⏸' : '▶';
}

function updateSlider() {
  slider.max   = state.duration || 1000;
  slider.value = state.currentTime;
}

function fmtElapsed(ms) {
  const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function updateTimeDisplay() {
  if (!state.duration) { timeDisp.textContent = '--:--:--'; return; }
  if (state.mode === 'time' && state.globalStart !== null) {
    const abs = new Date(state.globalStart + state.currentTime);
    timeDisp.textContent = `${abs.toLocaleTimeString('ja-JP')}  +${fmtElapsed(state.currentTime)}`;
  } else {
    timeDisp.textContent = `経過 ${fmtElapsed(state.currentTime)}`;
  }
}

function buildListIcon(track) {
  const c = track.color;
  const sz = 24;
  switch (track.iconType) {
    case 'image':
      if (track.iconImage) {
        return `<span style="display:inline-block;width:${sz}px;height:${sz}px;border-radius:50%;overflow:hidden;border:2px solid ${c};flex-shrink:0"><img src="${track.iconImage}" style="width:100%;height:100%;object-fit:cover;display:block"></span>`;
      }
      break;
    case 'square':
      return `<span style="display:inline-block;width:${sz}px;height:${sz}px;background:${c};border-radius:2px;flex-shrink:0"></span>`;
    case 'triangle':
      return `<svg width="${sz}" height="${sz}" style="flex-shrink:0"><polygon points="${sz/2},1 ${sz-1},${sz-1} 1,${sz-1}" fill="${c}"/></svg>`;
    case 'diamond':
      return `<svg width="${sz}" height="${sz}" style="flex-shrink:0"><polygon points="${sz/2},1 ${sz-1},${sz/2} ${sz/2},${sz-1} 1,${sz/2}" fill="${c}"/></svg>`;
    case 'arrow':
      return `<svg width="${sz}" height="${sz}" style="flex-shrink:0"><polygon points="${sz/2},1 ${sz-1},${sz-1} ${sz/2},${sz-4} 1,${sz-1}" fill="${c}"/></svg>`;
  }
  // デフォルト: 円
  return `<span style="display:inline-block;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};flex-shrink:0"></span>`;
}

function updateTrackList() {
  trackList.innerHTML = '';
  emptyHint.style.display = state.tracks.length ? 'none' : 'block';

  // F通過時刻で昇順ソート（未フィニッシュは末尾）
  const ranked = state.tracks
    .map((track, idx) => ({ track, idx }))
    .sort((a, b) => {
      const fa = cptToMs(a.track.cpTimes?.['F']) ?? Infinity;
      const fb = cptToMs(b.track.cpTimes?.['F']) ?? Infinity;
      return fa - fb;
    });

  ranked.forEach(({ track, idx }) => {
    const li = document.createElement('li');
    li.style.cssText = 'flex-direction:column;align-items:stretch;cursor:default';

    const startLabel = state.mode === 'elapsed'
      ? `<div class="track-start">🕐 ${new Date(track.userStartTime).toLocaleString('ja-JP')}</div>`
      : '';

    li.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        ${buildListIcon(track)}
        <span class="track-name" title="${track.filename}">${track.displayName}</span>
        <button class="remove-btn" data-idx="${idx}" title="削除">×</button>
      </div>
      ${startLabel}`;

    const cpLabelEl = document.createElement('div');
    cpLabelEl.className = 'track-cp-label';
    if (track._lastCpLabel) cpLabelEl.textContent = track._lastCpLabel;
    li.appendChild(cpLabelEl);
    track._cpLabelEl = cpLabelEl;

    trackList.appendChild(li);

    li.addEventListener('dblclick', e => {
      if (e.target.classList.contains('remove-btn')) return;
      openTrackSettings(idx);
    });
  });

  trackList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeTrack(Number(btn.dataset.idx)));
  });
}

// ── Event listeners ────────────────────────────────────────────
btnPlay.addEventListener('click', () => state.playing ? pause() : play());
btnReset.addEventListener('click', reset);

document.querySelectorAll('.skip-btn').forEach(btn => {
  btn.addEventListener('click', () => seek(state.currentTime + parseInt(btn.dataset.skip)));
});

speedSel.addEventListener('change', () => { state.speed = parseFloat(speedSel.value); });

let wasPLayingBeforeSeek = false;
slider.addEventListener('mousedown', () => {
  wasPLayingBeforeSeek = state.playing;
  if (state.playing) pause();
});
slider.addEventListener('input', () => seek(parseFloat(slider.value)));
slider.addEventListener('mouseup', () => { if (wasPLayingBeforeSeek) play(); });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
  if (e.code === 'KeyR')  reset();
});

// File loading
async function loadFiles(files) {
  for (const file of [...files]) {
    if (!file.name.toLowerCase().endsWith('.gpx')) continue;
    try {
      const text = await file.text();
      addTrack(parseGPX(text, file.name), file.name);
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
}

fileInput.addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  loadFiles(e.dataTransfer.files);
});

// ── CP (Control Point) ────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('データ行がありません');

  const header = lines[0].toLowerCase().split(',').map(h => h.trim());
  const hasName = header.includes('name');
  const idxNum  = header.indexOf('number');
  const idxName = header.indexOf('name');
  const idxLat  = header.indexOf('lat');
  const idxLng  = header.indexOf('lng');

  if (idxNum < 0 || idxLat < 0 || idxLng < 0) {
    throw new Error('ヘッダーに number, lat, lng が必要です');
  }

  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.trim());
    const lat = parseFloat(cols[idxLat]);
    const lng = parseFloat(cols[idxLng]);
    if (isNaN(lat) || isNaN(lng)) return null;
    return {
      number: cols[idxNum] ?? '',
      name: hasName ? (cols[idxName] ?? '') : '',
      lat,
      lng,
    };
  }).filter(Boolean);
}

function buildCPIcon(cp) {
  const n      = cp.number.toString().toUpperCase();
  const stroke = '#cc0000';
  const fill   = 'none';
  const sw     = 2.8;
  let html, w, h, ax, ay;

  if (n === 'S' || cp.type === 'start') {
    w = 44; h = 40; ax = w / 2; ay = h / 2;
    html = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="${w/2},${sw} ${w-sw},${h-sw} ${sw},${h-sw}"
        fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
    </svg>`;
  } else if (n === 'F' || cp.type === 'finish') {
    w = 46; h = 46; ax = w / 2; ay = h / 2;
    const r1 = w / 2 - sw, r2 = r1 * 0.58;
    html = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${w/2}" cy="${h/2}" r="${r1}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
      <circle cx="${w/2}" cy="${h/2}" r="${r2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
    </svg>`;
  } else {
    // 赤丸 + ラベル（offsetDistance・angle・fontSize で位置を決定）
    const r        = 17;
    const lbl      = cp.label;
    const offsetPx = lbl ? lbl.offsetDistance * 0.7 : 24;
    const angleDeg = lbl ? lbl.angle            : 315;
    const fs       = lbl ? Math.max(8, Math.round(lbl.fontSize * 0.35)) : 12;

    // angle: 0=北(上)、時計回り（オリエンテーリング標準）
    const rad = angleDeg * Math.PI / 180;
    const dx  =  offsetPx * Math.sin(rad);
    const dy  = -offsetPx * Math.cos(rad);

    w = 120; h = 120; ax = 60; ay = 60;
    const lx = 60 + dx, ly = 60 + dy;

    html = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="60" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
      <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle"
        font-size="${fs}" font-weight="700" font-family="sans-serif"
        fill="${stroke}" paint-order="stroke" stroke="white" stroke-width="3">${n}</text>
    </svg>`;
  }

  return L.divIcon({ className: '', html, iconSize: [w, h], iconAnchor: [ax, ay] });
}

function clearCPs() {
  state.cpMarkers.forEach(m => m.remove());
  state.cpMarkers = [];
  state.cps = [];
  if (state.cpLine) { state.cpLine.remove(); state.cpLine = null; }
  document.getElementById('cp-status').classList.remove('visible');
  document.getElementById('cp-count').textContent = '';
}

function parseOmap(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.points)) throw new Error('points フィールドが見つかりません');
  return data.points
    .filter(p => Array.isArray(p.position) && p.position.length === 2)
    .map(p => ({
      number: p.displayLabel ?? String(p.order),
      name:   p.description ?? '',
      type:   p.type ?? 'normal',
      lat:    p.position[1],   // position は [lng, lat]
      lng:    p.position[0],
      order:  p.order ?? 0,
      label:  p.label ?? null, // { offsetDistance, angle, fontSize }
    }));
}

function loadCPs(cps) {
  if (cps.length === 0) throw new Error('有効なCPデータがありません');

  clearCPs();
  state.cps = cps;

  // コース順: start → 数字昇順 → finish
  const sorted = [...cps].sort((a, b) => {
    const rank = v => (v.type === 'start' || v.number === 'S') ? -1
                    : (v.type === 'finish' || v.number === 'F') ? Infinity
                    : Number(v.number);
    return rank(a) - rank(b);
  });

  sorted.forEach(cp => {
    const marker = L.marker([cp.lat, cp.lng], { icon: buildCPIcon(cp) }).addTo(map);
    const tooltip = cp.name ? `${cp.number}: ${cp.name}` : `CP ${cp.number}`;
    marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -12] });
    state.cpMarkers.push(marker);
  });

  state.cpLine = L.polyline(
    sorted.map(cp => [cp.lat, cp.lng]),
    { color: '#9b59b6', weight: 2, opacity: 0.7, dashArray: '6,4' }
  ).addTo(map);

  document.getElementById('cp-count').textContent = `${cps.length} CP 読み込み済み`;
  document.getElementById('cp-status').classList.add('visible');
}

const cpFileInput  = document.getElementById('cp-file-input');
const cpDropzone   = document.getElementById('cp-dropzone');
const btnClearCP   = document.getElementById('btn-clear-cp');

async function handleCPFile(file) {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.mcp')) return;
  try {
    const text = await file.text();
    const cps  = name.endsWith('.mcp') ? parseOmap(text) : parseCSV(text);
    loadCPs(cps);
  } catch (err) {
    alert(`CP読み込みエラー: ${err.message}`);
  }
}

cpFileInput.addEventListener('change', e => { if (e.target.files[0]) handleCPFile(e.target.files[0]); e.target.value = ''; });
cpDropzone.addEventListener('click', () => cpFileInput.click());
cpDropzone.addEventListener('dragover',  e => { e.preventDefault(); cpDropzone.classList.add('drag-over'); });
cpDropzone.addEventListener('dragleave', () => cpDropzone.classList.remove('drag-over'));
cpDropzone.addEventListener('drop', e => {
  e.preventDefault();
  cpDropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleCPFile(e.dataTransfer.files[0]);
});
btnClearCP.addEventListener('click', clearCPs);

// ── Mode switch ────────────────────────────────────────────────
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', e => {
    state.mode = e.target.value;
    recalcGlobalTimes();
    updateSlider();
    updateTrackList();
    renderFrame();
  });
});

// ── Track settings dialog ──────────────────────────────────────
const tsdDialog = document.getElementById('track-settings-dialog');
let tsdIdx = -1;

function toDatetimeLocal(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function showImageSection(visible, dataUrl) {
  document.getElementById('tsd-image-section').style.display = visible ? 'block' : 'none';
  const preview = document.getElementById('tsd-img-preview');
  const hint    = document.getElementById('tsd-img-hint');
  if (dataUrl) {
    preview.style.display = 'flex';
    preview.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    hint.textContent = '変更するには再度選択またはドロップ';
  } else {
    preview.style.display = 'none';
    preview.innerHTML = '';
    hint.textContent = '画像をドロップまたはクリックして選択';
  }
}

let tsdPendingImage = null;

function openTrackSettings(idx) {
  const track = state.tracks[idx];
  tsdIdx = idx;
  tsdPendingImage = track.iconImage;

  document.getElementById('tsd-name').value    = track.displayName;
  document.getElementById('tsd-start').value   = toDatetimeLocal(track.userStartTime);
  const iconRadio = document.querySelector(`input[name="tsd-icon"][value="${track.iconType}"]`);
  if (iconRadio) iconRadio.checked = true;
  document.getElementById('tsd-color').value   = track.color;
  document.getElementById('tsd-trail').value   = String(track.trailDuration);
  document.getElementById('tsd-weight').value  = String(track.lineWeight);
  document.getElementById('tsd-weight-val').textContent = String(track.lineWeight);
  document.getElementById('tsd-iconsize').value = String(track.iconSize || 14);
  document.getElementById('tsd-iconsize-val').textContent = String(track.iconSize || 14);
  showImageSection(track.iconType === 'image', tsdPendingImage);
  tsdDialog.showModal();
}

// アイコン種類切り替えで画像セクション表示/非表示
document.querySelectorAll('input[name="tsd-icon"]').forEach(r => {
  r.addEventListener('change', () => {
    showImageSection(r.value === 'image', tsdPendingImage);
  });
});

// 画像アップロード
const tsdImgInput = document.getElementById('tsd-img-input');
const tsdImgDrop  = document.getElementById('tsd-img-drop');

function handleTsdImageFile(file) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onerror = () => alert('画像の読み込みに失敗しました');
  reader.onload = e => {
    const img = new Image();
    img.onerror = () => alert('画像の読み込みに失敗しました');
    img.onload  = () => openCropDialog(img);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

tsdImgDrop.addEventListener('click', () => tsdImgInput.click());
tsdImgDrop.addEventListener('dragover',  e => { e.preventDefault(); tsdImgDrop.classList.add('drag-over'); });
tsdImgDrop.addEventListener('dragleave', () => tsdImgDrop.classList.remove('drag-over'));
tsdImgDrop.addEventListener('drop', e => {
  e.preventDefault(); tsdImgDrop.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleTsdImageFile(e.dataTransfer.files[0]);
});
tsdImgInput.addEventListener('change', e => {
  if (e.target.files[0]) handleTsdImageFile(e.target.files[0]);
  e.target.value = '';
});

document.getElementById('tsd-weight').addEventListener('input', e => {
  document.getElementById('tsd-weight-val').textContent = e.target.value;
});
document.getElementById('tsd-iconsize').addEventListener('input', e => {
  document.getElementById('tsd-iconsize-val').textContent = e.target.value;
});

document.getElementById('tsd-ok').addEventListener('click', () => {
  if (tsdIdx < 0) { tsdDialog.close(); return; }
  const track = state.tracks[tsdIdx];

  const newName   = document.getElementById('tsd-name').value.trim() || track.displayName;
  const newStart  = document.getElementById('tsd-start').value;
  const newIcon   = document.querySelector('input[name="tsd-icon"]:checked')?.value || 'circle';
  const newColor  = document.getElementById('tsd-color').value;
  const newTrail    = parseInt(document.getElementById('tsd-trail').value);
  const newWeight   = parseInt(document.getElementById('tsd-weight').value);
  const newIconSize = parseInt(document.getElementById('tsd-iconsize').value);

  track.displayName   = newName;
  if (newStart) track.userStartTime = new Date(newStart).getTime();
  track.iconType      = newIcon;
  track.iconImage     = (newIcon === 'image') ? (tsdPendingImage ?? track.iconImage) : null;
  track.iconSize      = newIconSize;
  track.color         = newColor;
  track.trailDuration = newTrail;
  track.lineWeight    = newWeight;

  // 地図要素を即時更新
  track.marker.setIcon(buildTrackMarkerIcon(track));
  track.marker.setTooltipContent(track.displayName);
  track.ghostLine.setStyle({ color: newColor });
  track.activeLine.setStyle({ color: newColor, weight: newWeight });

  recalcGlobalTimes();
  updateSlider();
  updateTrackList();
  renderFrame();
  tsdDialog.close();
});
document.getElementById('tsd-cancel').addEventListener('click', () => tsdDialog.close());

// ── Canvas recording helpers ───────────────────────────────────

function drawLatLngsOnCtx(ctx, latlngs) {
  if (!latlngs.length) return;
  ctx.beginPath();
  latlngs.forEach((ll, i) => {
    const pt = map.latLngToContainerPoint(ll);
    i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();
}

function drawTrackMarkerOnCtx(ctx, track) {
  const ll = track.marker.getLatLng();
  const pt = map.latLngToContainerPoint(ll);
  const s  = track.iconSize || 14;
  const c  = track.color;

  ctx.save();
  ctx.translate(pt.x, pt.y);
  ctx.shadowBlur = 5;
  ctx.shadowColor = 'rgba(0,0,0,0.55)';

  if (track.iconType === 'arrow') {
    const inner = track.marker.getElement()?.querySelector('.track-icon-inner');
    const m = inner?.style.transform?.match(/rotate\(([\d.]+)deg\)/);
    if (m) ctx.rotate(parseFloat(m[1]) * Math.PI / 180);
  }

  switch (track.iconType) {
    case 'square':
      ctx.fillStyle = c; ctx.fillRect(-s/2, -s/2, s, s);
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(-s/2, -s/2, s, s);
      break;
    case 'triangle': {
      const w = s + 2, h = s;
      ctx.beginPath(); ctx.moveTo(0, -h/2); ctx.lineTo(w/2, h/2); ctx.lineTo(-w/2, h/2); ctx.closePath();
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      break;
    }
    case 'diamond':
      ctx.beginPath(); ctx.moveTo(0,-s/2); ctx.lineTo(s/2,0); ctx.lineTo(0,s/2); ctx.lineTo(-s/2,0); ctx.closePath();
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      break;
    case 'arrow': {
      const h = Math.round(s * 9 / 7);
      ctx.beginPath();
      ctx.moveTo(0, -h/2);
      ctx.lineTo(s/2, s - h/2);
      ctx.lineTo(0, Math.round(s * 5/7) - h/2);
      ctx.lineTo(-s/2, s - h/2);
      ctx.closePath();
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
      break;
    }
    case 'image':
      if (track.iconImage && track._recImg?.complete) {
        const r = Math.round(s * 15 / 14);
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(track._recImg, -r, -r, r*2, r*2);
        ctx.shadowBlur = 0; ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
      }
      break;
    default: // circle
      ctx.beginPath(); ctx.arc(0, 0, s/2, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.restore();
}

function drawCPMarkerOnCtx(ctx, cp) {
  const pt = map.latLngToContainerPoint([cp.lat, cp.lng]);
  const stroke = '#cc0000';
  ctx.save();
  ctx.translate(pt.x, pt.y);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.8;

  const n = String(cp.number).toUpperCase();
  if (n === 'S' || cp.type === 'start') {
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(21, 18); ctx.lineTo(-21, 18); ctx.closePath();
    ctx.stroke();
  } else if (n === 'F' || cp.type === 'finish') {
    ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2); ctx.stroke();
    const lbl = cp.label;
    const offsetPx = lbl ? lbl.offsetDistance * 0.7 : 24;
    const angleDeg = lbl ? lbl.angle : 315;
    const fs = lbl ? Math.max(8, Math.round(lbl.fontSize * 0.35)) : 12;
    const rad = angleDeg * Math.PI / 180;
    ctx.font = `700 ${fs}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
    ctx.strokeText(n, offsetPx * Math.sin(rad), -offsetPx * Math.cos(rad));
    ctx.fillStyle = stroke;
    ctx.fillText(n, offsetPx * Math.sin(rad), -offsetPx * Math.cos(rad));
  }
  ctx.restore();
}

function renderMapToCanvas(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 0, w, h);

  // タイル描画
  const mapEl = document.getElementById('map');
  const cr = mapEl.getBoundingClientRect();
  mapEl.querySelectorAll('.leaflet-tile-pane img.leaflet-tile').forEach(img => {
    if (!img.complete || !img.naturalWidth) return;
    const r = img.getBoundingClientRect();
    try { ctx.drawImage(img, r.left - cr.left, r.top - cr.top, r.width, r.height); }
    catch (e) { /* cross-origin */ }
  });

  // ゴーストライン
  state.tracks.forEach(track => {
    ctx.save(); ctx.strokeStyle = track.color; ctx.lineWidth = 2; ctx.globalAlpha = 0.25;
    drawLatLngsOnCtx(ctx, track.ghostLine.getLatLngs()); ctx.restore();
  });

  // CPルートライン
  if (state.cpLine) {
    ctx.save(); ctx.strokeStyle = '#9b59b6'; ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
    ctx.setLineDash([6, 4]); drawLatLngsOnCtx(ctx, state.cpLine.getLatLngs()); ctx.restore();
  }

  // CPマーカー
  state.cps.forEach(cp => drawCPMarkerOnCtx(ctx, cp));

  // アクティブライン
  state.tracks.forEach(track => {
    ctx.save(); ctx.strokeStyle = track.color; ctx.lineWidth = track.lineWeight;
    ctx.globalAlpha = 0.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    drawLatLngsOnCtx(ctx, track.activeLine.getLatLngs()); ctx.restore();
  });

  // トラックマーカー
  state.tracks.forEach(track => drawTrackMarkerOnCtx(ctx, track));
}

// ── 録画専用: Mercator投影 & タイルキャッシュ ────────────────────

function lngToTileX(lng, zoom) {
  return (lng + 180) / 360 * Math.pow(2, zoom);
}

function latToTileY(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom);
}

// lat/lng → canvas pixel given camera view cv = { centerLat, centerLng, zoom, cw, ch }
function recProject(lat, lng, cv) {
  const TILE = 256;
  const cx = lngToTileX(cv.centerLng, cv.zoom) * TILE;
  const cy = latToTileY(cv.centerLat, cv.zoom) * TILE;
  return {
    x: cv.cw / 2 + (lngToTileX(lng, cv.zoom) * TILE - cx),
    y: cv.ch / 2 + (latToTileY(lat, cv.zoom) * TILE - cy),
  };
}

// positions=[{lat,lng}] → { centerLat, centerLng, zoom } (integer zoom)
function computeOptimalView(positions, cw, ch) {
  if (!positions.length) return { centerLat: 35.68, centerLng: 139.75, zoom: 12 };
  const lats = positions.map(p => p.lat);
  const lngs = positions.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  if (minLat === maxLat && minLng === maxLng) return { centerLat, centerLng, zoom: 16 };
  let zoom = 18;
  for (; zoom >= 1; zoom--) {
    const spanX = (lngToTileX(maxLng, zoom) - lngToTileX(minLng, zoom)) * 256;
    const spanY = (latToTileY(minLat, zoom) - latToTileY(maxLat, zoom)) * 256;
    if (spanX <= cw * 0.8 && spanY <= ch * 0.8) break;
  }
  return { centerLat, centerLng, zoom };
}

function computeRecordingView(positions, w, h, currentZoom) {
  if (!positions.length) return { centerLat: 35.68, centerLng: 139.75, zoom: 12 };
  let centerLat, centerLng;
  if (afSettings.centerMode === 'track') {
    const idx = Math.min(Math.max(0, afSettings.centerTrackIdx), positions.length - 1);
    centerLat = positions[idx].lat;
    centerLng = positions[idx].lng;
  } else {
    const lats = positions.map(p => p.lat);
    const lngs = positions.map(p => p.lng);
    centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  }
  const zoom = computeFollowZoom(
    positions, centerLat, centerLng, w, h,
    afSettings.inPct, afSettings.outPct, currentZoom
  );
  return { centerLat, centerLng, zoom };
}

function buildRecTileUrl(layer, z, x, y) {
  const subs = layer.options.subdomains;
  const subArr = Array.isArray(subs) ? subs : String(subs || 'abc').split('');
  const s = subArr[(Math.abs(x) + Math.abs(y)) % subArr.length];
  const zoom = z + (layer.options.zoomOffset || 0);
  return L.Util.template(layer._url, { z: zoom, x, y, r: '', s, ...layer.options });
}

const recTileCache = new Map(); // url → HTMLImageElement | null

async function prefetchRecTiles(layer, positions, zoomMin, zoomMax, onProgress) {
  const urls = new Set();
  for (let z = zoomMin; z <= zoomMax; z++) {
    const maxN = Math.pow(2, z);
    for (const p of positions) {
      const tx = Math.floor(lngToTileX(p.lng, z));
      const ty = Math.floor(latToTileY(p.lat, z));
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const nx = tx + dx, ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= maxN || ny >= maxN) continue;
          urls.add(buildRecTileUrl(layer, z, nx, ny));
        }
      }
    }
  }
  const urlArr = [...urls];
  const BATCH = 8;
  function loadOne(url) {
    if (recTileCache.has(url)) return Promise.resolve();
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => { recTileCache.set(url, img); resolve(); };
      img.onerror = () => { recTileCache.set(url, null); resolve(); };
      img.src = url;
    });
  }
  for (let i = 0; i < urlArr.length; i += BATCH) {
    await Promise.all(urlArr.slice(i, i + BATCH).map(loadOne));
    onProgress(Math.min(i + BATCH, urlArr.length) / urlArr.length);
  }
}

function drawTilesForRecView(ctx, cv) {
  const { centerLng, centerLat, zoom, cw, ch } = cv;
  const TILE = 256;
  const z = Math.floor(zoom);
  const tileSize = TILE * Math.pow(2, zoom - z);
  const cx = lngToTileX(centerLng, zoom) * TILE;
  const cy = latToTileY(centerLat, zoom) * TILE;
  const tileMinX = Math.floor((cx - cw / 2) / tileSize);
  const tileMaxX = Math.ceil( (cx + cw / 2) / tileSize);
  const tileMinY = Math.floor((cy - ch / 2) / tileSize);
  const tileMaxY = Math.ceil( (cy + ch / 2) / tileSize);
  const maxN = Math.pow(2, z);
  let layer = null;
  for (const l of Object.values(baseLayers)) { if (map.hasLayer(l)) { layer = l; break; } }
  if (!layer) return;
  for (let tx = tileMinX; tx <= tileMaxX; tx++) {
    if (tx < 0 || tx >= maxN) continue;
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      if (ty < 0 || ty >= maxN) continue;
      const img = recTileCache.get(buildRecTileUrl(layer, z, tx, ty));
      if (!img) continue;
      const px = cw / 2 + tx * tileSize - cx;
      const py = ch / 2 + ty * tileSize - cy;
      try { ctx.drawImage(img, px, py, tileSize, tileSize); } catch (e) { /* tainted */ }
    }
  }
}

function drawIconShapeOnCtx(ctx, track) {
  const s = track.iconSize || 14, c = track.color;
  switch (track.iconType) {
    case 'square':
      ctx.fillStyle = c; ctx.fillRect(-s/2, -s/2, s, s);
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(-s/2, -s/2, s, s);
      break;
    case 'triangle': {
      const tw = s + 2;
      ctx.beginPath(); ctx.moveTo(0,-s/2); ctx.lineTo(tw/2,s/2); ctx.lineTo(-tw/2,s/2); ctx.closePath();
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      break;
    }
    case 'diamond':
      ctx.beginPath(); ctx.moveTo(0,-s/2); ctx.lineTo(s/2,0); ctx.lineTo(0,s/2); ctx.lineTo(-s/2,0); ctx.closePath();
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      break;
    case 'arrow': {
      const ah = Math.round(s * 9/7);
      ctx.beginPath();
      ctx.moveTo(0,-ah/2); ctx.lineTo(s/2,s-ah/2);
      ctx.lineTo(0,Math.round(s*5/7)-ah/2); ctx.lineTo(-s/2,s-ah/2); ctx.closePath();
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
      break;
    }
    case 'image':
      if (track.iconImage && track._recImg?.complete) {
        const r = Math.round(s * 15/14);
        ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.clip();
        ctx.drawImage(track._recImg, -r,-r,r*2,r*2);
        ctx.shadowBlur = 0; ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
      }
      break;
    default:
      ctx.beginPath(); ctx.arc(0,0,s/2,0,Math.PI*2);
      ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawRecBubble(ctx, p, text, iconSize) {
  if (!text) return;
  const fontSize = Math.max(9, Math.round(iconSize * 0.8));
  ctx.font = `bold ${fontSize}px "Courier New", monospace`;
  const tw = ctx.measureText(text).width;
  const ph = fontSize + 8;
  const pw = tw + 16;
  const bx = p.x - pw / 2;
  const tailGap = Math.round(iconSize * 0.9);
  const by = p.y - tailGap - ph - 6;
  ctx.save();
  ctx.fillStyle = 'rgba(15,15,30,0.88)';
  ctx.strokeStyle = 'rgba(126,184,247,0.55)';
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, pw, ph, 5);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 5, by + ph);
  ctx.lineTo(p.x + 5, by + ph);
  ctx.lineTo(p.x, by + ph + 5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15,15,30,0.88)';
  ctx.fill();
  ctx.fillStyle = '#7eb8f7';
  ctx.font = `bold ${fontSize}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x, by + ph / 2);
  ctx.restore();
}

function recCpOrder(cpNum) {
  if (cpNum === null || cpNum === undefined) return -Infinity;
  const s = String(cpNum).toUpperCase();
  if (s === 'S') return 0;
  if (s === 'F') return 999999;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function drawRankingPanel(ctx, cw, ch) {
  if (!state.tracks.length) return;
  const ranked = [...state.tracks].sort((a, b) => {
    const ao = recCpOrder(a._recBubbleCpNum);
    const bo = recCpOrder(b._recBubbleCpNum);
    if (bo !== ao) return bo - ao;
    if (a._recBubbleCpNum !== null && a._recBubbleCpNum !== undefined) {
      const at = cptToMs(a.cpTimes?.[a._recBubbleCpNum]) ?? Infinity;
      const bt = cptToMs(b.cpTimes?.[b._recBubbleCpNum]) ?? Infinity;
      return at - bt;
    }
    const fa = cptToMs(a.cpTimes?.['F']) ?? Infinity;
    const fb = cptToMs(b.cpTimes?.['F']) ?? Infinity;
    return fa - fb;
  });

  const nameLineH = 15;
  const labelLineH = 12;
  const entryH = nameLineH + labelLineH;
  const pad = 8;
  const panelW = 185;
  const panelH = pad + ranked.length * entryH + (ranked.length - 1) * 4 + pad;
  const px = cw - panelW - 10;
  const py = ch - panelH - 10;

  ctx.save();
  ctx.fillStyle = 'rgba(15,15,30,0.78)';
  ctx.strokeStyle = 'rgba(126,184,247,0.3)';
  ctx.lineWidth = 1;
  roundRect(ctx, px, py, panelW, panelH, 6);
  ctx.fill(); ctx.stroke();

  let curY = py + pad;
  ranked.forEach(track => {
    const dotX = px + pad + 6;
    const nameY = curY + nameLineH / 2;
    const panelIconSize = 9;
    const scale = panelIconSize / (track.iconSize || 14);
    ctx.save();
    ctx.translate(dotX, nameY);
    ctx.scale(scale, scale);
    ctx.shadowBlur = 0;
    drawIconShapeOnCtx(ctx, track);
    ctx.restore();

    // name
    const maxNameW = panelW - pad - 14 - 4;
    ctx.font = `bold 10px sans-serif`;
    ctx.fillStyle = '#e8e8e8';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let name = track.displayName;
    while (name.length > 1 && ctx.measureText(name).width > maxNameW) name = name.slice(0, -1);
    if (name !== track.displayName) name += '…';
    ctx.fillText(name, dotX + 9, nameY);

    // CP label
    const labelY = curY + nameLineH + labelLineH / 2;
    const label = track._recLastCpLabel;
    if (label) {
      ctx.font = `bold 9px "Courier New", monospace`;
      ctx.fillStyle = '#7eb8f7';
      ctx.fillText(label, px + pad + 14, labelY);
    }

    curY += entryH + 4;
  });
  ctx.restore();
}

function renderRecordingFrame(ctx, cw, ch, currentTime, cv, bubbleDurationMs) {
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 0, cw, ch);

  drawTilesForRecView(ctx, cv);

  function proj(lat, lng) { return recProject(lat, lng, cv); }

  function drawPath(lls) {
    if (!lls.length) return;
    ctx.beginPath();
    lls.forEach(([lat, lng], i) => {
      const p = proj(lat, lng);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  // ゴーストライン
  for (const track of state.tracks) {
    ctx.save(); ctx.strokeStyle = track.color; ctx.lineWidth = 2; ctx.globalAlpha = 0.25;
    drawPath(track.data.points.map(p => [p.lat, p.lng]));
    ctx.restore();
  }

  // CPルートライン
  if (state.cps.length) {
    const sorted = [...state.cps].sort((a, b) => {
      const rank = v => v.type === 'start' ? -1 : v.type === 'finish' ? Infinity : Number(v.number);
      return rank(a) - rank(b);
    });
    ctx.save(); ctx.strokeStyle = '#9b59b6'; ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
    ctx.setLineDash([6, 4]);
    drawPath(sorted.map(cp => [cp.lat, cp.lng]));
    ctx.restore();
  }

  // CPマーカー
  for (const cp of state.cps) {
    const p = proj(cp.lat, cp.lng);
    const stroke = '#cc0000';
    ctx.save(); ctx.translate(p.x, p.y); ctx.strokeStyle = stroke; ctx.lineWidth = 2.8;
    const n = String(cp.number).toUpperCase();
    if (n === 'S' || cp.type === 'start') {
      ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(21, 18); ctx.lineTo(-21, 18); ctx.closePath(); ctx.stroke();
    } else if (n === 'F' || cp.type === 'finish') {
      ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2); ctx.stroke();
      const lbl = cp.label;
      const offsetPx = lbl ? lbl.offsetDistance * 0.7 : 24;
      const angleDeg = lbl ? lbl.angle : 315;
      const fs = lbl ? Math.max(8, Math.round(lbl.fontSize * 0.35)) : 12;
      const rad = angleDeg * Math.PI / 180;
      ctx.font = `700 ${fs}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
      ctx.strokeText(n, offsetPx * Math.sin(rad), -offsetPx * Math.cos(rad));
      ctx.fillStyle = stroke;
      ctx.fillText(n, offsetPx * Math.sin(rad), -offsetPx * Math.cos(rad));
    }
    ctx.restore();
  }

  // アクティブライン + マーカー
  const recPositions = [];
  const trackFrameData = [];
  for (const track of state.tracks) {
    const absTime = state.mode === 'time'
      ? state.globalStart + currentTime
      : track.userStartTime + currentTime;
    const { lat, lng, idx } = interpolatePosition(track.data.points, absTime);
    const elapsed = absTime - track.userStartTime;
    recPositions.push({ lat, lng });

    let covered = [];
    if (track.trailDuration > 0) {
      const si = track.data.points.findIndex(p => p.time >= absTime - track.trailDuration);
      if (si >= 0) {
        covered = track.data.points.slice(si, idx + 1).map(p => [p.lat, p.lng]);
        if (covered.length) covered.push([lat, lng]);
      }
    } else {
      covered = track.data.points.slice(0, idx + 1).map(p => [p.lat, p.lng]);
      if (covered.length) covered.push([lat, lng]);
    }
    if (covered.length > 1) {
      ctx.save(); ctx.strokeStyle = track.color; ctx.lineWidth = track.lineWeight;
      ctx.globalAlpha = 0.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      drawPath(covered); ctx.restore();
    }

    // CP通過マーク
    for (const [, val] of Object.entries(track.cpTimes || {})) {
      const cpMs = cptToMs(val);
      if (cpMs === null || cpMs > elapsed) continue;
      const cpPos = interpolatePosition(track.data.points, track.userStartTime + cpMs);
      const cp = proj(cpPos.lat, cpPos.lng);
      ctx.save();
      ctx.beginPath(); ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = track.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }

    const p = proj(lat, lng);
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.shadowBlur = 5; ctx.shadowColor = 'rgba(0,0,0,0.55)';
    if (track.iconType === 'arrow') {
      const nxt = track.data.points[Math.min(idx + 1, track.data.points.length - 1)];
      if (nxt && (nxt.lat !== lat || nxt.lng !== lng)) {
        ctx.rotate(bearing(lat, lng, nxt.lat, nxt.lng) * Math.PI / 180);
      }
    }
    drawIconShapeOnCtx(ctx, track);
    ctx.restore();

    // CP crossing detection for recording bubble
    if (bubbleDurationMs !== undefined && track._recPrevElapsed !== null) {
      if (elapsed > track._recPrevElapsed) {
        let lastPassed = null;
        for (const [num, val] of Object.entries(track.cpTimes || {})) {
          const ms = cptToMs(val);
          if (ms !== null && ms > track._recPrevElapsed && ms <= elapsed) {
            if (!lastPassed || ms > lastPassed.ms) lastPassed = { num, ms };
          }
        }
        if (lastPassed) {
          track._recBubbleUntil = elapsed + bubbleDurationMs;
          track._recBubbleCpNum = lastPassed.num;
          const cpNum = lastPassed.num;
          const thisMs = cptToMs(track.cpTimes?.[cpNum]);
          const timeStr = track.cpTimes?.[cpNum] ?? fmtElapsed(Math.max(0, elapsed));
          let diffStr = '';
          if (thisMs !== null) {
            let minMs = Infinity;
            for (const t of state.tracks) {
              const ms = cptToMs(t.cpTimes?.[cpNum]);
              if (ms !== null && ms < minMs) minMs = ms;
            }
            if (thisMs > minMs) diffStr = ` (+${fmtElapsed(thisMs - minMs)})`;
          }
          const prefix = String(cpNum).toUpperCase() === 'F' ? '' : 'CP';
          track._recLastCpLabel = `${prefix}${cpNum}:${timeStr}${diffStr}`;
        }
      } else if (elapsed < track._recPrevElapsed) {
        track._recBubbleUntil = -Infinity;
      }
    }
    if (bubbleDurationMs !== undefined) track._recPrevElapsed = elapsed;

    trackFrameData.push({ track, p, elapsed });
  }

  // 吹き出し（アイコンの上に描画）
  if (bubbleDurationMs !== undefined) {
    for (const { track, p, elapsed } of trackFrameData) {
      if (track._recBubbleUntil !== undefined && elapsed < track._recBubbleUntil) {
        drawRecBubble(ctx, p, track._recLastCpLabel, track.iconSize ?? 14);
      }
    }
    drawRankingPanel(ctx, cw, ch);
  }

}

// ── 動画エクスポート ───────────────────────────────────────────

let _recCancel = null;

// ブラウザがネイティブで対応する最適フォーマットを返す
function detectVideoFormat() {
  const candidates = [
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/mp4',             ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm',            ext: 'webm' },
  ];
  return candidates.find(f => MediaRecorder.isTypeSupported(f.mime))
      ?? candidates[candidates.length - 1];
}

async function exportVideo(speed, fps) {
  if (!state.tracks.length || !state.duration) {
    alert('トラックを読み込んでください');
    setRecordingUI(false);
    document.getElementById('rec-dialog').close();
    return;
  }
  if (!window.MediaRecorder) {
    alert('このブラウザは動画録画に対応していません');
    setRecordingUI(false);
    document.getElementById('rec-dialog').close();
    return;
  }

  const fmt  = detectVideoFormat();
  const size = parseInt(document.getElementById('rec-res').value);
  const w = size, h = size;
  const msPerFrame  = speed * 1000 / fps;
  const totalFrames = Math.ceil(state.duration / msPerFrame);
  const hintEl = document.getElementById('rec-hint');

  // ── タイルプリフェッチ ─────────────────────────────────────────
  const sampleCount = Math.min(200, totalFrames + 1);
  let zoomMin = 18, zoomMax = 1;
  const samplePositions = [];

  for (let i = 0; i <= sampleCount; i++) {
    const t = (i / sampleCount) * state.duration;
    const positions = state.tracks.map(track => {
      const absTime = state.mode === 'time'
        ? state.globalStart + t
        : track.userStartTime + t;
      const { lat, lng } = interpolatePosition(track.data.points, absTime);
      return { lat, lng };
    });
    samplePositions.push(...positions);
    const { zoom } = computeRecordingView(positions, w, h, null);
    zoomMin = Math.min(zoomMin, zoom);
    zoomMax = Math.max(zoomMax, zoom);
  }
  state.cps.forEach(cp => samplePositions.push({ lat: cp.lat, lng: cp.lng }));
  zoomMin = Math.max(1, zoomMin - 1);
  zoomMax = Math.min(18, zoomMax + 1);

  let layer = null;
  for (const l of Object.values(baseLayers)) { if (map.hasLayer(l)) { layer = l; break; } }

  if (layer) {
    recTileCache.clear();
    await prefetchRecTiles(layer, samplePositions, zoomMin, zoomMax, prog => {
      updateRecordProgress(prog * 0.4);
      hintEl.textContent = `タイル先読み中: ${Math.round(prog * 100)}%`;
    });
  }
  hintEl.textContent = '録画中...';

  // ── キャンバス & MediaRecorder セットアップ ───────────────────
  const recCanvas = document.createElement('canvas');
  recCanvas.width = w; recCanvas.height = h;
  recCanvas.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(recCanvas);
  const ctx = recCanvas.getContext('2d');

  const bubbleDurationMs = speed * 2000;
  state.tracks.forEach(t => {
    if (t.iconType === 'image' && t.iconImage && !t._recImg) {
      t._recImg = new Image(); t._recImg.src = t.iconImage;
    }
    t._recPrevElapsed = null;
    t._recBubbleUntil = -Infinity;
    t._recBubbleCpNum = null;
    t._recLastCpLabel = '';
  });

  const bitrate  = parseInt(document.getElementById('rec-bitrate').value);
  const stream   = recCanvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: bitrate });
  const chunks   = [];

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    if (chunks.length) {
      const blob = new Blob(chunks, { type: fmt.mime });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'),
                    { href: url, download: `track-replay.${fmt.ext}` });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    recCanvas.remove();
    state.tracks.forEach(t => delete t._recImg);
    _recCancel = null;
  };

  const wasPlaying = state.playing;
  const savedTime  = state.currentTime;
  pause();

  recorder.start(500);

  // ── スムースカメラ録画ループ ──────────────────────────────────
  let smoothLat = null, smoothLng = null, smoothZoom = null;
  let cancelled = false;
  _recCancel = () => { cancelled = true; };

  for (let f = 0; f <= totalFrames && !cancelled; f++) {
    const t = Math.min(f * msPerFrame, state.duration);

    const positions = state.tracks.map(track => {
      const absTime = state.mode === 'time'
        ? state.globalStart + t
        : track.userStartTime + t;
      const { lat, lng } = interpolatePosition(track.data.points, absTime);
      return { lat, lng };
    });

    const view = computeRecordingView(positions, w, h, smoothZoom);

    if (smoothLat === null) {
      smoothLat = view.centerLat;
      smoothLng = view.centerLng;
      smoothZoom = view.zoom;
    } else {
      smoothZoom = smoothZoom * 0.7  + view.zoom      * 0.3;
      smoothLat  = smoothLat  * 0.85 + view.centerLat * 0.15;
      smoothLng  = smoothLng  * 0.85 + view.centerLng * 0.15;
    }

    const cv = { centerLat: smoothLat, centerLng: smoothLng, zoom: smoothZoom, cw: w, ch: h };
    renderRecordingFrame(ctx, w, h, t, cv, bubbleDurationMs);
    updateRecordProgress(0.4 + 0.6 * f / totalFrames);
    await new Promise(r => setTimeout(r, 1000 / fps));
  }

  if (!cancelled) {
    await new Promise(r => setTimeout(r, 1000));
  }

  recorder.stop();

  state.currentTime = savedTime;
  renderFrame();
  if (wasPlaying) play();
  setRecordingUI(false);
  document.getElementById('rec-dialog').close();
}

// ── 録画ダイアログ ─────────────────────────────────────────────

const recDialog = document.getElementById('rec-dialog');

function setRecordingUI(active) {
  document.getElementById('rec-settings').style.display = active ? 'none' : '';
  document.getElementById('rec-active').style.display   = active ? '' : 'none';
  document.getElementById('rec-start').style.display    = active ? 'none' : '';
  document.getElementById('rec-cancel').textContent     = active ? '中止' : 'キャンセル';
}

function updateRecordProgress(fraction) {
  document.getElementById('rec-progress').value = fraction;
  document.getElementById('rec-pct').textContent = Math.round(fraction * 100) + '%';
}

function updateRecDurationHint() {
  const fmt = window.MediaRecorder ? detectVideoFormat().ext.toUpperCase() : '非対応';
  if (!state.duration) {
    document.getElementById('rec-hint').textContent = `形式: ${fmt} / トラックを読み込んでください`;
    return;
  }
  const speed    = parseInt(document.getElementById('rec-speed').value);
  const fps      = parseInt(document.getElementById('rec-fps').value);
  const videoSec = state.duration / 1000 / speed;
  const realSec  = Math.ceil(videoSec);  // setTimeout 方式のため実時間≒動画時間
  const m = Math.floor(videoSec / 60), s = Math.round(videoSec % 60);
  document.getElementById('rec-hint').textContent =
    `形式: ${fmt} / 動画: 約${m > 0 ? m+'分' : ''}${s}秒 / 出力時間: 約${realSec}秒`;
}

const btnAutoFollow = document.getElementById('btn-autofollow');

function updateAfTrackSel() {
  const isTrackMode = document.querySelector('input[name="af-center"]:checked')?.value === 'track';
  const isEnabled   = document.getElementById('af-enabled').checked;
  document.getElementById('af-track-sel').disabled = !isEnabled || !isTrackMode;
}

function setAfControlsDisabled(disabled) {
  document.querySelectorAll('input[name="af-center"]').forEach(el => el.disabled = disabled);
  document.getElementById('af-zoom').disabled = disabled;
  updateAfZoomControls();
  updateAfTrackSel();
}

function updateAfZoomControls() {
  const disabled = !document.getElementById('af-enabled').checked;
  const allowZoom = document.getElementById('af-zoom').checked;
  document.getElementById('af-outpct').disabled = disabled || !allowZoom;
  document.getElementById('af-inpct').disabled  = disabled || !allowZoom;
}

function openAfDialog() {
  document.getElementById('af-enabled').checked = state.autoFollow;
  document.getElementById('af-zoom').checked    = afSettings.allowZoom;
  const r = document.querySelector(`input[name="af-center"][value="${afSettings.centerMode}"]`);
  if (r) r.checked = true;
  document.getElementById('af-outpct').value = afSettings.outPct;
  document.getElementById('af-inpct').value  = afSettings.inPct;
  const sel = document.getElementById('af-track-sel');
  sel.innerHTML = '';
  if (state.tracks.length) {
    state.tracks.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = t.displayName;
      sel.appendChild(o);
    });
    sel.value = Math.min(afSettings.centerTrackIdx, state.tracks.length - 1);
  } else {
    const o = document.createElement('option');
    o.textContent = '（トラックなし）'; sel.appendChild(o);
  }
  setAfControlsDisabled(!state.autoFollow);
  document.getElementById('af-dialog').showModal();
}

btnAutoFollow.addEventListener('click', openAfDialog);

document.getElementById('af-enabled').addEventListener('change', e => {
  setAfControlsDisabled(!e.target.checked);
});

document.getElementById('af-zoom').addEventListener('change', updateAfZoomControls);

document.querySelectorAll('input[name="af-center"]').forEach(el => {
  el.addEventListener('change', updateAfTrackSel);
});

map.on('dragstart', () => {
  if (state.autoFollow) {
    state.autoFollow = false;
    btnAutoFollow.classList.remove('active');
  }
});

// 縮小条件: outPct > inPct を保証
document.getElementById('af-outpct').addEventListener('change', e => {
  let v = Math.max(10, Math.min(100, parseInt(e.target.value) || 100));
  const inp = parseInt(document.getElementById('af-inpct').value) || 30;
  if (v <= inp) v = Math.min(100, inp + 10);
  e.target.value = v;
});
// 拡大条件: inPct < outPct を保証
document.getElementById('af-inpct').addEventListener('change', e => {
  let v = Math.max(10, Math.min(90, parseInt(e.target.value) || 30));
  const out = parseInt(document.getElementById('af-outpct').value) || 100;
  if (v >= out) v = Math.max(10, out - 10);
  e.target.value = v;
});

document.getElementById('af-apply').addEventListener('click', () => {
  const wasFollowing = state.autoFollow;
  const nowFollowing = document.getElementById('af-enabled').checked;
  afSettings.centerMode      = document.querySelector('input[name="af-center"]:checked')?.value || 'avg';
  afSettings.centerTrackIdx  = parseInt(document.getElementById('af-track-sel').value) || 0;
  afSettings.outPct          = parseInt(document.getElementById('af-outpct').value) || 100;
  afSettings.inPct           = parseInt(document.getElementById('af-inpct').value)  || 30;
  afSettings.allowZoom       = document.getElementById('af-zoom').checked;
  state.autoFollow = nowFollowing;
  if (nowFollowing && !wasFollowing) {
    state.afLat = null; state.afLng = null; state.afZoom = null;
    renderFrame();
  }
  btnAutoFollow.classList.toggle('active', state.autoFollow);
  document.getElementById('af-dialog').close();
});

document.getElementById('af-close').addEventListener('click', () => {
  document.getElementById('af-dialog').close();
});

// ── CP通過時刻入力ダイアログ ──────────────────────────────────

function normalizeCptTime(val) {
  const v = val.trim();
  if (!v) return '';
  const m = v.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[2]), ss = parseInt(m[3]);
  if (mm > 59 || ss > 59) return null;
  return `${String(parseInt(m[1])).padStart(2, '0')}:${m[2]}:${m[3]}`;
}

function buildCptBody(trackIdx) {
  const body = document.getElementById('cpt-body');
  body.innerHTML = '';

  const normalCps = state.cps
    .filter(cp => {
      const n = String(cp.number).toUpperCase();
      return cp.type !== 'start' && n !== 'S';
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!normalCps.length) {
    body.innerHTML = '<p style="font-size:12px;color:#888;text-align:center;margin:14px 0">CPデータが読み込まれていません</p>';
    return;
  }

  const track = state.tracks[trackIdx];
  if (!track.cpTimes) track.cpTimes = {};

  const grid = document.createElement('div');
  grid.className = 'cpt-grid';

  // ヘッダー
  ['CP', '経過時間 (hh:mm:ss)', '緯度・経度（GPX）', '緯度・経度（CP）'].forEach((h, i) => {
    const el = document.createElement('span');
    el.className = 'cpt-grid-hdr' + (i === 2 ? ' cpt-col-gpx' : i === 3 ? ' cpt-col-cp' : '');
    el.textContent = h;
    grid.appendChild(el);
  });
  const sep = document.createElement('div');
  sep.className = 'cpt-grid-sep';
  grid.appendChild(sep);

  for (const cp of normalCps) {
    const label = document.createElement('span');
    label.className = 'cpt-label';
    label.textContent = cp.number;
    grid.appendChild(label);

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'cpt-input';
    inp.placeholder = 'hh:mm:ss';
    inp.value = track.cpTimes[cp.number] ?? '';
    inp.dataset.cpNum = cp.number;

    const latlngInp = document.createElement('input');
    latlngInp.type = 'text';
    latlngInp.className = 'cpt-latlng cpt-col-gpx';
    latlngInp.readOnly = true;
    latlngInp.placeholder = '緯度,経度';

    function fillLatLng(norm) {
      const ms = norm ? cptToMs(norm) : null;
      if (ms !== null) {
        const pos = interpolatePosition(track.data.points, track.userStartTime + ms);
        latlngInp.value = `${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}`;
      } else {
        latlngInp.value = '';
      }
    }
    fillLatLng(track.cpTimes[cp.number] ?? null);

    inp.addEventListener('input', () => {
      inp.classList.remove('cpt-invalid');
      const norm = normalizeCptTime(inp.value);
      if (norm !== null) {
        if (norm === '') delete track.cpTimes[cp.number];
        else track.cpTimes[cp.number] = norm;
        fillLatLng(norm || null);
        refreshCPTrailMarkers(track);
      }
    });

    inp.addEventListener('blur', () => {
      const norm = normalizeCptTime(inp.value);
      if (norm === null) {
        inp.classList.add('cpt-invalid');
      } else {
        inp.classList.remove('cpt-invalid');
        inp.value = norm;
        if (norm === '') delete track.cpTimes[cp.number];
        else track.cpTimes[cp.number] = norm;
        fillLatLng(norm || null);
        refreshCPTrailMarkers(track);
      }
    });

    const cpLatlngInp = document.createElement('input');
    cpLatlngInp.type = 'text';
    cpLatlngInp.className = 'cpt-latlng cpt-col-cp';
    cpLatlngInp.readOnly = true;
    cpLatlngInp.placeholder = '緯度,経度';
    if (cp.lat != null && cp.lng != null) {
      cpLatlngInp.value = `${Number(cp.lat).toFixed(6)},${Number(cp.lng).toFixed(6)}`;
    }

    grid.appendChild(inp);
    grid.appendChild(latlngInp);
    grid.appendChild(cpLatlngInp);
  }

  body.appendChild(grid);
  applyCptColVisibility();
}

function applyCptColVisibility() {
  const showGpx = document.getElementById('cpt-show-gpx').checked;
  const showCp  = document.getElementById('cpt-show-cp').checked;
  const grid = document.querySelector('#cpt-body .cpt-grid');
  if (!grid) return;

  let cols = '2em 78px';
  if (showGpx) cols += ' 148px';
  if (showCp)  cols += ' 148px';
  grid.style.gridTemplateColumns = cols;

  const dlgInner = document.querySelector('#cp-times-dialog .dlg-inner');
  if (dlgInner) {
    const extraCols = (showGpx ? 1 : 0) + (showCp ? 1 : 0);
    dlgInner.style.width = extraCols === 2 ? 'min(480px,98vw)' : extraCols === 1 ? 'min(330px,98vw)' : '';
  }

  grid.querySelectorAll('.cpt-col-gpx').forEach(el => { el.style.display = showGpx ? '' : 'none'; });
  grid.querySelectorAll('.cpt-col-cp') .forEach(el => { el.style.display = showCp  ? '' : 'none'; });
}

document.getElementById('cpt-show-gpx').addEventListener('change', applyCptColVisibility);
document.getElementById('cpt-show-cp') .addEventListener('change', applyCptColVisibility);

let cptTrackIdx = 0;

function openCpTimesDialog(trackIdx) {
  cptTrackIdx = trackIdx ?? 0;

  const sel = document.getElementById('cpt-track-sel');
  sel.innerHTML = '';
  state.tracks.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = t.displayName;
    sel.appendChild(o);
  });
  sel.value = cptTrackIdx;

  buildCptBody(cptTrackIdx);
  document.getElementById('cp-times-dialog').showModal();
}

document.getElementById('cpt-track-sel').addEventListener('change', e => {
  cptTrackIdx = parseInt(e.target.value);
  buildCptBody(cptTrackIdx);
});

document.getElementById('cpt-close').addEventListener('click', () => {
  document.getElementById('cp-times-dialog').close();
});

document.getElementById('cpt-gpx-correct').addEventListener('click', () => {
  const track = state.tracks[cptTrackIdx];
  if (!track) return;

  // CPと通過時刻が両方揃っているアンカーを収集（絶対時刻順でソート）
  const anchors = [];
  for (const cp of state.cps) {
    const val = track.cpTimes?.[cp.number];
    const ms = cptToMs(val);
    if (ms === null || cp.lat == null || cp.lng == null) continue;
    anchors.push({
      absTime: track.userStartTime + ms,
      lat: Number(cp.lat),
      lng: Number(cp.lng),
    });
  }
  anchors.sort((a, b) => a.absTime - b.absTime);
  if (anchors.length < 2) {
    alert('補正には緯度・経度（CP）が2点以上必要です');
    return;
  }

  // 補正前のGPS位置からdeltaを計算（全アンカー分を先に算出）
  const pts = track.data.points;
  for (const a of anchors) {
    const orig = interpolatePosition(pts, a.absTime);
    a.dLat = a.lat - orig.lat;
    a.dLng = a.lng - orig.lng;
  }

  // アンカー間の中間ポイントのみ差分シフトを適用（境界は除外して二重加算を防ぐ）
  for (let ai = 0; ai < anchors.length - 1; ai++) {
    const a0 = anchors[ai], a1 = anchors[ai + 1];
    const dt = a1.absTime - a0.absTime;
    for (const p of pts) {
      if (p.time <= a0.absTime || p.time >= a1.absTime) continue; // 境界を除く
      const r = dt === 0 ? 0.5 : (p.time - a0.absTime) / dt;
      p.lat += a0.dLat * (1 - r) + a1.dLat * r;
      p.lng += a0.dLng * (1 - r) + a1.dLng * r;
    }
  }

  // 各アンカー時刻にCP座標を持つポイントを強制挿入
  // → interpolatePosition がアンカー時刻でCP座標と正確に一致するようになる
  for (const a of anchors) {
    const existingIdx = pts.findIndex(p => p.time === a.absTime);
    if (existingIdx >= 0) {
      pts[existingIdx].lat = a.lat;
      pts[existingIdx].lng = a.lng;
    } else {
      const insertIdx = pts.findIndex(p => p.time > a.absTime);
      const idx = insertIdx < 0 ? pts.length : insertIdx;
      pts.splice(idx, 0, { time: a.absTime, lat: a.lat, lng: a.lng });
    }
  }

  // ゴーストライン更新
  track.ghostLine.setLatLngs(pts.map(p => [p.lat, p.lng]));

  // CPトレイルマーカー再配置
  Object.values(track.cpTrailMarkers).forEach(m => m.remove());
  track.cpTrailMarkers = {};
  refreshCPTrailMarkers(track);

  // ダイアログの緯度・経度（GPX）列を再描画
  buildCptBody(cptTrackIdx);

  alert('GPX軌跡を補正しました');
});

document.getElementById('cpt-import').addEventListener('click', () => {
  document.getElementById('cpt-file-input').click();
});

document.getElementById('cpt-lc-import').addEventListener('click', () => {
  document.getElementById('lc-file-input').click();
});

document.getElementById('lc-close').addEventListener('click', () => {
  document.getElementById('lc-dialog').close();
  openCpTimesDialog(cptTrackIdx);
});


let lcRunners = [];

function parseLcHtml(html) {
  const nameMatches   = [...html.matchAll(/runnerData\['runnerName'\]\s*=\s*'([^']*)'/g)];
  const elapsedMatches = [...html.matchAll(/runnerData\['elapsedTime'\]\s*=\s*\[([^\]]*)\]/g)];
  return nameMatches.map((m, i) => ({
    name: m[1],
    elapsedTime: elapsedMatches[i]
      ? [...elapsedMatches[i][1].matchAll(/'([^']*)'/g)].map(t => t[1])
      : [],
  }));
}

function buildLcResult(runners) {
  const div = document.getElementById('lc-result');
  div.innerHTML = '';
  if (runners.length === 0) {
    div.textContent = 'データが見つかりません';
    div.classList.add('has-data');
    return;
  }
  runners.forEach((runner, i) => {
    const label = document.createElement('label');
    label.className = 'lc-runner-label';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'lc-runner';
    radio.value = i;
    if (i === 0) radio.checked = true;
    label.appendChild(radio);
    label.append(runner.name);
    div.appendChild(label);
  });
  div.classList.add('has-data');
}

// LapCenterの経過時間('mm:ss' or 'h:mm:ss')をhh:mm:ssに変換
function lcElapsedToHms(val) {
  const parts = val.split(':');
  if (parts.length === 2) {
    const mm = parseInt(parts[0]), ss = parseInt(parts[1]);
    return `${String(Math.floor(mm / 60)).padStart(2,'0')}:${String(mm % 60).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  }
  if (parts.length === 3) {
    return parts.map(p => String(parseInt(p)).padStart(2,'0')).join(':');
  }
  return null;
}

document.getElementById('lc-read').addEventListener('click', () => {
  const selected = document.querySelector('input[name="lc-runner"]:checked');
  if (!selected) return;

  const runner = lcRunners[parseInt(selected.value)];
  if (!runner) return;

  const normalCps = state.cps
    .filter(cp => {
      const n = String(cp.number).toUpperCase();
      return cp.type !== 'start' && n !== 'S';
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const track = state.tracks[cptTrackIdx];
  if (!track.cpTimes) track.cpTimes = {};

  runner.elapsedTime.forEach((t, i) => {
    if (i >= normalCps.length) return;
    const hms = lcElapsedToHms(t);
    if (hms) track.cpTimes[normalCps[i].number] = hms;
  });

  document.getElementById('lc-dialog').close();
  openCpTimesDialog(cptTrackIdx);
});

document.getElementById('lc-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = ev => {
    lcRunners = parseLcHtml(ev.target.result);
    buildLcResult(lcRunners);
    document.getElementById('cp-times-dialog').close();
    document.getElementById('lc-dialog').showModal();
  };
  reader.readAsText(file, 'utf-8');
});

document.getElementById('cpt-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const lines = ev.target.result.trim().split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) throw new Error('データ行がありません');
      // 1行目はヘッダーとしてスキップ
      const track = state.tracks[cptTrackIdx];
      if (!track.cpTimes) track.cpTimes = {};
      let imported = 0;
      for (const line of lines.slice(1)) {
        const cols = line.split(',').map(c => c.trim());
        if (cols.length < 2) continue;
        const cpNum = cols[0];
        const norm  = normalizeCptTime(cols[1]);
        if (!cpNum || norm === null) continue;
        if (norm === '') delete track.cpTimes[cpNum];
        else { track.cpTimes[cpNum] = norm; imported++; }
      }
      buildCptBody(cptTrackIdx);
      refreshCPTrailMarkers(track);
      alert(`${imported}件のCP通過時刻を読み込みました`);
    } catch (err) {
      alert('CSVの読み込みに失敗しました: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

document.getElementById('tsd-cp-times').addEventListener('click', () => {
  tsdDialog.close();
  openCpTimesDialog(tsdIdx);
});

document.getElementById('btn-record').addEventListener('click', () => {
  updateRecDurationHint();
  setRecordingUI(false);
  recDialog.showModal();
});

['rec-res', 'rec-speed', 'rec-fps'].forEach(id =>
  document.getElementById(id).addEventListener('change', updateRecDurationHint));

document.getElementById('rec-start').addEventListener('click', async () => {
  const speed = parseInt(document.getElementById('rec-speed').value);
  const fps   = parseInt(document.getElementById('rec-fps').value);
  setRecordingUI(true);
  await exportVideo(speed, fps);
});

document.getElementById('rec-cancel').addEventListener('click', () => {
  if (_recCancel) { _recCancel(); }
  else            { recDialog.close(); }
});

// Init UI
updateTrackList();
updateTimeDisplay();
btnAutoFollow.classList.add('active');
