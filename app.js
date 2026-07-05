(() => {
'use strict';

/* ============================================================
   CCTV Cabling Designer
   FTTx ONU -> Distribution Switch -> PoE Switch 8GE -> CCTV
   ============================================================ */

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const canvas = $('#board');
const ctx = canvas.getContext('2d');
const wrap = $('#canvasWrap');

/* ---------- engineering constants ---------- */
const CAT6_MAX = 180;            // เมตร — เกินนี้ต้องใช้ Fiber
const TIA_CH_MAX = 100;          // เมตร — channel limit ตาม TIA-568
const BRANCH_MAX_M = 10;         // เมตร — จุดติดตั้งห่างแนวท่อไม่เกินนี้จึง branch จากแนวเดิมได้
const SLACK_FACTOR = 1.10;       // เผื่อความยาวสาย 10%
const SLACK_ENDS = 10;           // service loop ปลายทางรวม (ม.)

const CABLES = {
  cat6:     { key: 'cat6',     name: 'LAN CAT6',      color: '#fbbf24', od: 6.2 },
  fiber:    { key: 'fiber',    name: 'Fiber Optic',   color: '#ef4444', od: 6.0 },
  // ลิงก์ไร้สาย (WAP↔WAP) — ไม่มีสาย/ท่อ, od=0 เพื่อไม่นับเข้าท่อร้อยสาย
  wireless: { key: 'wireless', name: 'Wireless Link', color: '#a855f7', od: 0, wireless: true },
};

const DEV = {
  onu: { prefix: 'ONU', name: 'FTTx ONU',            color: '#ef4444' },
  dsw: { prefix: 'DSW', name: 'Distribution Switch',  color: '#3b82f6' },
  psw: { prefix: 'PSW', name: 'PoE Switch 8GE',       color: '#22c55e' },
  cam: { prefix: 'CAM', name: 'กล้อง CCTV',           color: '#facc15' },
  wap: { prefix: 'WAP', name: 'Wireless Access Point', color: '#a855f7' },
};

// สภาพแวดล้อมการติดตั้ง → ชนิดท่อร้อยสาย
const ENVS = {
  indoor:  { name: 'ในอาคาร/ในร่ม',                 pipe: 'EMT',            short: 'EMT' },
  outdoor: { name: 'ภายนอกอาคาร (ติดผนัง/ชายคา)',   pipe: 'IMC / uPVC กันน้ำ', short: 'IMC' },
  buried:  { name: 'ฝังดินใต้ดิน',                   pipe: 'HDPE / PE',       short: 'HDPE' },
};

// ท่อร้อยสาย EMT (เส้นผ่านศูนย์กลางภายใน มม.)
const CONDUITS = [
  { label: '20 มม. (3/4")',  idmm: 20.9 },
  { label: '25 มม. (1")',    idmm: 26.6 },
  { label: '32 มม. (1-1/4")', idmm: 35.1 },
  { label: '40 มม. (1-1/2")', idmm: 40.9 },
  { label: '50 มม. (2")',    idmm: 52.5 },
];

/* ---------- state ---------- */
const state = {
  img: null,
  imgSrcKind: null,          // 'sample' | 'file'
  imgDataUrl: null,          // for persistence / report
  view: { s: 1, ox: 0, oy: 0 },
  pxPerM: null,
  mode: 'select',
  devices: [],               // {id,type,x,y,label,auto?}
  routes: [],                // {id,fromId,toId,points:[{x,y}],override:'auto'|'cat6'|'fiber',env,auto?}
  walls: [],                 // {id,points:[{x,y}]} — เส้นขอบอาคาร/แนวท่อ สำหรับ auto-route
  cal: { p1: null, p2: null },
  draft: null,               // {fromId, points:[]}
  wallDraft: null,           // {points:[]}
  altView: null,             // {routeId, options:[{points}]} — แนวเดินสายทางเลือก (ชั่วคราว)
  conduitLabelOffsets: {},   // key ช่วงท่อ → {x,y} offset โลก ของป้ายที่ผู้ใช้ลากย้าย
  selected: null,            // {kind:'device'|'route', id}
  hoverW: null,              // world coords of pointer
  nextId: 1,
};

let panning = false, dragDev = null, downScr = null, moved = false;
let dragLabel = null;        // {key, midW, gdx, gdy} — กำลังลากป้ายท่อ
let conduitLabelHits = [];   // กรอบป้ายท่อบนจอจากการวาดรอบล่าสุด (สำหรับ hit-test)

/* ============================================================
   coordinate helpers
   ============================================================ */
const w2s = p => ({ x: p.x * state.view.s + state.view.ox, y: p.y * state.view.s + state.view.oy });
const s2w = p => ({ x: (p.x - state.view.ox) / state.view.s, y: (p.y - state.view.oy) / state.view.s });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function mousePos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function fitView() {
  if (!state.img) return;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const s = Math.min(cw / state.img.naturalWidth, ch / state.img.naturalHeight) * 0.96;
  state.view.s = s;
  state.view.ox = (cw - state.img.naturalWidth * s) / 2;
  state.view.oy = (ch - state.img.naturalHeight * s) / 2;
}

/* ============================================================
   geometry / engineering calculations
   ============================================================ */
function polyLenPx(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += dist(points[i - 1], points[i]);
  return L;
}
function routeLenM(route) {
  if (!state.pxPerM) return null;
  return polyLenPx(route.points) / state.pxPerM;
}
function autoCable(route) {
  // ปลายทั้งสองเป็น Wireless AP → ลิงก์ไร้สายอัตโนมัติ (ไม่คิดสาย/ท่อ)
  const a = deviceById(route.fromId), b = deviceById(route.toId);
  if (a && b && a.type === 'wap' && b.type === 'wap') return 'wireless';
  const L = routeLenM(route);
  if (L == null) return 'cat6';
  return L <= CAT6_MAX ? 'cat6' : 'fiber';
}
function effCable(route) {
  return (route.override && route.override !== 'auto') ? route.override : autoCable(route);
}
function isWireless(route) { return effCable(route) === 'wireless'; }
function purchaseLen(L) {
  return Math.ceil(L * SLACK_FACTOR + SLACK_ENDS);
}
// ขนาดท่อจากจำนวนสาย × OD ตาม fill ratio (TIA/NEC: 1 เส้น 53%, 2 เส้น 31%, ≥3 เส้น 40%)
function conduitFor(n, od) {
  const fill = n === 1 ? 0.53 : n === 2 ? 0.31 : 0.40;
  const need = n * Math.PI * od * od / 4 / fill;
  for (const c of CONDUITS) {
    if (Math.PI * c.idmm * c.idmm / 4 >= need) return c.label;
  }
  return CONDUITS[CONDUITS.length - 1].label + ' ×หลายท่อ';
}
// ขนาดท่อจากรายการ OD ของสายที่ทับกันในช่วงเดียวกันจริง (fill ratio ตาม วสท. 022001-22: 53/31/40%)
function conduitSizeForOds(ods) {
  const n = ods.length;
  const fill = n === 1 ? 0.53 : n === 2 ? 0.31 : 0.40;
  const area = ods.reduce((a, od) => a + Math.PI * od * od / 4, 0);
  const need = area / fill;
  for (let i = 0; i < CONDUITS.length; i++) {
    if (Math.PI * CONDUITS[i].idmm * CONDUITS[i].idmm / 4 >= need) return { idx: i, label: CONDUITS[i].label };
  }
  return { idx: CONDUITS.length - 1, label: CONDUITS[CONDUITS.length - 1].label + ' ×หลายท่อ' };
}
function deviceById(id) { return state.devices.find(d => d.id === id); }

/* ============================================================
   ท่อร่วม (conduit sharing) — แตกเส้นทุกเส้นเป็นช่วงย่อยตามแนวเส้นตรงจริง
   นับสายที่ทับแนวเดียวกันจริง แล้วรวมช่วงติดกันที่มีสายชุดเดียวกันเป็นท่อเดียว
   ============================================================ */
const CONDUIT_MERGE_TOL_M = 0.3; // เมตร — ระยะตั้งฉากสูงสุดที่ยังถือว่า "เดินในท่อเดียวกัน"

function conduitAnalysis() {
  if (!state.pxPerM) return [];
  // แปลงเป็นพิกเซลโลกตามมาตราส่วนจริง แต่ไม่ต่ำกว่า 4px — ที่สเกลหยาบ (ภาพดาวเทียม px/ม. ต่ำ)
  // ความคลาดเคลื่อนจากการวาดมือ/การลดจุด (simplifyPts ~0.75px) ใหญ่กว่า 0.3 ม. เสียอีก
  const dTol = Math.max(CONDUIT_MERGE_TOL_M * state.pxPerM, 4);
  const segList = [];
  for (const r of state.routes) {
    if (routeLenM(r) == null || isWireless(r)) continue; // ลิงก์ไร้สายไม่มีท่อ
    const cable = CABLES[effCable(r)];
    const env = r.env || 'outdoor';
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i];
      if (dist(a, b) < 0.5) continue;
      segList.push({ a, b, od: cable.od, env, routeId: r.id });
    }
  }
  // จัดกลุ่มช่วงที่ "เดินแนวเดียวกัน" — ต้อง (1) ทิศเกือบขนานกัน (ต่างไม่เกิน ~10° กันจับคู่กับ
  // branch ที่หักฉาก) และ (2) มีปลายข้างหนึ่งห่างอีกช่วงไม่เกิน dTol แบบ clamp ปลาย (distToSeg)
  // — ใช้ distToSeg แทนระยะถึงเส้นตรงอนันต์ เพราะช่วงยาวที่เอียงต่างกันนิดเดียว (วาดมือ/ลดจุด)
  // จะมีปลายไกลเบี่ยงเกินเกณฑ์ทั้งที่ซ้อนทับกันจริง ทำให้สายเส้นทางเดียวกันไม่รวมท่อ
  const segAng = s => Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
  const sameConduit = (s1, s2) => {
    let dAng = Math.abs(segAng(s1) - segAng(s2)) % Math.PI;
    dAng = Math.min(dAng, Math.PI - dAng);
    if (dAng > 0.17) return false;
    return distToSeg(s2.a, s1.a, s1.b) < dTol || distToSeg(s2.b, s1.a, s1.b) < dTol ||
           distToSeg(s1.a, s2.a, s2.b) < dTol || distToSeg(s1.b, s2.a, s2.b) < dTol;
  };
  const parent = segList.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < segList.length; i++)
    for (let j = i + 1; j < segList.length; j++) {
      if (segList[i].env !== segList[j].env || !sameConduit(segList[i], segList[j])) continue;
      const a = find(i), b = find(j);
      if (a !== b) parent[a] = b;
    }
  const clusters = new Map();
  segList.forEach((s, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(s);
  });
  const runs = [];
  for (const segs of clusters.values()) {
    // แกนอ้างอิงร่วมของกลุ่มจากช่วงที่ยาวสุด แล้วฉายทุกช่วงลงแกนเดียวกัน
    const ref = segs.reduce((m, s) => (dist(s.a, s.b) > dist(m.a, m.b) ? s : m));
    const ang = Math.atan2(ref.b.y - ref.a.y, ref.b.x - ref.a.x);
    const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
    const d = ref.a.x * nx + ref.a.y * ny;
    segs.forEach(s => {
      s.t0 = s.a.x * ux + s.a.y * uy;
      s.t1 = s.b.x * ux + s.b.y * uy;
      if (s.t0 > s.t1) { const tmp = s.t0; s.t0 = s.t1; s.t1 = tmp; }
    });
    const bounds = [...new Set(segs.flatMap(s => [s.t0, s.t1]))].sort((a, b) => a - b);
    const micro = [];
    for (let i = 1; i < bounds.length; i++) {
      const t0 = bounds[i - 1], t1 = bounds[i];
      if (t1 - t0 < dTol) continue; // เศษช่วงสั้นระดับรอยต่อ/จุดแยก — เป็น noise ไม่ใช่ท่อจริง
      const mid = (t0 + t1) / 2;
      const covering = segs.filter(s => s.t0 <= mid + 1e-6 && s.t1 >= mid - 1e-6);
      if (!covering.length) continue;
      const routeIds = [...new Set(covering.map(s => s.routeId))].sort((a, b) => a - b);
      const ods = routeIds.map(id => covering.find(s => s.routeId === id).od);
      micro.push({ t0, t1, env: covering[0].env, routeIds, ods });
    }
    // รวมช่วงติดกันที่มีชุดสายเดียวกันเข้าเป็นท่อเดียว
    for (let i = 0; i < micro.length; i++) {
      let j = i;
      const setKey = micro[i].routeIds.join(',');
      while (j + 1 < micro.length && micro[j + 1].routeIds.join(',') === setKey && micro[j + 1].t0 - micro[j].t1 < 2 * dTol) j++;
      const m0 = micro[i], m1 = micro[j];
      const p0 = { x: d * nx + m0.t0 * ux, y: d * ny + m0.t0 * uy };
      const p1 = { x: d * nx + m1.t1 * ux, y: d * ny + m1.t1 * uy };
      const size = conduitSizeForOds(m0.ods);
      runs.push({ env: m0.env, p0, p1, lenPx: m1.t1 - m0.t0, count: m0.routeIds.length, sizeIdx: size.idx, size: size.label, routeIds: m0.routeIds });
      i = j;
    }
  }
  // รวม run ที่ชุดสายเหมือนกันและปลายต่อเนื่องกัน (ท่อเส้นเดียวเดินต่อผ่านจุดหักมุม/โค้ง)
  // เป็นเส้นทาง polyline เดียว — ไม่งั้นแนวที่เลี้ยวจะถูกแสดงเป็นหลายป้ายทั้งที่เป็นท่อเดียวกัน
  runs.forEach(r => { r.pts = [r.p0, r.p1]; });
  const joinKey = r => r.env + '|' + r.routeIds.join(',');
  let joined = true;
  while (joined) {
    joined = false;
    outer:
    for (let i = 0; i < runs.length; i++) {
      for (let j = 0; j < runs.length; j++) {
        if (i === j || joinKey(runs[i]) !== joinKey(runs[j])) continue;
        const A = runs[i].pts, B = runs[j].pts;
        let merged = null;
        if (dist(A[A.length - 1], B[0]) < dTol) merged = A.concat(B.slice(1));
        else if (dist(A[A.length - 1], B[B.length - 1]) < dTol) merged = A.concat(B.slice(0, -1).reverse());
        else if (dist(A[0], B[B.length - 1]) < dTol) merged = B.concat(A.slice(1));
        else if (dist(A[0], B[0]) < dTol) merged = B.slice(1).reverse().concat(A);
        if (merged) {
          runs[i].pts = merged;
          runs[i].lenPx += runs[j].lenPx;
          runs.splice(j, 1);
          joined = true;
          break outer;
        }
      }
    }
  }
  return runs;
}

