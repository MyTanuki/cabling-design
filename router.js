/* ============================================================
   router.js — ตัวหาเส้นทางเดินสาย/ท่อ (graph + Dijkstra)
   สคริปต์อิสระ: ไม่พึ่ง global state / DOM — รับ segs, devs, pxPerM, ortho เป็นพารามิเตอร์
   ยกมาจากแอป CCTV Cabling Designer เพื่อนำไปใช้ซ้ำในโครงการอื่นได้
   ------------------------------------------------------------
   เป็น classic script (ไม่ใช่ ES module) เพื่อให้เปิดด้วย file:// ได้
   และไม่พังเมื่อ HTML/JS ใน cache ไม่ตรงเวอร์ชันกัน
   ------------------------------------------------------------
   วิธีใช้:
     <script src="router.js"></script>   <!-- โหลดก่อนสคริปต์ที่เรียกใช้ -->
     const { createRouter } = CableRouter;
     const segs = walls.flatMap(w => w.points.slice(1).map((p, i) => [w.points[i], p]));
     const router = createRouter(segs, devicePoints, { pxPerM: 2, ortho: true });
     const pts = router.path(a, b);   // {x,y}[] หรือ null ถ้าเดินตามแนวไม่ได้
   ============================================================ */
(function (global) {
'use strict';

/* ---------- ค่าคงที่การเดินสาย (เมตร) ---------- */
const BRANCH_MAX_M = 10;   // จุดติดตั้งห่างแนวท่อไม่เกินนี้จึง branch จากแนวเดิมได้
const PATCH_MAX_M = 4;     // ลิงก์สั้นมาก (ตู้เดียวกัน เช่น ONU→DSW) ต่อตรงได้ นอกนั้นเดินตามแนวท่อ
const PATCH_DETOUR = 2.5;  // ต่อตรงเฉพาะเมื่อเดินตามท่อแล้วอ้อมไกลกว่าเส้นตรงเกินเท่านี้

/* ---------- เรขาคณิตล้วน (ไม่พึ่งอะไร) ---------- */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function polyLenPx(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += dist(points[i - 1], points[i]);
  return L;
}
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
function manhattanPts(a, b, ortho) {
  const pts = [{ x: a.x, y: a.y }];
  if (ortho && Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1)
    pts.push({ x: b.x, y: a.y });
  pts.push({ x: b.x, y: b.y });
  return pts;
}
function samePath(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => dist(p, b[i]) < 1);
}

// ทำช่วง "drop" ปลายเส้น (อุปกรณ์↔แนวท่อ) ที่เป็นเส้นทแยงให้เป็นแนวฉาก L
// โดยแทรกจุดหักมุมให้ช่วงที่ติดกับแนวท่อวิ่งตามแกนของแนวท่อ (อุปกรณ์ที่อยู่นอก/เลยปลายแนว)
// aOnWall/bOnWall: อุปกรณ์ปลายนั้นเกาะอยู่บนแนวท่อพอดี → ช่วงติดปลายคือ "แนวท่อ" เอง (อาจเอียง)
// ไม่ใช่ช่วง drop จริง จึงห้ามดัดเป็นฉาก ไม่งั้นจะเกิดหนามย้อนกลับ/หลุดออกนอกแนวบนผนังเอียง
// นอกจากนี้ ถ้าช่วง drop "ตั้งฉากกับแนวท่ออยู่แล้ว" (จุดฉาย perpendicular กลางช่วง) ก็คงไว้
// ตามหลัก: สายแตกจากแนวท่อไปหาอุปกรณ์ต้องเดินตั้งฉากกับแนวท่อ — ไม่ดัดเป็นฉากตามแกนจอ
function orthoDrops(pts, aOnWall, bOnWall, ortho) {
  if (!ortho || pts.length < 3) return pts;
  const out = pts.map(p => ({ x: p.x, y: p.y }));
  // ช่วง drop (dropA→dropB) ตั้งฉากกับแนวท่อ (condA→condB) หรือไม่ (|cos| ≈ 0)
  const perp = (dropA, dropB, condA, condB) => {
    const ux = dropB.x - dropA.x, uy = dropB.y - dropA.y;
    const vx = condB.x - condA.x, vy = condB.y - condA.y;
    const m = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    return m > 0 && Math.abs(ux * vx + uy * vy) / m < 0.06;
  };
  // corner: เดินจาก con ไป "ตามแนวท่อ" (ทิศ ref→con) จนถึงจุดที่ตั้งฉากกับอุปกรณ์ แล้วค่อย drop
  // ตั้งฉากกับแนวท่อจริง (ไม่ใช่แกนจอ) → ใช้ได้กับท่อเอียงด้วย · ท่อตั้งฉากแกนจะได้ผลเท่าเดิม
  const corner = (dev, con, ref) => {
    const ux = con.x - ref.x, uy = con.y - ref.y; // ทิศแนวท่อที่ con
    const L2 = ux * ux + uy * uy;
    if (!L2) return { x: con.x, y: con.y };
    const s = ((dev.x - con.x) * ux + (dev.y - con.y) * uy) / L2; // ฉายระยะ dev ลงแกนแนวท่อ
    return { x: con.x + ux * s, y: con.y + uy * s };
  };
  const n = out.length;
  // ดัดช่วง drop ให้ตั้งฉากกับแนวท่อ ยกเว้น: ปลายเกาะบนแนว (onWall) หรือ drop ตั้งฉากอยู่แล้ว (perp)
  // เดิมมีเงื่อนไข diag() ด้วย แต่มันปล่อย drop แนวดิ่ง/นอนบนท่อ "เอียง" ที่ไม่ตั้งฉากให้ผ่าน
  if (!bOnWall && !perp(out[n - 2], out[n - 1], out[n - 3], out[n - 2]))
    out.splice(n - 1, 0, corner(out[n - 1], out[n - 2], out[n - 3]));
  if (!aOnWall && !perp(out[1], out[0], out[1], out[2]))
    out.splice(1, 0, corner(out[0], out[1], out[2]));
  return out;
}

/* สร้างตัวหาเส้นทาง: กราฟจากช่วงแนวท่อ (segs) + จุดอุปกรณ์ (devs) เชื่อมเข้าได้หลายเส้นใกล้เคียง
   (ให้ Dijkstra เลือกทางเข้า-ออกที่ทำให้เส้นรวมสั้นที่สุด)
   ถ้าไม่มีแนวท่อ (segs ว่าง) → เส้นตรงหักมุมฉาก (Manhattan)
   ตัวเลือก: pxPerM (px/เมตร สำหรับคำนวณระยะ branch/patch), ortho (บังคับหักมุมฉาก) */
function createRouter(segs, devs, { pxPerM = null, ortho = true } = {}) {
  if (!segs.length) {
    const alts = (a, b) => {
      const out = [{ points: manhattanPts(a, b, ortho) }];
      if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1)
        out.push({ points: [{ x: a.x, y: a.y }, { x: a.x, y: b.y }, { x: b.x, y: b.y }] }); // สลับมุมหัก
      return out;
    };
    return {
      path: (a, b) => manhattanPts(a, b, ortho),
      dist: (a, b) => polyLenPx(manhattanPts(a, b, ortho)),
      commit: () => {},
      alts,
    };
  }
  const keyOf = p => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
  // จุดตัดของเส้นแนวท่อด้วยกันเอง + จุดฉายของอุปกรณ์ → แบ่งเป็นช่วงย่อย
  const splits = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const r = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (r) { splits[i].push(r.t); splits[j].push(r.u); }
    }
  const branchPx = (pxPerM ? BRANCH_MAX_M * pxPerM : 30) + 0.5; // +epsilon กันปัดเศษ
  const patchPx = (pxPerM ? PATCH_MAX_M * pxPerM : 12) + 0.5;   // ระยะ "ต่อตรง" สำหรับลิงก์สั้นมาก
  // อุปกรณ์เชื่อมเข้า "จุดบนแนวท่อที่ใกล้ที่สุดจริง" (ตามกติกา: นอกแนว→เข้าหาจุดใกล้สุด)
  // เลือกเฉพาะจุดที่ใกล้สุด (+ จุดที่ระยะใกล้เคียงกันมากเป็น tie) — ไม่แตะแนวท่อที่อยู่ไกลกว่า
  // จุดฉายอาจเป็นกลางช่วง (ตั้งฉาก) หรือปลายช่วง (เลยแนว) ก็ได้ แล้ว orthoDrops จัดช่วงปลายให้เป็นแนวฉาก
  const drops = [];
  devs.forEach(d => {
    const projs = segs.map((s, i) => ({ i, ...projToSeg(d, s[0], s[1]) })).sort((x, y) => x.d - y.d);
    const near = projs[0].d;
    projs.filter(p => p.d <= near * 1.25 + 1).slice(0, 3).forEach(p => {
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
  // โหนดอุปกรณ์ที่ "อยู่นอกแนวท่อ" — ใช้เป็นต้นทาง/ปลายทางเท่านั้น ห้ามเดินสายทะลุผ่าน (กันสายอ้อมผ่านกล้องอื่น)
  // อุปกรณ์ที่เกาะบนแนวท่อ (เช่น สวิตช์ที่ snap เข้าขอบอาคาร) เป็น "จุดร่วมท่อ" ต้องให้สายอื่นเดินผ่านได้
  // ไม่งั้นแนวท่อถูกตัดขาดตรงจุดนั้น สายที่ควรวิ่งตรงผ่านจะถูกบังคับให้อ้อมไกล
  const onWall = d => segs.some(s => projToSeg(d, s[0], s[1]).d < 1);
  const deviceKeys = new Set(devs.filter(d => !onWall(d)).map(keyOf));

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
      if (deviceKeys.has(k) && k !== srcK) continue; // ไม่ขยายต่อจากโหนดอุปกรณ์อื่น = ห้ามเดินทะลุ
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
  // ห้ามเดินนอกแนวอาคาร/แนวท่อ — เดินตามแนวท่อเสมอถ้ากราฟต่อถึงกัน
  // ต่อตรงได้เฉพาะ: (1) ลิงก์สั้นมาก ≤ PATCH_MAX_M (ตู้เดียวกัน) หรือ (2) กราฟไม่ต่อถึงแต่ยังอยู่ในระยะ branch
  return {
    // คืนจุดเส้นทาง หรือ null ถ้าต้องเดินนอกแนว (ผู้เรียกต้องข้ามการเชื่อมนี้)
    path(a, b) {
      const straight = dist(a, b);
      const patch = straight <= patchPx ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : null;
      const branch = straight <= branchPx ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : null;
      const ka = keyOf(a), kb = keyOf(b);
      if (ka === kb || !adj.has(ka) || !adj.has(kb)) return branch; // ไม่เชื่อมกราฟ → ต่อตรงเฉพาะระยะ branch
      const keys = rawPath(ka, kb, reuseBias.size ? reuseBias : null);
      if (!keys) return branch; // กราฟไม่ต่อถึงกัน — ยอมให้เฉพาะระยะ branch
      // ต่อตรงเฉพาะลิงก์สั้นมาก "และ" การเดินตามท่ออ้อมไกลกว่ามาก (ตู้เดียวกันที่อยู่ลึกจากแนวท่อ)
      // ไม่งั้นเดินตามแนวท่อเสมอ (กล้องใกล้ท่อ 3 ม. ก็ให้เลาะท่อ ไม่ต่อตรง)
      if (patch && keysLen(keys) > polyLenPx(patch) * PATCH_DETOUR) return patch;
      return orthoDrops(keysPts(keys), onWall(a), onWall(b), ortho); // ปกติ: เดินตามแนวท่อ (ดัดช่วง drop ปลายให้ฉาก เว้นปลายที่เกาะบนแนว)
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
      // ต่อถึงตามแนวท่อ → ใช้ระยะแนวท่อ (ยกเว้นลิงก์สั้นที่อ้อมไกลจริงจึงใช้เส้นตรง) · ไม่ต่อถึง → branch หรือไปไม่ถึง
      if (isFinite(g)) return (euclid <= patchPx && g > euclid * PATCH_DETOUR) ? euclid : g;
      return euclid <= branchPx ? euclid : Infinity;
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

/* ---------- เปิดใช้งานผ่าน global (classic script) ---------- */
global.CableRouter = {
  createRouter,
  // เรขาคณิต (ใช้ซ้ำได้)
  dist, polyLenPx, projToSeg, nearestOnSegments, segIntersect,
  simplifyPts, samePath, manhattanPts, orthoDrops,
  // ค่าคงที่
  BRANCH_MAX_M, PATCH_MAX_M, PATCH_DETOUR,
};

})(typeof globalThis !== 'undefined' ? globalThis : self);