function conduitBends(env) {
  const seen = new Set();
  for (const r of state.routes) {
    if ((r.env || 'outdoor') !== env || routeLenM(r) == null) continue;
    for (let i = 1; i < r.points.length - 1; i++) {
      seen.add(Math.round(r.points[i].x) + ',' + Math.round(r.points[i].y));
    }
  }
  return seen.size;
}

function nextLabel(type) {
  if (type === 'onu') return 'ONU';
  let mx = 0;
  state.devices.forEach(d => {
    if (d.type === type) { const m = /-(\d+)$/.exec(d.label); if (m) mx = Math.max(mx, +m[1]); }
  });
  return `${DEV[type].prefix}-${mx + 1}`;
}

/* ============================================================
   auto-routing ตามขอบอาคาร (graph + Dijkstra)
   ============================================================ */
function projToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return { t, proj, d: dist(p, proj) };
}
function nearestOnSegments(p, segs) {
  let best = null;
  segs.forEach((s, i) => {
    const r = projToSeg(p, s[0], s[1]);
    if (!best || r.d < best.d) best = { segIdx: i, ...r };
  });
  return best;
}
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u };
}
function simplifyPts(pts) {
  const out = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || dist(l, p) > 0.5) out.push({ x: p.x, y: p.y });
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross / (dist(a, c) || 1) < 0.75) out.splice(i, 1);
  }
  return out.length >= 2 ? out : pts;
}
function wallSegs() {
  const segs = [];
  state.walls.forEach(w => { for (let i = 1; i < w.points.length; i++) segs.push([w.points[i - 1], w.points[i]]); });
  return segs;
}

/* ============================================================
   ตรวจสอบว่าเส้นขอบอาคาร/แนวท่อแต่ละเส้น "เชื่อมถึงกันจริง" หรือไม่
   (ใช้กติกาเดียวกับที่ตัวหาเส้นทางใช้จริง: ต้องตัดกันหรือปลายจุดตรงกันพอดี
   แค่วางเส้นให้ดูใกล้กันบนจอไม่พอ — ป้องกันปัญหาที่เจอบ่อยว่าเส้นเชื่อมหยุดสั้นไปนิดเดียว)
   ============================================================ */
const WALL_TOUCH_PX = 1; // พิกเซลโลก — ถือว่า "จุดเดียวกัน" ถ้าห่างกันไม่เกินนี้

function wallsTouch(wi, wj) {
  const endsI = [wi.points[0], wi.points[wi.points.length - 1]];
  const endsJ = [wj.points[0], wj.points[wj.points.length - 1]];
  for (const a of endsI) for (const b of endsJ) if (dist(a, b) < WALL_TOUCH_PX) return true;
  for (let a = 1; a < wi.points.length; a++)
    for (let b = 1; b < wj.points.length; b++)
      if (segIntersect(wi.points[a - 1], wi.points[a], wj.points[b - 1], wj.points[b])) return true;
  return false;
}

// กลุ่มเส้นขอบอาคารที่เชื่อมถึงกัน — คืน Map(wallId -> componentIndex)
function wallComponentMap() {
  const walls = state.walls;
  const parent = walls.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < walls.length; i++)
    for (let j = i + 1; j < walls.length; j++)
      if (wallsTouch(walls[i], walls[j])) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
  const rootIdx = new Map(), map = new Map();
  walls.forEach((w, i) => {
    const r = find(i);
    if (!rootIdx.has(r)) rootIdx.set(r, rootIdx.size);
    map.set(w.id, rootIdx.get(r));
  });
  return map;
}

// จุดปลายของเส้น w ที่ p ลอยอิสระ ไม่แตะเส้นอื่นเลย (ไม่นับปลายทั้งสองที่ชนกันเองตอนวาดเป็นลูปปิด)
function isDanglingEnd(w, p) {
  const other = w.points[0] === p ? w.points[w.points.length - 1] : w.points[0];
  if (dist(p, other) < WALL_TOUCH_PX) return false; // ลูปปิด ปลายชนกันเอง ไม่ถือว่าลอย
  for (const w2 of state.walls) {
    if (w2 === w) continue;
    if (dist(p, w2.points[0]) < WALL_TOUCH_PX || dist(p, w2.points[w2.points.length - 1]) < WALL_TOUCH_PX) return false;
    for (let i = 1; i < w2.points.length; i++)
      if (projToSeg(p, w2.points[i - 1], w2.points[i]).d < WALL_TOUCH_PX) return false;
  }
  return true;
}
function manhattanPts(a, b) {
  const pts = [{ x: a.x, y: a.y }];
  if ($('#chkOrtho').checked && Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1)
    pts.push({ x: b.x, y: a.y });
  pts.push({ x: b.x, y: b.y });
  return pts;
}

function samePath(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => dist(p, b[i]) < 1);
}

/* สร้างตัวหาเส้นทาง: กราฟจากเส้นขอบอาคารทั้งหมด + จุดอุปกรณ์เชื่อมเข้าได้หลายเส้นใกล้เคียง
   (ให้ Dijkstra เลือกทางเข้า-ออกที่ทำให้เส้นรวมสั้นที่สุด)
   ถ้าไม่มีขอบอาคาร → เส้นตรงหักมุมฉาก (Manhattan) */
function makeRouter(devs) {
  const segs = wallSegs();
  if (!segs.length) {
    const alts = (a, b) => {
      const out = [{ points: manhattanPts(a, b) }];
      if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1)
        out.push({ points: [{ x: a.x, y: a.y }, { x: a.x, y: b.y }, { x: b.x, y: b.y }] }); // สลับมุมหัก
      return out;
    };
    return {
      path: (a, b) => manhattanPts(a, b),
      dist: (a, b) => polyLenPx(manhattanPts(a, b)),
      commit: () => {},
      alts,
    };
  }
  const keyOf = p => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
  // จุดตัดของเส้นขอบอาคารด้วยกันเอง + จุดฉายของอุปกรณ์ → แบ่งเป็นช่วงย่อย
  const splits = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const r = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (r) { splits[i].push(r.t); splits[j].push(r.u); }
    }
  const branchPx = (state.pxPerM ? BRANCH_MAX_M * state.pxPerM : 30) + 0.5; // +epsilon กันปัดเศษ
  // อุปกรณ์เชื่อมเข้าขอบอาคารได้หลายเส้น (สูงสุด 4 เส้นที่ระยะใกล้เคียงกับเส้นที่ใกล้สุด)
  const drops = [];
  devs.forEach(d => {
    const projs = segs.map((s, i) => ({ i, ...projToSeg(d, s[0], s[1]) })).sort((x, y) => x.d - y.d);
    const lim = projs[0].d * 1.8 + (state.pxPerM ? 10 * state.pxPerM : 30);
    projs.filter(p => p.d <= lim).slice(0, 4).forEach(p => {
      splits[p.i].push(p.t);
      drops.push([d, p.proj]);
    });
  });
  const adj = new Map();
  const node = p => { const k = keyOf(p); if (!adj.has(k)) adj.set(k, { p: { x: p.x, y: p.y }, e: [] }); return k; };
  const edge = (a, b) => {
    const ka = node(a), kb = node(b);
    if (ka === kb) return;
    const w = dist(a, b);
    adj.get(ka).e.push([kb, w]); adj.get(kb).e.push([ka, w]);
  };
  segs.forEach((s, i) => {
    const ts = [...new Set(splits[i].map(t => +Math.min(1, Math.max(0, t)).toFixed(6)))].sort((x, y) => x - y);
    const at = t => ({ x: s[0].x + (s[1].x - s[0].x) * t, y: s[0].y + (s[1].y - s[0].y) * t });
    for (let m = 1; m < ts.length; m++) {
      if (ts[m] - ts[m - 1] < 1e-9) continue;
      edge(at(ts[m - 1]), at(ts[m]));
    }
  });
  drops.forEach(([d, pr]) => edge(d, pr));

  const cache = new Map();
  const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  // reuseBias: Map edgeKey → ตัวคูณน้ำหนัก < 1 ลดต้นทุนช่วงที่มีสายเดินผ่านแล้ว
  // เพื่อให้สายเส้นถัด ๆ ไปเลือกเดินร่วมท่อเดิมแทนที่จะแยกท่อใหม่โดยไม่จำเป็น
  const reuseBias = new Map();
  // penal: Map edgeKey → ตัวคูณน้ำหนัก ใช้กดเส้นทางเดิมเพื่อหาเส้นทางสำรอง
  function dijkstra(srcK, penal) {
    if (!penal && cache.has(srcK)) return cache.get(srcK);
    const distM = new Map(), prev = new Map();
    const pq = [[0, srcK]];
    distM.set(srcK, 0);
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [dc, k] = pq.shift();
      if (dc > (distM.has(k) ? distM.get(k) : Infinity)) continue;
      for (const [nk, w] of adj.get(k).e) {
        const nd = dc + (penal ? w * (penal.get(edgeKey(k, nk)) || 1) : w);
        if (nd < (distM.has(nk) ? distM.get(nk) : Infinity)) {
          distM.set(nk, nd); prev.set(nk, k); pq.push([nd, nk]);
        }
      }
    }
    const r = { distM, prev };
    if (!penal) cache.set(srcK, r);
    return r;
  }
  function rawPath(ka, kb, penal) {
    const { distM, prev } = dijkstra(ka, penal);
    if (!distM.has(kb)) return null;
    const keys = [];
    let k = kb;
    while (k !== undefined) { keys.push(k); if (k === ka) break; k = prev.get(k); }
    return keys.reverse();
  }
  const keysLen = keys => {
    let L = 0;
    for (let i = 1; i < keys.length; i++) L += dist(adj.get(keys[i - 1]).p, adj.get(keys[i]).p);
    return L;
  };
  const keysPts = keys => simplifyPts(keys.map(k => adj.get(k).p));
  // ห้ามเดินนอกแนวอาคาร/แนวท่อ — ข้อยกเว้นเดียว: จุดสองจุดใกล้กันมาก (≤ BRANCH_MAX_M
  // เช่น ONU→DSW ในตู้เดียวกัน) ต่อตรงแบบ patch ได้
  return {
    // คืนจุดเส้นทาง หรือ null ถ้าต้องเดินนอกแนว (ผู้เรียกต้องข้ามการเชื่อมนี้)
    path(a, b) {
      const direct = dist(a, b) <= branchPx ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : null;
      const ka = keyOf(a), kb = keyOf(b);
      if (ka === kb || !adj.has(ka) || !adj.has(kb)) return direct;
      const keys = rawPath(ka, kb, reuseBias.size ? reuseBias : null);
      if (!keys) return direct; // กราฟไม่ต่อถึงกัน — ยอมให้เฉพาะระยะใกล้มาก
      if (direct && polyLenPx(direct) < keysLen(keys)) return direct;
      return keysPts(keys);
    },
    // เรียกหลังจาก path(a,b) ถูกใช้จริงแล้ว — กดต้นทุนช่วงที่เพิ่งเดินผ่านให้ถูกลง
    // เพื่อให้สายเส้นถัดไปเลือกใช้ท่อร่วมเดิมเมื่อเป็นไปได้ (ลดจำนวนท่อที่ต้องเดินแยก)
    commit(a, b) {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka === kb || !adj.has(ka) || !adj.has(kb)) return;
      const keys = rawPath(ka, kb, reuseBias.size ? reuseBias : null);
      if (!keys) return;
      for (let i = 1; i < keys.length; i++) {
        const ek = edgeKey(keys[i - 1], keys[i]);
        reuseBias.set(ek, Math.max(0.35, (reuseBias.get(ek) || 1) * 0.55));
      }
    },
    dist(a, b) {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka === kb) return 0;
      const euclid = dist(a, b);
      const g = (adj.has(ka) && adj.has(kb))
        ? (dijkstra(ka).distM.get(kb) ?? Infinity)
        : Infinity;
      return euclid <= branchPx ? Math.min(euclid, g) : g;
    },
    // แนวเดินสายทางเลือก: หาเส้นทางสำรองโดยกดน้ำหนักเส้นทางที่พบแล้ว (penalty method)
    alts(a, b, maxAlt = 3) {
      const ka = keyOf(a), kb = keyOf(b);
      const out = [];
      const push = pts => {
        if (pts && pts.length >= 2 && !out.some(o => samePath(o.points, pts))) out.push({ points: pts });
      };
      // มีแนวท่อแล้ว: จุดที่ต่อไม่ถึงแนว → ไม่เสนอเส้นนอกแนว
      if (ka === kb || !adj.has(ka) || !adj.has(kb)) return out;
      const base = rawPath(ka, kb, null);
      if (!base) return out;
      push(keysPts(base));
      const baseLen = keysLen(base);
      const penal = new Map();
      let prevKeys = base;
      for (let n = 0; n < maxAlt + 2 && out.length < maxAlt; n++) {
        for (let i = 1; i < prevKeys.length; i++) {
          const ek = edgeKey(prevKeys[i - 1], prevKeys[i]);
          penal.set(ek, (penal.get(ek) || 1) * 4);
        }
        const alt = rawPath(ka, kb, penal);
        if (!alt || keysLen(alt) > baseLen * 2.5 + 1) break; // ยาวเกินไป ไม่คุ้มเป็นทางเลือก
        push(keysPts(alt));
        prevKeys = alt;
      }
      return out;
    },
  };
}

/* ============================================================
   auto-placement DSW / PSW (k-means จัดกลุ่มกล้อง ≤8 ตัว/สวิตช์)
   ============================================================ */
function kmeansCenters(pts, k, fixed) {
  k = Math.min(Math.max(k, 1), pts.length + fixed.length);
  const centers = fixed.map(f => ({ x: f.x, y: f.y, fixed: true }));
  // เริ่มด้วยจุดที่ไกลจาก center เดิมที่สุด (farthest-point)
  while (centers.length < k) {
    let best = pts[0], bd = -1;
    for (const p of pts) {
      const d = centers.length ? Math.min(...centers.map(c => dist(p, c))) : Infinity;
      if (d > bd) { bd = d; best = p; }
    }
    centers.push({ x: best.x, y: best.y, fixed: false });
  }
  for (let it = 0; it < 25; it++) {
    const sums = centers.map(() => ({ x: 0, y: 0, n: 0 }));
    for (const p of pts) {
      let bi = 0;
      for (let i = 1; i < centers.length; i++) if (dist(p, centers[i]) < dist(p, centers[bi])) bi = i;
      sums[bi].x += p.x; sums[bi].y += p.y; sums[bi].n++;
    }
    let movedAny = false;
    centers.forEach((c, i) => {
      if (c.fixed || !sums[i].n) return;
      const nx = sums[i].x / sums[i].n, ny = sums[i].y / sums[i].n;
      if (Math.hypot(nx - c.x, ny - c.y) > 0.5) movedAny = true;
      c.x = nx; c.y = ny;
    });
    if (!movedAny) break;
  }
  return centers;
}
function autoPlaceSwitches() {
  const cams = state.devices.filter(d => d.type === 'cam');
  // WAP ก็ต้องมี PoE Switch จ่ายไฟ + uplink เช่นกัน → รวมเป็น endpoint ที่ต้องมีสวิตช์ในระยะ
  const waps = state.devices.filter(d => d.type === 'wap');
  const endpoints = [...cams, ...waps];
  const onu = state.devices.find(d => d.type === 'onu');
  if (!onu || !endpoints.length) {
    $('#statusHint').textContent = 'ต้องวางจุด ONU และกล้อง/WAP อย่างน้อย 1 ตัวก่อน (ขั้นตอนที่ 3)';
    return;
  }
  // ล้างสวิตช์ที่วางอัตโนมัติรอบก่อน + เส้นที่เกี่ยวข้อง
  const autoIds = new Set(state.devices.filter(d => d.auto).map(d => d.id));
  state.devices = state.devices.filter(d => !d.auto);
  state.routes = state.routes.filter(r => !autoIds.has(r.fromId) && !autoIds.has(r.toId));

  const manualPsw = state.devices.filter(d => d.type === 'psw');
  const segs = wallSegs();
  const branchPx = state.pxPerM ? BRANCH_MAX_M * state.pxPerM + 0.5 : Infinity;
  // จุดที่แตะแนวอาคาร/ท่อได้ (มี PSW ตัวใหม่ช่วยจ่ายได้) — จุดที่ไกลทุกแนวเพิ่มสวิตช์ก็ไม่ช่วย
  const nearWall = p => !segs.length || segs.reduce((m, s) => Math.min(m, projToSeg(p, s[0], s[1]).d), Infinity) <= branchPx;
  let k = Math.max(manualPsw.length || 1, Math.ceil(endpoints.length / 8));
  let placed = [];
  // เพิ่มจำนวน PSW จนกล้อง/WAP ทุกตัว (ที่แตะแนวได้) อยู่ในระยะ CAT6 ตามเส้นทางเดินจริง
  for (let attempt = 0; ; attempt++) {
    const centers = kmeansCenters(endpoints, k, manualPsw);
    placed = centers.slice(manualPsw.length).map(c => {
      if (segs.length) { const n = nearestOnSegments(c, segs); if (n) return { x: n.proj.x, y: n.proj.y }; } // ยึด PSW เข้ากับขอบอาคาร
      return { x: c.x, y: c.y };
    });
    if (!state.pxPerM || k >= endpoints.length || attempt >= 4) break;
    const all = [...manualPsw.map(m => ({ x: m.x, y: m.y })), ...placed];
    const router = makeRouter([...all, ...endpoints.map(e => ({ x: e.x, y: e.y }))]);
    // จุดที่แตะแนวได้แต่ยังไม่มีสวิตช์ในระยะ (รวมจุดคนละอาคารที่ระยะ Infinity) → ต้องเพิ่มสวิตช์
    const reach = endpoints.filter(nearWall).map(e => Math.min(...all.map(p => router.dist(e, p))));
    const worst = reach.length ? Math.max(...reach) : 0;
    if (worst / state.pxPerM <= CAT6_MAX - 10) break;
    k++;
  }
  placed.forEach(pos => {
    state.devices.push({ id: state.nextId++, type: 'psw', x: pos.x, y: pos.y, label: nextLabel('psw'), auto: true });
  });
  if (!state.devices.some(d => d.type === 'dsw')) {
    const off = state.pxPerM ? 3 * state.pxPerM : 20; // DSW อยู่ตู้เดียวกับ ONU (ห่าง ~3 ม.)
    state.devices.push({ id: state.nextId++, type: 'dsw', x: onu.x + off, y: onu.y, label: nextLabel('dsw'), auto: true });
  }
  refresh();
  const nP = state.devices.filter(d => d.type === 'psw').length;
  $('#statusHint').textContent = `วางสวิตช์แล้ว: PoE SW ${nP} ตัว (กล้อง ${cams.length} + WAP ${waps.length}, ≤8 ตัว/สวิตช์) — ลากย้ายปรับได้ แล้วกด "คำนวณแนวสายอัตโนมัติ"`;
}

/* ============================================================
   แนวเดินสายทางเลือก (alternative routes)
   ============================================================ */
const ALT_COLORS = ['#a78bfa', '#34d399', '#f472b6'];

function showAlternatives(id) {
  const r = state.routes.find(x => x.id === id);
  if (!r) return;
  const a = deviceById(r.fromId), b = deviceById(r.toId);
  if (!a || !b) return;
  const router = makeRouter([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
  const opts = router.alts({ x: a.x, y: a.y }, { x: b.x, y: b.y }, 3)
    .filter(o => !samePath(o.points, r.points))
    .slice(0, 3);
  state.altView = opts.length ? { routeId: id, options: opts } : null;
  state.selected = { kind: 'route', id };
  centerOnRoute(r);
  refresh();
  $('#statusHint').textContent = opts.length
    ? `พบแนวทางเลือก ${opts.length} เส้นทาง — คลิกเส้นประบนภาพ หรือปุ่ม "ใช้เส้นนี้" ในตาราง · Esc = ปิด`
    : 'ไม่พบแนวเดินสายทางเลือกอื่นสำหรับเส้นนี้ — ลองวาดขอบอาคาร/แนวท่อเพิ่ม';
}

function applyAlt(i) {
  if (!state.altView) return;
  const r = state.routes.find(x => x.id === state.altView.routeId);
  const o = state.altView.options[i];
  if (!r || !o) { state.altView = null; refresh(); return; }
  r.points = o.points.map(p => ({ x: p.x, y: p.y }));
  state.altView = null;
  refresh();
  const L = routeLenM(r);
  $('#statusHint').textContent = `แทนที่แนวเส้น ${routeLabel(r)} ด้วยทางเลือกแล้ว${L != null ? ` (${L.toFixed(0)} ม.)` : ''}`;
}

function clearAlts() {
  if (!state.altView) return;
  state.altView = null;
  refresh();
}

function hitAlt(scr) {
  if (!state.altView) return null;
  for (let i = 0; i < state.altView.options.length; i++) {
    const pts = state.altView.options[i].points.map(w2s);
    for (let j = 1; j < pts.length; j++)
      if (distToSeg(scr, pts[j - 1], pts[j]) <= 7) return i;
  }
  return null;
}

function renderAltBox() {
  const box = $('#altBox');
  if (!state.altView) { box.innerHTML = ''; return; }
  const r = state.routes.find(x => x.id === state.altView.routeId);
  if (!r) { state.altView = null; box.innerHTML = ''; return; }
  const cur = routeLenM(r);
  box.innerHTML =
    `<div class="alt-head">🔀 แนวทางเลือกของ ${routeLabel(r)} — เส้นปัจจุบัน ${cur != null ? cur.toFixed(0) + ' ม.' : '—'}</div>` +
    state.altView.options.map((o, i) => {
      const L = state.pxPerM ? polyLenPx(o.points) / state.pxPerM : null;
      return `<div class="alt-item" style="border-left-color:${ALT_COLORS[i % ALT_COLORS.length]}">
        <span>ทางเลือก ${i + 1} — ${L != null ? L.toFixed(0) + ' ม.' : '—'}</span>
        <button class="btn" data-usealt="${i}">ใช้เส้นนี้</button>
      </div>`;
    }).join('') +
    `<div class="row"><button class="btn" id="btnCloseAlt">ปิดทางเลือก (Esc)</button></div>`;
  box.querySelectorAll('button[data-usealt]').forEach(btn =>
    btn.addEventListener('click', () => applyAlt(+btn.dataset.usealt)));
  box.querySelector('#btnCloseAlt').addEventListener('click', clearAlts);
}

/* ============================================================
   auto-route: ONU→DSW→PSW→CAM ตามขอบอาคาร
   ============================================================ */
function autoRouteAll() {
  const onu = state.devices.find(d => d.type === 'onu');
  const dsw = state.devices.find(d => d.type === 'dsw');
  const psws = state.devices.filter(d => d.type === 'psw');
  const cams = state.devices.filter(d => d.type === 'cam');
  const waps = state.devices.filter(d => d.type === 'wap');
  if (!cams.length || !psws.length) {
    $('#statusHint').textContent = 'ต้องมีกล้องและ PoE Switch ก่อน — วางเองหรือกด "วาง DSW/PSW อัตโนมัติ"';
    return;
  }
  state.routes = state.routes.filter(r => !r.auto); // คำนวณใหม่แบบ idempotent
  const router = makeRouter([onu, dsw, ...psws, ...cams, ...waps].filter(Boolean).map(d => ({ x: d.x, y: d.y })));
  const has = (a, b) => state.routes.some(r =>
    (r.fromId === a.id && r.toId === b.id) || (r.fromId === b.id && r.toId === a.id));
  const skipped = [];
  const mk = (a, b) => {
    if (!a || !b || has(a, b)) return false;
    const pts = router.path(a, b);
    if (!pts) { skipped.push(`${a.label}→${b.label}`); return false; } // ห้ามลากนอกแนว
    router.commit(a, b); // ลดต้นทุนช่วงนี้ไว้ ให้เส้นถัดไปเลือกร่วมท่อเดิมได้ถ้าคุ้ม
    state.routes.push({
      id: state.nextId++, fromId: a.id, toId: b.id,
      points: pts, override: 'auto', env: 'outdoor', auto: true,
    });
    return true;
  };
  let n = 0;
  if (onu && dsw) n += mk(onu, dsw) ? 1 : 0;
  if (dsw) psws.forEach(p => { n += mk(dsw, p) ? 1 : 0; });
  // นับโหลดเดิมของแต่ละ PSW (เส้นที่ผู้ใช้ลากเอง)
  const load = new Map(psws.map(p => [p.id, 0]));
  const linkedCams = new Set();
  state.routes.forEach(r => {
    const f = deviceById(r.fromId), t = deviceById(r.toId);
    if (!f || !t) return;
    const pair = f.type === 'psw' && t.type === 'cam' ? [f, t] :
                 t.type === 'psw' && f.type === 'cam' ? [t, f] : null;
    if (pair) { load.set(pair[0].id, (load.get(pair[0].id) || 0) + 1); linkedCams.add(pair[1].id); }
  });
  // จ่ายกล้องเข้าสวิตช์ที่ใกล้สุด (ตามระยะจริงบนกราฟ) โดยไม่เกิน 8 พอร์ต
  const todo = cams.filter(c => !linkedCams.has(c.id))
    .map(c => ({
      c,
      ds: psws.map(p => ({ p, d: router.dist(c, p) }))
        .filter(x => isFinite(x.d))            // ตัดปลายทางที่ต่อถึงกันตามแนวไม่ได้
        .sort((x, y) => x.d - y.d),
    }))
    .sort((x, y) => (x.ds.length ? x.ds[0].d : Infinity) - (y.ds.length ? y.ds[0].d : Infinity));
  for (const t of todo) {
    if (!t.ds.length) { skipped.push(`${t.c.label} (ห่างแนวเกิน ${BRANCH_MAX_M} ม.)`); continue; }
    const pick = t.ds.find(x => (load.get(x.p.id) || 0) < 8) || t.ds[0];
    load.set(pick.p.id, (load.get(pick.p.id) || 0) + 1);
    n += mk(pick.p, t.c) ? 1 : 0;
  }
  // จ่าย uplink ให้ WAP ที่ยังไม่มีสายเข้าสวิตช์: ต่อสาย (CAT6/Fiber) ไปสวิตช์ที่ใกล้สุด (PSW ก่อน, DSW สำรอง)
  const uplinkSwitches = [...psws, dsw].filter(Boolean);
  const cabledWap = new Set();
  state.routes.forEach(r => {
    const f = deviceById(r.fromId), t = deviceById(r.toId);
    if (!f || !t) return;
    const wp = f.type === 'wap' ? f : t.type === 'wap' ? t : null;
    const sw = (f.type === 'psw' || f.type === 'dsw') ? f : ((t.type === 'psw' || t.type === 'dsw') ? t : null);
    if (wp && sw) cabledWap.add(wp.id);
  });
  const wapTodo = waps.filter(w => !cabledWap.has(w.id))
    .map(w => ({
      w,
      ds: uplinkSwitches.map(p => ({ p, d: router.dist(w, p) }))
        .filter(x => isFinite(x.d))
        .sort((x, y) => x.d - y.d),
    }))
    .sort((x, y) => (x.ds.length ? x.ds[0].d : Infinity) - (y.ds.length ? y.ds[0].d : Infinity));
  for (const t of wapTodo) {
    if (!t.ds.length) { skipped.push(`${t.w.label} (ห่างแนวเกิน ${BRANCH_MAX_M} ม.)`); continue; }
    // เลือก PSW ที่พอร์ตยังว่างก่อน; ถ้าไม่มีเลยใช้จุดใกล้สุด (อาจเป็น DSW)
    const pick = t.ds.find(x => x.p.type === 'psw' && (load.get(x.p.id) || 0) < 8) || t.ds[0];
    if (pick.p.type === 'psw') load.set(pick.p.id, (load.get(pick.p.id) || 0) + 1);
    n += mk(pick.p, t.w) ? 1 : 0;
  }
  refresh();
  const skipMsg = skipped.length
    ? ` · ข้าม ${skipped.length} จุดที่อยู่นอกแนว (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}) — วาดแนวท่อไปให้ถึง หรือย้ายจุดเข้าใกล้แนว`
    : '';
  $('#statusHint').textContent = state.walls.length
    ? `คำนวณแนวสายตามแนวอาคาร/ท่อแล้ว ${n} เส้น${skipMsg}`
    : `คำนวณแนวสายแล้ว ${n} เส้น (แนวเส้นตรงหักมุมฉาก — วาด "ขอบอาคาร" ก่อนเพื่อให้เส้นเลาะตามแนวอาคาร)`;
}

function routeLabel(route) {
  const a = deviceById(route.fromId), b = deviceById(route.toId);
  return `${a ? a.label : '?'} → ${b ? b.label : '?'}`;
}

function routeNotes(route) {
  const notes = [];
  const L = routeLenM(route);
  const cable = effCable(route);
  const a = deviceById(route.fromId), b = deviceById(route.toId);
  const hasCam = (a && a.type === 'cam') || (b && b.type === 'cam');
  if (cable === 'wireless') {
    notes.push('ลิงก์ไร้สาย (Point-to-Point/Bridge) — ต้องมองเห็นกันชัด (Line-of-Sight) และจ่ายไฟ + สาย uplink ที่แต่ละ WAP แยกต่างหาก');
    return notes;
  }
  if (L == null) notes.push('ยังไม่ตั้งสเกล — วัดระยะไม่ได้');
  if (cable === 'cat6' && L != null && L > CAT6_MAX)
    notes.push(`เกินพิกัด ${CAT6_MAX} ม. ของ CAT6 — ควรเปลี่ยนเป็น Fiber`);
  else if (cable === 'cat6' && L != null && L > TIA_CH_MAX)
    notes.push(`เกิน ${TIA_CH_MAX} ม. (มาตรฐาน TIA-568) — ใช้โหมด Extended PoE ของสวิตช์ Hikvision`);
  if (cable === 'fiber' && hasCam)
    notes.push('ปลายทางเป็นกล้อง: ต้องใช้ Media Converter/SFP และจ่ายไฟกล้องแยกในพื้นที่ (PoE ส่งผ่านไฟเบอร์ไม่ได้)');
  return notes;
}

/* ============================================================
   drawing
   ============================================================ */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  draw();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
  if (!state.img) return;

  // image
  ctx.save();
  ctx.setTransform(dpr * state.view.s, 0, 0, dpr * state.view.s, dpr * state.view.ox, dpr * state.view.oy);
  ctx.drawImage(state.img, 0, 0);
  ctx.restore();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  drawScene(ctx, w2s, 1, { screen: true });
  drawLegend(ctx, 12, 12, 1);
}

/* วาด overlay ทั้งหมด — ใช้ร่วมกันทั้งบนจอและตอน export
   proj: world->target coords, k: ตัวคูณขนาดเส้น/ฟอนต์ */
function drawScene(g, proj, k, opts = {}) {
  // ---- calibration line ----
  if (state.cal.p1) {
    const p1 = proj(state.cal.p1);
    g.strokeStyle = '#38bdf8'; g.lineWidth = 2 * k; g.setLineDash([6 * k, 4 * k]);
    if (state.cal.p2) {
      const p2 = proj(state.cal.p2);
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
      crossMark(g, p2, k);
    } else if (opts.screen && state.mode === 'calibrate' && state.hoverW) {
      const p2 = proj(state.hoverW);
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
    }
    g.setLineDash([]);
    crossMark(g, p1, k);
  }

  // ---- walls (ขอบอาคาร/แนวท่อ) ----
  // ถ้ามีมากกว่า 1 เส้น ให้ไล่สีตามกลุ่มที่เชื่อมถึงกันจริง (ตัดกัน/ปลายชนกัน) เพื่อให้เห็นทันทีว่า
  // เส้นไหนยังไม่เชื่อมกับเครือข่ายหลัก — ถ้าเชื่อมเป็นกลุ่มเดียวหมดจะได้สีฟ้าเดิมทุกเส้น (ไม่มีอะไรเปลี่ยน)
  const wallCompMap = state.walls.length > 1 ? wallComponentMap() : null;
  for (const wl of state.walls) {
    const sel = state.selected && state.selected.kind === 'wall' && state.selected.id === wl.id;
    const color = wallCompMap ? WALL_GROUP_COLORS[wallCompMap.get(wl.id) % WALL_GROUP_COLORS.length] : null;
    const dangle = [isDanglingEnd(wl, wl.points[0]), isDanglingEnd(wl, wl.points[wl.points.length - 1])];
    drawWall(g, wl.points.map(proj), k, sel, color, dangle);
  }
  if (opts.screen && state.wallDraft) {
    drawWall(g, state.wallDraft.points.map(proj), k, true);
    if (state.hoverW && state.wallDraft.points.length) {
      const last = state.wallDraft.points[state.wallDraft.points.length - 1];
      const nxt = snapPoint(last, state.hoverW);
      const a = proj(last), b = proj(nxt);
      g.strokeStyle = '#22d3ee'; g.lineWidth = 1.5 * k; g.setLineDash([4 * k, 4 * k]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.setLineDash([]);
    }
  }

  // ---- ท่อร้อยสายจริง (casing สี+จำนวนสายทับกัน) — เลือกรูปแบบที่ #selConduit ----
  if (opts.screen) conduitLabelHits = [];
  const conduitMode = $('#selConduit').value;
  if (conduitMode !== 'off') drawConduitOverlay(g, proj, k, conduitMode, opts.screen);

  // ---- routes ----
  state.routes.forEach((r, ri) => {
    const cable = CABLES[effCable(r)];
    const sel = state.selected && state.selected.kind === 'route' && state.selected.id === r.id;
    // ลิงก์ไร้สายวาดเป็นเส้นประ (ไม่ใช่แนวเดินสายจริง)
    strokePoly(g, r.points.map(proj), cable.color, sel ? 6 * k : 4 * k, k, sel, cable.wireless ? [10 * k, 7 * k] : null);
    // ป้ายระยะที่กึ่งกลางเส้น — โหมด "กรอบชี้เส้น" ใช้กรอบชี้แบบเดียวกับป้ายท่อ ไม่ทับบนเส้น
    // ลากย้ายได้เหมือนป้ายท่อ (คีย์ r+id เก็บใน conduitLabelOffsets ชุดเดียวกัน)
    const L = routeLenM(r);
    const mid = polyMidpoint(r.points);
    const txt = L != null ? `${r.name || ''}${L.toFixed(0)} ม.` : '— ม.';
    const rKey = 'r' + r.id;
    const rOff = state.conduitLabelOffsets[rKey];
    let rRect;
    if (conduitMode === 'callout') {
      const a = proj(r.points[0]), b = proj(r.points[r.points.length - 1]);
      const chord = dist(a, b);
      const ux = chord ? (b.x - a.x) / chord : 1, uy = chord ? (b.y - a.y) / chord : 0;
      const side = ri % 2 ? -1 : 1; // สลับฝั่ง (สวนทางกับ callout ของท่อ) ลดการซ้อนกัน
      const pm = proj(mid);
      const center = rOff ? proj({ x: mid.x + rOff.x, y: mid.y + rOff.y })
        : { x: pm.x - uy * side * 34 * k, y: pm.y + ux * side * 34 * k };
      rRect = conduitCallout(g, pm, center, [txt], cable.color, k);
    } else {
      const pos = rOff ? proj({ x: mid.x + rOff.x, y: mid.y + rOff.y }) : proj(mid);
      rRect = pill(g, pos, txt, cable.color, k);
    }
    if (opts.screen && rRect) conduitLabelHits.push({ ...rRect, key: rKey, midW: mid });
  });

  // ---- แนวเดินสายทางเลือก (เส้นประ ชั่วคราว) ----
  if (opts.screen && state.altView) {
    state.altView.options.forEach((o, i) => {
      const color = ALT_COLORS[i % ALT_COLORS.length];
      strokePoly(g, o.points.map(proj), color, 3 * k, k, false, [10 * k, 6 * k]);
      const L = state.pxPerM ? polyLenPx(o.points) / state.pxPerM : null;
      pill(g, proj(polyMidpoint(o.points)),
        `ทางเลือก ${i + 1}${L != null ? ' · ' + L.toFixed(0) + ' ม.' : ''}`, color, k);
    });
  }

  // ---- draft route ----
  if (opts.screen && state.draft) {
    const pts = state.draft.points.map(proj);
    strokePoly(g, pts, '#38bdf8', 3 * k, k, false, [8 * k, 5 * k]);
    if (state.hoverW) {
      const last = state.draft.points[state.draft.points.length - 1];
      const nxt = snapPoint(last, state.hoverW);
      const a = proj(last), b = proj(nxt);
      g.strokeStyle = '#38bdf8'; g.lineWidth = 2 * k; g.setLineDash([4 * k, 4 * k]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.setLineDash([]);
      if (state.pxPerM) {
        const L = (polyLenPx(state.draft.points) + dist(last, nxt)) / state.pxPerM;
        pill(g, { x: b.x + 14 * k, y: b.y - 14 * k }, `${L.toFixed(0)} ม.`, '#38bdf8', k);
      }
    }
  }

  // ---- devices ----
  for (const d of state.devices) {
    const p = proj(d);
    const sel = state.selected && state.selected.kind === 'device' && state.selected.id === d.id;
    drawDevice(g, d, p, k, sel);
  }
}

function strokePoly(g, pts, color, w, k, glow, dash) {
  if (pts.length < 2) return;
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (dash) g.setLineDash(dash);
  // เส้นขอบเข้มให้มองเห็นบนภาพถ่าย
  g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = w + 3 * k;
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.stroke();
  g.strokeStyle = color; g.lineWidth = w;
  if (glow) { g.shadowColor = color; g.shadowBlur = 12 * k; }
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.stroke();
  g.shadowBlur = 0; g.setLineDash([]);
  // จุดหักมุม
  for (let i = 1; i < pts.length - 1; i++) {
    g.fillStyle = color; g.beginPath(); g.arc(pts[i].x, pts[i].y, 2.5 * k + w / 4, 0, Math.PI * 2); g.fill();
  }
}

function polyMidpoint(points) {
  const total = polyLenPx(points);
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (acc + seg >= total / 2) {
      const t = (total / 2 - acc) / seg;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    acc += seg;
  }
  return points[0];
}

function pill(g, p, text, color, k) {
  g.font = `${11.5 * k}px "Segoe UI", "Leelawadee UI", sans-serif`;
  const w = g.measureText(text).width + 12 * k, h = 17 * k;
  const x = p.x - w / 2, y = p.y - h / 2;
  g.fillStyle = 'rgba(10,15,28,.88)';
  roundRect(g, x, y, w, h, 8 * k); g.fill();
  g.strokeStyle = color; g.lineWidth = 1 * k; roundRect(g, x, y, w, h, 8 * k); g.stroke();
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, p.x, p.y + 0.5 * k);
  return { x, y, w, h };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const WALL_GROUP_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#facc15'];

function drawWall(g, pts, k, sel, color, dangle) {
  if (pts.length < 1) return;
  color = color || '#22d3ee';
  g.save();
  g.strokeStyle = sel ? '#67e8f9' : color;
  g.lineWidth = (sel ? 3 : 2) * k;
  g.setLineDash([7 * k, 4 * k]);
  if (sel) { g.shadowColor = '#22d3ee'; g.shadowBlur = 10 * k; }
  if (pts.length >= 2) {
    g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
    g.stroke();
  }
  g.setLineDash([]);
  g.fillStyle = color;
  for (const p of pts) { g.beginPath(); g.arc(p.x, p.y, 2.5 * k, 0, Math.PI * 2); g.fill(); }
  // ปลายเส้นที่ลอยอิสระ (ไม่แตะเส้นอื่น) — วงกลมเตือนสีส้ม
  if (dangle) {
    [[0, dangle[0]], [pts.length - 1, dangle[1]]].forEach(([i, isDangling]) => {
      if (!isDangling || !pts[i]) return;
      g.strokeStyle = '#f97316'; g.lineWidth = 2 * k;
      g.beginPath(); g.arc(pts[i].x, pts[i].y, 7 * k, 0, Math.PI * 2); g.stroke();
    });
  }
  g.restore();
}

const CONDUIT_COLORS = ['#94a3b8', '#60a5fa', '#34d399', '#fbbf24', '#f97316'];

function drawConduitOverlay(g, proj, k, mode, screen) {
  conduitAnalysis().forEach((run, idx) => {
    const P = run.pts.map(proj);
    // จุดกึ่งกลางเส้นทางในพิกัดโลก — ใช้เป็นคีย์ประจำช่วงและจุดอ้างอิง offset ป้ายที่ผู้ใช้ลากย้าย
    const midW = polyMidpoint(run.pts);
    const key = run.routeIds.join(',') + '|' + Math.round(midW.x) + ',' + Math.round(midW.y);
    const off = state.conduitLabelOffsets[key];
    const color = CONDUIT_COLORS[Math.min(run.sizeIdx, CONDUIT_COLORS.length - 1)];
    g.save();
    g.lineCap = 'butt'; g.lineJoin = 'round'; g.globalAlpha = 0.55;
    g.strokeStyle = color; g.lineWidth = 8 * k;
    g.beginPath(); P.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.stroke();
    g.globalAlpha = 1;
    // ขีดจำนวนสายที่ทับกันในท่อนี้ — กระจายตามความยาวเส้นทาง
    const len = polyLenPx(P);
    if (len > 4) {
      for (let c = 1; c <= run.count; c++) {
        let target = len * c / (run.count + 1), acc = 0;
        for (let i2 = 1; i2 < P.length; i2++) {
          const segL = dist(P[i2 - 1], P[i2]);
          if (acc + segL >= target && segL > 0) {
            const t = (target - acc) / segL;
            const px = P[i2 - 1].x + (P[i2].x - P[i2 - 1].x) * t;
            const py = P[i2 - 1].y + (P[i2].y - P[i2 - 1].y) * t;
            const ux = (P[i2].x - P[i2 - 1].x) / segL, uy = (P[i2].y - P[i2 - 1].y) / segL;
            g.strokeStyle = 'rgba(15,23,42,.9)'; g.lineWidth = 1.5 * k;
            g.beginPath(); g.moveTo(px + uy * 4 * k, py - ux * 4 * k); g.lineTo(px - uy * 4 * k, py + ux * 4 * k); g.stroke();
            break;
          }
          acc += segL;
        }
      }
    }
    g.restore();
    const Lm = run.lenPx / state.pxPerM;
    const a = P[0], b = P[P.length - 1];
    const mid = proj(midW);
    // จำนวนสายแยกตามชนิด เช่น "CAT6 ×2 + Fiber ×1"
    const byCable = {};
    run.routeIds.forEach(id => {
      const r = state.routes.find(x => x.id === id);
      if (!r) return;
      const nm = effCable(r) === 'cat6' ? 'CAT6' : 'Fiber';
      byCable[nm] = (byCable[nm] || 0) + 1;
    });
    const cableLine = Object.entries(byCable).map(([nm, n]) => `${nm} ×${n}`).join(' + ') || `${run.count} สาย`;
    let rect;
    if (mode === 'callout') {
      // กรอบชี้เส้นแบบแบบแปลนวิศวกรรม: ยกกรอบออกด้านข้างแนวท่อ สลับฝั่งกันไม่ให้ซ้อน
      // ถ้าผู้ใช้เคยลากย้ายป้ายช่วงนี้ ใช้ตำแหน่งที่ลากไว้ (offset โลก) แทนตำแหน่งอัตโนมัติ
      const chord = dist(a, b);
      const ux = chord ? (b.x - a.x) / chord : 1, uy = chord ? (b.y - a.y) / chord : 0;
      const side = idx % 2 ? 1 : -1;
      const center = off
        ? proj({ x: midW.x + off.x, y: midW.y + off.y })
        : { x: mid.x - uy * side * 52 * k, y: mid.y + ux * side * 52 * k };
      rect = conduitCallout(g, mid, center, [
        `${ENVS[run.env].short} ${run.size}`,
        cableLine,
        `ยาว ${Lm.toFixed(0)} ม.`,
      ], color, k);
    } else {
      // ป้ายบนเส้น: ชนิด ขนาด จำนวนสายแยกชนิด ความยาว — เลื่อนลงเล็กน้อยไม่ให้ทับป้ายระยะของเส้นสาย
      const pos = off
        ? proj({ x: midW.x + off.x, y: midW.y + off.y })
        : { x: mid.x, y: mid.y + 18 * k };
      rect = pill(g, pos,
        `${ENVS[run.env].short} ${run.size.replace(' ×หลายท่อ', '')} · ${cableLine} · ${Lm.toFixed(0)} ม.`, color, k * 0.9);
    }
    if (screen && rect) conduitLabelHits.push({ ...rect, key, midW });
  });
}

function conduitCallout(g, anchor, center, lines, color, k) {
  const cx = center.x, cy = center.y;
  g.font = `${11 * k}px "Segoe UI", "Leelawadee UI", sans-serif`;
  const w = Math.max(...lines.map(t => g.measureText(t).width)) + 14 * k;
  const lh = 14.5 * k, h = lines.length * lh + 8 * k;
  const x = cx - w / 2, y = cy - h / 2;
  // เส้นชี้จากแนวท่อไปยังกรอบ (วาดก่อน ให้กรอบทับปลายเส้น)
  g.strokeStyle = color; g.lineWidth = 1.2 * k;
  g.beginPath(); g.moveTo(anchor.x, anchor.y); g.lineTo(cx, cy); g.stroke();
  g.fillStyle = color;
  g.beginPath(); g.arc(anchor.x, anchor.y, 2.5 * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(10,15,28,.92)';
  roundRect(g, x, y, w, h, 4 * k); g.fill();
  g.strokeStyle = color; g.lineWidth = 1.2 * k; roundRect(g, x, y, w, h, 4 * k); g.stroke();
  g.fillStyle = '#e2e8f0'; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((t, i) => g.fillText(t, cx, y + 4 * k + lh * (i + 0.5)));
  return { x, y, w, h };
}

function crossMark(g, p, k) {
  g.strokeStyle = '#38bdf8'; g.lineWidth = 2 * k;
  g.beginPath();
  g.moveTo(p.x - 6 * k, p.y); g.lineTo(p.x + 6 * k, p.y);
  g.moveTo(p.x, p.y - 6 * k); g.lineTo(p.x, p.y + 6 * k);
  g.stroke();
}

function drawDevice(g, d, p, k, sel) {
  const R = 11 * k;
  g.save();
  if (sel) { g.shadowColor = '#38bdf8'; g.shadowBlur = 14 * k; }
  if (d.type === 'onu') {
    starPath(g, p.x, p.y, 14 * k, 6 * k, 5);
    g.fillStyle = '#ef4444'; g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k; g.stroke();
  } else if (d.type === 'cam') {
    g.beginPath(); g.arc(p.x, p.y, R, 0, Math.PI * 2);
    g.fillStyle = '#facc15'; g.fill();
    g.strokeStyle = '#b45309'; g.lineWidth = 2 * k; g.stroke();
    g.fillStyle = '#713f12'; g.font = `bold ${12 * k}px "Segoe UI", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('C', p.x, p.y + 0.5 * k);
  } else if (d.type === 'wap') {
    g.beginPath(); g.arc(p.x, p.y, R, 0, Math.PI * 2);
    g.fillStyle = '#a855f7'; g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k; g.stroke();
    // ส่วนโค้งสัญญาณ WiFi ด้านบน
    g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k;
    for (let i = 1; i <= 2; i++) { g.beginPath(); g.arc(p.x, p.y + 3 * k, (3 + i * 3) * k, -Math.PI * 0.75, -Math.PI * 0.25); g.stroke(); }
    g.fillStyle = '#fff'; g.beginPath(); g.arc(p.x, p.y + 3 * k, 1.5 * k, 0, Math.PI * 2); g.fill();
  } else {
    const c = d.type === 'dsw' ? '#3b82f6' : '#22c55e';
    roundRect(g, p.x - R, p.y - R, R * 2, R * 2, 4 * k);
    g.fillStyle = c; g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k; g.stroke();
    g.fillStyle = '#fff'; g.font = `bold ${12 * k}px "Segoe UI", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(d.type === 'dsw' ? 'D' : 'P', p.x, p.y + 0.5 * k);
  }
  g.restore();
  // label
  g.font = `bold ${11 * k}px "Segoe UI", "Leelawadee UI", sans-serif`;
  const tw = g.measureText(d.label).width;
  g.fillStyle = 'rgba(10,15,28,.8)';
  g.fillRect(p.x - tw / 2 - 4 * k, p.y + 14 * k, tw + 8 * k, 15 * k);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'top';
  g.fillText(d.label, p.x, p.y + 16 * k);
}

function starPath(g, cx, cy, R, r, n) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + i * Math.PI / n;
    const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.closePath();
}

function drawLegend(g, x, y, k) {
  const rows = [
    { color: CABLES.cat6.color, text: `LAN CAT6 (≤ ${CAT6_MAX} ม.)` },
    { color: CABLES.fiber.color, text: `Fiber Optic (> ${CAT6_MAX} ม.)` },
  ];
  if (state.routes.some(isWireless))
    rows.push({ color: CABLES.wireless.color, text: 'Wireless Link (WAP↔WAP)', dash: true });
  if (state.walls.length) {
    const nGroups = state.walls.length > 1 ? new Set(wallComponentMap().values()).size : 1;
    rows.push({ color: '#22d3ee', text: nGroups > 1 ? 'ขอบอาคาร/แนวท่อ (สีต่างกัน = ไม่เชื่อมถึงกัน)' : 'ขอบอาคาร/แนวท่อ (อ้างอิง)', dash: true });
    if (nGroups > 1) rows.push({ color: '#f97316', text: 'วงกลมส้ม = ปลายเส้นลอย ไม่แตะเส้นอื่น' });
  }
  const w = 210 * k, h = (18 + rows.length * 20 + 20) * k;
  g.fillStyle = 'rgba(15,23,42,.85)';
  roundRect(g, x, y, w, h, 8 * k); g.fill();
  g.strokeStyle = '#334155'; g.lineWidth = 1 * k; roundRect(g, x, y, w, h, 8 * k); g.stroke();
  g.font = `bold ${12 * k}px "Segoe UI", "Leelawadee UI", sans-serif`;
  g.fillStyle = '#e2e8f0'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText('สัญลักษณ์แนวเดินสาย', x + 10 * k, y + 14 * k);
  g.font = `${11.5 * k}px "Segoe UI", "Leelawadee UI", sans-serif`;
  rows.forEach((row, i) => {
    const yy = y + (32 + i * 20) * k;
    g.strokeStyle = row.color; g.lineWidth = row.dash ? 2.5 * k : 4 * k;
    if (row.dash) g.setLineDash([6 * k, 4 * k]);
    g.beginPath(); g.moveTo(x + 10 * k, yy); g.lineTo(x + 42 * k, yy); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#e2e8f0';
    g.fillText(row.text, x + 50 * k, yy);
  });
  const yy = y + (32 + rows.length * 20) * k;
  g.fillStyle = '#94a3b8';
  g.fillText(state.pxPerM ? `มาตราส่วน: ${state.pxPerM.toFixed(2)} px/ม.` : 'ยังไม่ได้ตั้งสเกล', x + 10 * k, yy);
}

/* ============================================================
   hit testing
   ============================================================ */
function hitDevice(scr) {
  for (let i = state.devices.length - 1; i >= 0; i--) {
    const d = state.devices[i];
    if (dist(w2s(d), scr) <= 16) return d;
  }
  return null;
}
function hitRoute(scr) {
  for (let i = state.routes.length - 1; i >= 0; i--) {
    const r = state.routes[i];
    const pts = r.points.map(w2s);
    for (let j = 1; j < pts.length; j++) {
      if (distToSeg(scr, pts[j - 1], pts[j]) <= 6) return r;
    }
  }
  return null;
}
function hitWall(scr) {
  for (let i = state.walls.length - 1; i >= 0; i--) {
    const wl = state.walls[i];
    const pts = wl.points.map(w2s);
    for (let j = 1; j < pts.length; j++) {
      if (distToSeg(scr, pts[j - 1], pts[j]) <= 6) return wl;
    }
  }
  return null;
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}
function hitConduitLabel(scr) {
  for (let i = conduitLabelHits.length - 1; i >= 0; i--) {
    const h = conduitLabelHits[i];
    if (scr.x >= h.x && scr.x <= h.x + h.w && scr.y >= h.y && scr.y <= h.y + h.h) return h;
  }
  return null;
}

/* ============================================================
   interactions
   ============================================================ */
function snapPoint(prev, pt) {
  if (!$('#chkOrtho').checked || !prev) return pt;
  const dx = Math.abs(pt.x - prev.x), dy = Math.abs(pt.y - prev.y);
  return dx >= dy ? { x: pt.x, y: prev.y } : { x: prev.x, y: pt.y };
}

function setMode(m) {
  if (state.draft) { state.draft = null; }
  if (state.wallDraft) commitWall();
  state.mode = m;
  $$('.tool[data-mode], .devbtn[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === m));
  canvas.style.cursor = m === 'select' ? 'default' : 'crosshair';
  updateHint();
  draw();
}

const HINTS = {
  select: 'คลิกเพื่อเลือกจุด/เส้น · ลากจุดเพื่อย้าย · ลากป้ายท่อ/ป้ายระยะเพื่อจัดตำแหน่งป้าย · ลากพื้นที่ว่างเพื่อเลื่อนภาพ · ล้อเมาส์เพื่อซูม',
  calibrate: 'คลิกจุดที่ 1 และจุดที่ 2 บนแถบสเกลของภาพ แล้วกรอกระยะจริงในขั้นตอนที่ 2',
  'place-onu': 'คลิกตำแหน่งติดตั้ง FTTx ONU (ดาวแดง) · คลิกขวา/Esc เพื่อเลิกวาง',
  'place-dsw': 'คลิกตำแหน่งติดตั้ง Distribution Switch · คลิกขวา/Esc เพื่อเลิกวาง',
  'place-psw': 'คลิกตำแหน่งติดตั้ง PoE Switch 8GE · คลิกขวา/Esc เพื่อเลิกวาง',
  'place-cam': 'คลิกตำแหน่งติดตั้งกล้อง CCTV ได้ต่อเนื่องหลายจุด · คลิกขวา/Esc เพื่อเลิกวาง',
  'place-wap': 'คลิกตำแหน่งติดตั้ง Wireless Access Point ได้ต่อเนื่องหลายจุด · เชื่อม WAP↔WAP = ลิงก์ไร้สายอัตโนมัติ · คลิกขวา/Esc เพื่อเลิกวาง',
  route: 'คลิกอุปกรณ์ต้นทาง → คลิกจุดหักมุมตามขอบอาคาร → คลิกอุปกรณ์ปลายทางเพื่อจบ · คลิกขวา = ย้อนจุด · Esc = ยกเลิก',
  wall: 'คลิกวาดเส้นขอบอาคาร/แนวท่อทีละจุด · ดับเบิลคลิก หรือ Esc = จบเส้น · คลิกขวา = ย้อนจุด — เส้นนี้ใช้เป็นแนวให้ระบบคำนวณแนวสายอัตโนมัติ',
};
function updateHint() {
  let t = HINTS[state.mode] || '';
  if (state.mode === 'route' && state.draft) {
    const from = deviceById(state.draft.fromId);
    t = `กำลังลากสายจาก ${from ? from.label : '?'} — คลิกจุดหักมุม หรือคลิกอุปกรณ์ปลายทางเพื่อจบเส้น`;
  }
  if (!state.img) t = 'เริ่มต้นด้วยการอัปโหลดภาพสถานที่ติดตั้ง';
  $('#statusHint').textContent = t;
}

canvas.addEventListener('mousedown', e => {
  if (!state.img) return;
  const scr = mousePos(e);
  downScr = scr; moved = false;
  if (e.button === 0 && state.mode === 'select' && !hitDevice(scr)) {
    const lb = hitConduitLabel(scr);
    if (lb) { // จับป้ายท่อเพื่อลากย้าย — จำระยะจากจุดจับถึงกึ่งกลางป้าย กันป้ายกระโดด
      dragLabel = { key: lb.key, midW: lb.midW, gdx: lb.x + lb.w / 2 - scr.x, gdy: lb.y + lb.h / 2 - scr.y };
      return;
    }
  }
  if (e.button === 1 || (e.button === 0 && state.mode === 'select' && !hitDevice(scr) && !hitRoute(scr) && !hitWall(scr))) {
    panning = true;
    e.preventDefault();
    return;
  }
  if (e.button === 0 && state.mode === 'select') {
    const d = hitDevice(scr);
    if (d) dragDev = d;
  }
});

canvas.addEventListener('mousemove', e => {
  const scr = mousePos(e);
  state.hoverW = s2w(scr);
  if (downScr && dist(scr, downScr) > 4) moved = true;
  if (panning && moved) {
    state.view.ox += e.movementX; state.view.oy += e.movementY;
  } else if (dragDev && moved) {
    const w = s2w(scr);
    dragDev.x = w.x; dragDev.y = w.y;
    for (const r of state.routes) {
      if (r.fromId === dragDev.id) r.points[0] = { x: w.x, y: w.y };
      if (r.toId === dragDev.id) r.points[r.points.length - 1] = { x: w.x, y: w.y };
    }
  } else if (dragLabel && moved) {
    const c = s2w({ x: scr.x + dragLabel.gdx, y: scr.y + dragLabel.gdy });
    state.conduitLabelOffsets[dragLabel.key] = { x: c.x - dragLabel.midW.x, y: c.y - dragLabel.midW.y };
  }
  const wpt = state.hoverW;
  $('#statusPos').textContent = state.pxPerM && state.img
    ? `x ${(wpt.x / state.pxPerM).toFixed(1)} ม., y ${(wpt.y / state.pxPerM).toFixed(1)} ม.`
    : '';
  draw();
});

canvas.addEventListener('mouseup', e => {
  const scr = mousePos(e);
  const wasClick = !moved;
  const wasDrag = (dragDev && moved) || (dragLabel && moved);
  panning = false; dragDev = null; dragLabel = null; downScr = null;
  if (wasDrag) { refresh(); return; }
  if (!wasClick || e.button !== 0 || !state.img) return;
  handleClick(scr);
});

canvas.addEventListener('wheel', e => {
  if (!state.img) return;
  e.preventDefault();
  const scr = mousePos(e);
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const ns = Math.min(Math.max(state.view.s * f, 0.02), 60);
  state.view.ox = scr.x - (scr.x - state.view.ox) * (ns / state.view.s);
  state.view.oy = scr.y - (scr.y - state.view.oy) * (ns / state.view.s);
  state.view.s = ns;
  $('#statusZoom').textContent = `${Math.round(ns * 100)}%`;
  draw();
}, { passive: false });

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (state.mode === 'route' && state.draft) {
    if (state.draft.points.length > 1) state.draft.points.pop();
    else state.draft = null;
    updateHint(); draw();
  } else if (state.mode === 'wall' && state.wallDraft) {
    if (state.wallDraft.points.length > 1) state.wallDraft.points.pop();
    else state.wallDraft = null;
    draw();
  } else if (state.mode !== 'select') {
    setMode('select');
  }
});

canvas.addEventListener('dblclick', () => {
  if (state.wallDraft) commitWall();
});

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') {
    if (state.altView) clearAlts();
    else if (state.wallDraft) commitWall();
    else if (state.draft) { state.draft = null; updateHint(); draw(); }
    else setMode('select');
  }
  if (e.key === 'Enter' && state.wallDraft) commitWall();
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) deleteSelected();
});

function commitWall() {
  if (!state.wallDraft) return;
  const pts = simplifyPts(state.wallDraft.points);
  state.wallDraft = null;
  if (pts.length >= 2) state.walls.push({ id: state.nextId++, points: pts });
  updateHint();
  refresh();
}

function handleClick(scr) {
  const w = s2w(scr);
  switch (state.mode) {
    case 'calibrate': {
      if (!state.cal.p1 || state.cal.p2) { state.cal.p1 = w; state.cal.p2 = null; }
      else {
        state.cal.p2 = w;
        $('#btnApplyScale').disabled = false;
        $('#statusHint').textContent = 'กรอก "ระยะจริง (เมตร)" ในขั้นตอนที่ 2 แล้วกดยืนยัน';
        $('#inpRealDist').focus();
      }
      draw();
      return;
    }
    case 'place-onu': case 'place-dsw': case 'place-psw': case 'place-cam': case 'place-wap': {
      const type = state.mode.slice(6);
      if (type === 'onu' && state.devices.some(d => d.type === 'onu')) {
        $('#statusHint').textContent = 'มี ONU อยู่แล้ว 1 จุด — ย้ายจุดเดิมได้ในโหมดเลือก';
        return;
      }
      state.devices.push({ id: state.nextId++, type, x: w.x, y: w.y, label: nextLabel(type) });
      refresh();
      return;
    }
    case 'wall': {
      if (!state.wallDraft) state.wallDraft = { points: [w] };
      else {
        const last = state.wallDraft.points[state.wallDraft.points.length - 1];
        state.wallDraft.points.push(snapPoint(last, w));
      }
      draw();
      return;
    }
    case 'route': {
      const d = hitDevice(scr);
      if (!state.draft) {
        if (d) {
          state.draft = { fromId: d.id, points: [{ x: d.x, y: d.y }] };
          updateHint();
        } else {
          $('#statusHint').textContent = 'ต้องเริ่มจากอุปกรณ์ — คลิกที่จุด ONU / Switch / กล้อง ก่อน';
        }
      } else if (d && d.id !== state.draft.fromId) {
        // จบเส้นที่อุปกรณ์ปลายทาง (เติมจุดหักมุมอัตโนมัติถ้าเปิด snap)
        const last = state.draft.points[state.draft.points.length - 1];
        if ($('#chkOrtho').checked && Math.abs(d.x - last.x) > 2 && Math.abs(d.y - last.y) > 2) {
          state.draft.points.push({ x: d.x, y: last.y });
        }
        state.draft.points.push({ x: d.x, y: d.y });
        state.routes.push({
          id: state.nextId++,
          fromId: state.draft.fromId,
          toId: d.id,
          points: state.draft.points,
          override: 'auto',
          env: 'outdoor',
        });
        state.draft = null;
        updateHint();
        refresh();
      } else if (!d) {
        const last = state.draft.points[state.draft.points.length - 1];
        state.draft.points.push(snapPoint(last, w));
        draw();
      }
      return;
    }
    default: { // select
      if (state.altView) {
        const ai = hitAlt(scr);
        if (ai != null) { applyAlt(ai); return; }
      }
      const d = hitDevice(scr);
      const r = d ? null : hitRoute(scr);
      const wl = (d || r) ? null : hitWall(scr);
      if (!d && !r && !wl && state.altView) state.altView = null; // คลิกพื้นที่ว่าง = ปิดทางเลือก
      state.selected = d ? { kind: 'device', id: d.id }
        : r ? { kind: 'route', id: r.id }
        : wl ? { kind: 'wall', id: wl.id } : null;
      renderTable();
      renderAltBox();
      draw();
    }
  }
}

function deleteSelected() {
  if (!state.selected) return;
  if (state.selected.kind === 'device') {
    const id = state.selected.id;
    state.devices = state.devices.filter(d => d.id !== id);
    state.routes = state.routes.filter(r => r.fromId !== id && r.toId !== id);
  } else if (state.selected.kind === 'wall') {
    state.walls = state.walls.filter(w => w.id !== state.selected.id);
  } else {
    state.routes = state.routes.filter(r => r.id !== state.selected.id);
  }
  state.selected = null;
  refresh();
}

/* ============================================================
   image loading
   ============================================================ */
function loadImage(src, kind) {
  const img = new Image();
  img.onload = () => {
    state.img = img;
    state.imgSrcKind = kind;
    state.imgDataUrl = kind === 'file' ? src : null;
    $('#dropHint').classList.add('hidden');
    fitView();
    $('#statusZoom').textContent = `${Math.round(state.view.s * 100)}%`;
    updateHint();
    refresh();
  };
  img.onerror = () => { $('#statusHint').textContent = 'โหลดภาพไม่สำเร็จ'; };
  img.src = src;
}

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const rd = new FileReader();
  rd.onload = () => loadImage(rd.result, 'file');
  rd.readAsDataURL(file);
}

$('#fileInput').addEventListener('change', e => handleFile(e.target.files[0]));
$('#btnUpload').addEventListener('click', () => $('#fileInput').click());
$('#btnUpload2').addEventListener('click', () => $('#fileInput').click());
$('#btnSample').addEventListener('click', () => loadImage('picture.jpg', 'sample'));
$('#btnSample2').addEventListener('click', () => loadImage('picture.jpg', 'sample'));

['dragover', 'dragleave', 'drop'].forEach(ev => {
  wrap.addEventListener(ev, e => {
    e.preventDefault();
    $('#dropHint').classList.toggle('dragover', ev === 'dragover');
    if (ev === 'drop') handleFile(e.dataTransfer.files[0]);
  });
});

/* ============================================================
   scale calibration
   ============================================================ */
$('#btnCalibrate').addEventListener('click', () => { state.cal = { p1: null, p2: null }; setMode('calibrate'); });
$('#btnApplyScale').addEventListener('click', () => {
  const m = parseFloat($('#inpRealDist').value);
  if (!state.cal.p1 || !state.cal.p2 || !(m > 0)) return;
  state.pxPerM = dist(state.cal.p1, state.cal.p2) / m;
  setMode('select');
  refresh();
});

/* ============================================================
   toolbar / sidebar wiring
   ============================================================ */
$$('.tool[data-mode], .devbtn[data-mode]').forEach(b =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#btnRoute').addEventListener('click', () => setMode('route'));
$('#btnWall').addEventListener('click', () => setMode('wall'));
$('#btnAutoPlace').addEventListener('click', autoPlaceSwitches);
$('#btnAutoRoute').addEventListener('click', autoRouteAll);
$('#btnDeleteSel').addEventListener('click', deleteSelected);
$('#btnZoomFit').addEventListener('click', () => { fitView(); $('#statusZoom').textContent = `${Math.round(state.view.s * 100)}%`; draw(); });
$('#chkOrtho').addEventListener('change', draw);
$('#selConduit').addEventListener('change', draw);
$('#btnClear').addEventListener('click', () => {
  if (!confirm('ล้างจุดอุปกรณ์ แนวสาย ขอบอาคาร และสเกลทั้งหมด?')) return;
  Object.assign(state, {
    devices: [], routes: [], walls: [],
    cal: { p1: null, p2: null }, pxPerM: null, draft: null, wallDraft: null,
    selected: null, nextId: 1, conduitLabelOffsets: {},
  });
  localStorage.removeItem(LS_KEY);
  refresh();
});

/* ============================================================
   results: table / equipment / recommendations
   ============================================================ */
function refresh() {
  if (state.altView && !state.routes.some(r => r.id === state.altView.routeId))
    state.altView = null; // เส้นถูกลบไปแล้ว
  draw();
  renderScaleUI();
  renderTable();
  renderAltBox();
  renderEquipment();
  renderWarnings();
  renderDevSummary();
  saveLocal();
}

function renderScaleUI() {
  const b = $('#scaleBadge');
  if (state.pxPerM) {
    b.textContent = `สเกล ${state.pxPerM.toFixed(2)} px/ม.`;
    b.className = 'badge ok';
    $('#scaleInfo').textContent =
      `มาตราส่วน: ${state.pxPerM.toFixed(2)} พิกเซล/เมตร (1 เมตร ≈ ${state.pxPerM.toFixed(1)} px)`;
  } else {
    b.textContent = 'ยังไม่ได้ตั้งสเกล';
    b.className = 'badge warn';
    $('#scaleInfo').textContent = 'มาตราส่วน: —';
  }
}

function renderDevSummary() {
  const c = t => state.devices.filter(d => d.type === t).length;
  $('#devSummary').textContent =
    `วางแล้ว: ONU ${c('onu')} · Dist.SW ${c('dsw')} · PoE SW ${c('psw')} · กล้อง ${c('cam')} ตัว · WAP ${c('wap')}`;
}

function renderTable() {
  const tb = $('#tblRoutes tbody');
  tb.innerHTML = '';
  state.routes.forEach((r, i) => {
    const L = routeLenM(r);
    const cable = CABLES[effCable(r)];
    const env = r.env || 'outdoor';
    const notes = routeNotes(r);
    const tr = document.createElement('tr');
    tr.dataset.rid = r.id;
    if (state.selected && state.selected.kind === 'route' && state.selected.id === r.id)
      tr.classList.add('selected');
    tr.innerHTML = `
      <td class="drag-handle" draggable="true" title="ลากเพื่อจัดลำดับรายการ">⠿ ${i + 1}</td>
      <td>${routeLabel(r)}${notes.map(n => `<span class="route-note">⚠ ${n}</span>`).join('')}</td>
      <td>
        <span class="cable-tag ${cable.key}">${cable.key === 'cat6' ? 'CAT6' : cable.key === 'fiber' ? 'Fiber' : 'WiFi'}</span><br>
        <select data-rid="${r.id}">
          <option value="auto"${r.override === 'auto' ? ' selected' : ''}>อัตโนมัติ</option>
          <option value="cat6"${r.override === 'cat6' ? ' selected' : ''}>CAT6</option>
          <option value="fiber"${r.override === 'fiber' ? ' selected' : ''}>Fiber</option>
          <option value="wireless"${r.override === 'wireless' ? ' selected' : ''}>Wireless</option>
        </select>
      </td>
      <td class="num">${L != null ? L.toFixed(1) : '—'}</td>
      <td class="num">${cable.wireless ? '—' : (L != null ? purchaseLen(L) : '—')}</td>
      <td>${cable.wireless ? '<span class="muted">ไร้สาย (ไม่มีท่อ)</span>' : `${ENVS[env].short} ${conduitFor(1, cable.od)}<br>
        <select data-env="${r.id}" title="สภาพแวดล้อมการติดตั้ง → ชนิดท่อ">
          <option value="indoor"${env === 'indoor' ? ' selected' : ''}>ในร่ม·EMT</option>
          <option value="outdoor"${env === 'outdoor' ? ' selected' : ''}>กลางแจ้ง·IMC</option>
          <option value="buried"${env === 'buried' ? ' selected' : ''}>ฝังดิน·HDPE</option>
        </select>`}
      </td>
      <td class="actions">
        <button class="mini move" data-up="${r.id}" title="เลื่อนรายการขึ้น">▲</button>
        <button class="mini move" data-down="${r.id}" title="เลื่อนรายการลง">▼</button>
        <button class="mini alt" data-alt="${r.id}" title="แสดงแนวเดินสายทางเลือก">🔀</button>
        <button class="mini" data-del="${r.id}" title="ลบเส้นนี้">✖</button>
      </td>`;
    tb.appendChild(tr);
  });
  $('#tblNote').textContent = state.routes.length
    ? `ความยาวสั่งซื้อ = ระยะตามแบบ ×${SLACK_FACTOR.toFixed(2)} + เผื่อปลายทาง ${SLACK_ENDS} ม. · ขนาดท่อคิดที่ fill ratio ≤ 40% (สาย 1 เส้น/ท่อ) · คลิกแถวเพื่อเลือกและเลื่อนภาพไปยังเส้นนั้น · จัดลำดับด้วยปุ่ม ▲▼ หรือลากที่ ⠿`
    : 'ยังไม่มีแนวเดินสาย — วางอุปกรณ์แล้วกด "เริ่มลากแนวสาย"';
  tb.querySelectorAll('select[data-rid]').forEach(sel => {
    sel.addEventListener('change', () => {
      const r = state.routes.find(x => x.id === +sel.dataset.rid);
      if (r) { r.override = sel.value; refresh(); }
    });
  });
  tb.querySelectorAll('select[data-env]').forEach(sel => {
    sel.addEventListener('change', () => {
      const r = state.routes.find(x => x.id === +sel.dataset.env);
      if (r) { r.env = sel.value; refresh(); }
    });
  });
  tb.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.routes = state.routes.filter(x => x.id !== +btn.dataset.del);
      if (state.selected && state.selected.kind === 'route' && state.selected.id === +btn.dataset.del)
        state.selected = null;
      refresh();
    });
  });
  tb.querySelectorAll('button[data-up]').forEach(btn =>
    btn.addEventListener('click', () => moveRoute(+btn.dataset.up, -1)));
  tb.querySelectorAll('button[data-down]').forEach(btn =>
    btn.addEventListener('click', () => moveRoute(+btn.dataset.down, 1)));
  tb.querySelectorAll('button[data-alt]').forEach(btn =>
    btn.addEventListener('click', () => showAlternatives(+btn.dataset.alt)));

  // คลิกแถว = เลือกเส้น + เลื่อนภาพไปยังเส้นนั้น · ลากที่ ⠿ = จัดลำดับ
  tb.querySelectorAll('tr').forEach(tr => {
    const rid = +tr.dataset.rid;
    tr.addEventListener('click', e => {
      if (e.target.closest('select, button')) return;
      const r = state.routes.find(x => x.id === rid);
      if (!r) return;
      if (state.altView && state.altView.routeId !== rid) state.altView = null;
      state.selected = { kind: 'route', id: rid };
      centerOnRoute(r);
      renderTable();
      renderAltBox();
    });
    const handle = tr.querySelector('.drag-handle');
    handle.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', String(rid));
      e.dataTransfer.effectAllowed = 'move';
      tr.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => tr.classList.remove('dragging'));
    tr.addEventListener('dragover', e => { e.preventDefault(); tr.classList.add('drag-over'); });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
    tr.addEventListener('drop', e => {
      e.preventDefault();
      tr.classList.remove('drag-over');
      const srcId = +e.dataTransfer.getData('text/plain');
      reorderRoute(srcId, rid);
    });
  });
}

function moveRoute(id, delta) {
  const i = state.routes.findIndex(r => r.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.routes.length) return;
  const [r] = state.routes.splice(i, 1);
  state.routes.splice(j, 0, r);
  refresh();
}

function reorderRoute(srcId, dstId) {
  if (!srcId || srcId === dstId) return;
  const si = state.routes.findIndex(r => r.id === srcId);
  const di = state.routes.findIndex(r => r.id === dstId);
  if (si < 0 || di < 0) return;
  const [m] = state.routes.splice(si, 1);
  state.routes.splice(di, 0, m); // ลากลง = วางต่อท้ายแถวเป้าหมาย, ลากขึ้น = แทรกก่อนแถวเป้าหมาย
  refresh();
}

function centerOnRoute(r) {
  const xs = r.points.map(p => p.x), ys = r.points.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  state.view.ox = wrap.clientWidth / 2 - cx * state.view.s;
  state.view.oy = wrap.clientHeight / 2 - cy * state.view.s;
  draw();
}

function equipmentRows() {
  const nCam = state.devices.filter(d => d.type === 'cam').length;
  const nPsw = state.devices.filter(d => d.type === 'psw').length;
  const nDsw = state.devices.filter(d => d.type === 'dsw').length;
  const nOnu = state.devices.filter(d => d.type === 'onu').length;
  const nWap = state.devices.filter(d => d.type === 'wap').length;
  const pswNeed = Math.max(nPsw, Math.ceil(nCam / 8) || 0);
  const fiberRoutes = state.routes.filter(r => effCable(r) === 'fiber');
  const cat6Routes = state.routes.filter(r => effCable(r) === 'cat6');
  const sum = rs => rs.reduce((a, r) => { const L = routeLenM(r); return a + (L != null ? purchaseLen(L) : 0); }, 0);
  const nvrCh = nCam <= 8 ? 8 : nCam <= 16 ? 16 : nCam <= 32 ? 32 : 64;
  const nvrModel = nCam <= 8 ? 'DS-7608NI-K2' : nCam <= 16 ? 'DS-7616NI-K2' : nCam <= 32 ? 'DS-7732NI-K4' : 'DS-9664NI-I8';
  const storageTB = Math.ceil(nCam * 43 * 30 / 1000 * 10) / 10; // 4MP H.265 ~4Mbps ≈ 43GB/วัน/กล้อง, เก็บ 30 วัน

  const rows = [
    [`กล้อง IP 4MP (PoE)`, `${nCam} ตัว`, `Hikvision DS-2CD2043G2-IU (Bullet, IP67) / DS-2CD2143G2-I (Dome)`],
    [`PoE Switch 8GE`, `${pswNeed} ตัว${nPsw !== pswNeed ? ` (วางในแบบ ${nPsw})` : ''}`, `Hikvision DS-3E0510P-E/M (8×GE PoE + 2×GE Uplink, งบ PoE 110W) — โหมด Extend รองรับสายไกล`],
    [`Distribution Switch`, `${Math.max(nDsw, 1)} ตัว${nDsw === 0 ? ' (ยังไม่วางในแบบ)' : ''}`, `Hikvision DS-3E1518-SI (16×GE + 2×SFP GE, L2 Managed)`],
    [`NVR ${nvrCh} ช่อง`, `1 เครื่อง`, `Hikvision ${nvrModel} + HDD ${storageTB > 0 ? `≥ ${storageTB} TB (บันทึก ~30 วัน)` : '—'}`],
    [`FTTx ONU`, `${Math.max(nOnu, 1)} ตัว`, `ตามผู้ให้บริการอินเทอร์เน็ต (ต่อเข้า Distribution SW)`],
  ];
  if (nWap)
    rows.push([`Wireless Access Point`, `${nWap} ตัว`, `Hikvision DS-3WAP series / Ubiquiti UniFi — จ่ายไฟ PoE + สาย uplink ที่แต่ละจุด (ลิงก์ไร้สายต้องมองเห็นกันชัด)`]);
  if (cat6Routes.length)
    rows.push([`สาย LAN CAT6 Outdoor (UV/Gel)`, `รวม ~${sum(cat6Routes)} ม. (${cat6Routes.length} เส้นทาง)`, `CAT6 U/UTP Outdoor Double Jacket มีสลิง/ไม่มีสลิงตามหน้างาน`]);
  if (fiberRoutes.length) {
    rows.push([`สาย Fiber Optic Outdoor`, `รวม ~${sum(fiberRoutes)} ม. (${fiberRoutes.length} เส้นทาง)`, `Single-mode G.652D Drop/ADSS 2-4 Core`]);
    rows.push([`SFP Module 1.25G`, `${fiberRoutes.length * 2} ตัว`, `Hikvision HK-SFP-1.25G-20-1310 (LC, SM) ปลายละ 1 ตัว หรือ Media Converter คู่`]);
  }
  return { rows, nCam, pswNeed, fiberRoutes, cat6Routes };
}

function renderEquipment() {
  const { rows } = equipmentRows();
  const html = `<table><thead><tr><th>รายการ</th><th>จำนวน</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${r[0]}<span class="model">${r[2]}</span></td><td>${r[1]}</td></tr>`).join('')
  }</tbody></table>`;
  $('#equipBox').innerHTML = html;
  $('#conduitBox').innerHTML = conduitHTML();
  $('#recoBox').innerHTML = recommendationsHTML();
}

/* ---------- สรุปท่อร้อยสาย + อุปกรณ์ประกอบ แยกตามสภาพแวดล้อมและขนาดท่อจริง ---------- */
function conduitSummaryData() {
  const runs = conduitAnalysis();
  const groups = {};
  for (const run of runs) {
    const g = groups[run.env] || (groups[run.env] = { totalLen: 0, bySize: new Map() });
    const Lm = run.lenPx / state.pxPerM;
    g.totalLen += Lm;
    const sz = g.bySize.get(run.size) || { len: 0, maxCount: 0, idx: run.sizeIdx };
    sz.len += Lm;
    sz.maxCount = Math.max(sz.maxCount, run.count);
    g.bySize.set(run.size, sz);
  }
  for (const env of Object.keys(groups)) {
    const g = groups[env];
    g.routes = state.routes.filter(r => (r.env || 'outdoor') === env && routeLenM(r) != null && !isWireless(r)).length;
    g.pull = Math.max(0, Math.ceil(g.totalLen / 30) - 1);   // กล่องพักสายทุก ~30 ม.
    g.hand = Math.max(0, Math.ceil(g.totalLen / 50) - 1);   // บ่อพักใต้ดินทุก ~50 ม.
    g.bends = conduitBends(env);
  }
  return groups;
}

function conduitRows(env, g) {
  const sizes = [...g.bySize.entries()].sort((a, b) => a[1].idx - b[1].idx);
  const pipeLabel = env === 'indoor' ? 'ท่อ EMT' : env === 'outdoor' ? 'ท่อ IMC/uPVC กันน้ำ' : 'ท่อ HDPE/PE';
  const rows = [];
  let totalSticks = 0;
  sizes.forEach(([size, d]) => {
    if (env === 'buried') {
      const reels = Math.ceil(d.len / 100);
      rows.push([`${pipeLabel} ${size} (สูงสุด ${d.maxCount} สาย/ท่อ)`, `${reels} ม้วน (~${Math.ceil(d.len)} ม.)`]);
      totalSticks += reels;
    } else {
      const sticks = Math.ceil(d.len / 3);
      rows.push([`${pipeLabel} ${size} (สูงสุด ${d.maxCount} สาย/ท่อ, เส้นละ 3 ม.)`, `${sticks} เส้น (~${Math.ceil(d.len)} ม.)`]);
      totalSticks += sticks;
    }
  });
  const coup = Math.max(0, totalSticks - sizes.length);
  if (env === 'indoor') rows.push(
    ['ข้อต่อตรง EMT (Coupling)', `${coup} ตัว`],
    ['คอนเน็คเตอร์ EMT เข้ากล่อง/ตู้', `${g.routes * 2} ตัว`],
    ['จุดดัดโค้ง 90° (ดัดด้วยเบนเดอร์)', `${g.bends} จุด`],
    ['แคล้มป์จับท่อ + พุก (ทุก 1.5 ม.)', `${Math.ceil(g.totalLen / 1.5)} ชุด`],
    ['กล่องพักสาย (Pull Box)', `${g.pull} กล่อง`],
  );
  else if (env === 'outdoor') rows.push(
    ['ข้อต่อตรงกันน้ำ (Rain-tight Coupling)', `${coup} ตัว`],
    ['คอนเน็คเตอร์กันน้ำ + ล็อคนัท + บุชชิ่ง', `${g.routes * 2} ชุด`],
    ['ข้องอ 90° กันน้ำ', `${g.bends} ตัว`],
    ['แคล้มป์สแตนเลส/ก้ามปู + พุก (ทุก 1.5 ม.)', `${Math.ceil(g.totalLen / 1.5)} ชุด`],
    ['กล่องพักสายกันน้ำ IP66', `${g.pull} กล่อง`],
    ['ซิลิโคน/เทปพันเกลียวกันซึม', `${g.routes} ชุด`],
  );
  else rows.push(
    ['ข้อต่อ Compression HDPE', `${coup + g.hand} ตัว`],
    ['บ่อพักสาย (Handhole) ทุก ~50 ม.', `${g.hand} บ่อ`],
    ['ชุดท่อโค้งขึ้นผนัง (Riser ท่อ GI + ข้องอ)', `${g.routes * 2} ชุด`],
    ['เทปเตือนแนวสายใต้ดิน (ฝังเหนือท่อ 30 ซม.)', `~${Math.ceil(g.totalLen)} ม.`],
    ['ทรายรองก้นร่อง หนา 10 ซม.', `~${(g.totalLen * 0.03).toFixed(1)} ลบ.ม.`],
  );
  return rows;
}

function conduitHTML() {
  const groups = conduitSummaryData();
  const keys = ['indoor', 'outdoor', 'buried'].filter(k => groups[k]);
  if (!keys.length)
    return '<p class="muted">ยังไม่มีแนวเดินสายที่วัดระยะได้ — เลือกสภาพแวดล้อมของแต่ละเส้น (ในร่ม/กลางแจ้ง/ฝังดิน) ได้ในตารางการเชื่อมต่อ</p>';
  return keys.map(k => {
    const g = groups[k];
    return `<h4 class="env-h">${ENVS[k].name} — ท่อ ${ENVS[k].pipe} (${g.routes} เส้นทาง, รวม ~${Math.ceil(g.totalLen)} ม. ของท่อจริงหลังนับสายทับกัน)</h4>
      <table><tbody>${conduitRows(k, g).map(r =>
        `<tr><td>${r[0]}</td><td class="num">${r[1]}</td></tr>`).join('')}</tbody></table>`;
  }).join('');
}

function recommendationsHTML() {
  return `<ol>
    <li><strong>ระยะสาย LAN:</strong> CAT6 เดินได้ไม่เกิน ${CAT6_MAX} ม. (มาตรฐาน TIA-568 รับรองที่ 100 ม. — ช่วง 100–${CAT6_MAX} ม. ให้ใช้โหมด Extended PoE ของสวิตช์ Hikvision ซึ่งลดความเร็วเหลือ 10 Mbps เพียงพอสำหรับกล้อง) หากเกินให้ใช้ Fiber Optic + Media Converter/SFP และจ่ายไฟกล้องจากแหล่งจ่ายใกล้จุดติดตั้ง</li>
    <li><strong>ท่อร้อยสาย (วสท. 022001-22 / TIA-569):</strong> fill ratio ตามจำนวนสายที่เดินร่วมท่อจริง — 1 เส้น 53%, 2 เส้น 31%, ≥3 เส้น 40% (ดูขนาดท่อจริงต่อช่วงในหัวข้อ "ท่อร้อยสายและอุปกรณ์ประกอบ" หรือเลือกรูปแบบแสดงผลที่ตัวเลือก "ท่อร้อยสาย" บนแถบเครื่องมือ)</li>
    <li><strong>เลือกชนิดท่อตามสภาพแวดล้อม:</strong> ภายในอาคาร/ในร่มใช้ <strong>EMT</strong> · ภายนอกอาคารโดนแดดฝนใช้ <strong>IMC</strong> (โลหะหนา กันน้ำ) หรือ <strong>uPVC ทน UV</strong> พร้อมข้อต่อ/คอนเน็คเตอร์แบบกันน้ำ (Rain-tight) · ฝังดินใช้ <strong>HDPE/PE</strong> ฝังลึก ≥ 60 ซม. รองทรายก้นร่อง 10 ซม. พร้อมเทปเตือนแนวสายเหนือท่อ 30 ซม. และทำบ่อพัก (Handhole) ทุก ~50 ม.</li>
    <li><strong>จุดดึงสาย:</strong> ติดตั้ง Pull Box ทุก ๆ ~30 ม. หรือเมื่อหักมุม 90° สะสมครบ 2 จุด เพื่อลดแรงดึง (แรงดึง CAT6 ไม่เกิน 110 N)</li>
    <li><strong>รัศมีโค้งงอ:</strong> CAT6 ≥ 4 เท่าของเส้นผ่านศูนย์กลางสาย (~25 มม.) · Fiber ≥ 20 เท่า (~120 มม.) ขณะดึงสาย</li>
    <li><strong>ระยะห่างจากไฟฟ้ากำลัง:</strong> แยกจากสายไฟ AC ≥ 30 ซม. (เดินขนาน) หากจำเป็นต้องข้ามให้ตัดตั้งฉาก 90° หรือใช้ท่อโลหะคั่น (ลดสัญญาณรบกวน EMI)</li>
    <li><strong>สายภายนอกอาคาร:</strong> ใช้ CAT6 ชนิด Outdoor (UV-resistant/Gel-filled) เท่านั้น และติดตั้ง Surge Protector (Gigabit PoE passthrough) ที่ปลายสายซึ่งเข้าอาคาร พร้อมต่อลงกราวด์</li>
    <li><strong>การต่อลงดิน (TIA-607):</strong> ตู้อุปกรณ์ Rack/ตู้กันน้ำทุกจุดต่อสายดิน และใช้ตู้กันน้ำ IP66 สำหรับ PoE Switch ภายนอกอาคาร พร้อมระบายอากาศ</li>
    <li><strong>เผื่อสาย (Service Loop):</strong> เผื่อสายปลายละ 3–5 ม. ม้วนเก็บในตู้/Pull Box สำหรับการแก้ไขในอนาคต (ตารางคำนวณเผื่อ 10% + ${SLACK_ENDS} ม. แล้ว)</li>
    <li><strong>การทดสอบ:</strong> ทดสอบสาย LAN ด้วยเครื่อง Certify (Fluke DSX) ทุกเส้น · Fiber ทดสอบด้วย OTDR/Power Meter ค่า Loss ไม่เกิน budget · บันทึกผลเป็นเอกสารส่งมอบ</li>
    <li><strong>การติดป้าย (TIA-606):</strong> ติดป้ายรหัสสายทั้งสองปลายตามตารางการเชื่อมต่อ เช่น "PSW-1/CAM-3" เพื่อการบำรุงรักษา</li>
    <li><strong>ไฟฟ้าสำรอง:</strong> จ่ายไฟ NVR / Distribution SW / PoE Switch ผ่าน UPS ขนาดเพียงพอ ≥ 15–30 นาที และคำนวณงบ PoE รวมของกล้องไม่เกิน 80% ของพิกัดสวิตช์</li>
  </ol>`;
}

function renderWarnings() {
  const warns = [];
  if (state.img && !state.pxPerM)
    warns.push('ยังไม่ได้ตั้งมาตราส่วน — ระยะทางในตารางจะยังคำนวณไม่ได้ (ขั้นตอนที่ 2)');
  // ตรวจว่าเส้นขอบอาคาร/แนวท่อที่วาดไว้ "เชื่อมถึงกันจริง" หรือแค่ดูใกล้กันบนจอ
  if (state.walls.length > 1) {
    const compMap = wallComponentMap();
    const nGroups = new Set(compMap.values()).size;
    if (nGroups > 1)
      warns.push(`ขอบอาคาร/แนวท่อแยกเป็น ${nGroups} กลุ่มที่ไม่เชื่อมถึงกัน (ดูสีเส้นต่างกันบนแบบแปลน) — ลากเส้นเชื่อมให้ปลายทะลุเข้าไปในอีกเส้นจริงๆ ไม่ใช่แค่หยุดใกล้ๆ`);
    const dangling = state.walls.filter(w => isDanglingEnd(w, w.points[0]) || isDanglingEnd(w, w.points[w.points.length - 1])).length;
    if (dangling)
      warns.push(`มีปลายเส้นขอบอาคาร/แนวท่อลอยอิสระ ${dangling} เส้น (วงกลมส้มบนแบบแปลน) — ถ้าตั้งใจเชื่อมกับเส้นอื่น ให้ลากปลายให้ทะลุเข้าไปในเส้นเป้าหมาย`);
  }
  // กติกาเดินสายตามแนวเท่านั้น: อุปกรณ์ห่างแนวเกินระยะ branch + เส้นที่มีช่วงออกนอกแนว
  if (state.walls.length && state.pxPerM) {
    const segs = wallSegs();
    const branchPx = BRANCH_MAX_M * state.pxPerM + 0.5; // +epsilon เท่ากับ makeRouter
    const distToWalls = p => segs.reduce((m, s) => Math.min(m, projToSeg(p, s[0], s[1]).d), Infinity);
    const far = state.devices.filter(d => distToWalls(d) > branchPx);
    if (far.length)
      warns.push(`อุปกรณ์อยู่ห่างแนวอาคาร/ท่อเกิน ${BRANCH_MAX_M} ม. (ลากสายอัตโนมัติไม่ได้): ${far.map(d => d.label).join(', ')} — วาดแนวท่อไปให้ถึง`);
    const tol = 3; // px — เผื่อความคลาดเคลื่อนของการลากมือ
    for (const r of state.routes) {
      if (isWireless(r)) continue; // ลิงก์ไร้สายข้ามพื้นที่ว่างได้ ไม่ต้องเลาะแนวท่อ
      if (polyLenPx(r.points) <= branchPx && r.points.length === 2) continue; // patch สั้นในตู้เดียวกัน
      let off = 0;
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1], b = r.points[i];
        const aOK = distToWalls(a) <= tol, bOK = distToWalls(b) <= tol;
        if (aOK && bOK) continue;
        // ช่วง branch เข้าอุปกรณ์: ปลายด้านอุปกรณ์อยู่ใกล้แนว (≤ ระยะ branch) อีกด้านอยู่บนแนว
        if (i === 1 && bOK && distToWalls(a) <= branchPx) continue;
        if (i === r.points.length - 1 && aOK && distToWalls(b) <= branchPx) continue;
        off++;
      }
      if (off) warns.push(`${routeLabel(r)}: มีช่วงเดินนอกแนวอาคาร/ท่อ ${off} ช่วง — ปรับแนวหรือวาดแนวท่อเพิ่ม`);
    }
  }
  // ตรวจพอร์ต PoE Switch เกิน 8
  for (const psw of state.devices.filter(d => d.type === 'psw')) {
    const cams = state.routes.filter(r => {
      const other = r.fromId === psw.id ? deviceById(r.toId) : r.toId === psw.id ? deviceById(r.fromId) : null;
      return other && other.type === 'cam';
    }).length;
    if (cams > 8) warns.push(`${psw.label} มีกล้องต่ออยู่ ${cams} ตัว เกิน 8 พอร์ต — เพิ่ม PoE Switch อีกตัว`);
  }
  // กล้องที่ยังไม่ได้เชื่อม
  const linked = new Set();
  state.routes.forEach(r => { linked.add(r.fromId); linked.add(r.toId); });
  const orphan = state.devices.filter(d => d.type === 'cam' && !linked.has(d.id));
  if (orphan.length && state.routes.length)
    warns.push(`กล้องยังไม่ได้ลากสาย: ${orphan.map(d => d.label).join(', ')}`);
  $('#warnBox').innerHTML = warns.map(w => `<div class="warn-item">⚠ ${w}</div>`).join('');
}

/* ============================================================
   export PNG / print report
   ============================================================ */
function renderExportCanvas() {
  if (!state.img) return null;
  const iw = state.img.naturalWidth, ih = state.img.naturalHeight;
  const off = document.createElement('canvas');
  off.width = iw; off.height = ih;
  const g = off.getContext('2d');
  g.drawImage(state.img, 0, 0);
  const k = Math.max(1, iw / 1400);
  drawScene(g, p => p, k, { screen: false });
  drawLegend(g, 12 * k, 12 * k, k);
  return off;
}

$('#btnExportPng').addEventListener('click', () => {
  const off = renderExportCanvas();
  if (!off) { alert('ยังไม่มีภาพ'); return; }
  const a = document.createElement('a');
  a.download = 'cctv-cabling-design.png';
  a.href = off.toDataURL('image/png');
  a.click();
});

$('#btnPrint').addEventListener('click', () => {
  if (!state.img) { alert('ยังไม่มีภาพ'); return; }
  buildReport();
  window.print();
});

function buildReport() {
  const off = renderExportCanvas();
  const today = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  const { rows } = equipmentRows();
  const routeRows = state.routes.map((r, i) => {
    const L = routeLenM(r);
    const cable = CABLES[effCable(r)];
    const env = r.env || 'outdoor';
    const notes = routeNotes(r);
    return `<tr>
      <td>${i + 1}</td><td>${routeLabel(r)}</td>
      <td><span class="cable-tag">${cable.name}</span></td>
      <td style="text-align:right">${L != null ? L.toFixed(1) : '—'}</td>
      <td style="text-align:right">${cable.wireless ? '—' : (L != null ? purchaseLen(L) : '—')}</td>
      <td>${cable.wireless ? 'ไร้สาย (ไม่มีท่อ)' : `${ENVS[env].short} ${conduitFor(1, cable.od)} (${ENVS[env].name})`}</td>
      <td>${notes.join(' · ') || '—'}</td></tr>`;
  }).join('');

  $('#report').innerHTML = `
    <h1>รายงานการออกแบบระบบเดินสายกล้องวงจรปิด (CCTV)</h1>
    <div class="rep-meta">โครงสร้าง: FTTx ONU → Distribution Switch → PoE Switch 8GE → CCTV · อุปกรณ์หลัก: Hikvision · วันที่ ${today}</div>
    <h2>1. แบบแปลนแนวเดินสาย</h2>
    ${off ? `<img class="plan" src="${off.toDataURL('image/jpeg', 0.92)}">` : ''}
    <p>เส้นสีเหลือง = LAN CAT6 (≤ ${CAT6_MAX} ม.) · เส้นสีแดง = Fiber Optic (&gt; ${CAT6_MAX} ม.) · มาตราส่วน ${state.pxPerM ? state.pxPerM.toFixed(2) + ' px/ม.' : '—'}</p>
    <h2>2. ตารางการเชื่อมต่อจุดต่อจุด</h2>
    <table>
      <thead><tr><th>#</th><th>เส้นทาง</th><th>ประเภทสาย</th><th>ระยะตามแบบ (ม.)</th><th>ความยาวสั่งซื้อ (ม.)</th><th>ท่อร้อยสาย</th><th>หมายเหตุ</th></tr></thead>
      <tbody>${routeRows || '<tr><td colspan="7">—</td></tr>'}</tbody>
    </table>
    <p>ความยาวสั่งซื้อ = ระยะตามแบบ ×${SLACK_FACTOR.toFixed(2)} + เผื่อปลายทาง ${SLACK_ENDS} ม. · ขนาดท่อคิดที่ fill ratio ≤ 40% (สาย 1 เส้น/ท่อ)</p>
    <h2>3. ท่อร้อยสายและอุปกรณ์ประกอบการติดตั้ง</h2>
    <p>เกณฑ์เลือกชนิดท่อ: ภายในอาคาร/ในร่มใช้ <strong>EMT</strong> · ภายนอกอาคาร (กันน้ำ/ทน UV) ใช้ <strong>IMC / uPVC</strong> · ฝังดินใช้ <strong>HDPE/PE</strong> ฝังลึก ≥ 60 ซม.</p>
    ${conduitHTML()}
    <h2>4. สรุปรายการอุปกรณ์ (Hikvision)</h2>
    <table>
      <thead><tr><th>รายการ</th><th>จำนวน</th><th>รุ่นแนะนำ</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody>
    </table>
    <h2 class="page-break">5. ข้อแนะนำการติดตั้งตามมาตรฐานวิศวกรรม</h2>
    ${recommendationsHTML()}`;
}

/* ============================================================
   persistence (localStorage)
   ============================================================ */
const LS_KEY = 'cctv-cabling-design-v1';
function saveLocal() {
  try {
    const data = {
      devices: state.devices, routes: state.routes, walls: state.walls,
      pxPerM: state.pxPerM, cal: state.cal, nextId: state.nextId,
      conduitLabelOffsets: state.conduitLabelOffsets,
      imgSrcKind: state.imgSrcKind,
      imgDataUrl: (state.imgSrcKind === 'file' && state.imgDataUrl && state.imgDataUrl.length < 3.5e6)
        ? state.imgDataUrl : null,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) { /* quota เต็ม — ข้าม */ }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    Object.assign(state, {
      devices: d.devices || [], routes: d.routes || [], walls: d.walls || [],
      pxPerM: d.pxPerM || null, cal: d.cal || { p1: null, p2: null },
      nextId: d.nextId || 1,
      conduitLabelOffsets: d.conduitLabelOffsets || {},
    });
    if (d.imgSrcKind === 'sample') loadImage('picture.jpg', 'sample');
    else if (d.imgDataUrl) loadImage(d.imgDataUrl, 'file');
  } catch (e) { /* ข้อมูลเสีย — เริ่มใหม่ */ }
}

/* ============================================================
   boot
   ============================================================ */
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
setMode('select');
loadLocal();
refresh();

})();
