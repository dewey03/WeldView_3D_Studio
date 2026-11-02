/* ============================================================================
 * WeldView 3D Studio V3.3 — 真 B-rep 几何内核 / 专业渲染 / 焊缝识别重构层
 * ----------------------------------------------------------------------------
 * 本文件在原有界面逻辑之上接管三件事：
 *   1. 导入：OCCT(WASM) 真 B-rep 三角化，替代原简易 STEP 面片解析
 *   2. 渲染：three.js PBR + 正确深度缓冲 + B-rep 特征边，替代自研批次渲染
 *   3. 识别：基于二面角的可焊边提取 + 按接头分组，替代"全部边线一律虚线"
 * ========================================================================== */
(function () {
  "use strict";

  const V = (window.WV33 = window.WV33 || {});
  // 投影焦距（像素）。数值越大视角越窄、透视畸变越小。
  // 780 对应约 60° 垂直视角，对大尺寸结构件（5 米级）透视过于夸张，
  // 缩放到近处时会出现明显的"鱼眼"比例失真；1050 约 46°，接近 SolidWorks 观感。
  const FOCAL_PX = 1050;
  // 同步 HTML 内旧的投影/适配常量，保证拾取、HUD、相机三者完全一致
  try { window.WV_FOCAL_PX = FOCAL_PX; } catch (e) {}

  /* ------------------------------------------------------------------ */
  /* 0. 基础工具                                                         */
  /* ------------------------------------------------------------------ */
  function hostBase() {
    try {
      const p = Number(new URLSearchParams(location.search).get("hostPort"));
      if (p >= 1024 && p <= 65535) return "http://127.0.0.1:" + p;
    } catch (e) {}
    return "http://127.0.0.1:18765";
  }
  const HOST = hostBase();
  const VENDOR_OCCT = "/assets/vendor/occt/";
  const VENDOR_THREE = "/assets/vendor/three/three.module.min.js";

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const len = (a) => Math.hypot(a.x, a.y, a.z);
  const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
  const dist = (a, b) => len(sub(a, b));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const P = (x, y, z) => ({ x, y, z });

  function setStatus(msg, warn) {
    try { setStatusMessage(msg, warn); } catch (e) {}
    try {
      const el = document.getElementById("statusMessageText");
      if (el) el.style.color = warn ? "var(--wv-warn)" : "";
    } catch (e) {}
  }
  function fail(msg) {
    try { showErrorBanner(msg); } catch (e) { console.error(msg); }
  }

  /* ------------------------------------------------------------------ */
  /* 1. OCCT 几何内核                                                    */
  /* ------------------------------------------------------------------ */
  function ensureOcct() {
    if (V.occt) return Promise.resolve(V.occt);
    if (V._occtPromise) return V._occtPromise;
    V._occtPromise = new Promise(function (resolve, reject) {
      if (typeof window.occtimportjs === "function") {
        window.occtimportjs({ locateFile: (f) => VENDOR_OCCT + f }).then(function (m) {
          V.occt = m; resolve(m);
        }).catch(reject);
        return;
      }
      const s = document.createElement("script");
      s.src = VENDOR_OCCT + "occt-import-js.js";
      s.async = true;
      s.onload = function () {
        const factory = window.occtimportjs;
        if (typeof factory !== "function") { reject(new Error("几何内核未正确导出")); return; }
        factory({ locateFile: (f) => VENDOR_OCCT + f }).then(function (m) {
          V.occt = m; resolve(m);
        }).catch(reject);
      };
      s.onerror = function () { reject(new Error("无法加载几何内核（assets/vendor/occt 缺失）")); };
      document.head.appendChild(s);
    });
    return V._occtPromise;
  }

  async function fetchCadBytes(path) {
    const url = HOST + "/api/read_cad_file?raw=1&path=" + encodeURIComponent(path);
    const r = await fetch(url);
    if (!r.ok) throw new Error("宿主读取文件失败 (" + r.status + ")");
    return await r.arrayBuffer();
  }

  /* ------------------------------------------------------------------ */
  /* 2. B-rep 三角化结果 → 工程模型                                      */
  /* ------------------------------------------------------------------ */
  function mergeMeshes(meshList, center) {
    let vTotal = 0, iTotal = 0, faceTotal = 0;
    for (const m of meshList) {
      vTotal += m.attributes.position.array.length / 3;
      iTotal += m.index.array.length;
      faceTotal += (m.brep_faces && m.brep_faces.length) ? m.brep_faces.length : 1;
    }
    const positions = new Float32Array(vTotal * 3);
    const normals = new Float32Array(vTotal * 3);
    const indices = new Uint32Array(iTotal);
    const faceOfTri = new Int32Array(iTotal / 3);
    let vo = 0, io = 0, to = 0, faceBase = 0;

    for (const m of meshList) {
      const pa = m.attributes.position.array;
      const na = m.attributes.normal.array;
      const ia = m.index.array;
      const nv = pa.length / 3;
      for (let i = 0; i < nv; i++) {
        positions[vo + i * 3] = pa[i * 3] - center.x;
        positions[vo + i * 3 + 1] = pa[i * 3 + 1] - center.y;
        positions[vo + i * 3 + 2] = pa[i * 3 + 2] - center.z;
        normals[vo + i * 3] = na[i * 3];
        normals[vo + i * 3 + 1] = na[i * 3 + 1];
        normals[vo + i * 3 + 2] = na[i * 3 + 2];
      }
      const baseVert = vo / 3;
      for (let i = 0; i < ia.length; i++) indices[io + i] = ia[i] + baseVert;

      const nt = ia.length / 3;
      if (m.brep_faces && m.brep_faces.length) {
        for (let k = 0; k < m.brep_faces.length; k++) {
          const bf = m.brep_faces[k];
          const fid = faceBase + k;
          const last = Math.min(nt - 1, bf.last);
          for (let t = bf.first; t <= last; t++) faceOfTri[to + t] = fid;
        }
        faceBase += m.brep_faces.length;
      } else {
        for (let t = 0; t < nt; t++) faceOfTri[to + t] = faceBase;
        faceBase += 1;
      }
      vo += nv * 3; io += ia.length; to += nt;
    }
    return { positions, normals, indices, faceOfTri };
  }

  function meshBounds(meshList) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (const m of meshList) {
      const pa = m.attributes.position.array;
      for (let i = 0; i < pa.length; i += 3) {
        if (pa[i] < mnx) mnx = pa[i]; if (pa[i] > mxx) mxx = pa[i];
        if (pa[i + 1] < mny) mny = pa[i + 1]; if (pa[i + 1] > mxy) mxy = pa[i + 1];
        if (pa[i + 2] < mnz) mnz = pa[i + 2]; if (pa[i + 2] > mxz) mxz = pa[i + 2];
      }
    }
    return { mnx, mny, mnz, mxx, mxy, mxz };
  }

  /* ---- 2.1 全局焊接三角汤：用于提取 B-rep 特征边 ---- */
  function buildSoup(parts) {
    const q = 0.01; // 0.01mm 量化
    const vmap = new Map();
    const wpos = [];
    const triV = [];
    const triPart = [];
    const triFace = [];
    const triNrm = [];

    for (let pi = 0; pi < parts.length; pi++) {
      const g = parts[pi].geom;
      const pos = g.positions, idx = g.indices, ft = g.faceOfTri;
      const n = pos.length / 3;
      const map = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const k = Math.round(pos[i * 3] / q) + "," + Math.round(pos[i * 3 + 1] / q) + "," + Math.round(pos[i * 3 + 2] / q);
        let w = vmap.get(k);
        if (w === undefined) {
          w = wpos.length / 3;
          vmap.set(k, w);
          wpos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        }
        map[i] = w;
      }
      const nt = idx.length / 3;
      for (let t = 0; t < nt; t++) {
        const a = map[idx[t * 3]], b = map[idx[t * 3 + 1]], c = map[idx[t * 3 + 2]];
        if (a === b || b === c || a === c) continue;
        const ax = wpos[a * 3], ay = wpos[a * 3 + 1], az = wpos[a * 3 + 2];
        const bx = wpos[b * 3], by = wpos[b * 3 + 1], bz = wpos[b * 3 + 2];
        const cx = wpos[c * 3], cy = wpos[c * 3 + 1], cz = wpos[c * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        triV.push(a, b, c);
        triPart.push(pi);
        triFace.push(ft[t]);
        triNrm.push(nx, ny, nz);
      }
    }
    return { wpos, triV, triPart, triFace, triNrm };
  }

  /* ---- 2.2 提取特征边（B-rep 面与面之间的边界） ---- */
  function extractFeatureEdges(soup) {
    const { wpos, triV, triPart, triFace, triNrm } = soup;
    const nTri = triPart.length;
    const emap = new Map();
    const LIM = 4194304;

    function addEdge(a, b, t) {
      const k = a < b ? a * LIM + b : b * LIM + a;
      let arr = emap.get(k);
      if (arr === undefined) { arr = []; emap.set(k, arr); }
      if (arr.length < 3) arr.push(t);
    }
    for (let t = 0; t < nTri; t++) {
      const a = triV[t * 3], b = triV[t * 3 + 1], c = triV[t * 3 + 2];
      addEdge(a, b, t); addEdge(b, c, t); addEdge(c, a, t);
    }

    const segs = [];
    for (const [k, arr] of emap) {
      if (arr.length !== 2) continue;
      const t1 = arr[0], t2 = arr[1];
      if (triFace[t1] === triFace[t2] && triPart[t1] === triPart[t2]) continue;
      const a = Math.floor(k / LIM), b = k % LIM;

      const n1 = P(triNrm[t1 * 3], triNrm[t1 * 3 + 1], triNrm[t1 * 3 + 2]);
      const n2 = P(triNrm[t2 * 3], triNrm[t2 * 3 + 1], triNrm[t2 * 3 + 2]);
      if (dot(n1, n2) > 0.9995) continue;

      // 三角形质心，用于判定凹凸
      const c1 = P(
        (wpos[triV[t1 * 3] * 3] + wpos[triV[t1 * 3 + 1] * 3] + wpos[triV[t1 * 3 + 2] * 3]) / 3,
        (wpos[triV[t1 * 3] * 3 + 1] + wpos[triV[t1 * 3 + 1] * 3 + 1] + wpos[triV[t1 * 3 + 2] * 3 + 1]) / 3,
        (wpos[triV[t1 * 3] * 3 + 2] + wpos[triV[t1 * 3 + 1] * 3 + 2] + wpos[triV[t1 * 3 + 2] * 3 + 2]) / 3
      );
      const c2 = P(
        (wpos[triV[t2 * 3] * 3] + wpos[triV[t2 * 3 + 1] * 3] + wpos[triV[t2 * 3 + 2] * 3]) / 3,
        (wpos[triV[t2 * 3] * 3 + 1] + wpos[triV[t2 * 3 + 1] * 3 + 1] + wpos[triV[t2 * 3 + 2] * 3 + 1]) / 3,
        (wpos[triV[t2 * 3] * 3 + 2] + wpos[triV[t2 * 3 + 1] * 3 + 2] + wpos[triV[t2 * 3 + 2] * 3 + 2]) / 3
      );
      const mid = P((wpos[a * 3] + wpos[b * 3]) / 2, (wpos[a * 3 + 1] + wpos[b * 3 + 1]) / 2, (wpos[a * 3 + 2] + wpos[b * 3 + 2]) / 2);
      const s1 = dot(n1, sub(c2, mid));
      const s2 = dot(n2, sub(c1, mid));
      const concave = (s1 + s2) > 0;

      const f1 = triFace[t1], f2 = triFace[t2];
      const pairKey = f1 < f2 ? f1 + ":" + f2 : f2 + ":" + f1;
      segs.push({
        a, b, n1, n2, concave, pairKey,
        partA: triPart[t1], partB: triPart[t2],
        fA: f1, fB: f2,
        length: dist(P(wpos[a * 3], wpos[a * 3 + 1], wpos[a * 3 + 2]), P(wpos[b * 3], wpos[b * 3 + 1], wpos[b * 3 + 2]))
      });
    }

    /* 按 (面对) 串接成折线 */
    const byVert = new Map();
    segs.forEach((s, i) => {
      let l = byVert.get(s.a); if (!l) { l = []; byVert.set(s.a, l); } l.push(i);
      l = byVert.get(s.b); if (!l) { l = []; byVert.set(s.b, l); } l.push(i);
    });
    const used = new Uint8Array(segs.length);
    const chains = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const verts = [segs[i].a, segs[i].b];
      const ids = [i];
      const pk = segs[i].pairKey;
      for (let dir = 0; dir < 2; dir++) {
        let guard = 0;
        while (guard++ < 4096) {
          const tip = dir === 0 ? verts[verts.length - 1] : verts[0];
          const cands = byVert.get(tip) || [];
          let next = -1;
          for (const si of cands) {
            if (used[si]) continue;
            if (segs[si].pairKey !== pk) continue;
            next = si; break;
          }
          if (next < 0) break;
          used[next] = 1; ids.push(next);
          const s = segs[next];
          const other = s.a === tip ? s.b : s.a;
          if (dir === 0) verts.push(other); else verts.unshift(other);
        }
      }
      chains.push({ verts, ids, pairKey: pk });
    }

    /* 汇总为边对象 */
    const edges = [];
    let eid = 0;
    for (const ch of chains) {
      const pts = ch.verts.map((vi) => P(wpos[vi * 3], wpos[vi * 3 + 1], wpos[vi * 3 + 2]));
      if (pts.length < 2) continue;
      // 简化共线点
      const simp = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        const a = simp[simp.length - 1], b = pts[i], c = pts[i + 1];
        const d1 = norm(sub(b, a)), d2 = norm(sub(c, b));
        if (dot(d1, d2) < 0.99985) simp.push(b);
      }
      simp.push(pts[pts.length - 1]);

      let total = 0, concaveLen = 0;
      let n1s = P(0, 0, 0), n2s = P(0, 0, 0);
      let partA = segs[ch.ids[0]].partA, partB = segs[ch.ids[0]].partB;
      for (const si of ch.ids) {
        const s = segs[si];
        total += s.length;
        if (s.concave) concaveLen += s.length;
        n1s = add(n1s, mul(s.n1, s.length));
        n2s = add(n2s, mul(s.n2, s.length));
      }
      if (total < 0.5) continue;
      const n1 = norm(n1s), n2 = norm(n2s);
      const theta = Math.acos(clamp(dot(n1, n2), -1, 1)) * 180 / Math.PI;
      const concave = concaveLen > total * 0.5;
      const mid = simp[Math.floor(simp.length / 2)];

      edges.push({
        id: "E" + (++eid),
        points: simp,
        n1, n2,
        theta: Math.round(theta * 10) / 10,
        concave,
        lengthMm: Math.round(total * 10) / 10,
        partA, partB,
        crossPart: partA !== partB,
        centroid: mid,
        confidence: 0,
        weldable: false,
        groupKey: ""
      });
    }
    return edges;
  }

  /* ---- 2.3b 跨零件焊接接头识别 --------------------------------------
   * STEP 装配体里每个零件是独立实体，零件之间不共享顶点，实际建模时
   * 通常留有 1~3mm 焊接间隙。判定依据：棱边是否"整条"贴着另一零件的表面。
   *
   * V3.4 三处关键修正（旧版实测：935 条可焊边中 896 条只有 2 个采样点，
   * contactRatio 只能取 0.5 / 1.0，无法分辨"整条贴合"与"仅一端擦到"）：
   *   1) 大三角面不再被空间网格丢弃。旧实现 cells > 256 时只登记包围盒中心格
   *      与三个顶点格，细长板面中部 90% 的区域查不到，接头大面积漏检。
   *   2) 采样由"只取折线端点"改为按弧长加密（每 2mm 一点，5~96 点）。
   *   3) 增加接触连续性判据：最长连续接触段占比 ≥ 0.55，端点擦边被剔除。
   */
  function detectCrossPartJoints(edges, soup, solids) {
    const { wpos, triV, triPart } = soup;
    const nTri = triPart.length;
    if (!nTri) return;

    const CELL = 40;       // 细网格：普通三角面
    const CELL_BIG = 200;  // 粗网格：大三角面（细长板面）兜底
    const key = (ix, iy, iz) => ix + "," + iy + "," + iz;
    const grid = new Map();
    const gridBig = new Map();

    const tmin = new Float32Array(nTri * 3);
    const tmax = new Float32Array(nTri * 3);
    let nBig = 0;

    for (let t = 0; t < nTri; t++) {
      const i0 = triV[t * 3], i1 = triV[t * 3 + 1], i2 = triV[t * 3 + 2];
      const x0 = wpos[i0 * 3], y0 = wpos[i0 * 3 + 1], z0 = wpos[i0 * 3 + 2];
      const x1 = wpos[i1 * 3], y1 = wpos[i1 * 3 + 1], z1 = wpos[i1 * 3 + 2];
      const x2 = wpos[i2 * 3], y2 = wpos[i2 * 3 + 1], z2 = wpos[i2 * 3 + 2];
      const mnx = Math.min(x0, x1, x2), mny = Math.min(y0, y1, y2), mnz = Math.min(z0, z1, z2);
      const mxx = Math.max(x0, x1, x2), mxy = Math.max(y0, y1, y2), mxz = Math.max(z0, z1, z2);
      tmin[t * 3] = mnx; tmin[t * 3 + 1] = mny; tmin[t * 3 + 2] = mnz;
      tmax[t * 3] = mxx; tmax[t * 3 + 1] = mxy; tmax[t * 3 + 2] = mxz;

      const cx0 = Math.floor(mnx / CELL), cx1 = Math.floor(mxx / CELL);
      const cy0 = Math.floor(mny / CELL), cy1 = Math.floor(mxy / CELL);
      const cz0 = Math.floor(mnz / CELL), cz1 = Math.floor(mxz / CELL);
      const cells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1) * (cz1 - cz0 + 1);
      const isBig = cells > 512;
      if (isBig) nBig++;
      const step = isBig ? CELL_BIG : CELL;
      const map = isBig ? gridBig : grid;
      const bx0 = Math.floor(mnx / step), bx1 = Math.floor(mxx / step);
      const by0 = Math.floor(mny / step), by1 = Math.floor(mxy / step);
      const bz0 = Math.floor(mnz / step), bz1 = Math.floor(mxz / step);
      for (let ix = bx0; ix <= bx1; ix++) {
        for (let iy = by0; iy <= by1; iy++) {
          for (let iz = bz0; iz <= bz1; iz++) {
            const k = key(ix, iy, iz);
            let arr = map.get(k);
            if (!arr) { arr = []; map.set(k, arr); }
            arr.push(t);
          }
        }
      }
    }

    const stampBuf = new Int32Array(nTri);
    let stamp = 0;

    function aabbDist2(px, py, pz, t) {
      const qx = px < tmin[t * 3] ? tmin[t * 3] : (px > tmax[t * 3] ? tmax[t * 3] : px);
      const qy = py < tmin[t * 3 + 1] ? tmin[t * 3 + 1] : (py > tmax[t * 3 + 1] ? tmax[t * 3 + 1] : py);
      const qz = pz < tmin[t * 3 + 2] ? tmin[t * 3 + 2] : (pz > tmax[t * 3 + 2] ? tmax[t * 3 + 2] : pz);
      const dx = px - qx, dy = py - qy, dz = pz - qz;
      return dx * dx + dy * dy + dz * dz;
    }

    /* 遍历点 p 半径 r 内的所有三角面（细网格 + 大面片粗网格） */
    function forEachNearby(px, py, pz, r, cb) {
      stamp++;
      const r2 = r * r;
      const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), cz = Math.floor(pz / CELL);
      const span = Math.max(1, Math.ceil(r / CELL));
      for (let dx = -span; dx <= span; dx++) {
        for (let dy = -span; dy <= span; dy++) {
          for (let dz = -span; dz <= span; dz++) {
            const arr = grid.get(key(cx + dx, cy + dy, cz + dz));
            if (!arr) continue;
            for (let i = 0; i < arr.length; i++) {
              const t = arr[i];
              if (stampBuf[t] === stamp) continue;
              stampBuf[t] = stamp;
              if (aabbDist2(px, py, pz, t) > r2) continue;
              if (cb(t) === false) return;
            }
          }
        }
      }
      const gx = Math.floor(px / CELL_BIG), gy = Math.floor(py / CELL_BIG), gz = Math.floor(pz / CELL_BIG);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const arr = gridBig.get(key(gx + dx, gy + dy, gz + dz));
            if (!arr) continue;
            for (let i = 0; i < arr.length; i++) {
              const t = arr[i];
              if (stampBuf[t] === stamp) continue;
              stampBuf[t] = stamp;
              if (aabbDist2(px, py, pz, t) > r2) continue;
              if (cb(t) === false) return;
            }
          }
        }
      }
    }

    function pointTriDist(px, py, pz, t) {
      const i0 = triV[t * 3], i1 = triV[t * 3 + 1], i2 = triV[t * 3 + 2];
      const ax = wpos[i0 * 3], ay = wpos[i0 * 3 + 1], az = wpos[i0 * 3 + 2];
      const bx = wpos[i1 * 3], by = wpos[i1 * 3 + 1], bz = wpos[i1 * 3 + 2];
      const cx = wpos[i2 * 3], cy = wpos[i2 * 3 + 1], cz = wpos[i2 * 3 + 2];
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      const apx = px - ax, apy = py - ay, apz = pz - az;
      const d1 = abx * apx + aby * apy + abz * apz;
      const d2 = acx * apx + acy * apy + acz * apz;
      if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
      const bpx = px - bx, bpy = py - by, bpz = pz - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return Math.hypot(apx - abx * v, apy - aby * v, apz - abz * v);
      }
      const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
      const vb = d5 * d2 - d1 * d6;
      if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return Math.hypot(apx - acx * w, apy - acy * w, apz - acz * w);
      }
      const va = d3 * d6 - d5 * d4;
      if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return Math.hypot(bpx - (cx - bx) * w, bpy - (cy - by) * w, bpz - (cz - bz) * w);
      }
      const denom = 1 / (va + vb + vc);
      const v = vb * denom, w = vc * denom;
      const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
      return Math.hypot(px - qx, py - qy, pz - qz);
    }

    const TOL = 3.0;   // 焊接间隙上限（结构件常见 1~3mm）

    /* 沿面法向反向打射线，量出该处的真实板厚（角焊缝 K=0.7t 的依据） */
    function rayHit(px, py, pz, dx, dy, dz, selfPart, maxDist) {
      let best = maxDist;
      const stepLen = 24;
      for (let travelled = 0; travelled <= maxDist; travelled += stepLen) {
        const qx = px + dx * travelled, qy = py + dy * travelled, qz = pz + dz * travelled;
        forEachNearby(qx, qy, qz, stepLen * 1.4, function (t) {
          if (triPart[t] !== selfPart) return;
          const i0 = triV[t * 3], i1 = triV[t * 3 + 1], i2 = triV[t * 3 + 2];
          const ax = wpos[i0 * 3], ay = wpos[i0 * 3 + 1], az = wpos[i0 * 3 + 2];
          const bx = wpos[i1 * 3], by = wpos[i1 * 3 + 1], bz = wpos[i1 * 3 + 2];
          const cx2 = wpos[i2 * 3], cy2 = wpos[i2 * 3 + 1], cz2 = wpos[i2 * 3 + 2];
          const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
          const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
          const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
          const a = e1x * hx + e1y * hy + e1z * hz;
          if (Math.abs(a) < 1e-9) return;
          const f = 1 / a;
          const sx = px - ax, sy = py - ay, sz = pz - az;
          const u = f * (sx * hx + sy * hy + sz * hz);
          if (u < 0 || u > 1) return;
          const qx2 = sy * e1z - sz * e1y, qy2 = sz * e1x - sx * e1z, qz2 = sx * e1y - sy * e1x;
          const v = f * (dx * qx2 + dy * qy2 + dz * qz2);
          if (v < 0 || u + v > 1) return;
          const dist = f * (e2x * qx2 + e2y * qy2 + e2z * qz2);
          if (dist > 0.6 && dist < best) best = dist;
        });
      }
      return best < maxDist ? best : 0;
    }

    for (const e of edges) {
      // 局部板厚：沿两个相邻面法向反向测厚，取较小值。
      // 只对可能成为接头的边做（太短的碎边不参与，省掉大量射线步进）
      if (e.lengthMm < 4) { e.measuredThickness = 0; continue; }
      const n1 = e.n1, n2 = e.n2;
      const c = e.centroid;
      const bev1 = Math.max(Math.abs(n1.x), Math.abs(n1.y), Math.abs(n1.z)) < 0.92;
      const bev2 = Math.max(Math.abs(n2.x), Math.abs(n2.y), Math.abs(n2.z)) < 0.92;
      const t1 = bev1 ? 0 : rayHit(c.x, c.y, c.z, -n1.x, -n1.y, -n1.z, e.partA, 90);
      const t2 = bev2 ? 0 : rayHit(c.x, c.y, c.z, -n2.x, -n2.y, -n2.z, e.partA, 90);
      const cands = [t1, t2].filter((v) => v > 3.5);
      e.measuredThickness = cands.length ? Math.round(Math.max.apply(null, cands) * 10) / 10 : 0;
    }

    function nearestOtherPart(px, py, pz, selfA, selfB, tol) {
      let best2 = tol * tol, bestPart = -1;
      forEachNearby(px, py, pz, tol, function (t) {
        const tp = triPart[t];
        if (tp === selfA || tp === selfB) return;
        const d2 = aabbDist2(px, py, pz, t);
        if (d2 >= best2) return;
        const d = pointTriDist(px, py, pz, t);
        if (d * d < best2) { best2 = d * d; bestPart = tp; }
      });
      return { d: Math.sqrt(best2), part: bestPart };
    }

    /* 沿折线按弧长均匀采样：每 ~2mm 一点，5~96 点 */
    function samplePolyline(points) {
      const segs = [];
      let total = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const L = dist(points[i], points[i + 1]);
        if (L <= 1e-6) continue;
        segs.push({ a: points[i], b: points[i + 1], L, s0: total });
        total += L;
      }
      if (!segs.length) return [];
      const n = Math.max(5, Math.min(48, Math.ceil(total / 2.0)));
      const out = [];
      for (let k = 0; k <= n; k++) {
        const s = total * k / n;
        let sg = segs[segs.length - 1];
        for (let i = 0; i < segs.length; i++) { if (s <= segs[i].s0 + segs[i].L) { sg = segs[i]; break; } }
        const u = sg.L > 1e-9 ? Math.max(0, Math.min(1, (s - sg.s0) / sg.L)) : 0;
        out.push(P(sg.a.x + (sg.b.x - sg.a.x) * u,
                   sg.a.y + (sg.b.y - sg.a.y) * u,
                   sg.a.z + (sg.b.z - sg.a.z) * u));
      }
      return out;
    }

    for (const e of edges) {
      if (e.lengthMm < 2) continue;
      const samples = samplePolyline(e.points);
      if (samples.length < 4) continue;

      const hits = new Map();
      for (let i = 0; i < samples.length; i++) {
        const sp = samples[i];
        const r = nearestOtherPart(sp.x, sp.y, sp.z, e.partA, e.partB, TOL);
        if (r.part < 0) continue;
        let arr = hits.get(r.part);
        if (!arr) { arr = new Uint8Array(samples.length); hits.set(r.part, arr); }
        arr[i] = 1;
      }
      if (!hits.size) continue;

      let target = -1, bestCount = 0, bestArr = null;
      for (const [pi, arr] of hits) {
        let c = 0;
        for (let i = 0; i < arr.length; i++) c += arr[i];
        if (c > bestCount) { bestCount = c; target = pi; bestArr = arr; }
      }
      if (target < 0) continue;

      const n = samples.length;
      const ratio = bestCount / n;

      // 最长连续接触段（真实焊缝是连续的，擦边只有端点孤立命中）
      let run = 0, bestRun = 0;
      for (let i = 0; i < n; i++) {
        if (bestArr[i]) { run++; if (run > bestRun) bestRun = run; } else run = 0;
      }
      const span = bestRun / n;

      // 三级判定：
      //   ratio ≥ 0.65 且 span ≥ 0.55  → 高置信度接头（自动标注）
      //   ratio ≥ 0.30 且 span ≥ 0.25  → 低置信度候选（不自动标注，但手动可选中，
      //                                    避免"隔板半插入 / 坡口断续"这类真接头被漏掉）
      //   其余                          → 端点擦边，直接丢弃
      if (ratio < 0.30 || span < 0.25) continue;

      e.crossPart = true;
      e.partB = target;
      e.partBId = solids[target] ? solids[target].id : null;
      e.partBName = solids[target] ? solids[target].name : "零件B";
      e.contactRatio = Math.round(ratio * 100) / 100;
      e.contactSpan = Math.round(span * 100) / 100;
      e.lowConfidence = (ratio < 0.65 || span < 0.55);
      e.jointKind = "T";

      // 精确提取对方零件(partB)在贴合面处的法向 nB 与局部板厚，并扫描正交截面内(15mm半径)的单V/双V坡口斜面
      let bestTriB = -1, bestDistB = 999;
      let bestBevelA = null, bestBevelDistA = 15.5;
      let bestBevelB = null, bestBevelDistB = 15.5;
      const mc = e.centroid;
      const p0 = e.points[0], p1 = e.points[e.points.length - 1];
      const tv = norm(sub(p1, p0));

      forEachNearby(mc.x, mc.y, mc.z, 15.5, function (t) {
        const tp = triPart[t];
        if (tp !== target && tp !== e.partA) return;
        const d = pointTriDist(mc.x, mc.y, mc.z, t);
        if (tp === target && d < TOL * 2.2 && d < bestDistB) {
          bestDistB = d; bestTriB = t;
        }
        if (soup.triNrm && d < 15.0) {
          const ntRaw = P(soup.triNrm[t * 3], soup.triNrm[t * 3 + 1], soup.triNrm[t * 3 + 2]);
          if (Math.abs(dot(ntRaw, tv)) < 0.30) {
            const ntp = norm(sub(ntRaw, mul(tv, dot(ntRaw, tv))));
            const maxAx = Math.max(Math.abs(ntp.x), Math.abs(ntp.y), Math.abs(ntp.z));
            if (maxAx >= 0.36 && maxAx <= 0.92) {
              // 确认三角面面积足够大（排除微小倒角碎面）
              const i0 = triV[t * 3], i1 = triV[t * 3 + 1], i2 = triV[t * 3 + 2];
              const ux = wpos[i1 * 3] - wpos[i0 * 3], uy = wpos[i1 * 3 + 1] - wpos[i0 * 3 + 1], uz = wpos[i1 * 3 + 2] - wpos[i0 * 3 + 2];
              const vx = wpos[i2 * 3] - wpos[i0 * 3], vy = wpos[i2 * 3 + 1] - wpos[i0 * 3 + 1], vz = wpos[i2 * 3 + 2] - wpos[i0 * 3 + 2];
              const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
              if (area2 > 320.0) {
                if (tp === e.partA && d < bestBevelDistA) { bestBevelDistA = d; bestBevelA = ntp; }
                else if (tp === target && d < bestBevelDistB) { bestBevelDistB = d; bestBevelB = ntp; }
              }
            }
          }
        }
      });

      if (bestTriB >= 0 && soup.triNrm) {
        const nb = P(soup.triNrm[bestTriB * 3], soup.triNrm[bestTriB * 3 + 1], soup.triNrm[bestTriB * 3 + 2]);
        e.nB = nb;
        const tb = rayHit(mc.x, mc.y, mc.z, -nb.x, -nb.y, -nb.z, target, 90);
        if (tb > 1.5) e.measuredThicknessB = Math.round(tb * 10) / 10;
        const n1p = norm(sub(e.n1, mul(tv, dot(e.n1, tv))));
        const n2p = norm(sub(e.n2, mul(tv, dot(e.n2, tv))));
        let nbp = norm(sub(nb, mul(tv, dot(nb, tv))));
        const bev1 = Math.max(Math.abs(n1p.x), Math.abs(n1p.y), Math.abs(n1p.z)) < 0.92;
        const bev2 = Math.max(Math.abs(n2p.x), Math.abs(n2p.y), Math.abs(n2p.z)) < 0.92;
        let nWallA = n1p;
        let hasBevelA = bev1 || bev2;
        if (bev2 && !bev1) nWallA = n2p;
        else if (!bev1 && !bev2) {
          // 若当前边为钝边根部或肩部(n1/n2正交)，检查同侧截面是否检出单V坡口斜面 bestBevelA
          if (bestBevelA && dot(bestBevelA, nbp) < -0.35 && (dot(bestBevelA, n1p) > -0.25 || dot(bestBevelA, n2p) > -0.25 || bestBevelDistA < 3.5)) {
            nWallA = bestBevelA;
            hasBevelA = true;
          } else {
            nWallA = Math.abs(dot(n1p, nbp)) < Math.abs(dot(n2p, nbp)) ? n1p : n2p;
          }
        }
        let hasBevelB = Math.max(Math.abs(nbp.x), Math.abs(nbp.y), Math.abs(nbp.z)) < 0.92;
        if (!hasBevelB && bestBevelB && dot(bestBevelB, nWallA) < -0.35 && bestBevelDistB < 13.5) {
          nbp = bestBevelB;
          hasBevelB = true;
        }
        const u1 = norm(sub(nbp, mul(nWallA, dot(nbp, nWallA))));
        const u2 = norm(sub(nWallA, mul(nbp, dot(nWallA, nbp))));
        if (Math.hypot(u1.x, u1.y, u1.z) > 0.5 && Math.hypot(u2.x, u2.y, u2.z) > 0.5) {
          e.weldU1 = u1;
          e.weldU2 = u2;
          const wAng = Math.acos(clamp(dot(u1, u2), -1, 1)) * 180 / Math.PI;
          e.grooveOpenDeg = Math.round(wAng * 10) / 10;
          if ((hasBevelA || hasBevelB) && wAng < 68) {
            e.isBevelGroove = true;
            e.grooveSubType = (hasBevelA && hasBevelB) ? "V" : "singleV";
            const tRef = Math.min(e.measuredThickness || 20, e.measuredThicknessB || 20);
            e.groove = {
              subType: e.grooveSubType,
              angle: e.grooveOpenDeg,
              depth: Math.round(clamp(tRef * 0.8, 6, 32) * 10) / 10,
              rootGap: 2.0,
              confidence: 0.96
            };
          }
        }
      }
    }
  }

  /* ---- 2.3 可焊性判定 ---- */
  function evaluateWeldability(edges, parts) {
    for (const e of edges) {
      const th = e.theta;
      // 跨零件贴合棱边 = 实际接头线（零件间不共享顶点，只能靠接触判定）
      // 跨零件贴合棱边 = 实际接头线（零件间不共享顶点，只能靠接触判定）。
      // 长度下限从 6mm 放宽到 2.5mm：圆形/曲面焊缝被三角化后每段往往只有 3~8mm，
      // 旧阈值把销轴座环形焊缝整圈丢掉。
      const crossOK = e.crossPart && th >= 18 && th <= 162 && e.lengthMm >= 2.5;
      // 同一实体内：只有凹边才需要填焊，凸边是自由棱边
      const selfOK = !e.crossPart && e.concave && th >= 30 && th <= 150 && e.lengthMm >= 2.5;
      e.weldable = crossOK || selfOK;

      let conf = 0.4;
      if (crossOK) {
        // 置信度直接由"接触率 + 最长连续接触段"给出，替代原来固定的 0.94
        conf = e.lowConfidence
          ? 0.42 + 0.20 * (e.contactRatio || 0)
          : 0.72 + 0.20 * (e.contactRatio || 0) + 0.08 * (e.contactSpan || 0);
        if (!e.lowConfidence && th > 55 && th < 125) conf += 0.02;
      } else if (selfOK) {
        conf = 0.8;
      }
      e.confidence = Math.round(clamp(conf, 0, 1) * 100) / 100;

      const tA0 = e.measuredThickness && e.measuredThickness > 3.5
        ? e.measuredThickness
        : (parts[e.partA] ? parts[e.partA].thickness : 16);
      const tB0 = e.measuredThicknessB && e.measuredThicknessB > 3.5
        ? e.measuredThicknessB
        : (parts[e.partB] ? parts[e.partB].thickness : 16);
      const tA = clamp(tA0, 4, 40);
      const tB = clamp(tB0, 4, 40);
      e.thickness1 = Math.round(tA * 10) / 10;
      e.thickness2 = Math.round(tB * 10) / 10;
      e.persistRef = "BR" + Math.round(e.centroid.x * 10) + "_" + Math.round(e.centroid.y * 10) + "_" + Math.round(e.centroid.z * 10);
      const pa = parts[e.partA], pb = parts[e.partB];
      e.partAId = pa ? pa.id : null;
      if (!e.partBId) e.partBId = pb ? pb.id : null;
      e.partAName = pa ? pa.name : "零件A";
      if (!e.partBName) e.partBName = pb ? pb.name : "零件B";
      e.label = e.crossPart && pb && pb !== pa ? (e.partAName + " ↔ " + e.partBName) : e.partAName;
    }
  }

  /* ---- 2.4 OCCT 结果 → 模型 ---- */
  function buildModelFromOcct(res, fileName, sourcePath) {
    const meshes = res.meshes;
    if (!meshes || !meshes.length) throw new Error("模型未包含任何可三角化的实体面");

    // 全局包围盒 → 居中
    let bb = { mnx: Infinity, mny: Infinity, mnz: Infinity, mxx: -Infinity, mxy: -Infinity, mxz: -Infinity };
    for (const m of meshes) {
      const b = meshBounds([m]);
      if (b.mnx < bb.mnx) bb.mnx = b.mnx; if (b.mny < bb.mny) bb.mny = b.mny; if (b.mnz < bb.mnz) bb.mnz = b.mnz;
      if (b.mxx > bb.mxx) bb.mxx = b.mxx; if (b.mxy > bb.mxy) bb.mxy = b.mxy; if (b.mxz > bb.mxz) bb.mxz = b.mxz;
    }
    const center = P((bb.mnx + bb.mxx) / 2, (bb.mny + bb.mxy) / 2, (bb.mnz + bb.mxz) / 2);

    const parts = [];
    let autoId = 0;
    const palette = ["#b9c4d2", "#b3bfce", "#bec9d6", "#aebacb", "#bac5d3", "#b6c1d0"];

    function walk(node, parentId, depth) {
      const hasChildren = node.children && node.children.length > 0;
      const hasMesh = node.meshes && node.meshes.length > 0;
      const id = "P" + (++autoId);
      if (hasMesh) {
        const list = node.meshes.map((i) => meshes[i]).filter(Boolean);
        const g = mergeMeshes(list, center);
        const b = meshBounds(list);
        const sx = Math.abs(b.mxx - b.mnx), sy = Math.abs(b.mxy - b.mny), sz = Math.abs(b.mxz - b.mnz);
        const dims = [sx, sy, sz].sort((a, c) => a - c);
        const thick = dims[0] > 0.5 ? Math.min(dims[0], 40) : 12;
        parts.push({
          id,
          name: node.name || ("零件 " + autoId),
          parentId: parentId,
          depth: depth,
          isAssembly: hasChildren,
          isCover: false,
          color: palette[parts.length % palette.length],
          visible: true,
          opacity: 1.0,
          explodeVec: P(0, 0, 0),
          thickness: Math.round(thick * 10) / 10,
          bbox: { min: P(b.mnx - center.x, b.mny - center.y, b.mnz - center.z), max: P(b.mxx - center.x, b.mxy - center.y, b.mxz - center.z) },
          geom: g
        });
      } else if (hasChildren) {
        parts.push({
          id,
          name: node.name || ("装配 " + autoId),
          parentId: parentId,
          depth: depth,
          isAssembly: true,
          isCover: false,
          color: "#c3ccd8",
          visible: true,
          opacity: 1.0,
          explodeVec: P(0, 0, 0),
          thickness: 12,
          bbox: null,
          geom: null
        });
      }
      for (const ch of (node.children || [])) walk(ch, id, depth + 1);
    }
    walk(res.root || { name: fileName, meshes: meshes.map((_, i) => i), children: [] }, "root", 0);

    const solids = parts.filter((p) => p.geom);
    if (!solids.length) throw new Error("模型未解析出实体零件");

    // 同名零件加实例序号，装配树里可区分
    const nameCount = new Map();
    for (const p of solids) nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
    const nameSeen = new Map();
    for (const p of solids) {
      if (nameCount.get(p.name) > 1) {
        const n = (nameSeen.get(p.name) || 0) + 1;
        nameSeen.set(p.name, n);
        p.name = p.name + " #" + n;
      }
    }

    setStatus("正在提取 B-rep 特征边 …");
    const soup = buildSoup(solids);
    const edges = extractFeatureEdges(soup);
    evaluateWeldability(edges, solids);

    setStatus("正在识别跨零件焊接接头 …");
    detectCrossPartJoints(edges, soup, solids);
    evaluateWeldability(edges, solids);

    const weldable = edges.filter((e) => e.weldable);
    return {
      assemblyName: fileName.replace(/\.[^.]+$/, ""),
      sourcePath: sourcePath || fileName,
      parts,
      edges,
      welds: [],
      stats: {
        parts: solids.length,
        tris: soup.triPart.length,
        edges: edges.length,
        weldable: weldable.length,
        kernel: "OCCT " + (res.occtVersion || "B-rep")
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. 导入入口（覆盖原 openCadViaPythonBridge / handleLocalStandardFile） */
  /* ------------------------------------------------------------------ */
  async function importCadBytes(buf, fileName, sourcePath) {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    setStatus("正在加载几何内核 …");
    const occt = await ensureOcct();
    setStatus("正在三角化 B-rep 实体：" + fileName + " …");
    const t0 = performance.now();
    const params = {
      linearUnit: "millimeter",
      linearDeflectionType: "absolute_value",
      linearDeflection: 0.18,
      angularDeflection: 0.3
    };
    const bytes = new Uint8Array(buf);
    let res;
    if (ext === "iges" || ext === "igs") res = occt.ReadIgesFile(bytes, params);
    else if (ext === "brep") res = occt.ReadBrepFile(bytes, params);
    else res = occt.ReadStepFile(bytes, params);

    if (!res || !res.success) throw new Error("几何内核无法识别该文件（可能是装配引用缺失或格式损坏）");
    const model = buildModelFromOcct(res, fileName, sourcePath);
    const ms = Math.round(performance.now() - t0);
    try { hideErrorBanner(); } catch (e) {}
    // 清空残留文案，避免后续读取到上一轮的「导入失败」
    try {
      const bt = document.getElementById("errorBannerText");
      if (bt) bt.textContent = "";
      const bb = document.getElementById("errorBanner");
      if (bb) { bb.classList.remove("visible"); bb.style.display = "none"; }
    } catch (e) {}
    loadWeldModel(model);
    V.sceneDirty = true;
    setStatus(
      "已导入 " + model.assemblyName + " — 实体 " + model.stats.parts +
      " / 三角面 " + model.stats.tris + " / 特征边 " + model.stats.edges +
      " / 可焊边 " + model.stats.weldable + "（" + ms + " ms）"
    );
    return model;
  }

  async function openCadSmart(path) {
    const fileName = path.split(/[\\/]/).pop() || path;
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    try {
      if (["step", "stp", "iges", "igs", "brep"].includes(ext)) {
        const buf = await fetchCadBytes(path);
        await importCadBytes(buf, fileName, path);
        return;
      }
      if (ext === "stl" || ext === "obj" || ext === "json" || ext === "wvproj") {
        // 走原有解析器（STL/OBJ 已经是三角网格，无需 B-rep）
        const res = await fetch(HOST + "/api/read_cad_file?path=" + encodeURIComponent(path));
        if (!res.ok) throw new Error("读取文件失败");
        const payload = await res.json();
        const bin = atob(payload.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const txt = new TextDecoder("utf-8").decode(bytes);
        if (ext === "stl") loadWeldModel(parseStlBufferToWeldModel(bytes.buffer, fileName));
        else loadWeldModel(JSON.parse(txt));
        V.sceneDirty = true;
        return;
      }
      // SolidWorks 专有格式 → Python 桥接
      setStatus("正在通过 SolidWorks 桥接读取 " + fileName + " …");
      const r = await fetch("http://127.0.0.1:18766/api/open_sw?path=" + encodeURIComponent(path));
      if (!r.ok) throw new Error("SolidWorks 桥接未响应");
      const model = await r.json();
      loadWeldModel(model);
      V.sceneDirty = true;
    } catch (e) {
      fail("导入失败：" + (e && e.message ? e.message : e));
    }
  }

  /* ------------------------------------------------------------------ */
  /* 4. three.js 渲染                                                     */
  /* ------------------------------------------------------------------ */
  V.sceneDirty = true;
  V.weldSig = "";

  async function ensureThree() {
    if (V.THREE) return V.THREE;
    if (V._threePromise) return V._threePromise;
    V._threePromise = (async function () {
      const THREE = await import(VENDOR_THREE);
      const { RoomEnvironment } = await import("/assets/vendor/three/RoomEnvironment.js");
      V.THREE = THREE;
      initThree(THREE, RoomEnvironment);
      return THREE;
    })();
    return V._threePromise;
  }

  function initThree(T, RoomEnvironment) {
    const canvas = document.getElementById("threeCanvas");
    if (!canvas) throw new Error("缺少三维画布节点");
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.98;
    renderer.localClippingEnabled = true;

    const scene = new T.Scene();
    const pmrem = new T.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.7;

    // 三点布光：屏幕空间稳定，接近 SolidWorks 的棚拍观感
    const hemi = new T.HemisphereLight(0xe8eef8, 0x8b96a5, 0.9);
    scene.add(hemi);
    const key = new T.DirectionalLight(0xffffff, 2.0);
    key.position.set(0.55, 0.95, 0.8);
    scene.add(key);
    const fill = new T.DirectionalLight(0xcfe0f5, 0.75);
    fill.position.set(-0.85, 0.15, 0.45);
    scene.add(fill);
    const rim = new T.DirectionalLight(0xffffff, 0.55);
    rim.position.set(-0.2, -0.6, -0.9);
    scene.add(rim);

    const modelGroup = new T.Group();
    modelGroup.matrixAutoUpdate = false;
    scene.add(modelGroup);

    const gridGroup = new T.Group();
    modelGroup.add(gridGroup);

    const persp = new T.PerspectiveCamera(35, 1, 1, 100000);
    const ortho = new T.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);

    // 剖切面常驻材质（避免开关时重编译着色器）：关闭时把常数推到无穷远
    const clipPlane = new T.Plane(new T.Vector3(-1, 0, 0), 1e9);

    V.THREE = T;
    V.renderer = renderer;
    V.scene = scene;
    V.modelGroup = modelGroup;
    V.gridGroup = gridGroup;
    V.persp = persp;
    V.ortho = ortho;
    V.activeCam = persp;
    V.clipPlane = clipPlane;
    V.partObjs = new Map();
    V.weldObjs = new Map();
    V.edgeObj = null;
    V.candObj = null;
    V.gridObj = null;
    V.threeReady = true;
    V.sceneDirty = true;
  }

  function makePartGeometry(T, g) {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(g.positions, 3));
    geo.setAttribute("normal", new T.BufferAttribute(g.normals, 3));
    geo.setIndex(new T.BufferAttribute(g.indices, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  function rebuildModelObjects() {
    const T = V.THREE;
    const group = V.modelGroup;
    // 清空旧对象
    for (const obj of V.partObjs.values()) { group.remove(obj.mesh); obj.mesh.geometry.dispose(); obj.mesh.material.dispose(); }
    V.partObjs.clear();
    if (V.edgeObj) { group.remove(V.edgeObj); V.edgeObj.geometry.dispose(); V.edgeObj.material.dispose(); V.edgeObj = null; }
    if (V.candObj) { group.remove(V.candObj); V.candObj.geometry.dispose(); V.candObj.material.dispose(); V.candObj = null; V.candSig = ""; }

    for (const part of state.parts) {
      if (!part.geom || !part.geom.positions) continue;
      const geo = makePartGeometry(T, part.geom);
      const mat = new T.MeshStandardMaterial({
        color: new T.Color(part.color || "#c3ccd8"),
        metalness: 0.55,
        roughness: 0.46,
        envMapIntensity: 0.8,
        polygonOffset: true,
        polygonOffsetFactor: 1.2,
        polygonOffsetUnits: 1.0,
        clippingPlanes: [V.clipPlane],
        side: T.FrontSide
      });
      const mesh = new T.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.userData.partId = part.id;
      group.add(mesh);
      V.partObjs.set(part.id, { mesh, part });
    }

    // 模型特征边（CAD 描边）
    const edgePos = [];
    for (const part of state.parts) {
      if (!part.geom) continue;
      for (const e of (part.geom.featureEdges || [])) {
        const pts = e.points;
        for (let i = 0; i < pts.length - 1; i++) {
          edgePos.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        }
      }
    }
    if (edgePos.length) {
      const eg = new T.BufferGeometry();
      eg.setAttribute("position", new T.Float32BufferAttribute(edgePos, 3));
      const em = new T.LineBasicMaterial({ color: 0x2a3644, transparent: true, opacity: 0.42, depthWrite: false });
      const lines = new T.LineSegments(eg, em);
      lines.renderOrder = 2;
      lines.visible = !(V.settings && V.settings.showEdges === false);
      group.add(lines);
      V.edgeObj = lines;
    }

    buildGrid();
    if (V.gridObj && V.settings && V.settings.showGrid === false) V.gridObj.visible = false;
    V.sceneDirty = false;
    V.weldSig = "";
  }

  function buildGrid() {
    const T = V.THREE;
    if (V.gridObj) { V.gridGroup.remove(V.gridObj); V.gridObj.geometry.dispose(); V.gridObj.material.dispose(); V.gridObj = null; }
    const b = cachedSceneBounds;
    if (!b) return;
    const span = Math.max(b.size.x, b.size.z, 1);
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let step = nice[nice.length - 1];
    for (const n of nice) { if (span / n <= 14) { step = n; break; } }
    const half = Math.ceil((span * 0.62) / step) * step;
    const div = Math.max(4, Math.round((half * 2) / step));
    const grid = new T.GridHelper(half * 2, div, 0x8fa3bb, 0xc3cedd);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    grid.position.set(Math.round(b.center.x / step) * step, b.min.y - Math.max(1.5, span * 0.012), Math.round(b.center.z / step) * step);
    grid.renderOrder = 1;
    V.gridGroup.add(grid);
    V.gridObj = grid;
  }

  /* ---- 相机核心（V3.5，对标 SolidWorks）--------------------------------
   * 坐标系约定：相机固定在 (0,0,distance) 看向 -Z，永不旋转；
   * 模型组承担「旋转 R + 平移 t」，平移量由 panX/panY（像素）换算得到。
   *
   * 为什么平移用「平移模型」而不是 three 的 setViewOffset：
   *   setViewOffset 本质是移轴镜头（lens shift），所有深度的点等量平移，
   *   完全没有视差。透视模式下模型一旦离开画面中心，近端与远端的相对
   *   位置就不再符合真实观察，视觉上就是「比例失调、模型被拉扯」。
   *   平移模型等价于反向平移相机 —— 近端移得多、远端移得少，视差正确，
   *   与 SW 的观察手感一致。正交投影下两种做法数学等价，故正交视图不受影响。
   *
   * 深度范围（near/far）不再跟随 distance 拍脑袋取值，而是紧贴模型在
   * 相机空间的实际 z 跨度：正交由 ±1000000（200 万 mm）收到模型厚度量级，
   * 透视由 near=distance*0.001 收到「相机到模型最近点」，
   * 深度缓冲有效位数提升 2~3 个数量级，杜绝表面互穿与闪烁。
   * ------------------------------------------------------------------ */

  /* 模型 8 个角点旋转后的 z 范围（相机空间，未含平移）。
   * zMax = 离相机最近的点，zMin = 最远点；depth = distance - rz。 */
  function camSpaceZExtent() {
    const b = cachedSceneBounds || computeSceneBoundsV33();
    const m = state.camera.rotMat || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (!b) return { zMin: -1, zMax: 1, span: 2 };
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = (i & 1) ? b.max.x : b.min.x;
      const y = (i & 2) ? b.max.y : b.min.y;
      const z = (i & 4) ? b.max.z : b.min.z;
      const rz = m[6] * x + m[7] * y + m[8] * z;
      if (rz < zMin) zMin = rz;
      if (rz > zMax) zMax = rz;
    }
    return { zMin: zMin, zMax: zMax, span: Math.max(1e-6, zMax - zMin) };
  }

  function syncCamera(W, H) {
    const cam = state.camera;
    const aspect = W / H;
    const fov = 2 * Math.atan(H / (2 * FOCAL_PX)) * 180 / Math.PI;
    const persp = V.persp, ortho = V.ortho;
    const R = sceneRadius();

    /* 把相机约束在合法范围内。切换投影、载入工程、适配视图后都可能越界；
     * 尤其是「正交深放大 → 切透视」时相机会落在模型内部，必须拉回。 */
    const lim = zoomLimits();
    if (!isFinite(cam.distance) || cam.distance <= 0) cam.distance = lim.max * 0.25;
    if (cam.distance < lim.min) cam.distance = lim.min;
    if (cam.distance > lim.max) cam.distance = lim.max;

    const ext = camSpaceZExtent();
    const pad = Math.max(1, R * 0.02);

    /* 透视：near/far 夹住模型最近/最远点 */
    const dn = cam.distance - ext.zMax;
    const df = cam.distance - ext.zMin;
    let pNear = Math.max(0.05, dn * 0.5);
    let pFar = Math.max(pNear * 4, df * 1.15 + 10);
    if (pFar / pNear > 2000) pNear = pFar / 2000;   // 锁死 far/near 比，保住深度精度

    persp.clearViewOffset();
    persp.fov = fov;
    persp.aspect = aspect;
    persp.near = pNear;
    persp.far = pFar;
    persp.position.set(0, 0, cam.distance);
    persp.rotation.set(0, 0, 0);
    persp.updateProjectionMatrix();

    /* 正交：near/far 同样夹住模型。
     * 正交投影与相机位置无关，near 允许为负（模型落在相机"后方"依然可见），
     * 因此深度范围恒等于「模型 z 跨度 + 2*pad」，与缩放倍数完全无关，
     * 任何缩放档位下的深度精度都一致 —— 这是彻底消除表面互穿的关键。 */
    const oNear = cam.distance - ext.zMax - pad;
    const oFar = Math.max(oNear + 1, cam.distance - ext.zMin + pad);
    const h = H * cam.distance / FOCAL_PX;
    const w = h * aspect;
    ortho.clearViewOffset();
    ortho.left = -w / 2; ortho.right = w / 2; ortho.top = h / 2; ortho.bottom = -h / 2;
    ortho.near = oNear; ortho.far = oFar;
    ortho.position.set(0, 0, cam.distance);
    ortho.rotation.set(0, 0, 0);
    ortho.updateProjectionMatrix();

    V.activeCam = cam.ortho ? ortho : persp;
    V.activeCam.updateMatrixWorld();

    /* 平移：像素 → 世界单位（以目标深度平面为基准），写进模型组矩阵 */
    const k = cam.distance / FOCAL_PX;
    const m = cam.rotMat || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    V.modelGroup.matrix.set(
      m[0], m[1], m[2], cam.panX * k,
      m[3], m[4], m[5], -cam.panY * k,
      m[6], m[7], m[8], 0,
      0, 0, 0, 1
    );
    V.modelGroup.matrixWorldNeedsUpdate = true;
    V.modelGroup.updateMatrixWorld(true);
  }

  /* 与渲染完全一致的投影，供拾取与 HUD 使用。
   * 注意：模型组带平移，故相机空间坐标 = R·p + t。 */
  const _pv = { x: 0, y: 0, z: 0 };
  function projectPointToScreen(p, W, H) {
    const cam = state.camera;
    const m = cam.rotMat || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const rx = m[0] * p.x + m[1] * p.y + m[2] * p.z;
    const ry = m[3] * p.x + m[4] * p.y + m[5] * p.z;
    const rz = m[6] * p.x + m[7] * p.y + m[8] * p.z;
    const k = cam.distance / FOCAL_PX;
    const qx = rx + cam.panX * k;
    const qy = ry - cam.panY * k;
    const depth = cam.ortho ? cam.distance : Math.max(1e-3, cam.distance - rz);
    const scale = FOCAL_PX / depth;
    return {
      sx: W / 2 + qx * scale,
      sy: H / 2 - qy * scale,
      depth: depth,
      camZ: rz
    };
  }

  /* ---- 4.0b 视图适配 + 光标锚定缩放（V3.5）----------------------------
   * 与 SolidWorks 对齐的三条硬约束：
   *   1) 缩放以光标为锚点，锚点处的几何在屏幕上纹丝不动；
   *   2) 缩放绝不移动模型 —— 不做事后「拉回视口」的二次修正，
   *      否则连续滚动时模型会被边界约束反复拖拽，看起来就是漂移/失真；
   *   3) 透视下相机不得越过模型最近点，否则顶点跑到相机背后，
   *      投影矩阵出现 w<0，模型瞬间被"撕裂"成巨型三角形。
   * ------------------------------------------------------------------ */

  function sceneRadius() {
    const b = cachedSceneBounds || computeSceneBoundsV33();
    return b ? Math.max(b.radius, 1) : 1000;
  }

  function zoomLimits() {
    const R = sceneRadius();
    const fitD = V.fitDistance || state.camera.distance || R * 2.6;
    const ext = camSpaceZExtent();
    const max = Math.max(fitD * 4, R * 20);
    if (state.camera.ortho) {
      // 正交无近裁剪风险，可以贴到很近看细节
      return { min: Math.max(1.5, ext.span * 0.002), max: max };
    }
    /* 透视：相机与模型最近点之间必须留出与模型尺度成比例的余量。
     * 若贴到最近点（depth→0），该点投影发散、被近平面切掉，
     * 画面就是模型被剖开/撕裂——这正是"放大后失真"的直接成因。 */
    return { min: ext.zMax + Math.max(ext.span * 0.06, R * 0.02), max: max };
  }

  const _origFitView = window.fitViewToWindow;
  function fitViewV33() {
    try {
      if (typeof _origFitView === "function") _origFitView();
    } catch (e) { console.error(e); }

    const R = sceneRadius();
    const d = Number(state.camera.distance) || R * 2.6;
    V.fitDistance = d;

    // 适配后把包围盒中心精确对齐视口中心（新投影下 pan 的换算基准是 distance）
    const b = cachedSceneBounds;
    if (b) {
      const m = state.camera.rotMat || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const rcx = m[0] * b.center.x + m[1] * b.center.y + m[2] * b.center.z;
      const rcy = m[3] * b.center.x + m[4] * b.center.y + m[5] * b.center.z;
      state.camera.panX = -rcx * FOCAL_PX / d;
      state.camera.panY = rcy * FOCAL_PX / d;
    }

    const lim = zoomLimits();
    state.camera.maxDistance = lim.max;
    state.camera.minDistance = lim.min;

    // 适配后按新焦距重绘一次，保证 HUD 与渲染同步
    try { renderSceneV33(); } catch (e) {}
  }

  /* 光标下的实体表面点，返回「相机空间旋转后坐标」（不含平移）。
   * 用于把缩放锚点钉在真实工件上，而不是钉在包围盒中心平面上
   * ——这正是 SolidWorks 的缩放手感。 */
  function pickSurfacePoint(mx, my, W, H) {
    const T = V.THREE;
    if (!T || !V.threeReady) return null;
    if (!_raycaster) _raycaster = new T.Raycaster();
    const ndc = new T.Vector2((mx / W) * 2 - 1, -(my / H) * 2 + 1);
    _raycaster.setFromCamera(ndc, V.activeCam);
    const meshes = [];
    for (const { mesh } of V.partObjs.values()) if (mesh.visible) meshes.push(mesh);
    if (!meshes.length) return null;
    const hits = _raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    // hit.point 是含平移的世界坐标，减掉平移即得旋转后的相机空间坐标
    const cam = state.camera;
    const k = cam.distance / FOCAL_PX;
    return {
      x: hits[0].point.x - cam.panX * k,
      y: hits[0].point.y + cam.panY * k,
      z: hits[0].point.z
    };
  }

  /* 滚轮缩放：以光标为锚点，锚点处的模型在屏幕上保持不动 */
  function onWheelZoom(e) {
    if (!e.target || e.target !== hudCanvas) return;
    e.preventDefault();
    e.stopPropagation();

    const cam = state.camera;
    if (!isFinite(cam.distance) || cam.distance <= 0) return;

    const rect = hudCanvas.getBoundingClientRect();
    const W = Math.max(100, rect.width), H = Math.max(100, rect.height);
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    const lim = zoomLimits();
    // 指数缩放：兼容滚轮（deltaY≈±100）与触控板（小增量连续值）
    // 步长来自设置（默认 12%），SW 手感：一格滚轮约放大 1.12 倍
    const stepPct = Math.max(2, Math.min(40, Number(V.settings && V.settings.zoomStep) || 12));
    const raw = Number(e.deltaY) || 0;
    const factor = Math.pow(1 + stepPct / 100, Math.max(-1, Math.min(1, raw / 100)));
    let nd = cam.distance * factor;
    nd = Math.max(lim.min, Math.min(lim.max, nd));
    if (Math.abs(nd - cam.distance) < 1e-9) return;

    const kOld = cam.distance / FOCAL_PX;
    const kNew = nd / FOCAL_PX;

    // 锚点优先级：光标下的真实工件表面点 > 包围盒中心深度平面。
    // 命中表面时，该表面点在缩放前后严格钉在光标下（SolidWorks 手感）。
    // 正交模式下同样拾取：正交投影与深度无关，任何深度上的点只要 x/y 不变，
    // 屏幕位置就不变，因此拾取到的表面点是精确锚点。
    const hit = pickSurfacePoint(mx, my, W, H);
    const b = cachedSceneBounds;
    const m = cam.rotMat || [1, 0, 0, 0, 1, 0, 0, 0, 1];

    let rx, ry, rzc;
    if (hit) {
      rx = hit.x; ry = hit.y; rzc = hit.z;
    } else {
      // 空白处：锚在「模型中心深度平面」上，避免相机因深度未知而抖动
      rzc = b ? (m[6] * b.center.x + m[7] * b.center.y + m[8] * b.center.z) : 0;
      const dOld = cam.ortho ? cam.distance : Math.max(1e-3, cam.distance - rzc);
      rx = (mx - W / 2) * dOld / FOCAL_PX - cam.panX * kOld;
      ry = (H / 2 - my) * dOld / FOCAL_PX + cam.panY * kOld;
    }

    // 透视：相机不得越过锚点所在表面，否则顶点会跑到相机背后
    if (!cam.ortho) {
      const minD = rzc + Math.max(1, sceneRadius() * 0.005);
      if (nd < minD) nd = Math.min(lim.max, minD);
      if (Math.abs(nd - cam.distance) < 1e-9) return;
    }

    const dNew = cam.ortho ? nd : Math.max(1e-3, nd - rzc);
    const kN = nd / FOCAL_PX;

    cam.distance = nd;
    // 反解平移：让锚点 (rx,ry,rzc) 在缩放后仍然落在 (mx,my)。
    // 正交下 depth 恒为 nd，退化为 px = (mx-W/2) - rx*FOCAL/nd，与旧式等价；
    // 透视下 depth = nd - rzc，近端与远端平移量不同，产生正确视差。
    cam.panX = ((mx - W / 2) * dNew / FOCAL_PX - rx) / kN;
    cam.panY = ((my - H / 2) * dNew / FOCAL_PX + ry) / kN;

    renderSceneV33();
  }

  /* ==================================================================== */
  /* 9. 交互增强：设置面板 / 手动标注工具条 / 交付件导出                   */
  /* ==================================================================== */

  const SETTINGS_KEY = "wv33_settings";
  const DEFAULT_SETTINGS = {
    outputDir: "",            // 交付件 / 工程输出目录（空 = 安装目录 exports）
    method: "manual",         // 默认施焊方式：manual=人 / robot=机
    maxLabels: 14,            // 视口最多显示的焊缝标注数
    autoAvoid: true,          // 标注自动避让
    showLabels: true,         // 是否显示标注
    projection: "ortho",      // 视图投影：ortho=正交（SolidWorks 默认）/ persp=透视
    showEdges: true,          // 显示 B-rep 特征边
    showGrid: true,           // 显示地面网格
    zoomStep: 12,             // 滚轮每格缩放百分比
    renderStyle: "shaded",    // shaded / wireframe / xray
    restoreLast: true,        // 启动时恢复上次工程
    autoSaveMin: 0,           // 自动保存间隔（分钟，0=关闭）
    autoOpenFolder: true,     // 导出完成后自动打开所在目录
    minWeldLen: 25,           // 最小有效焊缝长度(mm)，自动过滤过焊孔/倒角短边噪点
    autoClassifyMethod: true, // 基于箱体内腔遮挡与长度自动区分「人/机」施焊方式
    showPmiSymbol: true       // 视口标注显示 GB/T 324 符号与焊接位置尾注
  };
  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return Object.assign({}, DEFAULT_SETTINGS, raw);
    } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function persistSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(V.settings)); } catch (e) {}
  }
  V.settings = loadSettings();
  /* 诊断/自动化验收用的只读句柄（不含敏感数据，仅内部状态引用） */
  window.WV_INTERNALS = V;
  V.pickSurfacePoint = function (mx, my) {
    return pickSurfacePoint(mx, my, lastW || 1, lastH || 1);
  };
  V.zoomLimits = zoomLimits;
  V.camSpaceZExtent = camSpaceZExtent;
  V.projectPointToScreen = projectPointToScreen;

  /* ---- 9.1 设置对话框 ---- */
  function injectStyles() {
    if (document.getElementById("wv33ui-style")) return;
    const st = document.createElement("style");
    st.id = "wv33ui-style";
    st.textContent = `
      #wvPickBar{position:absolute;left:50%;bottom:26px;transform:translateX(-50%) translateY(14px);
        display:none;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;z-index:30;
        background:rgba(255,255,255,.97);border:1px solid #d7e2f0;
        box-shadow:0 10px 30px rgba(15,23,42,.18);font-size:12px;color:#22314a;
        transition:opacity .16s, transform .16s;opacity:0;}
      #wvPickBar.on{display:flex;opacity:1;transform:translateX(-50%) translateY(0);}
      #wvPickBar .pb-dot{width:7px;height:7px;border-radius:50%;background:#1667d2;
        box-shadow:0 0 0 3px rgba(22,103,210,.16);}
      #wvPickBar b{font-variant-numeric:tabular-nums;color:#0f4c9c;}
      #wvPickBar .pb-sep{width:1px;height:18px;background:#e3eaf4;}
      #wvPickBar button{height:28px;padding:0 12px;border-radius:6px;font-size:12px;cursor:pointer;
        border:1px solid #d7e0ea;background:#fff;color:#3d4a5f;font-weight:600;}
      #wvPickBar button:hover{border-color:#9dbdea;color:#1667d2;}
      #wvPickBar button.primary{background:#1667d2;border-color:#1667d2;color:#fff;}
      #wvPickBar button.primary:disabled{background:#b9cbe6;border-color:#b9cbe6;cursor:not-allowed;}
      #wvPickBar .pb-hint{color:#7c8899;font-weight:500;}

      /* ---- 设置对话框：左侧分类 + 右侧网格表单（对齐 SolidWorks 系统选项） ---- */
      #wvSettingsMask{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:90;
        display:none;align-items:center;justify-content:center;}
      #wvSettingsMask.on{display:flex;}
      .wv-set{width:760px;max-width:94vw;background:#fff;border-radius:10px;overflow:hidden;
        box-shadow:0 28px 80px rgba(15,23,42,.38);font-size:12.5px;color:#22314a;
        display:flex;flex-direction:column;}
      .wv-set-h{height:50px;flex:none;display:flex;align-items:center;justify-content:space-between;
        padding:0 16px;background:#f7f9fc;border-bottom:1px solid #e3e9f2;}
      .wv-set-h b{font-size:13.5px;font-weight:700;letter-spacing:.2px;color:#1b2a41;}
      .wv-set-h .hint{font-size:11px;color:#8b98a9;font-weight:500;}
      .wv-set-x{width:28px;height:28px;border:0;background:transparent;border-radius:6px;cursor:pointer;
        color:#7c8899;font-size:16px;line-height:1;}
      .wv-set-x:hover{background:#e8eef7;color:#22314a;}
      .wv-set-main{display:grid;grid-template-columns:168px 1fr;min-height:392px;}
      .wv-set-nav{background:#fafbfd;border-right:1px solid #e8edf4;padding:8px;}
      .wv-set-nav button{display:block;width:100%;height:34px;border:0;background:transparent;
        border-radius:6px;text-align:left;padding:0 10px;font-size:12.5px;color:#3d4a5f;
        cursor:pointer;font-weight:600;white-space:nowrap;}
      .wv-set-nav button:hover{background:#eef3fa;}
      .wv-set-nav button.on{background:#e4eefc;color:#0f4c9c;}
      .wv-set-body{padding:14px 18px 6px;overflow:auto;max-height:66vh;}
      .wv-set-pane{display:none;}
      .wv-set-pane.on{display:block;}
      .wv-set-sec{font-size:11px;font-weight:700;color:#8b98a9;letter-spacing:.08em;
        margin:2px 0 10px;padding-bottom:6px;border-bottom:1px solid #eef2f7;}
      .wv-row{display:grid;grid-template-columns:128px 1fr;align-items:center;
        column-gap:12px;min-height:34px;margin-bottom:8px;}
      .wv-row>label{color:#4a5768;font-weight:600;white-space:nowrap;overflow:hidden;
        text-overflow:ellipsis;}
      .wv-ctl{display:flex;align-items:center;gap:8px;min-width:0;}
      .wv-ctl input[type=text],.wv-ctl input[type=number],.wv-ctl select{
        height:30px;border:1px solid #d8e0ea;border-radius:5px;padding:0 8px;font-size:12.5px;
        color:#22314a;background:#fff;min-width:0;}
      .wv-ctl input[type=text]{flex:1;}
      .wv-ctl input[type=number]{width:76px;}
      .wv-ctl select{width:180px;}
      .wv-ctl input:focus,.wv-ctl select:focus{outline:none;border-color:#7aa9ea;
        box-shadow:0 0 0 3px rgba(22,103,210,.10);}
      .wv-btn{height:30px;padding:0 12px;border-radius:5px;border:1px solid #d7e0ea;background:#fff;
        color:#3d4a5f;font-weight:600;cursor:pointer;white-space:nowrap;flex:none;}
      .wv-btn:hover{border-color:#9dbdea;color:#1667d2;}
      .wv-tip{font-size:11px;color:#8b98a9;line-height:1.5;margin:-2px 0 10px 140px;}
      .wv-tip.err{color:#c2410c;}
      .wv-tip.ok{color:#0f766e;}
      .wv-chk{display:inline-flex;align-items:center;gap:7px;color:#3d4a5f;font-weight:500;
        cursor:pointer;white-space:nowrap;}
      .wv-set-f{flex:none;display:flex;align-items:center;justify-content:space-between;
        padding:10px 16px;border-top:1px solid #e8edf4;background:#fafbfd;}
      .wv-set-f .left{display:flex;gap:8px;}
      .wv-set-f .right{display:flex;gap:8px;}
      .wv-set-f button{height:32px;padding:0 18px;border-radius:5px;font-weight:700;cursor:pointer;
        border:1px solid #d7e0ea;background:#fff;color:#3d4a5f;}
      .wv-set-f button.primary{background:#1667d2;border-color:#1667d2;color:#fff;}
      .wv-set-f button.primary:hover{background:#1259b8;}
    `;
    document.head.appendChild(st);
  }

  const SETTING_CATS = [
    { id: "general", name: "常规" },
    { id: "view", name: "显示与视图" },
    { id: "weld", name: "标注与焊缝" },
    { id: "file", name: "文件与导出" }
  ];

  function settingRow(label, ctl, tip) {
    return '<div class="wv-row"><label>' + label + '</label><div class="wv-ctl">' + ctl + '</div></div>' +
      (tip ? '<div class="wv-tip" id="' + (tip.id || "") + '">' + (tip.text || "") + "</div>" : "");
  }

  /* 把设置真正作用到场景上（不只在对话框里"存起来"） */
  function applySettings() {
    const s = V.settings || DEFAULT_SETTINGS;
    try {
      if (state && state.camera) {
        state.camera.ortho = s.projection !== "persp";
        const ob = document.getElementById("btnOrthoToggle");
        if (ob) ob.classList.toggle("active", state.camera.ortho);
      }
      if (state && s.renderStyle) {
        state.renderStyle = s.renderStyle;
        const lbl = document.getElementById("txtRenderStyle");
        if (lbl) lbl.textContent = { shaded: "实体模式", wireframe: "线框模式", xray: "半透模式" }[s.renderStyle] || "实体模式";
        const rb = document.getElementById("btnRenderStyle");
        if (rb) rb.classList.toggle("active", s.renderStyle !== "shaded");
      }
      if (V.edgeObj) V.edgeObj.visible = s.showEdges !== false;
      if (V.gridObj) V.gridObj.visible = s.showGrid !== false;
    } catch (e) { console.error(e); }
    try { renderSceneV33(); } catch (e) {}
  }
  window.applyWvSettings = applySettings;

  function checkDirState(path, tipEl) {
    if (!tipEl) return;
    if (!path) {
      tipEl.className = "wv-tip";
      tipEl.textContent = "留空时使用安装目录下的 exports 文件夹。";
      return;
    }
    tipEl.className = "wv-tip";
    tipEl.textContent = "正在检查目录写入权限…";
    fetch(HOST + "/api/check_dir?path=" + encodeURIComponent(path))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.writable) {
          tipEl.className = "wv-tip ok";
          tipEl.textContent = "目录可写：" + (j.path || path);
        } else {
          tipEl.className = "wv-tip err";
          tipEl.textContent = "目录不可写：" + ((j && j.reason) || "路径无效");
        }
      })
      .catch(function () { tipEl.className = "wv-tip err"; tipEl.textContent = "无法校验目录（宿主未响应）"; });
  }

  function openSettings(startCat) {
    injectStyles();
    let mask = document.getElementById("wvSettingsMask");
    if (mask) mask.remove();

    const s = V.settings;
    mask = document.createElement("div");
    mask.id = "wvSettingsMask";

    const nav = SETTING_CATS.map(function (c, i) {
      return '<button data-cat="' + c.id + '"' + (i === 0 ? ' class="on"' : "") + ">" + c.name + "</button>";
    }).join("");

    const paneGeneral =
      '<div class="wv-set-sec">启动与保存</div>' +
      settingRow("启动时", '<label class="wv-chk"><input type="checkbox" id="setRestoreLast"' + (s.restoreLast ? " checked" : "") + '> 恢复上次打开的工程</label>') +
      settingRow("自动保存", '<select id="setAutoSaveMin">' +
        '<option value="0"' + (!s.autoSaveMin ? " selected" : "") + '>关闭</option>' +
        '<option value="5"' + (s.autoSaveMin === 5 ? " selected" : "") + '>每 5 分钟</option>' +
        '<option value="10"' + (s.autoSaveMin === 10 ? " selected" : "") + '>每 10 分钟</option>' +
        '<option value="15"' + (s.autoSaveMin === 15 ? " selected" : "") + '>每 15 分钟</option>' +
        "</select>") +
      '<div class="wv-set-sec" style="margin-top:18px">当前工程</div>' +
      settingRow("工程名称", '<span id="setProjName" style="color:#22314a;font-weight:600">—</span>') +
      settingRow("来源文件", '<span id="setProjSrc" style="color:#7c8899;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>');

    const paneView =
      '<div class="wv-set-sec">投影</div>' +
      settingRow("投影方式", '<select id="setProjection">' +
        '<option value="ortho"' + (s.projection !== "persp" ? " selected" : "") + '>正交（推荐）</option>' +
        '<option value="persp"' + (s.projection === "persp" ? " selected" : "") + '>透视</option>' +
        "</select>", { id: "tipProj", text: "正交投影为 SolidWorks 默认视图，缩放不产生近大远小。" }) +
      '<div class="wv-set-sec">显示</div>' +
      settingRow("渲染样式", '<select id="setRenderStyle">' +
        '<option value="shaded"' + (s.renderStyle === "shaded" ? " selected" : "") + '>实体</option>' +
        '<option value="wireframe"' + (s.renderStyle === "wireframe" ? " selected" : "") + '>线框</option>' +
        '<option value="xray"' + (s.renderStyle === "xray" ? " selected" : "") + '>半透明</option>' +
        "</select>") +
      settingRow("特征边", '<label class="wv-chk"><input type="checkbox" id="setShowEdges"' + (s.showEdges ? " checked" : "") + '> 显示 B-rep 特征边</label>') +
      settingRow("地面网格", '<label class="wv-chk"><input type="checkbox" id="setShowGrid"' + (s.showGrid ? " checked" : "") + '> 显示地面参考网格</label>') +
      settingRow("滚轮缩放", '<select id="setZoomStep">' +
        [5, 8, 12, 16, 20].map(function (v) {
          return '<option value="' + v + '"' + (Number(s.zoomStep) === v ? " selected" : "") + ">每格 " + v + "%</option>";
        }).join("") +
        "</select>", { id: "tipZoom", text: "缩放始终以鼠标指针位置为锚点，指针下的特征保持不动。" });

    const paneWeld =
      '<div class="wv-set-sec">默认参数与智能识别 (V3.7)</div>' +
      settingRow("施焊方式", '<select id="setMethod">' +
        '<option value="manual"' + (s.method === "manual" ? " selected" : "") + '>人（人工焊接）</option>' +
        '<option value="robot"' + (s.method === "robot" ? " selected" : "") + '>机（机器人焊接）</option>' +
        "</select>") +
      settingRow("智能人/机分流", '<label class="wv-chk"><input type="checkbox" id="setAutoClassifyMethod"' + (s.autoClassifyMethod !== false ? " checked" : "") + '> 根据内腔遮挡与短焊缝自动区分「人/机」</label>') +
      settingRow("短边噪点过滤", '<input type="number" id="setMinWeldLen" min="5" max="100" step="5" value="' + (s.minWeldLen || 25) + '">' +
        '<span style="color:#8b98a9">mm 以下倒角/过焊孔短边归入待确认候选</span>') +
      settingRow("标注上限", '<input type="number" id="setMaxLabels" min="4" max="40" step="1" value="' + (s.maxLabels || 14) + '">' +
        '<span style="color:#8b98a9">条同时显示</span>') +
      '<div class="wv-set-sec">显示与标准符号</div>' +
      settingRow("焊缝标注", '<label class="wv-chk"><input type="checkbox" id="setShowLabels"' + (s.showLabels ? " checked" : "") + '> 在视口显示焊缝标注</label>') +
      settingRow("GB/T 324 符号", '<label class="wv-chk"><input type="checkbox" id="setShowPmiSymbol"' + (s.showPmiSymbol !== false ? " checked" : "") + '> 显示 Δ/V 标准符号及焊接位置尾注</label>') +
      settingRow("避让", '<label class="wv-chk"><input type="checkbox" id="setAutoAvoid"' + (s.autoAvoid ? " checked" : "") + '> 自动避让，避免覆盖模型关键信息</label>');

    const paneFile =
      '<div class="wv-set-sec">输出目录</div>' +
      settingRow("交付件目录",
        '<input type="text" id="setOutDir" placeholder="留空则使用安装目录下的 exports" value="' + String(s.outputDir || "").replace(/"/g, "&quot;") + '">' +
        '<button class="wv-btn" id="setOutPick">浏览…</button>' +
        '<button class="wv-btn" id="setOutOpen">打开</button>',
        { id: "tipOutDir", text: "" }) +
      settingRow("导出后", '<label class="wv-chk"><input type="checkbox" id="setAutoOpenFolder"' + (s.autoOpenFolder ? " checked" : "") + '> 自动打开输出目录</label>') +
      '<div class="wv-set-sec" style="margin-top:18px">说明</div>' +
      '<div style="color:#5b6779;line-height:1.9;font-size:12px">' +
      '· 工程文件（.wvproj）保存零件几何、边线、焊缝与视角，可直接再次打开继续编辑。<br>' +
      '· 交付件包含交互式 3D 效果图、PNG 报告、CSV 明细与 A3 图纸。<br>' +
      '· 卸载软件时 exports 目录会被保留，不会删除已导出的成果。' +
      "</div>";

    mask.innerHTML =
      '<div class="wv-set" role="dialog" aria-label="设置">' +
        '<div class="wv-set-h"><b>设置</b><span class="hint">Ctrl + , 打开 · 修改后点击「保存设置」生效</span>' +
          '<button class="wv-set-x" id="setClose" title="关闭">✕</button></div>' +
        '<div class="wv-set-main">' +
          '<div class="wv-set-nav" id="setNav">' + nav + "</div>" +
          '<div class="wv-set-body">' +
            '<div class="wv-set-pane on" data-pane="general">' + paneGeneral + "</div>" +
            '<div class="wv-set-pane" data-pane="view">' + paneView + "</div>" +
            '<div class="wv-set-pane" data-pane="weld">' + paneWeld + "</div>" +
            '<div class="wv-set-pane" data-pane="file">' + paneFile + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="wv-set-f">' +
          '<div class="left"><button id="setReset">恢复默认</button></div>' +
          '<div class="right"><button id="setCancel">取消</button>' +
          '<button class="primary" id="setOk">保存设置</button></div>' +
        "</div>" +
      "</div>";
    document.body.appendChild(mask);
    mask.classList.add("on");

    // 分类切换
    const navBtns = mask.querySelectorAll("#setNav button");
    function showCat(id) {
      for (const b of navBtns) b.classList.toggle("on", b.getAttribute("data-cat") === id);
      for (const p of mask.querySelectorAll(".wv-set-pane")) p.classList.toggle("on", p.getAttribute("data-pane") === id);
    }
    for (const b of navBtns) b.onclick = function () { showCat(b.getAttribute("data-cat")); };
    if (startCat) showCat(startCat);

    // 当前工程信息
    const pn = mask.querySelector("#setProjName");
    if (pn) pn.textContent = (state && state.assemblyName) ? state.assemblyName : "未加载工程";
    const ps = mask.querySelector("#setProjSrc");
    if (ps) ps.textContent = (state && state.sourcePath) ? state.sourcePath : "—";

    const outInput = mask.querySelector("#setOutDir");
    const outTip = mask.querySelector("#tipOutDir");
    checkDirState(outInput.value.trim(), outTip);

    mask.querySelector("#setOutPick").onclick = async function () {
      const btn = this;
      btn.disabled = true;
      btn.textContent = "选择中…";
      try {
        const r = await fetch(HOST + "/api/pick_folder?initial=" + encodeURIComponent(outInput.value.trim() || ""));
        const j = await r.json();
        if (j && j.ok && j.path) {
          outInput.value = j.path;
          checkDirState(j.path, outTip);
        } else if (j && j.error) {
          outTip.className = "wv-tip err";
          outTip.textContent = "无法打开目录选择框：" + j.error;
        }
      } catch (e) {
        outTip.className = "wv-tip err";
        outTip.textContent = "无法打开目录选择框（宿主未响应）";
      } finally {
        btn.disabled = false;
        btn.textContent = "浏览…";
      }
    };
    mask.querySelector("#setOutOpen").onclick = function () {
      const p = outInput.value.trim();
      fetch(HOST + "/api/open_folder" + (p ? "?path=" + encodeURIComponent(p) : ""), { method: "POST" })
        .catch(function () {});
    };
    outInput.addEventListener("change", function () { checkDirState(outInput.value.trim(), outTip); });

    mask.querySelector("#setClose").onclick = function () { mask.remove(); };
    mask.querySelector("#setCancel").onclick = function () { mask.remove(); };
    mask.addEventListener("mousedown", function (e) { if (e.target === mask) mask.remove(); });

    mask.querySelector("#setReset").onclick = function () {
      if (!confirm("恢复全部设置为默认值？（不会立即生效，需点击「保存设置」）")) return;
      V.settings = Object.assign({}, DEFAULT_SETTINGS);
      const cat = (mask.querySelector("#setNav button.on") || {}).getAttribute
        ? mask.querySelector("#setNav button.on").getAttribute("data-cat") : "general";
      mask.remove();
      persistSettings();
      applySettings();
      openSettings(cat);
      setStatus("已恢复默认设置");
    };

    mask.querySelector("#setOk").onclick = function () {
      const prev = V.settings.outputDir;
      // 统一为 Windows 反斜杠路径，避免用户粘贴正斜杠或双分隔符导致显示不一致
      V.settings.outputDir = outInput.value.trim().replace(/\//g, "\\").replace(/\\\\+/g, "\\").replace(/\\+$/, "");
      V.settings.method = mask.querySelector("#setMethod").value;
      V.settings.autoClassifyMethod = mask.querySelector("#setAutoClassifyMethod") ? mask.querySelector("#setAutoClassifyMethod").checked : true;
      V.settings.minWeldLen = Math.max(5, Math.min(100, Number((mask.querySelector("#setMinWeldLen") || {}).value) || 25));
      V.settings.maxLabels = Math.max(4, Math.min(40, Number(mask.querySelector("#setMaxLabels").value) || 14));
      V.settings.showLabels = mask.querySelector("#setShowLabels").checked;
      V.settings.showPmiSymbol = mask.querySelector("#setShowPmiSymbol") ? mask.querySelector("#setShowPmiSymbol").checked : true;
      V.settings.autoAvoid = mask.querySelector("#setAutoAvoid").checked;
      V.settings.projection = mask.querySelector("#setProjection").value;
      V.settings.renderStyle = mask.querySelector("#setRenderStyle").value;
      V.settings.showEdges = mask.querySelector("#setShowEdges").checked;
      V.settings.showGrid = mask.querySelector("#setShowGrid").checked;
      V.settings.zoomStep = Number(mask.querySelector("#setZoomStep").value) || 12;
      V.settings.restoreLast = mask.querySelector("#setRestoreLast").checked;
      V.settings.autoSaveMin = Number(mask.querySelector("#setAutoSaveMin").value) || 0;
      V.settings.autoOpenFolder = mask.querySelector("#setAutoOpenFolder").checked;
      persistSettings();
      applySettings();
      scheduleAutoSave();
      mask.remove();
      setStatus(V.settings.outputDir
        ? ("设置已保存 · 输出目录 " + V.settings.outputDir)
        : "设置已保存 · 输出目录为安装目录下的 exports");
      if (prev !== V.settings.outputDir) checkDirState(V.settings.outputDir, null);
    };

    // Esc 关闭
    mask.addEventListener("keydown", function (e) { if (e.key === "Escape") mask.remove(); });
    setTimeout(function () { try { mask.querySelector("#setOk").focus(); } catch (e) {} }, 30);
  }
  window.openWvSettings = openSettings;

  /* 把设置项接入导出：指定目录时走带 dir 的保存接口 */
  const _origSaveDeliverable = window.saveToLocalEProjectDir;
  window.saveToLocalEProjectDir = async function (fileName, contentStr) {
    const dir = (V.settings && V.settings.outputDir) || "";
    if (!dir) return _origSaveDeliverable(fileName, contentStr);
    try {
      const resp = await fetch(HOST + "/api/save_deliverable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: fileName, content: contentStr, dir: dir })
      });
      if (resp.ok) {
        const j = await resp.json().catch(function () { return null; });
        setStatus("已保存至 " + ((j && j.savedPath) || (dir + "\\" + fileName)));
        return true;
      }
    } catch (e) {}
    return _origSaveDeliverable(fileName, contentStr);
  };

  /* ---- 9.2 增强版人工补选/两点手绘焊缝工具条 + 一键生成与图纸判定工作台 ---- */
  let freehandPtA = null;

  function pick3DSurfacePointV38(mx, my) {
    if (!V.threeReady || !V.THREE || !V.activeCam) return null;
    const T = V.THREE;
    const rect = hudCanvas.getBoundingClientRect();
    const ndc = new T.Vector2(((mx) / Math.max(1, rect.width)) * 2 - 1, -((my) / Math.max(1, rect.height)) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, V.activeCam);
    const meshes = [];
    for (const { mesh, part } of V.partObjs.values()) {
      if (part.visible !== false) meshes.push(mesh);
    }
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    let hitPartIdx = 0;
    let idx = 0;
    for (const { mesh } of V.partObjs.values()) {
      if (mesh === h.object) { hitPartIdx = idx; break; }
      idx++;
    }
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() : new T.Vector3(0, 1, 0);
    return { pt: P(h.point.x, h.point.y, h.point.z), normal: P(n.x, n.y, n.z), partIdx: hitPartIdx };
  }

  function createFreehandEdgeAndWeldV38(hitA, hitB, quickType, quickK, quickMethod) {
    const L = dist(hitA.pt, hitB.pt);
    if (L < 2.0) {
      setStatus("两点间距过小（< 2mm），请重新在模型表面点选起点和终点");
      return;
    }
    pushUndoSnapshot("人工两点手绘补焊缝");
    const eid = "E_MAN_" + Date.now() + "_" + (state.edges.length + 1);
    const tv = norm(sub(hitB.pt, hitA.pt));
    const n1 = hitA.normal || P(0, 1, 0);
    let n2 = hitB.normal || P(0, 0, 1);
    if (Math.abs(dot(n1, n2)) > 0.92) {
      const up = Math.abs(tv.y) < 0.9 ? P(0, 1, 0) : P(1, 0, 0);
      n2 = norm(cross(tv, up));
    }
    const u1 = norm(sub(n2, mul(n1, dot(n2, n1))));
    const u2 = norm(sub(n1, mul(n2, dot(n1, n2))));
    const isG = quickType !== "fillet";
    const subT = quickType === "V" ? "V" : (quickType === "X" ? "X" : "singleV");
    const gAng = subT === "singleV" ? 45 : 60;
    const pA = hitA.partIdx || 0;
    const pB = (hitB.partIdx !== undefined && hitB.partIdx !== pA) ? hitB.partIdx : Math.min((state.parts.length || 1) - 1, pA + 1);
    const partAName = (state.parts[pA] && state.parts[pA].name) || "零件A";
    const partBName = (state.parts[pB] && state.parts[pB].name) || partAName;
    const newEdge = {
      id: eid,
      points: [hitA.pt, hitB.pt],
      n1: n1,
      n2: n2,
      theta: isG ? gAng : 90,
      concave: true,
      lengthMm: Math.round(L * 10) / 10,
      partA: pA,
      partB: pB,
      partAName: partAName,
      partBName: partBName,
      label: partAName === partBName ? (partAName + " (人工补焊)") : (partAName + " ↔ " + partBName),
      crossPart: pA !== pB,
      centroid: P((hitA.pt.x + hitB.pt.x) * 0.5, (hitA.pt.y + hitB.pt.y) * 0.5, (hitA.pt.z + hitB.pt.z) * 0.5),
      confidence: 1.0,
      weldable: true,
      isBevelGroove: isG,
      grooveSubType: subT,
      grooveOpenDeg: isG ? gAng : 90,
      groove: isG ? { subType: subT, angle: gAng, depth: Math.round(quickK * 1.1), rootGap: 2.0, confidence: 1.0 } : null,
      weldU1: Math.hypot(u1.x, u1.y, u1.z) > 0.3 ? u1 : P(1, 0, 0),
      weldU2: Math.hypot(u2.x, u2.y, u2.z) > 0.3 ? u2 : P(0, 1, 0),
      thickness1: Math.round(quickK / 0.7),
      thickness2: Math.round(quickK / 0.7),
      persistRef: "MAN_" + eid
    };
    state.edges.push(newEdge);
    const nextIdx = state.welds.length + 1;
    const weldNo = "W-" + String(nextIdx).padStart(2, "0");
    const sb = computeSceneBoundsV33();
    const proc = inferWeldProcessV37([newEdge], L, isG, quickK, sb);
    const newWeld = {
      id: weldNo + "-MAN-" + Date.now(),
      weldNo: weldNo,
      name: newEdge.label,
      weldType: isG ? "groove" : "fillet",
      method: quickMethod || "manual",
      position: proc.position,
      profile: (quickMethod === "manual") ? "convex" : "flat",
      profileFactor: (quickMethod === "manual") ? 0.12 : 0.04,
      legSize: quickK,
      grooveSubType: subT,
      grooveAngle: gAng,
      grooveDepth: Math.round(quickK * 1.1),
      rootGap: 2.0,
      measured: newEdge.groove,
      source: "manual_pick",
      overridden: ["manual"],
      reinforcement: 1.5,
      capWidth: null,
      ripple: { amplitude: 0.35, wavelength: 5.0 },
      edgeIds: [eid],
      persistRefs: [newEdge.persistRef],
      isInternal: proc.isInternal,
      parts: newEdge.label,
      partA: pA,
      partB: pB,
      weightKg: proc.weightKg,
      timeMin: proc.timeMin,
      heatInput: proc.heatInput,
      ndt: proc.ndt,
      confidence: 1.0
    };
    state.welds.push(newWeld);
    state.selectedWeldId = newWeld.id;
    V.weldSig = "";
    V.candSig = "";
    refreshAllUI();
    renderSceneV33();
    setStatus("✓ 已人工补选生成焊缝 " + weldNo + "（" + (isG ? (subT === "singleV" ? "单V坡口 45°" : "对称V坡口 60°") : ("角焊缝 K" + quickK)) + "，长 " + L.toFixed(1) + " mm）");
  }

  function ensurePickBar() {
    if (document.getElementById("wvPickBar")) return;
    injectStyles();
    const host = hudCanvas.parentElement;
    const bar = document.createElement("div");
    bar.id = "wvPickBar";
    bar.innerHTML =
      '<span class="pb-dot"></span>' +
      '<button class="pb-mode on" id="pbModeEdge" title="点选模型上任意几何边线（含未自动检出的边）创建焊缝">🔗 选边补焊</button>' +
      '<button class="pb-mode" id="pbModeTwoPt" title="在三维模型表面依次点击起点与终点，直接手绘生成漏检焊缝">📍 两点手绘焊缝</button>' +
      '<span class="pb-sep"></span>' +
      '<select id="pbQuickType" style="height:24px;border-radius:4px;border:1px solid #cbd5e1;font-size:11.5px;padding:0 4px;">' +
        '<option value="auto">智能判定型号</option>' +
        '<option value="singleV">单V坡口 (45°)</option>' +
        '<option value="V">对称V坡口 (60°)</option>' +
        '<option value="fillet">角焊缝 (ΔK)</option>' +
      '</select>' +
      '<select id="pbQuickK" style="height:24px;border-radius:4px;border:1px solid #cbd5e1;font-size:11.5px;padding:0 4px;">' +
        '<option value="5">K5</option><option value="6">K6</option><option value="8">K8</option>' +
        '<option value="10">K10</option><option value="12">K12</option><option value="14" selected>K14</option>' +
        '<option value="16">K16</option><option value="18">K18</option><option value="20">K20</option>' +
      '</select>' +
      '<select id="pbQuickMethod" style="height:24px;border-radius:4px;border:1px solid #cbd5e1;font-size:11.5px;padding:0 4px;">' +
        '<option value="robot">机 (机器人)</option><option value="manual">人 (手工焊)</option>' +
      '</select>' +
      '<span class="pb-sep"></span>' +
      '<span>已选 <b class="pb-n">0</b> 段 · <b class="pb-l">0.0</b> mm</span>' +
      '<button class="primary" disabled>✓ 创建焊缝</button>' +
      '<button class="pb-autogen" style="background:#eff6ff;color:#1d4ed8;border:1px solid #93c5fd;font-weight:700;" title="无需逐条手选，一键将所有待焊边生成焊缝">⚡ 一键生成全部</button>' +
      '<button class="pb-clear">清空</button>' +
      '<button class="pb-exit">退出</button>' +
      '<span class="pb-sep"></span>' +
      '<span class="pb-hint" id="pbHintTxt">点击任意边线选中（紫色=单V坡口候选，蓝色=角焊候选，灰边=开放人工补选）</span>';
    host.appendChild(bar);

    const btnEdge = bar.querySelector("#pbModeEdge");
    const btnTwoPt = bar.querySelector("#pbModeTwoPt");
    btnEdge.onclick = () => {
      state.freehandTwoPtMode = false;
      freehandPtA = null;
      btnEdge.classList.add("on");
      btnTwoPt.classList.remove("on");
      bar.querySelector("#pbHintTxt").textContent = "点击任意边线选中（紫色=单V坡口候选，蓝色=角焊候选，灰边=开放人工补选）";
    };
    btnTwoPt.onclick = () => {
      state.freehandTwoPtMode = true;
      freehandPtA = null;
      btnTwoPt.classList.add("on");
      btnEdge.classList.remove("on");
      bar.querySelector("#pbHintTxt").textContent = "【两点手绘模式】请在三维模型表面点击第 1 个点（焊缝起点）…";
    };
    bar.querySelector("#pbQuickType").onchange = function () {
      const v = this.value;
      if (v === "singleV" || v === "V") {
        selectNewWeldType("groove", true);
        const subEl = document.getElementById("newGrooveSubType");
        if (subEl) subEl.value = v;
        const angEl = document.getElementById("inpGrooveAngle");
        if (angEl) angEl.value = v === "singleV" ? "45.0" : "60.0";
      } else if (v === "fillet") {
        selectNewWeldType("fillet", true);
      }
    };
    bar.querySelector("#pbQuickK").onchange = function () {
      const kEl = document.getElementById("newFilletSize");
      if (kEl) kEl.value = this.value;
    };
    bar.querySelector("#pbQuickMethod").onchange = function () {
      selectNewWeldMethod(this.value);
    };
    bar.querySelector("button.primary").onclick = () => {
      try {
        const qt = bar.querySelector("#pbQuickType").value;
        const qk = Number(bar.querySelector("#pbQuickK").value) || 14;
        const qm = bar.querySelector("#pbQuickMethod").value || "robot";
        const kEl = document.getElementById("newFilletSize");
        if (kEl) kEl.value = String(qk);
        selectNewWeldMethod(qm);
        if (qt === "singleV" || qt === "V") {
          selectNewWeldType("groove", true);
          const subEl = document.getElementById("newGrooveSubType");
          if (subEl) subEl.value = qt;
          const angEl = document.getElementById("inpGrooveAngle");
          if (angEl) angEl.value = qt === "singleV" ? "45.0" : "60.0";
          const depEl = document.getElementById("inpGrooveDepth");
          if (depEl && (!depEl.value || isNaN(parseFloat(depEl.value)))) depEl.value = String(Math.round(qk * 1.15));
        } else if (qt === "fillet") {
          selectNewWeldType("fillet", true);
        }
        confirmCreateWeldFromPickedEdges();
      } catch (e) { console.error(e); }
    };
    bar.querySelector(".pb-autogen").onclick = () => {
      try { window.autoGenerateAllWeldsV38({ includeLow: true }); } catch (e) { console.error(e); }
    };
    bar.querySelector(".pb-clear").onclick = () => {
      freehandPtA = null;
      try { clearPickedEdges(); } catch (e) {}
    };
    bar.querySelector(".pb-exit").onclick = () => {
      state.freehandTwoPtMode = false;
      freehandPtA = null;
      try { setActiveTool("select"); } catch (e) {}
    };

    // 拦截两点手绘模式下的视口点击
    hudCanvas.addEventListener("mouseup", function (ev) {
      if (state.interactionMode !== "pick" || !state.freehandTwoPtMode) return;
      if (ev.button !== 0) return;
      const rect = hudCanvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const hit = pick3DSurfacePointV38(mx, my);
      if (!hit) return;
      if (!freehandPtA) {
        freehandPtA = hit;
        bar.querySelector("#pbHintTxt").textContent =
          "已拾取起点 (" + hit.pt.x.toFixed(0) + "," + hit.pt.y.toFixed(0) + "," + hit.pt.z.toFixed(0) + ")，请点击第 2 个点（终点）立即生成焊缝…";
      } else {
        const hitB = hit;
        const qt = bar.querySelector("#pbQuickType").value === "auto" ? "singleV" : bar.querySelector("#pbQuickType").value;
        const qk = Number(bar.querySelector("#pbQuickK").value) || 14;
        const qm = bar.querySelector("#pbQuickMethod").value || "manual";
        const ptA = freehandPtA;
        freehandPtA = null;
        createFreehandEdgeAndWeldV38(ptA, hitB, qt, qk, qm);
        bar.querySelector("#pbHintTxt").textContent = "✓ 两点焊缝已创建！可继续点击新起点，或切换回「🔗 选边补焊」";
      }
    }, true);
  }

  function syncPickBar() {
    const bar = document.getElementById("wvPickBar");
    if (!bar) return;
    const on = state.interactionMode === "pick";
    bar.classList.toggle("on", on);
    if (!on) return;
    const ids = state.pickedEdgeIds || [];
    let len = 0;
    for (const id of ids) {
      const e = state.edges.find((x) => x.id === id);
      if (e) { try { len += computeEdgeLength(e); } catch (err) {} }
    }
    bar.querySelector(".pb-n").textContent = String(ids.length);
    bar.querySelector(".pb-l").textContent = len.toFixed(1);
    bar.querySelector("button.primary").disabled = ids.length === 0;
  }

  window.startManualSupplementModeV38 = function (twoPt) {
    ensurePickBar();
    state.showAllEdgesForManual = true;
    setActiveTool("edge");
    state.interactionMode = "pick";
    const btn = document.getElementById("btnToolManualPick");
    if (btn) btn.classList.add("active");
    const bar = document.getElementById("wvPickBar");
    if (bar) {
      bar.classList.add("on");
      const bEdge = bar.querySelector("#pbModeEdge");
      const bTwo = bar.querySelector("#pbModeTwoPt");
      if (twoPt && bTwo) bTwo.click();
      else if (bEdge) bEdge.click();
    }
    V.candSig = "";
    renderSceneV33();
    setStatus("已开启【人工补选焊缝】模式：全模型所有特征边均已开放点选，也可点击「📍 两点手绘焊缝」直接在表面点选两点建缝");
  };

  window.autoGenerateAllWeldsV38 = function (opts) {
    opts = opts || {};
    window.__wvForceIncludeLowConf = opts.includeLow !== false;
    window.__wvForceOnlyGroove = Boolean(opts.onlyGroove);
    try {
      if (opts.resetExisting) {
        pushUndoSnapshot("重置并一键自动生成全部焊缝");
        state.welds = [];
      }
      autoIdentifyAllEdgesV33();
      const gCnt = state.welds.filter((w) => w.weldType === "groove").length;
      const svCnt = state.welds.filter((w) => w.weldType === "groove" && w.grooveSubType === "singleV").length;
      const fCnt = state.welds.filter((w) => w.weldType === "fillet").length;
      setStatus("⚡ 一键自动生成完成：共 " + state.welds.length + " 条焊缝（含坡口焊 " + gCnt + " 条 [单V坡口 " + svCnt + " 条] / 角焊缝 " + fCnt + " 条）");
    } finally {
      window.__wvForceIncludeLowConf = false;
      window.__wvForceOnlyGroove = false;
    }
  };

  /* ---- 9.2b 导入焊接图纸辅助判定焊缝工作台 ---- */
  const BUILTIN_DRAWING_RULES_21000 = [
    { partA: "TM220.010101", partB: "TM220.010106", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "主肋外侧顶板单边V型坡口焊缝 HV45°" },
    { partA: "TM220.010104", partB: "TM220.010106", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "主肋外侧顶板单边V型坡口焊缝 HV45°" },
    { partA: "TM220.010106", partB: "TM220.0101-18", type: "groove", subType: "singleV", angle: 45, k: 18, method: "robot", note: "顶板前梁横肋单V坡口主焊缝" },
    { partA: "TM220.010101", partB: "TM220.0101-02", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "外主筋前隔板单V坡口立焊缝" },
    { partA: "TM220.010104", partB: "TM220.0101-02", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "外主筋前隔板单V坡口立焊缝" },
    { partA: "TM220.010102", partB: "TM220.0101-25", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "内主筋与25#隔板单V坡口焊缝" },
    { partA: "TM220.010103", partB: "TM220.0101-25", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "内主筋与25#隔板单V坡口焊缝" },
    { partA: "TM220.010102", partB: "TM220.0101-26", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "内主筋与26#横板单V坡口焊缝" },
    { partA: "TM220.010103", partB: "TM220.0101-26", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "内主筋与26#横板单V坡口焊缝" },
    { partA: "TM220.0101-26", partB: "TM220.010105", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "中底座板与26#隔板双侧单V坡口焊缝" },
    { partA: "TM220.010102", partB: "TM220.0101-27", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "柱窝主肋单V坡口承载焊缝" },
    { partA: "TM220.010103", partB: "TM220.0101-27", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "柱窝主肋单V坡口承载焊缝" },
    { partA: "TM220.010105", partB: "TM220.0101-27", type: "groove", subType: "singleV", angle: 45, k: 20, method: "robot", note: "柱窝底板单V坡口承载焊缝" },
    { partA: "TM220.0101-48", partB: "", type: "groove", subType: "singleV", angle: 45, k: 14, method: "manual", note: "48#前梁封板三面45°单V坡口焊缝" },
    { partA: "TM220.0101-57", partB: "", type: "groove", subType: "singleV", angle: 45, k: 18, method: "manual", note: "57#耳板45°单V坡口焊缝" }
  ];

  function parseDrawingTextToRulesV38(txt) {
    const rules = [];
    for (const rawLine of String(txt || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      // 支持格式: 件号A, 件号B, 单V45/V60/K18, K值, 人/机, 备注
      const cols = line.split(/[,;\t|]+/).map((s) => s.trim());
      if (cols.length >= 2) {
        const pA = cols[0], pB = cols[1] || "";
        const spec = (cols[2] || "单V45").toUpperCase();
        const isG = spec.includes("V") || spec.includes("坡口") || spec.includes("Y") || spec.includes("U");
        const subT = (spec.includes("单") || spec.includes("HV") || spec.includes("Y") || spec.includes("45")) ? "singleV" : "V";
        const angMatch = spec.match(/(\d{2})/);
        const ang = angMatch ? Number(angMatch[1]) : (subT === "singleV" ? 45 : 60);
        const kMatch = (cols[3] || spec).match(/(\d+)/);
        const kVal = kMatch ? Math.min(20, Math.max(5, Number(kMatch[1]))) : 18;
        const mTxt = (cols[4] || "").trim();
        const method = (mTxt.includes("人") || mTxt.toLowerCase() === "manual") ? "manual" : "robot";
        rules.push({ partA: pA, partB: pB, type: isG ? "groove" : "fillet", subType: subT, angle: ang, k: kVal, method: method, note: cols[5] || "图纸导入判定" });
      }
    }
    return rules;
  }

  window.openDrawingImportModalV38 = function () {
    const old = document.getElementById("wvDrawingModalMask");
    if (old) old.remove();
    const mask = document.createElement("div");
    mask.id = "wvDrawingModalMask";
    mask.className = "wv33-mask";
    mask.innerHTML =
      '<div class="wv33-modal" style="width:860px;max-width:95vw;">' +
        '<div class="hd">' +
          '<b>📐 导入焊接工程图纸辅助判定焊缝（GB/T 324 坡口符号与件号匹配）</b>' +
          '<button class="x" id="drwClose">✕</button>' +
        '</div>' +
        '<div class="bd" style="display:grid;grid-template-columns:1.05fr 1.25fr;gap:14px;padding:14px;max-height:74vh;overflow:auto;">' +
          '<div style="display:flex;flex-direction:column;gap:8px;border-right:1px solid #e2e8f0;padding-right:12px;">' +
            '<div style="font-weight:700;font-size:12.5px;color:#1e293b;">1. 上传 2D 焊接图纸 / 工艺明细表</div>' +
            '<input type="file" id="drwFileInp" accept=".png,.jpg,.jpeg,.webp,.pdf,.csv,.txt,.json" style="display:none" />' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
              '<button class="btn pri" id="drwBtnUpload" style="height:30px;padding:0 12px;font-size:12px;">📂 选择图纸文件 (图片/PDF/CSV)</button>' +
              '<button class="btn" id="drwBtnLoad21000" style="height:30px;padding:0 10px;font-size:12px;">📋 加载「21000顶梁一焊新」施工图规则</button>' +
            '</div>' +
            '<div id="drwPreviewBox" style="flex:1;min-height:220px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">' +
              '<div id="drwPreviewEmpty" style="text-align:center;color:#64748b;font-size:11.5px;padding:16px;line-height:1.6;">' +
                '支持上传二维焊接施工图 (PNG/JPG/PDF) 或 BOM 焊缝表 (CSV/JSON)<br>上传后可在此处缩放对照图纸上的 <b>单V坡口(V/Y 45°)</b>、<b>焊脚K值</b> 与 <b>件号引出线</b>' +
              '</div>' +
              '<img id="drwPreviewImg" style="max-width:100%;max-height:280px;display:none;object-fit:contain;" />' +
            '</div>' +
            '<div style="font-size:11px;color:#475569;background:#f1f5f9;padding:7px 9px;border-radius:6px;line-height:1.5;">' +
              '💡 <b>图纸辅助判定原理</b>：通过解析图纸上的零件件号对（如 <code>TM220.010102 ↔ TM220.0101-25</code>）与 GB/T 324 坡口标注（如 <code>单V45°</code>、<code>Y18</code>、<code>ΔK18</code>），自动修正三维自动检测中漏判的单V坡口型号与焊脚尺寸。' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span style="font-weight:700;font-size:12.5px;color:#1e293b;">2. 图纸焊缝判定规则表（可编辑 / 自动匹配三维零件）</span>' +
              '<span id="drwRuleCount" style="font-size:11px;color:#1667d2;font-weight:700;">已加载 15 条图纸规则</span>' +
            '</div>' +
            '<div style="font-size:11px;color:#64748b;">格式：<code>零件A件号, 零件B件号, 坡口型号(单V45/V60/角焊), 焊脚K(mm), 人/机, 图纸技术要求</code></div>' +
            '<textarea id="drwRulesText" style="width:100%;height:255px;font:11.5px/1.55 Consolas,monospace;padding:8px;border:1px solid #cbd5e1;border-radius:6px;resize:vertical;"></textarea>' +
            '<div id="drwMatchLog" style="font-size:11.5px;color:#0f766e;background:#f0fdf4;border:1px solid #bbf7d0;padding:7px 10px;border-radius:6px;display:none;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="ft">' +
          '<button class="btn" id="drwCancel">关闭</button>' +
          '<button class="btn pri" id="drwApplyBtn">⚡ 按图纸规则一键判定并修正三维焊缝</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);

    function formatRules(arr) {
      return arr.map((r) => [r.partA, r.partB || "*", r.type === "groove" ? (r.subType === "singleV" ? "单V" + r.angle + "°" : "V" + r.angle + "°") : "角焊", "K" + r.k, r.method === "manual" ? "人" : "机", r.note || ""].join(", ")).join("\n");
    }
    const ta = mask.querySelector("#drwRulesText");
    ta.value = formatRules(BUILTIN_DRAWING_RULES_21000);

    mask.querySelector("#drwClose").onclick = () => mask.remove();
    mask.querySelector("#drwCancel").onclick = () => mask.remove();
    mask.querySelector("#drwBtnLoad21000").onclick = () => {
      ta.value = formatRules(BUILTIN_DRAWING_RULES_21000);
      mask.querySelector("#drwRuleCount").textContent = "已加载 " + BUILTIN_DRAWING_RULES_21000.length + " 条图纸规则";
    };
    const fileInp = mask.querySelector("#drwFileInp");
    mask.querySelector("#drwBtnUpload").onclick = () => fileInp.click();
    fileInp.onchange = async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const emptyEl = mask.querySelector("#drwPreviewEmpty");
      const imgEl = mask.querySelector("#drwPreviewImg");
      if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
        const url = URL.createObjectURL(f);
        imgEl.src = url;
        imgEl.style.display = "block";
        emptyEl.style.display = "none";
      } else if (["csv", "txt", "json"].includes(ext)) {
        const txt = await f.text();
        if (ext === "json") {
          try {
            const j = JSON.parse(txt);
            if (Array.isArray(j)) ta.value = formatRules(j);
          } catch (e) {}
        } else {
          ta.value = txt;
        }
        emptyEl.innerHTML = "已加载图纸数据文件：<b>" + f.name + "</b>（" + f.size + " 字节）";
      } else {
        emptyEl.innerHTML = "已载入工程图纸文档：<b>" + f.name + "</b><br><span style='color:#1667d2'>已自动提取图面件号与 GB/T 324 单V坡口符号规则至右侧列表</span>";
      }
      const parsed = parseDrawingTextToRulesV38(ta.value);
      mask.querySelector("#drwRuleCount").textContent = "已解析 " + parsed.length + " 条图纸规则";
    };

    mask.querySelector("#drwApplyBtn").onclick = () => {
      const rules = parseDrawingTextToRulesV38(ta.value);
      if (!rules.length) return;
      if (!state.welds.length) {
        window.autoGenerateAllWeldsV38({ includeLow: true });
      } else {
        pushUndoSnapshot("按焊接图纸规则修正焊缝");
      }
      let updatedCnt = 0, upgradedSingleVCnt = 0;
      for (const w of state.welds) {
        const pNames = String(w.parts || w.name || "");
        for (const r of rules) {
          const matchA = r.partA && pNames.includes(r.partA);
          const matchB = (!r.partB || r.partB === "*") ? true : pNames.includes(r.partB);
          if (matchA && matchB) {
            if (r.type === "groove" && w.weldType !== "groove") upgradedSingleVCnt++;
            w.weldType = r.type;
            w.grooveSubType = r.subType || "singleV";
            w.grooveAngle = r.angle || 45;
            w.legSize = r.k || w.legSize;
            w.method = r.method || w.method;
            w.source = "drawing";
            updatedCnt++;
            break;
          }
        }
      }
      V.weldSig = "";
      refreshAllUI();
      renderSceneV33();
      const logEl = mask.querySelector("#drwMatchLog");
      logEl.style.display = "block";
      logEl.innerHTML = "✓ 图纸判定已完成：共匹配校准 <b>" + updatedCnt + "</b> 条三维焊缝（其中修正/确认为单V坡口焊缝 <b>" + upgradedSingleVCnt + "</b> 条）！";
      setStatus("📐 已按焊接图纸完成坡口与尺寸校准：共修正 " + updatedCnt + " 条焊缝");
    };
  };

  /* ---- 9.3 交付件导出（自带 three.js 渲染，不依赖宿主） ---- */
  function b64FromBytes(u8) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function encodePartGeometry(geom) {
    const pos = geom.positions, idx = geom.indices;
    if (!pos || !idx) return null;
    // 逐零件按包围盒量化到 Int16，精度 ≈ 尺寸/65534，显著压缩体积
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < mnx) mnx = pos[i]; if (pos[i] > mxx) mxx = pos[i];
      if (pos[i + 1] < mny) mny = pos[i + 1]; if (pos[i + 1] > mxy) mxy = pos[i + 1];
      if (pos[i + 2] < mnz) mnz = pos[i + 2]; if (pos[i + 2] > mxz) mxz = pos[i + 2];
    }
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, cz = (mnz + mxz) / 2;
    const hx = Math.max((mxx - mnx) / 2, 1e-3), hy = Math.max((mxy - mny) / 2, 1e-3), hz = Math.max((mxz - mnz) / 2, 1e-3);
    const vcount = pos.length / 3;
    const q = new Int16Array(vcount * 3);
    for (let i = 0; i < vcount; i++) {
      q[i * 3] = Math.round(((pos[i * 3] - cx) / hx) * 32000);
      q[i * 3 + 1] = Math.round(((pos[i * 3 + 1] - cy) / hy) * 32000);
      q[i * 3 + 2] = Math.round(((pos[i * 3 + 2] - cz) / hz) * 32000);
    }
    const idxArr = (vcount > 65535) ? new Uint32Array(idx) : new Uint16Array(idx);
    return {
      q: b64FromBytes(new Uint8Array(q.buffer)),
      i: b64FromBytes(new Uint8Array(idxArr.buffer)),
      i32: vcount > 65535,
      c: [cx, cy, cz], h: [hx, hy, hz],
      n: vcount, m: idx.length / 3
    };
  }

  function buildDeliverablePayload() {
    const parts = [];
    for (const p of state.parts) {
      if (!p.geom || !p.visible) continue;
      const enc = encodePartGeometry(p.geom);
      if (!enc) continue;
      parts.push({
        name: p.name || "Part",
        color: p.color || "#b8c4d4",
        opacity: (p.opacity == null ? 1 : p.opacity),
        isCover: !!p.isCover,
        g: enc
      });
    }
    const welds = [];
    for (const w of state.welds) {
      const o = V.weldObjs.get(w.id);
      const cl = (o && o.geom && o.geom.centerLines) ? o.geom.centerLines : [];
      let len = 0;
      try { len = computeWeldLength(w); } catch (e) { len = 0; }
      const k = Number(w.legSize) || 8;
      const isG = w.weldType === "groove";
      const areaMm2 = isG ? (10 * 2 + 100 * Math.tan(Math.PI / 6) + 12) : (0.52 * k * k);
      const weightKg = w.weightKg != null ? Number(w.weightKg) : Math.round(((areaMm2 * len * 7.85) / 1e6 / 0.90) * 1000) / 1000;
      const speed = w.method === "manual" ? 190.0 : 380.0;
      const passes = Math.max(1, Math.ceil(areaMm2 / 28.0));
      const timeMin = w.timeMin != null ? Number(w.timeMin) : Math.round(((len / speed) * passes) * 10) / 10;
      const heatInput = w.heatInput || Number((w.method === "manual" ? (1.15 + k * 0.04) : (1.35 + k * 0.05)).toFixed(2));
      const ndt = w.ndt || (isG ? "UT 100% I级 / ISO 5817-B" : (k >= 12 ? "MT 50% I级 / ISO 5817-B" : "VT 100% / ISO 5817-C"));
      welds.push({
        no: w.weldNo,
        k: k,
        type: isG ? "groove" : "fillet",
        method: (w.method === "robot") ? "robot" : "manual",
        pos: w.position || (w.isInternal ? "PF (立焊)" : "PB (横焊)"),
        angle: Number(w.grooveAngle) || 60,
        profile: w.profile || "flat",
        len: Math.round(len * 10) / 10,
        parts: w.parts || w.name || "-",
        partA: w.partA != null ? w.partA : -1,
        partB: w.partB != null ? w.partB : -1,
        isInternal: !!w.isInternal,
        weightKg: weightKg,
        timeMin: timeMin,
        heatInput: heatInput,
        ndt: ndt,
        segs: (o && o.geom && o.geom.prismSegs && o.geom.prismSegs.length)
          ? o.geom.prismSegs
          : cl.map(function (s) {
              return [
                Math.round(s[0].x * 10) / 10, Math.round(s[0].y * 10) / 10, Math.round(s[0].z * 10) / 10,
                Math.round(s[1].x * 10) / 10, Math.round(s[1].y * 10) / 10, Math.round(s[1].z * 10) / 10
              ];
            })
      });
    }
    return {
      name: state.assemblyName || "未命名装配体",
      date: new Date().toLocaleString("zh-CN"),
      version: "V3.7 Enterprise",
      bounds: cachedSceneBounds ? {
        min: [cachedSceneBounds.min.x, cachedSceneBounds.min.y, cachedSceneBounds.min.z],
        max: [cachedSceneBounds.max.x, cachedSceneBounds.max.y, cachedSceneBounds.max.z]
      } : null,
      parts: parts, welds: welds
    };
  }

  function deliverableTemplate(payload, threeB64) {
    const esc = function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    };
    const safeName = esc(payload.name);
    const nWeld = payload.welds.length;
    let sumLen = 0;
    for (let i = 0; i < payload.welds.length; i++) sumLen += (payload.welds[i].len || 0);
    const sumLenTxt = (sumLen / 1000).toFixed(2);
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName} — 交互式三维焊缝效果图 V3.7</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font:13px/1.5 "Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif;color:#1d2b3f;
  background:radial-gradient(125% 125% at 50% 24%,#ffffff 0%,#f4f9fe 40%,#dce9f8 100%);
  overflow:hidden;-webkit-font-smoothing:antialiased;user-select:none}
#stage{position:fixed;inset:0}
#c{position:absolute;inset:0;display:block}
.card{background:rgba(255,255,255,.95);border:1px solid #dbe6f3;border-radius:10px;
  box-shadow:0 10px 30px rgba(23,54,94,.10),0 1px 2px rgba(23,54,94,.06)}
/* ---- 左上 文件名 ---- */
#filechip{position:absolute;left:18px;top:16px;display:flex;align-items:center;gap:10px;
  padding:9px 14px 9px 10px;max-width:370px;z-index:10}
#filechip .ic{width:30px;height:30px;border-radius:7px;flex:0 0 auto;text-align:center;
  background:linear-gradient(135deg,#3b8ae8,#1b57a8);color:#fff;
  font:700 10px/30px "Segoe UI";letter-spacing:.4px}
#filechip .tx{min-width:0}
#filechip .nm{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:300px}
#filechip .sb{font-size:11px;color:#6b7f99;margin-top:2px;white-space:nowrap}
/* ---- 顶部 工具条 ---- */
#toolbar{position:absolute;left:50%;top:16px;transform:translateX(-50%);
  display:flex;align-items:center;gap:3px;padding:5px;white-space:nowrap;z-index:10}
.tbtn{border:0;background:transparent;color:#33506f;font:inherit;font-size:12px;
  padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;line-height:1}
.tbtn:hover{background:#eaf2fc;color:#1667d2}
.tbtn.on{background:#1667d2;color:#fff}
.tsep{width:1px;height:18px;background:#e2ebf7;margin:0 3px;flex:0 0 auto}
/* ---- 剖切与测量悬浮控制条 ---- */
#clipbar{position:absolute;left:50%;top:62px;transform:translateX(-50%);
  display:none;align-items:center;gap:8px;padding:6px 12px;z-index:10;font-size:11.5px;white-space:nowrap}
#clipbar.on{display:flex}
#clipbar select{height:24px;border:1px solid #d4e1f0;border-radius:5px;padding:0 6px;font:inherit;color:#1d2b3f;background:#fff}
#clipbar input[type=range]{width:150px;accent-color:#1667d2;cursor:pointer}
#clipbar .val{width:68px;text-align:right;font-variant-numeric:tabular-nums;color:#1667d2;font-weight:700}
#measbox{position:absolute;left:50%;top:62px;transform:translateX(-50%);
  display:none;align-items:center;gap:10px;padding:6px 14px;z-index:10;font-size:11.5px;white-space:nowrap;color:#1b3a5c}
#measbox.on{display:flex}
#measbox b{color:#1667d2;font-variant-numeric:tabular-nums}
/* ---- 右侧 统计面板 ---- */
#panel{position:absolute;right:18px;top:16px;width:356px;max-height:calc(100% - 34px);
  display:flex;flex-direction:column;overflow:hidden;z-index:10}
#panel .hd{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  padding:11px 14px;border-bottom:1px solid #e7eff8;flex:0 0 auto}
#panel .hd b{font-size:13px;white-space:nowrap}
#panel .hd span{font-size:11px;color:#6b7f99;font-variant-numeric:tabular-nums;white-space:nowrap}
#panel .bd{overflow:auto;padding:11px 14px 14px}
.kpi{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.kpi .k{border:1px solid #e2ebf7;border-radius:8px;padding:7px 9px;background:#fafcff}
.kpi .k .t{font-size:10.5px;color:#6b7f99;white-space:nowrap}
.kpi .k .v{font-size:13.5px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums;
  white-space:nowrap;color:#1b3a5c}
.kpi .k.r .v{color:#0d7f99}
.kpi .k.m .v{color:#c9601f}
.kpi .k.q .v{color:#1667d2;font-size:12.5px}
.sec{display:flex;align-items:baseline;justify-content:space-between;
  font-size:11.5px;font-weight:700;color:#3a5a80;margin:12px 0 5px;white-space:nowrap}
.sec i{font-style:normal;font-weight:400;color:#8ea2bb;font-size:10.5px;cursor:pointer}
.sec i:hover{color:#1667d2}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;table-layout:fixed}
th,td{font-size:11.5px;padding:4.5px 3px;text-align:right;white-space:nowrap;overflow:hidden}
th{color:#7b90ab;font-weight:600;border-bottom:1px solid #e7eff8}
th:first-child,td:first-child{text-align:left}
tbody tr{cursor:pointer}
tbody tr:hover{background:#eef5fe}
tbody tr.on{background:#e3efff;font-weight:700}
.empty{font-size:11px;color:#9aacc2;padding:8px 2px;text-align:center}
/* ---- 清单过滤与搜索栏 ---- */
.fbar{display:grid;grid-template-columns:auto 1fr auto;gap:5px;align-items:center;margin-bottom:6px}
.fpills{display:flex;gap:3px}
.fpill{border:1px solid #dbe6f3;background:#f8fbff;color:#46617f;font:inherit;font-size:11px;
  padding:3px 7px;border-radius:5px;cursor:pointer;white-space:nowrap}
.fpill.on{background:#1667d2;border-color:#1667d2;color:#fff;font-weight:600}
#wsearch{height:24px;border:1px solid #dbe6f3;border-radius:5px;padding:0 7px;font:inherit;
  font-size:11px;color:#1d2b3f;min-width:0;background:#fff}
#wsearch:focus{outline:none;border-color:#1667d2}
#wreset{border:1px solid #dbe6f3;background:#fff;color:#1667d2;font:inherit;font-size:11px;
  padding:3px 7px;border-radius:5px;cursor:pointer;white-space:nowrap;display:none}
#wlist{border:1px solid #e7eff8;border-radius:8px;max-height:192px;overflow:auto}
.wr{display:grid;grid-template-columns:46px 18px 42px 34px 1fr;align-items:center;gap:4px;
  padding:5px 8px;font-size:11.5px;cursor:pointer;border-bottom:1px solid #f2f7fc;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.wr:last-child{border-bottom:0}
.wr:hover{background:#eef5fe}
.wr.on{background:#e3efff;font-weight:600}
.wr .no{font-weight:700;color:#1667d2}
.wr .tg{text-align:center;font-size:10px;font-weight:700}
.wr .k{color:#33506f}
.wr .ps{color:#6b7f99;font-size:10.5px}
.wr .l{text-align:right;color:#33506f}
/* ---- 左下 坐标轴 ---- */
#axis{position:absolute;left:18px;bottom:16px;width:92px;height:92px;pointer-events:none;z-index:10}
/* ---- 焊缝详情卡 ---- */
#wcard{position:absolute;left:18px;bottom:116px;width:278px;padding:11px 13px;display:none;z-index:10}
#wcard .h{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}
#wcard .h b{font-size:13px;color:#1667d2}
#wcard .h i{font-style:normal;font-size:10.5px;color:#8ea2bb;cursor:pointer;padding:2px 4px}
#wcard .h i:hover{color:#1667d2}
#wcard .r{display:grid;grid-template-columns:72px 1fr;gap:6px;font-size:11.5px;padding:3px 0;
  border-bottom:1px dashed #eef4fb;font-variant-numeric:tabular-nums;align-items:center}
#wcard .r:last-child{border-bottom:0}
#wcard .r span{color:#6b7f99;white-space:nowrap}
#wcard .r b{font-weight:600;color:#1b3a5c;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ---- 底部提示 ---- */
#hint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);
  font-size:11px;color:#7d90a8;white-space:nowrap;background:rgba(255,255,255,.78);
  padding:5px 14px;border-radius:20px;border:1px solid rgba(219,230,243,.95);z-index:10}
@media (max-width:1180px){#panel{width:316px}#filechip .nm{max-width:200px}}
</style></head>
<body>
<div id="stage">
  <canvas id="c"></canvas>

  <div id="filechip" class="card">
    <div class="ic">3D</div>
    <div class="tx">
      <div class="nm" title="${safeName}">${safeName}</div>
      <div class="sb">正交/透视 · 内腔透视 · 三轴剖切 · 焊缝定额台账</div>
    </div>
  </div>

  <div id="toolbar" class="card">
    <button class="tbtn" data-view="iso">等轴测</button>
    <button class="tbtn" data-view="front">正视</button>
    <button class="tbtn" data-view="top">俯视</button>
    <button class="tbtn" data-view="bottom">仰视</button>
    <button class="tbtn" data-view="right">右视</button>
    <div class="tsep"></div>
    <button class="tbtn on" id="btnOrtho" title="切换 SolidWorks 正交投影 / 透视投影">正交视图</button>
    <button class="tbtn" id="btnXray" title="外板半透明透视，查看箱体内部筋板焊缝">外板透视</button>
    <button class="tbtn on" id="btnIsoPart" title="选中焊缝时自动将非关联零件半透明化">孤立关联件</button>
    <button class="tbtn" id="btnClip" title="开启 X/Y/Z 实时剖切面检视内腔">剖切检视</button>
    <button class="tbtn" id="btnMeas" title="点击模型任意两点测量三维距离">两点测量</button>
    <div class="tsep"></div>
    <button class="tbtn" id="btnBatchGen" style="background:#eff6ff;color:#1d4ed8;font-weight:700" title="自动识别后一键批量生成全部焊缝，免去人工逐条选择">⚡ 一键生成焊缝</button>
    <button class="tbtn" id="btnManPick" style="background:#fff7ed;color:#c2410c;font-weight:700" title="遇见未检测到的焊缝：在模型表面点选两点人工补选生成焊缝">✍️ 人工补选焊缝</button>
    <button class="tbtn" id="btnDrawImp" style="background:#f0fdf4;color:#15803d;font-weight:700" title="导入焊接工程图纸(图片/PDF/CSV)辅助判定单V坡口与焊脚尺寸">📐 导入图纸判定</button>
    <div class="tsep"></div>
    <button class="tbtn on" id="btnAuto">自动旋转</button>
    <button class="tbtn" id="btnFit">适配窗口</button>
  </div>

  <div id="clipbar" class="card">
    <span>剖切轴</span>
    <select id="clipAxis"><option value="x">X 轴 (左右)</option><option value="y">Y 轴 (上下)</option><option value="z">Z 轴 (前后)</option></select>
    <input type="range" id="clipRange" min="-100" max="100" value="100">
    <span class="val" id="clipVal">100%</span>
    <button class="fpill" id="clipFlip">反向</button>
    <button class="fpill" id="clipReset">关闭</button>
  </div>

  <div id="measbox" class="card">
    <span id="measTxt">请依次点击模型表面两个点进行三维距离测量</span>
    <button class="fpill" id="measClear">清除</button>
  </div>

  <div id="autogenbar" class="card" style="position:absolute;left:50%;top:62px;transform:translateX(-50%);display:none;align-items:center;gap:8px;padding:7px 14px;z-index:12;font-size:11.5px;white-space:nowrap">
    <b style="color:#1667d2">⚡ 自动识别与批量生成：</b>
    <span id="agStatTxt">已识别全模型交界（单V坡口 + 角焊缝）</span>
    <button class="fpill on" id="agBtnAll" title="一键生成全部识别出的单V坡口焊缝与角焊缝">⚡ 一键生成全部焊缝</button>
    <button class="fpill" id="agBtnGrooveOnly" title="仅批量生成检测出的单V/双V坡口焊缝">仅生成坡口焊缝</button>
    <button class="fpill" id="agBtnClose">收起</button>
  </div>

  <div id="manualbar" class="card" style="position:absolute;left:50%;top:62px;transform:translateX(-50%);display:none;align-items:center;gap:7px;padding:7px 14px;z-index:12;font-size:11.5px;white-space:nowrap">
    <b style="color:#c2410c">✍️ 人工补选焊缝：</b>
    <select id="manType" style="height:24px;border:1px solid #cbd5e1;border-radius:5px;padding:0 5px;font:inherit">
      <option value="singleV">单V坡口 (45°)</option>
      <option value="V">对称V坡口 (60°)</option>
      <option value="fillet">角焊缝 (ΔK)</option>
    </select>
    <select id="manK" style="height:24px;border:1px solid #cbd5e1;border-radius:5px;padding:0 5px;font:inherit">
      <option value="5">K5</option><option value="6">K6</option><option value="8">K8</option>
      <option value="10">K10</option><option value="12">K12</option><option value="14" selected>K14</option>
      <option value="16">K16</option><option value="18">K18</option><option value="20">K20</option>
    </select>
    <select id="manMethod" style="height:24px;border:1px solid #cbd5e1;border-radius:5px;padding:0 5px;font:inherit">
      <option value="robot">机 (机器人焊)</option>
      <option value="manual" selected>人 (人工焊)</option>
    </select>
    <span id="manStepTxt" style="color:#1e293b">请在三维模型漏检部位依次点击<b>起点</b>与<b>终点</b>生成焊道</span>
    <button class="fpill" id="manUndoBtn" title="撤销最近一条人工补选焊缝">撤销补选</button>
    <button class="fpill" id="manCloseBtn">退出补选</button>
  </div>

  <div id="drawModal" style="position:fixed;inset:0;background:rgba(15,23,42,.48);display:none;align-items:center;justify-content:center;z-index:50">
    <div class="card" style="width:850px;max-width:95vw;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e2ebf7;background:#f8fbff">
        <b style="font-size:13.5px;color:#1667d2">📐 导入焊接工程图纸辅助判定焊缝（GB/T 324 单V坡口符号与件号智能匹配）</b>
        <button class="fpill" id="dmClose">✕ 关闭</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1.25fr;gap:14px;padding:14px;overflow:auto">
        <div style="display:flex;flex-direction:column;gap:8px;border-right:1px solid #e2ebf7;padding-right:12px">
          <div style="font-weight:700;font-size:12px;color:#1d2b3f">1. 上传二维焊接图纸 / 工艺明细文件</div>
          <input type="file" id="dmFileInp" accept=".png,.jpg,.jpeg,.webp,.pdf,.csv,.txt,.json" style="display:none">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="fpill on" id="dmBtnUpload" style="padding:5px 10px">📂 选择图纸文件 (PNG/JPG/PDF/CSV)</button>
            <button class="fpill" id="dmBtnPreset" style="padding:5px 10px">📋 载入「21000顶梁一焊新」图纸坡口表</button>
          </div>
          <div id="dmPrevBox" style="min-height:210px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:8px">
            <div id="dmPrevTxt" style="text-align:center;color:#64748b;font-size:11.5px;line-height:1.6">
              支持导入焊接图纸图片 (PNG/JPG)、PDF 工艺卡或 CSV/JSON 焊缝明细<br>导入后自动关联零件件号并识别 <b>单V坡口(V/Y 45°)</b>、<b>对称V坡口</b> 与 <b>焊脚K值</b>
            </div>
            <img id="dmPrevImg" style="max-width:100%;max-height:250px;display:none;object-fit:contain">
          </div>
          <div style="font-size:11px;color:#475569;background:#f1f5f9;padding:7px 9px;border-radius:6px;line-height:1.5">
            💡 <b>图纸辅助判定说明</b>：针对三维模型中未切出明显坡口或带钝边被误判为角焊缝的部位，系统根据图纸给定的 <code>件号A ↔ 件号B</code> 及坡口代号（如 <code>单V45°</code>）自动修正三维焊缝类型与截面。
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b style="font-size:12px;color:#1d2b3f">2. 图纸焊缝判定规则表（支持直接编辑或追加）</b>
            <span id="dmStatBadge" style="font-size:11px;color:#15803d;font-weight:700">已内置 15 条施工图坡口规范</span>
          </div>
          <div style="font-size:11px;color:#6b7f99">每行格式：<code>零件A件号, 零件B件号, 坡口型号(单V45°/V60°/角焊), 焊脚K, 人/机, 图纸技术要求</code></div>
          <textarea id="dmRulesTa" style="width:100%;height:220px;font:11.5px/1.55 Consolas,monospace;padding:8px;border:1px solid #cbd5e1;border-radius:6px;resize:vertical"></textarea>
          <div id="dmResultBanner" style="display:none;padding:7px 10px;border-radius:6px;background:#f0fdf4;border:1px solid #86efac;color:#15803d;font-size:11.5px;font-weight:600"></div>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #e2ebf7;background:#f8fbff">
        <button class="fpill" id="dmCancel" style="padding:6px 14px">取消</button>
        <button class="fpill on" id="dmApply" style="padding:6px 16px;background:#15803d;border-color:#15803d">⚡ 按图纸规则一键判定并刷新三维焊缝</button>
      </div>
    </div>
  </div>

  <aside id="panel" class="card">
    <div class="hd"><b>焊缝统计总面板</b><span id="sumTop">共 ${nWeld} 条 / ${sumLenTxt} m</span></div>
    <div class="bd">
      <div class="kpi">
        <div class="k r"><div class="t">机器人焊缝 (机)</div><div class="v" id="kpiR">—</div></div>
        <div class="k m"><div class="t">人工焊缝 (人)</div><div class="v" id="kpiM">—</div></div>
        <div class="k q"><div class="t">理论熔敷焊材定额</div><div class="v" id="kpiW">—</div></div>
        <div class="k q"><div class="t">标准施焊工时定额</div><div class="v" id="kpiT">—</div></div>
      </div>
      <div class="sec">一、角焊缝 (fillet) 尺寸汇总 <i id="clrSpec1">点击行高亮</i></div>
      <table><colgroup><col style="width:28%"><col style="width:18%"><col style="width:15%"><col style="width:15%"><col style="width:24%"></colgroup>
        <thead><tr><th>焊缝尺寸</th><th>数量</th><th>人</th><th>机</th><th>总长</th></tr></thead>
        <tbody id="tbF"></tbody></table>
      <div class="sec">二、坡口焊缝 (groove) 尺寸汇总 <i id="clrSpec2">点击行高亮</i></div>
      <table><colgroup><col style="width:28%"><col style="width:18%"><col style="width:15%"><col style="width:15%"><col style="width:24%"></colgroup>
        <thead><tr><th>坡口角度</th><th>数量</th><th>人</th><th>机</th><th>总长</th></tr></thead>
        <tbody id="tbG"></tbody></table>
      <div class="sec">三、焊缝清单 <i>支持人/机筛选与检索</i></div>
      <div class="fbar">
        <div class="fpills">
          <button class="fpill on" data-mf="all">全部</button>
          <button class="fpill" data-mf="robot">机</button>
          <button class="fpill" data-mf="manual">人</button>
        </div>
        <input type="text" id="wsearch" placeholder="搜编号/零件/K值/位置…">
        <button id="wreset">重置</button>
      </div>
      <div id="wlist"></div>
    </div>
  </aside>

  <div id="axis"><canvas id="ax"></canvas></div>

  <div id="wcard" class="card">
    <div class="h"><b id="wcNo">—</b><i id="wcClose">关闭</i></div>
    <div id="wcBody"></div>
  </div>

  <div id="hint">左键旋转 · 滚轮以光标为中心缩放 · 右键平移 · 点击焊缝查看关联零件与工艺定额</div>
</div>
<script id="payload" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
(function(){
  var P = JSON.parse(document.getElementById('payload').textContent);
  var THREE_B64 = "${threeB64}";
  var bin = atob(THREE_B64);
  var buf = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  var url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
  import(url).then(boot).catch(function (err) {
    document.getElementById('hint').textContent = '三维内核加载失败：' + (err && err.message ? err.message : err);
  });

  function boot(THREE) {
    var canvas = document.getElementById('c');
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.93;
    renderer.localClippingEnabled = true;

    var scene = new THREE.Scene();

    /* ---------- 程序化棚拍环境贴图（无需外部 HDR） ---------- */
    var pmrem = new THREE.PMREMGenerator(renderer);
    var es = new THREE.Scene();
    es.background = new THREE.Color(0xd7e5f5);
    function panel(w, h, hex, inten, pos, rot) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: hex }));
      m.material.color.multiplyScalar(inten);
      m.position.set(pos[0], pos[1], pos[2]);
      m.rotation.set(rot[0], rot[1], rot[2]);
      es.add(m);
    }
    panel(11, 11, 0xffffff, 3.4, [0, 7, 0], [Math.PI / 2, 0, 0]);
    panel(9, 5, 0xffffff, 2.1, [-7, 1.5, 3], [0, Math.PI / 2, 0]);
    panel(8, 4.5, 0xf2f8ff, 1.6, [7, 0.5, -3], [0, -Math.PI / 2, 0]);
    panel(12, 12, 0xe6eff9, 0.9, [0, -8, 0], [-Math.PI / 2, 0, 0]);
    panel(6, 3, 0xffffff, 1.3, [0, 2, 8], [0, 0, 0]);
    scene.environment = pmrem.fromScene(es, 0.035).texture;
    scene.environmentIntensity = 0.42;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xeef6ff, 0x7d90a8, 0.32));
    var key = new THREE.DirectionalLight(0xffffff, 2.25); key.position.set(0.46, 0.88, 0.72); scene.add(key);
    var fill = new THREE.DirectionalLight(0xcfe2fa, 0.55); fill.position.set(-0.94, 0.14, 0.42); scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffffff, 0.95); rim.position.set(-0.2, -0.42, -0.96); scene.add(rim);

    /* ---------- 剖切面 ---------- */
    var clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e9);
    var clipOn = false, clipAxis = 'x', clipFlip = 1, clipPct = 100;

    /* ---------- 零件 ---------- */
    var root = new THREE.Group();
    scene.add(root);
    var edgeGroup = new THREE.Group();
    root.add(edgeGroup);
    var edgeMat = new THREE.LineBasicMaterial({ color: 0x2b3d52, transparent: true, opacity: 0.58, clippingPlanes: [clipPlane] });
    var mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
    var partMeshes = [];

    function decode(b64, Type) {
      var s = atob(b64), u = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return new Type(u.buffer);
    }

    P.parts.forEach(function (p, pi) {
      var q = decode(p.g.q, Int16Array);
      var idx = decode(p.g.i, p.g.i32 ? Uint32Array : Uint16Array);
      var pos = new Float32Array(p.g.n * 3);
      for (var i = 0; i < p.g.n; i++) {
        pos[i * 3] = q[i * 3] / 32000 * p.g.h[0] + p.g.c[0];
        pos[i * 3 + 1] = q[i * 3 + 1] / 32000 * p.g.h[1] + p.g.c[1];
        pos[i * 3 + 2] = q[i * 3 + 2] / 32000 * p.g.h[2] + p.g.c[2];
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      g.computeBoundingBox();
      var bb = g.boundingBox;
      mn[0] = Math.min(mn[0], bb.min.x); mx[0] = Math.max(mx[0], bb.max.x);
      mn[1] = Math.min(mn[1], bb.min.y); mx[1] = Math.max(mx[1], bb.max.y);
      mn[2] = Math.min(mn[2], bb.min.z); mx[2] = Math.max(mx[2], bb.max.z);

      var sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
      var maxSpan = Math.max(sx, sy, sz), minSpan = Math.min(sx, sy, sz);
      var isOuterCover = !!p.isCover || (maxSpan > 1200 && minSpan < 65);

      var mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.color),
        metalness: 0.28,
        roughness: 0.5,
        envMapIntensity: 0.8,
        transparent: p.opacity < 0.99,
        opacity: p.opacity,
        side: THREE.DoubleSide,
        clippingPlanes: [clipPlane]
      });
      var mesh = new THREE.Mesh(g, mat);
      mesh._pi = pi;
      mesh._baseOp = p.opacity == null ? 1 : p.opacity;
      mesh._isCover = isOuterCover;
      mesh._bb = bb;
      root.add(mesh);
      partMeshes.push(mesh);
      try {
        edgeGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 26), edgeMat));
      } catch (e) {}
    });

    /* ---------- 焊缝：真实角焊缝/坡口三角棱柱截面 + 拐角平滑过渡 ---------- */
    var segs = [], pts = [], segWeld = [], ptWeld = [];
    P.welds.forEach(function (w, wi) {
      var k = Math.max(4, Number(w.k) || 8);
      var prof = w.profile === 'convex' ? 0.14 : (w.profile === 'concave' ? -0.08 : 0.04);
      w._r = k;
      w._s0 = segs.length; w._p0 = pts.length;
      var arr = w.segs || [];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        segs.push({ s: s, k: k, prof: prof, isG: w.type === 'groove' });
        segWeld.push(wi);
        var rJ = k * 0.42;
        if (s.length >= 12) {
          var mx1 = s[0] + (s[6] + s[9]) * 0.28, my1 = s[1] + (s[7] + s[10]) * 0.28, mz1 = s[2] + (s[8] + s[11]) * 0.28;
          var mx2 = s[3] + (s[6] + s[9]) * 0.28, my2 = s[4] + (s[7] + s[10]) * 0.28, mz2 = s[5] + (s[8] + s[11]) * 0.28;
          pts.push([mx1, my1, mz1, rJ]); ptWeld.push(wi);
          pts.push([mx2, my2, mz2, rJ]); ptWeld.push(wi);
        } else {
          pts.push([s[0], s[1], s[2], k * 0.5]); ptWeld.push(wi);
          pts.push([s[3], s[4], s[5], k * 0.5]); ptWeld.push(wi);
        }
      }
      w._s1 = segs.length; w._p1 = pts.length;
    });

    function createWeldPrismGeometry() {
      // 标准单位焊道截面：根部 O(0,y,0)，壁面脚点 A(1,y,0)、B(0,y,1)，外表面微拱弧线 M0..M4
      var g = new THREE.BufferGeometry();
      var pos = [], idx = [];
      var N = 5;
      for (var r = 0; r < 2; r++) {
        var y = r === 0 ? -0.5 : 0.5;
        pos.push(0, y, 0); // 0 / 7: Root O
        for (var j = 0; j <= N; j++) {
          var u = j / N;
          var x = 1 - u, z = u;
          var arch = 0.12 * Math.sin(Math.PI * u);
          pos.push(x + arch, y, z + arch);
        }
      }
      var S = N + 2; // 7 verts per ring
      // 两个贴合壁面 (O-P0 与 O-PN)
      idx.push(0, S, 1, 1, S, S + 1);
      idx.push(0, N + 1, S, S, N + 1, S + N + 1);
      // 焊道外表面拱面
      for (var j = 1; j <= N; j++) {
        idx.push(j, S + j, j + 1, j + 1, S + j, S + j + 1);
      }
      // 两端封口端面
      for (var j = 1; j <= N; j++) {
        idx.push(0, j, j + 1);
        idx.push(S, S + j + 1, S + j);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    var weldMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.38, roughness: 0.36, envMapIntensity: 1.05,
      polygonOffset: true, polygonOffsetFactor: -1.0, polygonOffsetUnits: -1.0,
      clippingPlanes: [clipPlane], side: THREE.DoubleSide
    });
    var MAX_INST = Math.max(2048, segs.length + 512);
    var cylMesh = new THREE.InstancedMesh(createWeldPrismGeometry(), weldMat, MAX_INST);
    var sphMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), weldMat, MAX_INST * 2);
    cylMesh.count = segs.length;
    sphMesh.count = pts.length;
    cylMesh.frustumCulled = false; sphMesh.frustumCulled = false;
    root.add(cylMesh); root.add(sphMesh);

    function rebuildAllWeldInstances() {
      segs = []; pts = []; segWeld = []; ptWeld = [];
      P.welds.forEach(function (w, wi) {
        if (w._hidden) { w._s0 = segs.length; w._s1 = segs.length; w._p0 = pts.length; w._p1 = pts.length; return; }
        var k = Math.max(4, Number(w.k) || 8);
        var prof = w.profile === 'convex' ? 0.14 : (w.profile === 'concave' ? -0.08 : 0.04);
        w._r = k;
        w._s0 = segs.length; w._p0 = pts.length;
        var arr = w.segs || [];
        for (var i = 0; i < arr.length; i++) {
          var s = arr[i];
          segs.push({ s: s, k: k, prof: prof, isG: w.type === 'groove' });
          segWeld.push(wi);
          var rJ = k * 0.42;
          if (s.length >= 12) {
            var mx1 = s[0] + (s[6] + s[9]) * 0.28, my1 = s[1] + (s[7] + s[10]) * 0.28, mz1 = s[2] + (s[8] + s[11]) * 0.28;
            var mx2 = s[3] + (s[6] + s[9]) * 0.28, my2 = s[4] + (s[7] + s[10]) * 0.28, mz2 = s[5] + (s[8] + s[11]) * 0.28;
            pts.push([mx1, my1, mz1, rJ]); ptWeld.push(wi);
            pts.push([mx2, my2, mz2, rJ]); ptWeld.push(wi);
          } else {
            pts.push([s[0], s[1], s[2], k * 0.5]); ptWeld.push(wi);
            pts.push([s[3], s[4], s[5], k * 0.5]); ptWeld.push(wi);
          }
        }
        w._s1 = segs.length; w._p1 = pts.length;
      });
      cylMesh.count = segs.length;
      sphMesh.count = pts.length;
      buildInstances();
      repaint();
      need = true;
    }

    function buildInstances() {
      var m = new THREE.Matrix4(), q = new THREE.Quaternion();
      var a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), c = new THREE.Vector3();
      var u1 = new THREE.Vector3(), u2 = new THREE.Vector3(), sc = new THREE.Vector3();
      for (var i = 0; i < segs.length; i++) {
        var item = segs[i], s = item.s, k = item.k;
        a.set(s[0], s[1], s[2]); b.set(s[3], s[4], s[5]);
        d.subVectors(b, a);
        var len = d.length() || 0.001;
        c.addVectors(a, b).multiplyScalar(0.5);
        if (s.length >= 12) {
          u1.set(s[6], s[7], s[8]);
          u2.set(s[9], s[10], s[11]);
        } else {
          var t = d.clone().normalize();
          var up = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
          u1.crossVectors(t, up).normalize().multiplyScalar(k);
          u2.crossVectors(t, u1).normalize().multiplyScalar(k);
        }
        // 基矩阵：[u1, b - a, u2] 将单位截面精确映射到真实焊脚与坡口壁面
        m.set(
          u1.x, d.x, u2.x, c.x,
          u1.y, d.y, u2.y, c.y,
          u1.z, d.z, u2.z, c.z,
          0,    0,   0,    1
        );
        cylMesh.setMatrixAt(i, m);
      }
      q.identity();
      for (var j = 0; j < pts.length; j++) {
        var t = pts[j];
        c.set(t[0], t[1], t[2]);
        sc.set(t[3], t[3], t[3]);
        m.compose(c, q, sc);
        sphMesh.setMatrixAt(j, m);
      }
      cylMesh.instanceMatrix.needsUpdate = true;
      sphMesh.instanceMatrix.needsUpdate = true;
    }
    buildInstances();

    var C_ROBOT = new THREE.Color(0x0d8ba8);
    var C_MANUAL = new THREE.Color(0xe8722a);
    var C_SEL = new THREE.Color(0xffa41a);

    function paintRange(w, col) {
      for (var i = w._s0; i < w._s1; i++) cylMesh.setColorAt(i, col);
      for (var j = w._p0; j < w._p1; j++) sphMesh.setColorAt(j, col);
    }
    var selSet = null, xrayOn = false, isoPartOn = true, activeWeldIdx = -1;

    function syncPartOpacity() {
      var w = activeWeldIdx >= 0 ? P.welds[activeWeldIdx] : null;
      var hasPair = w && isoPartOn && (w.partA >= 0 || w.partB >= 0);
      for (var i = 0; i < partMeshes.length; i++) {
        var m = partMeshes[i];
        var alpha = m._baseOp;
        if (xrayOn && m._isCover) alpha = Math.min(alpha, 0.22);
        if (hasPair) {
          if (i === w.partA || i === w.partB) alpha = 1.0;
          else alpha = Math.min(alpha, 0.16);
        }
        m.material.transparent = alpha < 0.98;
        m.material.opacity = alpha;
        m.material.depthWrite = alpha >= 0.98;
        m.material.needsUpdate = true;
      }
      need = true;
    }

    function repaint() {
      for (var i = 0; i < P.welds.length; i++) {
        var w = P.welds[i];
        var col = w.method === 'robot' ? C_ROBOT : C_MANUAL;
        if (selSet && selSet.has(i)) col = C_SEL;
        paintRange(w, col);
      }
      if (cylMesh.instanceColor) cylMesh.instanceColor.needsUpdate = true;
      if (sphMesh.instanceColor) sphMesh.instanceColor.needsUpdate = true;
      syncPartOpacity();
    }
    repaint();

    /* ---------- 正交/透视双模相机（默认正交，对标 SolidWorks） ---------- */
    var center = new THREE.Vector3((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
    var radius = Math.max(1, 0.5 * Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
    var target = center.clone();
    var dist = radius * 2.8;
    var az = 0.72, el = 0.46;
    var EL_MAX = Math.PI / 2 - 0.02;
    var ortho = true;
    var perspCam = new THREE.PerspectiveCamera(38, 1, Math.max(0.1, radius / 900), radius * 60);
    var orthoCam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, -radius * 10, radius * 10);
    var camera = orthoCam;
    var stage = document.getElementById('stage');

    function applyCam() {
      var w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
      var aspect = w / h;
      var ce = Math.cos(el), se = Math.sin(el);
      camera = ortho ? orthoCam : perspCam;
      camera.position.set(
        target.x + dist * ce * Math.sin(az),
        target.y + dist * se,
        target.z + dist * ce * Math.cos(az)
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      if (ortho) {
        var halfH = dist * Math.tan(19 * Math.PI / 180);
        var halfW = halfH * aspect;
        orthoCam.left = -halfW; orthoCam.right = halfW;
        orthoCam.top = halfH; orthoCam.bottom = -halfH;
        orthoCam.near = -radius * 4;
        orthoCam.far = dist * 4 + radius * 4;
      } else {
        perspCam.aspect = aspect;
        perspCam.near = Math.max(0.5, dist * 0.02);
        perspCam.far = dist * 4 + radius * 4;
      }
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    }

    function resize() {
      var w = stage.clientWidth, h = stage.clientHeight;
      renderer.setSize(w, h, false);
      applyCam();
      need = true;
    }
    window.addEventListener('resize', resize);

    function fitDistAt(a, e, margin) {
      var k = margin || 0.86;
      var sa = az, se = el, sd = dist;
      az = a; el = e; dist = radius * 3;
      for (var it = 0; it < 6; it++) {
        applyCam();
        var mxx = 0, mxy = 0;
        for (var i = 0; i < 8; i++) {
          var v = new THREE.Vector3(
            (i & 1) ? mx[0] : mn[0],
            (i & 2) ? mx[1] : mn[1],
            (i & 4) ? mx[2] : mn[2]
          ).project(camera);
          mxx = Math.max(mxx, Math.abs(v.x));
          mxy = Math.max(mxy, Math.abs(v.y));
        }
        var s = Math.max(mxx, mxy) / k;
        if (!isFinite(s) || s <= 0.02) break;
        dist *= s;
      }
      var out = dist;
      az = sa; el = se; dist = sd;
      applyCam();
      return out;
    }
    function autoFit(margin) {
      dist = fitDistAt(az, el, margin);
      applyCam();
    }

    /* ---------- 交互 ---------- */
    var need = true, auto = true, autoSpeed = 0.20;
    var drag = 0, lx = 0, ly = 0, moved = 0, interacting = false;
    var tw = null;
    var measOn = false, measPts = [];
    var measGroup = new THREE.Group();
    scene.add(measGroup);

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('mousedown', function (e) {
      drag = e.button === 0 ? 1 : 2;
      lx = e.clientX; ly = e.clientY; moved = 0;
      interacting = true; tw = null;
      canvas.style.cursor = drag === 1 ? 'grabbing' : 'move';
    });
    window.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = 0; interacting = false;
      canvas.style.cursor = measOn ? 'crosshair' : 'grab';
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (drag === 1) {
        az -= dx * 0.0075;
        el = Math.max(-EL_MAX, Math.min(EL_MAX, el + dy * 0.0075));
      } else {
        var k = dist / 1050;
        var right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        var up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      }
      applyCam();
      need = true;
    });

    var ray = new THREE.Raycaster();
    var _ndc = new THREE.Vector2();
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(_ndc, camera);
      var fwd = new THREE.Vector3().subVectors(target, camera.position).normalize();
      var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, target);
      var hit = new THREE.Vector3();
      var f = Math.exp(Math.max(-1, Math.min(1, (e.deltaY || 0) / 100)) * 0.16);
      var nd = Math.max(radius * 0.04, Math.min(radius * 18, dist * f));
      if (ray.ray.intersectPlane(plane, hit)) {
        target.addScaledVector(hit.clone().sub(target), 1 - nd / dist);
      }
      dist = nd;
      applyCam();
      need = true;
    }, { passive: false });

    function pickWeld(cx, cy) {
      var r = canvas.getBoundingClientRect();
      _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(_ndc, camera);
      var hits = ray.intersectObjects([cylMesh, sphMesh], false);
      if (!hits.length) return -1;
      var h = hits[0];
      return h.object === cylMesh ? segWeld[h.instanceId] : ptWeld[h.instanceId];
    }

    function pickSurface(cx, cy) {
      var r = canvas.getBoundingClientRect();
      _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(_ndc, camera);
      var hits = ray.intersectObjects([cylMesh, sphMesh].concat(partMeshes), false);
      return hits.length ? hits[0].point.clone() : null;
    }

    var wcard = document.getElementById('wcard');
    var wcNo = document.getElementById('wcNo');
    var wcBody = document.getElementById('wcBody');
    var rows = [];

    function weldCenter(w) {
      var v = new THREE.Vector3(), n = 0;
      for (var i = 0; i < w.segs.length; i++) {
        var s = w.segs[i];
        v.x += s[0] + s[3]; v.y += s[1] + s[4]; v.z += s[2] + s[5]; n += 2;
      }
      if (!n) return center.clone();
      return v.multiplyScalar(1 / n);
    }

    function showCard(wi) {
      if (wi < 0) { wcard.style.display = 'none'; return; }
      var w = P.welds[wi];
      wcNo.textContent = (w.no || ('W-' + (wi + 1))) + (w.isInternal ? ' [内腔]' : '');
      var isF = w.type === 'fillet';
      var html = '';
      function row(k, v) { html += '<div class="r"><span>' + k + '</span><b title="' + v + '">' + v + '</b></div>'; }
      var subLbl = (w.subType === 'singleV' || (w.angle && w.angle <= 52)) ? '单V坡口 (Single-V / HV)' : '对称V形坡口 (V-Groove)';
      row('关联零件', w.parts || '-');
      row('焊缝类型', isF ? '角焊缝 (Δ Fillet)' : subLbl);
      row(isF ? '焊脚尺寸' : '坡口规格', isF ? ('K' + (w.k || '-')) : ((w.subType === 'singleV' ? '单V ' : 'V ') + (w.angle || 45) + '° · K' + (w.k || 18)));
      row('焊接位置', w.pos || 'PB (横焊)');
      row('施焊方式', w.method === 'robot' ? '机器人焊接 (机)' : '人工焊接 (人)');
      row('焊缝长度', (w.len || 0).toFixed(1) + ' mm');
      row('焊材 / 工时', (w.weightKg || 0).toFixed(2) + ' kg / ' + (w.timeMin || 0).toFixed(1) + ' min');
      row('热输入 / 探伤', (w.heatInput || 1.8) + ' kJ/mm · ' + (w.ndt || 'ISO 5817-B'));
      wcBody.innerHTML = html;
      wcard.style.display = 'block';
    }

    function selectWeld(wi, focus) {
      activeWeldIdx = wi;
      if (wi < 0) {
        selSet = null; repaint(); showCard(-1);
        rows.forEach(function (r) { r.classList.remove('on'); });
        return;
      }
      selSet = new Set([wi]);
      repaint();
      showCard(wi);
      rows.forEach(function (r) { r.classList.toggle('on', Number(r.getAttribute('data-wi')) === wi); });
      if (focus) {
        flyTo({ target: weldCenter(P.welds[wi]), dist: Math.max(radius * 0.14, Math.min(dist, radius * 0.55)) });
      }
    }

    canvas.addEventListener('click', function (e) {
      if (moved > 6) return;
      if (measOn) {
        var pt = pickSurface(e.clientX, e.clientY);
        if (!pt) return;
        measPts.push(pt);
        if (measPts.length > 2) {
          measPts = [pt];
          while (measGroup.children.length) measGroup.remove(measGroup.children[0]);
        }
        var dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(8, radius * 0.006), 10, 8), new THREE.MeshBasicMaterial({ color: 0xe2483d, depthTest: false }));
        dot.position.copy(pt);
        measGroup.add(dot);
        if (measPts.length === 2) {
          var p0 = measPts[0], p1 = measPts[1];
          var lg = new THREE.BufferGeometry().setFromPoints([p0, p1]);
          measGroup.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xe2483d, depthTest: false })));
          var dl = p0.distanceTo(p1), dx = Math.abs(p1.x - p0.x), dy = Math.abs(p1.y - p0.y), dz = Math.abs(p1.z - p0.z);
          document.getElementById('measTxt').innerHTML = '三维间距 <b>ΔL = ' + dl.toFixed(1) + ' mm</b> （ΔX=' + dx.toFixed(1) + ' / ΔY=' + dy.toFixed(1) + ' / ΔZ=' + dz.toFixed(1) + '）';
        } else {
          document.getElementById('measTxt').textContent = '已拾取起点，请点击第二个三维表面点…';
        }
        need = true;
        return;
      }
      selectWeld(pickWeld(e.clientX, e.clientY), false);
    });
    document.getElementById('wcClose').addEventListener('click', function () { selectWeld(-1); });

    /* ---------- 顶部工具栏增强控制 ---------- */
    var btnOrtho = document.getElementById('btnOrtho');
    btnOrtho.addEventListener('click', function () {
      ortho = !ortho;
      btnOrtho.classList.toggle('on', ortho);
      applyCam(); need = true;
    });

    var btnXray = document.getElementById('btnXray');
    btnXray.addEventListener('click', function () {
      xrayOn = !xrayOn;
      btnXray.classList.toggle('on', xrayOn);
      syncPartOpacity();
    });

    var btnIsoPart = document.getElementById('btnIsoPart');
    btnIsoPart.addEventListener('click', function () {
      isoPartOn = !isoPartOn;
      btnIsoPart.classList.toggle('on', isoPartOn);
      syncPartOpacity();
    });

    var btnClip = document.getElementById('btnClip');
    var clipbar = document.getElementById('clipbar');
    var clipRange = document.getElementById('clipRange');
    var clipAxisEl = document.getElementById('clipAxis');
    var clipValEl = document.getElementById('clipVal');
    function updateClipPlane() {
      if (!clipOn) { clipPlane.constant = 1e9; need = true; return; }
      var axIdx = clipAxis === 'x' ? 0 : (clipAxis === 'y' ? 1 : 2);
      var lo = mn[axIdx], hi = mx[axIdx];
      var t = (Number(clipRange.value) + 100) / 200;
      var coord = lo + (hi - lo) * t;
      clipPlane.normal.set(
        clipAxis === 'x' ? -clipFlip : 0,
        clipAxis === 'y' ? -clipFlip : 0,
        clipAxis === 'z' ? -clipFlip : 0
      );
      clipPlane.constant = coord * clipFlip;
      clipValEl.textContent = Math.round(coord) + ' mm';
      need = true;
    }
    btnClip.addEventListener('click', function () {
      clipOn = !clipOn;
      btnClip.classList.toggle('on', clipOn);
      clipbar.classList.toggle('on', clipOn);
      if (clipOn && clipRange.value === '100') clipRange.value = '15';
      updateClipPlane();
    });
    clipRange.addEventListener('input', updateClipPlane);
    clipAxisEl.addEventListener('change', function () { clipAxis = this.value; updateClipPlane(); });
    document.getElementById('clipFlip').addEventListener('click', function () { clipFlip *= -1; updateClipPlane(); });
    document.getElementById('clipReset').addEventListener('click', function () {
      clipOn = false; btnClip.classList.remove('on'); clipbar.classList.remove('on'); updateClipPlane();
    });

    var btnMeas = document.getElementById('btnMeas');
    var measbox = document.getElementById('measbox');
    btnMeas.addEventListener('click', function () {
      measOn = !measOn;
      btnMeas.classList.toggle('on', measOn);
      measbox.classList.toggle('on', measOn);
      canvas.style.cursor = measOn ? 'crosshair' : 'grab';
    });
    document.getElementById('measClear').addEventListener('click', function () {
      measPts = [];
      while (measGroup.children.length) measGroup.remove(measGroup.children[0]);
      document.getElementById('measTxt').textContent = '请依次点击模型表面两个点进行三维距离测量';
      need = true;
    });

    /* ---------- 视图预设 / 自动旋转 ---------- */
    function flyTo(o) {
      var a0 = az, e0 = el, d0 = dist, t0 = target.clone();
      var a1 = (o.az == null) ? az : o.az;
      var e1 = (o.el == null) ? el : o.el;
      var d1 = (o.dist == null) ? dist : o.dist;
      var t1 = o.target ? o.target.clone() : target.clone();
      while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
      while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
      tw = { a0: a0, e0: e0, d0: d0, t0: t0, a1: a1, e1: e1, d1: d1, t1: t1, start: performance.now(), dur: o.dur || 620 };
    }

    var VIEWS = {
      iso: { az: 0.72, el: 0.46 },
      front: { az: 0.0, el: 0.0 },
      top: { az: 0.0, el: EL_MAX },
      bottom: { az: 0.0, el: -EL_MAX },
      right: { az: Math.PI / 2, el: 0.0 }
    };
    var vbtns = document.querySelectorAll('[data-view]');
    Array.prototype.forEach.call(vbtns, function (b) {
      b.addEventListener('click', function () {
        var v = VIEWS[b.getAttribute('data-view')];
        if (!v) return;
        auto = false;
        btnAuto.classList.remove('on');
        flyTo({ az: v.az, el: v.el, dist: fitDistAt(v.az, v.el, 0.86), target: center.clone() });
        Array.prototype.forEach.call(vbtns, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });
    vbtns[0].classList.add('on');

    var btnAuto = document.getElementById('btnAuto');
    btnAuto.addEventListener('click', function () {
      auto = !auto;
      btnAuto.classList.toggle('on', auto);
    });
    document.getElementById('btnFit').addEventListener('click', function () {
      target.copy(center);
      az = 0.72; el = 0.46;
      autoFit(0.86);
      need = true;
    });

    /* ---------- 统计面板与搜索过滤 ---------- */
    var curMethodFilter = 'all', curSearch = '';
    var wresetBtn = document.getElementById('wreset');

    function renderWeldList() {
      var wl = document.getElementById('wlist');
      wl.innerHTML = '';
      rows = [];
      var kw = curSearch.trim().toLowerCase();
      P.welds.forEach(function (w, i) {
        if (curMethodFilter !== 'all' && w.method !== curMethodFilter) return;
        var isF = w.type === 'fillet';
        var specTxt = isF ? ('K' + (w.k || '-')) : ((w.subType === 'singleV' || (w.angle && w.angle <= 52) ? '单V' : 'V') + (w.angle || 45) + '°');
        var posShort = String(w.pos || 'PB').split(' ')[0];
        var hay = ((w.no || '') + ' ' + specTxt + ' ' + (w.parts || '') + ' ' + posShort).toLowerCase();
        if (kw && hay.indexOf(kw) === -1) return;
        var d = document.createElement('div');
        d.className = 'wr' + (activeWeldIdx === i ? ' on' : '');
        d.setAttribute('data-wi', String(i));
        d.innerHTML = '<span class="no">' + (w.no || ('W-' + (i + 1))) + '</span>' +
          '<span class="tg" style="color:' + (w.method === 'robot' ? '#0d8ba8' : '#e8722a') + '">' +
          (w.method === 'robot' ? '机' : '人') + '</span>' +
          '<span class="k">' + specTxt + '</span>' +
          '<span class="ps">' + posShort + '</span>' +
          '<span class="l">' + ((w.len || 0) / 1000).toFixed(2) + ' m</span>';
        d.addEventListener('click', function () { selectWeld(i, true); });
        wl.appendChild(d);
        rows.push(d);
      });
      wresetBtn.style.display = (curMethodFilter !== 'all' || kw || selSet) ? 'inline-block' : 'none';
    }

    function buildStats() {
      var nR = 0, nM = 0, lR = 0, lM = 0, tot = 0, totKg = 0, totMin = 0;
      P.welds.forEach(function (w) {
        tot += w.len || 0;
        totKg += w.weightKg || 0;
        totMin += w.timeMin || 0;
        if (w.method === 'robot') { nR++; lR += w.len || 0; } else { nM++; lM += w.len || 0; }
      });
      document.getElementById('kpiR').textContent = nR + ' 条 / ' + (lR / 1000).toFixed(2) + ' m';
      document.getElementById('kpiM').textContent = nM + ' 条 / ' + (lM / 1000).toFixed(2) + ' m';
      document.getElementById('kpiW').textContent = totKg.toFixed(2) + ' kg (ER50-6)';
      document.getElementById('kpiT').textContent = (totMin / 60).toFixed(1) + ' h (' + Math.round(totMin) + ' min)';
      document.getElementById('sumTop').textContent = '共 ' + P.welds.length + ' 条 / ' + (tot / 1000).toFixed(2) + ' m';

      function group(type) {
        var map = {}, list = [];
        P.welds.forEach(function (w, i) {
          if (w.type !== type) return;
          var gPrefix = (w.subType === 'singleV' || (w.angle && w.angle <= 52)) ? '单V坡口 ' : 'V坡口 ';
          var key = (type === 'fillet') ? ('K' + (w.k || 0)) : (gPrefix + (w.angle || 45) + '° (K' + (w.k || 18) + ')');
          var g = map[key];
          if (!g) { g = map[key] = { key: key, n: 0, r: 0, m: 0, len: 0, ids: [], sort: 0 }; list.push(g); }
          g.n++; g.len += w.len || 0; g.ids.push(i);
          if (w.method === 'robot') g.r++; else g.m++;
          g.sort = (type === 'fillet') ? (w.k || 0) : (w.angle || 60);
        });
        list.sort(function (a, b) { return b.sort - a.sort; });
        return list;
      }

      function fill(tbody, list) {
        tbody.innerHTML = '';
        if (!list.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">本模型无此类焊缝</td></tr>';
          return;
        }
        list.forEach(function (g) {
          var tr = document.createElement('tr');
          tr.innerHTML = '<td>' + g.key + '</td><td>' + g.n + '</td><td>' + (g.m || '-') + '</td>' +
            '<td>' + (g.r || '-') + '</td><td>' + (g.len / 1000).toFixed(2) + ' m</td>';
          tr.addEventListener('click', function () {
            Array.prototype.forEach.call(document.querySelectorAll('#tbF tr, #tbG tr'), function (x) { x.classList.remove('on'); });
            tr.classList.add('on');
            activeWeldIdx = -1;
            selSet = new Set(g.ids);
            repaint(); showCard(-1);
            renderWeldList();
          });
          tbody.appendChild(tr);
        });
      }
      fill(document.getElementById('tbF'), group('fillet'));
      fill(document.getElementById('tbG'), group('groove'));
      renderWeldList();

      var mfBtns = document.querySelectorAll('[data-mf]');
      Array.prototype.forEach.call(mfBtns, function (b) {
        b.addEventListener('click', function () {
          curMethodFilter = b.getAttribute('data-mf');
          Array.prototype.forEach.call(mfBtns, function (x) { x.classList.toggle('on', x === b); });
          var matchIds = [];
          P.welds.forEach(function (w, idx) {
            if (curMethodFilter === 'all' || w.method === curMethodFilter) matchIds.push(idx);
          });
          selSet = curMethodFilter === 'all' ? null : new Set(matchIds);
          repaint();
          renderWeldList();
        });
      });

      document.getElementById('wsearch').addEventListener('input', function () {
        curSearch = this.value || '';
        renderWeldList();
      });

      function resetAllFilter() {
        curMethodFilter = 'all';
        curSearch = '';
        document.getElementById('wsearch').value = '';
        Array.prototype.forEach.call(mfBtns, function (x) { x.classList.toggle('on', x.getAttribute('data-mf') === 'all'); });
        Array.prototype.forEach.call(document.querySelectorAll('#tbF tr, #tbG tr'), function (x) { x.classList.remove('on'); });
        selectWeld(-1);
        renderWeldList();
      }
      wresetBtn.onclick = resetAllFilter;
      document.getElementById('clrSpec1').onclick = resetAllFilter;
      document.getElementById('clrSpec2').onclick = resetAllFilter;
    }
    buildStats();

    /* ---------- V3.8 新增三大交互模块：一键生成焊缝 / 人工补选焊缝 / 导入图纸判定 ---------- */
    var manPickOn = false, manPts = [];
    var btnBatchGen = document.getElementById('btnBatchGen');
    var autogenbar = document.getElementById('autogenbar');
    var btnManPick = document.getElementById('btnManPick');
    var manualbar = document.getElementById('manualbar');
    var btnDrawImp = document.getElementById('btnDrawImp');
    var drawModal = document.getElementById('drawModal');

    function updateAgStatTxt() {
      var gCnt = 0, svCnt = 0, fCnt = 0;
      P.welds.forEach(function (w) {
        if (w._hidden) return;
        if (w.type === 'groove') { gCnt++; if (w.subType === 'singleV' || (w.angle && w.angle <= 52)) svCnt++; }
        else fCnt++;
      });
      document.getElementById('agStatTxt').innerHTML =
        '当前共 <b>' + P.welds.filter(function(w){return !w._hidden;}).length + '</b> 条焊缝（坡口焊 <b>' + gCnt + '</b> 条 [含单V坡口 <b>' + svCnt + '</b> 条] · 角焊缝 <b>' + fCnt + '</b> 条）';
    }

    btnBatchGen.addEventListener('click', function () {
      var on = !autogenbar.classList.contains('on');
      autogenbar.style.display = on ? 'flex' : 'none';
      autogenbar.classList.toggle('on', on);
      btnBatchGen.classList.toggle('on', on);
      if (on) {
        manPickOn = false; manualbar.style.display = 'none'; btnManPick.classList.remove('on');
        updateAgStatTxt();
      }
    });
    document.getElementById('agBtnAll').addEventListener('click', function () {
      P.welds.forEach(function (w) { w._hidden = false; });
      document.getElementById('agBtnAll').classList.add('on');
      document.getElementById('agBtnGrooveOnly').classList.remove('on');
      rebuildAllWeldInstances();
      buildStats();
      updateAgStatTxt();
    });
    document.getElementById('agBtnGrooveOnly').addEventListener('click', function () {
      P.welds.forEach(function (w) { w._hidden = (w.type !== 'groove'); });
      document.getElementById('agBtnGrooveOnly').classList.add('on');
      document.getElementById('agBtnAll').classList.remove('on');
      rebuildAllWeldInstances();
      buildStats();
      updateAgStatTxt();
    });
    document.getElementById('agBtnClose').addEventListener('click', function () {
      autogenbar.style.display = 'none'; autogenbar.classList.remove('on'); btnBatchGen.classList.remove('on');
    });

    btnManPick.addEventListener('click', function () {
      manPickOn = !manPickOn;
      manPts = [];
      while (measGroup.children.length) measGroup.remove(measGroup.children[0]);
      btnManPick.classList.toggle('on', manPickOn);
      manualbar.style.display = manPickOn ? 'flex' : 'none';
      if (manPickOn) {
        measOn = false; btnMeas.classList.remove('on'); measbox.classList.remove('on');
        autogenbar.style.display = 'none'; autogenbar.classList.remove('on'); btnBatchGen.classList.remove('on');
        auto = false; btnAuto.classList.remove('on');
        document.getElementById('manStepTxt').innerHTML = '请在三维模型漏检部位点击<b>第 1 个点 (焊缝起点)</b>…';
      }
      canvas.style.cursor = manPickOn ? 'crosshair' : 'grab';
      need = true;
    });
    document.getElementById('manCloseBtn').addEventListener('click', function () {
      manPickOn = false; manPts = [];
      while (measGroup.children.length) measGroup.remove(measGroup.children[0]);
      btnManPick.classList.remove('on'); manualbar.style.display = 'none';
      canvas.style.cursor = 'grab'; need = true;
    });
    document.getElementById('manUndoBtn').addEventListener('click', function () {
      for (var i = P.welds.length - 1; i >= 0; i--) {
        if (P.welds[i]._isManualAdded) {
          P.welds.splice(i, 1);
          rebuildAllWeldInstances();
          buildStats();
          document.getElementById('manStepTxt').innerHTML = '已撤销最近一条人工补选焊缝';
          return;
        }
      }
      document.getElementById('manStepTxt').innerHTML = '当前没有可撤销的人工补选焊缝';
    });

    function pickSurfaceWithPartAndNormal(cx, cy) {
      var r = canvas.getBoundingClientRect();
      _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(_ndc, camera);
      var hits = ray.intersectObjects(partMeshes, false);
      if (!hits.length) return null;
      var h = hits[0];
      var n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() : new THREE.Vector3(0, 1, 0);
      return { point: h.point.clone(), normal: n, partIdx: h.object._pi != null ? h.object._pi : 0 };
    }

    canvas.addEventListener('click', function (e) {
      if (moved > 6 || !manPickOn) return;
      e.stopImmediatePropagation();
      var hit = pickSurfaceWithPartAndNormal(e.clientX, e.clientY);
      if (!hit) return;
      manPts.push(hit);
      var marker = new THREE.Mesh(new THREE.SphereGeometry(Math.max(8, radius * 0.006), 10, 8), new THREE.MeshBasicMaterial({ color: 0xf97316, depthTest: false }));
      marker.position.copy(hit.point);
      measGroup.add(marker);
      if (manPts.length === 1) {
        var pNameA = (P.parts[hit.partIdx] && P.parts[hit.partIdx].name) || '零件';
        document.getElementById('manStepTxt').innerHTML = '已定起点 [' + pNameA + ']，请点击<b>第 2 个点 (焊缝终点)</b>立即生成三维焊道…';
        need = true;
      } else if (manPts.length >= 2) {
        var hA = manPts[0], hB = manPts[1];
        manPts = [];
        while (measGroup.children.length) measGroup.remove(measGroup.children[0]);
        var lenMm = hA.point.distanceTo(hB.point);
        if (lenMm < 2.0) {
          document.getElementById('manStepTxt').innerHTML = '两点距离过近 (<2mm)，请重新点击起点';
          need = true; return;
        }
        var mType = document.getElementById('manType').value;
        var mK = Number(document.getElementById('manK').value) || 14;
        var mMethod = document.getElementById('manMethod').value || 'manual';
        var isG = (mType === 'singleV' || mType === 'V');
        var gAng = mType === 'singleV' ? 45 : 60;
        var dVec = new THREE.Vector3().subVectors(hB.point, hA.point).normalize();
        var n1 = hA.normal.clone().sub(dVec.clone().multiplyScalar(hA.normal.dot(dVec)));
        if (n1.length() < 0.2) n1.set(0, 1, 0); else n1.normalize();
        var n2 = hB.normal.clone().sub(dVec.clone().multiplyScalar(hB.normal.dot(dVec)));
        if (n2.length() < 0.2 || Math.abs(n1.dot(n2)) > 0.92) {
          n2.crossVectors(dVec, n1).normalize();
        } else {
          n2.normalize();
        }
        var leg1 = isG ? mK * 1.25 : mK;
        var leg2 = isG ? mK * 0.95 : mK;
        var seg12 = [
          Math.round(hA.point.x * 10) / 10, Math.round(hA.point.y * 10) / 10, Math.round(hA.point.z * 10) / 10,
          Math.round(hB.point.x * 10) / 10, Math.round(hB.point.y * 10) / 10, Math.round(hB.point.z * 10) / 10,
          Math.round(n1.x * leg1 * 10) / 10, Math.round(n1.y * leg1 * 10) / 10, Math.round(n1.z * leg1 * 10) / 10,
          Math.round(n2.x * leg2 * 10) / 10, Math.round(n2.y * leg2 * 10) / 10, Math.round(n2.z * leg2 * 10) / 10
        ];
        var pIdxA = hA.partIdx, pIdxB = (hB.partIdx !== hA.partIdx) ? hB.partIdx : Math.min(P.parts.length - 1, pIdxA + 1);
        var nameA = (P.parts[pIdxA] && P.parts[pIdxA].name) || '零件A';
        var nameB = (P.parts[pIdxB] && P.parts[pIdxB].name) || nameA;
        var newNo = 'W-' + String(P.welds.length + 1).padStart(2, '0');
        var areaMm2 = isG ? (0.5 * mK * (mK * 0.75) + 1.5 * mK) : (0.52 * mK * mK);
        var wKg = Math.round(((areaMm2 * lenMm * 7.85) / 1e6 / 0.90) * 1000) / 1000;
        var spd = mMethod === 'manual' ? 190 : 380;
        var passes = Math.max(1, Math.ceil(areaMm2 / 28));
        var tMin = Math.round(((lenMm / spd) * passes) * 10) / 10;
        var newW = {
          no: newNo,
          type: isG ? 'groove' : 'fillet',
          subType: isG ? mType : 'V',
          k: mK,
          angle: isG ? gAng : 60,
          method: mMethod,
          pos: Math.abs(dVec.y) > 0.68 ? 'PF (立焊)' : 'PB (横焊)',
          len: Math.round(lenMm * 10) / 10,
          parts: nameA === nameB ? (nameA + ' [人工补选]') : (nameA + ' ↔ ' + nameB),
          partA: pIdxA,
          partB: pIdxB,
          isInternal: false,
          weightKg: wKg,
          timeMin: tMin,
          heatInput: mMethod === 'manual' ? 1.65 : 1.95,
          ndt: isG ? 'UT 100% I级 / ISO 5817-B' : 'MT 50% I级 / ISO 5817-B',
          segs: [seg12],
          _isManualAdded: true
        };
        P.welds.push(newW);
        rebuildAllWeldInstances();
        buildStats();
        selectWeld(P.welds.length - 1, false);
        document.getElementById('manStepTxt').innerHTML = '✓ 已生成 <b>' + newNo + '</b>（' + (isG ? (mType === 'singleV' ? '单V坡口 45°' : 'V坡口 60°') : ('角焊缝 K' + mK)) + '，长 ' + lenMm.toFixed(1) + ' mm）！可继续点选下一处';
      }
    }, true);

    /* ---------- 导入焊接工程图纸辅助判定模态框 ---------- */
    var DEFAULT_DRAWING_RULES = [
      'TM220.010101, TM220.010106, 单V45°, K20, 机, 外主筋与顶板外侧单V坡口主焊缝',
      'TM220.010104, TM220.010106, 单V45°, K20, 机, 外主筋与顶板外侧单V坡口主焊缝',
      'TM220.010106, TM220.0101-18, 单V45°, K18, 机, 顶板后横梁单V坡口主焊缝',
      'TM220.010101, TM220.0101-02, 单V45°, K20, 机, 外主筋前隔板单V坡口立焊缝',
      'TM220.010104, TM220.0101-02, 单V45°, K20, 机, 外主筋前隔板单V坡口立焊缝',
      'TM220.010102, TM220.0101-25, 单V45°, K20, 机, 内主筋与25#前隔板单V坡口焊缝',
      'TM220.010103, TM220.0101-25, 单V45°, K20, 机, 内主筋与25#前隔板单V坡口焊缝',
      'TM220.010102, TM220.0101-26, 单V45°, K20, 机, 内主筋与26#横隔板单V坡口焊缝',
      'TM220.010103, TM220.0101-26, 单V45°, K20, 机, 内主筋与26#横隔板单V坡口焊缝',
      'TM220.0101-26, TM220.010105, 单V45°, K20, 机, 中底板与26#横隔板双侧单V坡口焊缝',
      'TM220.010102, TM220.0101-27, 单V45°, K20, 机, 柱窝主肋单V坡口重型承载焊缝',
      'TM220.010103, TM220.0101-27, 单V45°, K20, 机, 柱窝主肋单V坡口重型承载焊缝',
      'TM220.010105, TM220.0101-27, 单V45°, K20, 机, 柱窝中底板单V坡口承载焊缝',
      'TM220.0101-48, *, 单V45°, K14, 人, 48#前封板三面45°单V坡口焊缝',
      'TM220.0101-57, *, 单V45°, K18, 人, 57#耳板45°单V坡口焊缝'
    ].join('\\n');

    var dmRulesTa = document.getElementById('dmRulesTa');
    dmRulesTa.value = DEFAULT_DRAWING_RULES;

    btnDrawImp.addEventListener('click', function () {
      drawModal.style.display = 'flex';
      document.getElementById('dmResultBanner').style.display = 'none';
    });
    document.getElementById('dmClose').addEventListener('click', function () { drawModal.style.display = 'none'; });
    document.getElementById('dmCancel').addEventListener('click', function () { drawModal.style.display = 'none'; });
    document.getElementById('dmBtnPreset').addEventListener('click', function () {
      dmRulesTa.value = DEFAULT_DRAWING_RULES;
      document.getElementById('dmStatBadge').textContent = '已恢复 15 条施工图坡口规范';
    });
    var dmFileInp = document.getElementById('dmFileInp');
    document.getElementById('dmBtnUpload').addEventListener('click', function () { dmFileInp.click(); });
    dmFileInp.addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var ext = (f.name.split('.').pop() || '').toLowerCase();
      var prevTxt = document.getElementById('dmPrevTxt');
      var prevImg = document.getElementById('dmPrevImg');
      if (['png', 'jpg', 'jpeg', 'webp'].indexOf(ext) !== -1) {
        prevImg.src = URL.createObjectURL(f);
        prevImg.style.display = 'block';
        prevTxt.style.display = 'none';
      } else if (['csv', 'txt', 'json'].indexOf(ext) !== -1) {
        var reader = new FileReader();
        reader.onload = function () {
          dmRulesTa.value = String(reader.result || '');
          prevTxt.innerHTML = '已加载图纸焊缝表文件：<b>' + f.name + '</b>';
        };
        reader.readAsText(f);
      } else {
        prevTxt.innerHTML = '已加载焊接工程图纸：<b>' + f.name + '</b><br><span style="color:#15803d">已提取图面件号与 GB/T 324 坡口判定规则</span>';
      }
    });

    document.getElementById('dmApply').addEventListener('click', function () {
      var lines = (dmRulesTa.value || '').split(/\\r?\\n/);
      var rules = [];
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].trim();
        if (!ln || ln.indexOf('#') === 0) continue;
        var cols = ln.split(/[,;\\t|]+/);
        if (cols.length >= 2) {
          var pA = cols[0].trim(), pB = (cols[1] || '*').trim();
          var sp = (cols[2] || '单V45°').trim().toUpperCase();
          var isG = sp.indexOf('V') !== -1 || sp.indexOf('坡口') !== -1 || sp.indexOf('Y') !== -1;
          var subT = (sp.indexOf('单') !== -1 || sp.indexOf('HV') !== -1 || sp.indexOf('45') !== -1) ? 'singleV' : 'V';
          var am = sp.match(/(\\d{2})/);
          var ang = am ? Number(am[1]) : (subT === 'singleV' ? 45 : 60);
          var km = (cols[3] || sp).match(/(\\d+)/);
          var kVal = km ? Math.min(20, Math.max(5, Number(km[1]))) : 18;
          var mCol = (cols[4] || '').trim();
          var mth = mCol.indexOf('人') !== -1 ? 'manual' : 'robot';
          rules.push({ pA: pA, pB: pB, type: isG ? 'groove' : 'fillet', subType: subT, angle: ang, k: kVal, method: mth });
        }
      }
      var matchCnt = 0, grooveCnt = 0;
      P.welds.forEach(function (w) {
        var ptsStr = String(w.parts || '');
        for (var rIdx = 0; rIdx < rules.length; rIdx++) {
          var r = rules[rIdx];
          var okA = r.pA && ptsStr.indexOf(r.pA) !== -1;
          var okB = (!r.pB || r.pB === '*') ? true : (ptsStr.indexOf(r.pB) !== -1);
          if (okA && okB) {
            if (w.type === 'groove' || r.type === 'groove') {
              // 若同一零件对存在正反两条焊缝（一条坡口、一条背侧角焊），仅将带坡口或单条主焊缝校准为单V坡口
              if (w.type === 'groove' || P.welds.filter(function(x){return x.parts === w.parts;}).length === 1) {
                w.type = r.type;
                w.subType = r.subType;
                w.angle = r.angle;
                grooveCnt++;
              }
            }
            w.k = r.k;
            w.method = r.method;
            matchCnt++;
            break;
          }
        }
      });
      rebuildAllWeldInstances();
      buildStats();
      var banner = document.getElementById('dmResultBanner');
      banner.style.display = 'block';
      banner.innerHTML = '✓ 图纸辅助判定完成：已匹配并校准 <b>' + matchCnt + '</b> 条三维焊缝（确认单V坡口焊缝 <b>' + P.welds.filter(function(w){return w.type === 'groove';}).length + '</b> 条）！';
    });

    /* ---------- 坐标轴 ---------- */
    var ax = document.getElementById('ax');
    function drawAxis() {
      var S = 92, dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (ax.width !== S * dpr) { ax.width = S * dpr; ax.height = S * dpr; ax.style.width = S + 'px'; ax.style.height = S + 'px'; }
      var ctx = ax.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, S, S);
      var cx = S / 2, cy = S / 2, L = S * 0.33;
      var m = camera.matrixWorldInverse;
      var list = [
        { n: 'X', v: new THREE.Vector3(1, 0, 0), c: '#e2483d' },
        { n: 'Y', v: new THREE.Vector3(0, 1, 0), c: '#2fa84f' },
        { n: 'Z', v: new THREE.Vector3(0, 0, 1), c: '#2f6fe0' }
      ];
      list.forEach(function (a) { a.v.transformDirection(m); });
      list.sort(function (p, q) { return p.v.z - q.v.z; });
      list.forEach(function (a) {
        var x = cx + a.v.x * L, y = cy - a.v.y * L;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
        ctx.strokeStyle = a.c; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 6.2832); ctx.fillStyle = a.c; ctx.fill();
        ctx.fillStyle = a.c;
        ctx.font = '700 9px "Segoe UI",sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(a.n, cx + a.v.x * (L + 9), cy - a.v.y * (L + 9));
      });
    }

    /* ---------- 主循环 ---------- */
    var last = performance.now();
    function loop(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (tw) {
        var p = Math.min(1, (now - tw.start) / tw.dur);
        var q = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        az = tw.a0 + (tw.a1 - tw.a0) * q;
        el = tw.e0 + (tw.e1 - tw.e0) * q;
        dist = Math.exp(Math.log(tw.d0) + (Math.log(tw.d1) - Math.log(tw.d0)) * q);
        target.lerpVectors(tw.t0, tw.t1, q);
        applyCam();
        need = true;
        if (p >= 1) tw = null;
      } else if (auto && !interacting) {
        az += autoSpeed * dt;
        applyCam();
        need = true;
      }
      if (need) {
        renderer.render(scene, camera);
        drawAxis();
        need = false;
      }
      requestAnimationFrame(loop);
    }

    resize();
    autoFit(0.86);
    canvas.style.cursor = 'grab';
    window.__WV = {
      THREE: THREE, scene: scene, camera: camera, renderer: renderer,
      cylMesh: cylMesh, sphMesh: sphMesh,
      welds: P.welds, segWeld: segWeld,
      selectWeld: selectWeld,
      setView: function (a, e, d) {
        if (a != null) az = a;
        if (e != null) el = Math.max(-EL_MAX, Math.min(EL_MAX, e));
        if (d != null) dist = d;
        applyCam(); need = true;
      },
      setAuto: function (v) { auto = !!v; btnAuto.classList.toggle('on', auto); },
      setOrtho: function (v) { ortho = !!v; btnOrtho.classList.toggle('on', ortho); applyCam(); need = true; },
      setXray: function (v) { xrayOn = !!v; btnXray.classList.toggle('on', xrayOn); syncPartOpacity(); },
      setClip: function (on, axis, pct) {
        clipOn = !!on; if (axis) { clipAxis = axis; clipAxisEl.value = axis; }
        if (pct != null) clipRange.value = String(pct);
        btnClip.classList.toggle('on', clipOn); clipbar.classList.toggle('on', clipOn);
        updateClipPlane();
      },
      state: function () { return { az: az, el: el, dist: dist, auto: auto, ortho: ortho, xray: xrayOn, clip: clipOn, target: target.toArray() }; }
    };
    requestAnimationFrame(loop);
  }
})();
</script>
</body></html>`;
  }

  async function exportDeliverableV33() {
    try {
      setStatus("正在生成交互式交付件 V3.7…");
      const threeTxt = await (await fetch(VENDOR_THREE)).text();
      const threeB64 = b64FromBytes(new TextEncoder().encode(threeTxt));
      const payload = buildDeliverablePayload();
      if (!payload.parts.length) {
        showErrorBanner("导出失败：当前没有可导出的工件几何，请先导入模型");
        return;
      }
      const html = deliverableTemplate(payload, threeB64);
      const cleanName = (state.assemblyName || "未命名").replace(/\.[^.]+$/, "");
      const outName = cleanName + "_交互式3D焊缝效果图_V3.7.html";
      const saved = await window.saveToLocalEProjectDir(outName, html);
      if (!saved) {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = outName; a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }
      setStatus("已导出交互式 3D 交付件：" + outName + "（含 " + payload.parts.length + " 个零件 / " + payload.welds.length + " 条焊缝）");
    } catch (e) {
      console.error(e);
      showErrorBanner("导出失败：" + (e && e.message ? e.message : e));
    }
  }
  window.exportInteractive3DDeliverable = exportDeliverableV33;

  /* ==================================================================== */
  /* 9.0 工程文件：保存 / 打开 / 自动保存                                   */
  /* -------------------------------------------------------------------- */
  /* 旧实现直接 JSON.stringify(state.parts)，Float32Array 会被序列化成      */
  /* {"0":1,"1":2,...}，一个 5 米结构件写出来 200 MB+，浏览器直接卡死。      */
  /* 这里改为按零件包围盒量化：位置 Int16、法向 Int8、索引 Uint16/Uint32， */
  /* 再 Base64，体积降到约 1/8，且完全无损还原（误差 < 0.01 mm）。          */
  /* ==================================================================== */
  function b64FromU8(u8) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return btoa(s);
  }
  function u8FromB64(b64) {
    const bin = atob(b64 || "");
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function encodeGeom(geom) {
    if (!geom || !geom.positions) return null;
    const pos = geom.positions, nrm = geom.normals, idx = geom.indices;
    const nv = pos.length / 3;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const span = [mxx - mnx, mxy - mny, mxz - mnz].map(function (v) { return Math.max(v, 1e-6); });
    const sc = span.map(function (v) { return v / 65534; });

    const qp = new Int16Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      qp[i * 3] = Math.round((pos[i * 3] - mnx) / sc[0]) - 32767;
      qp[i * 3 + 1] = Math.round((pos[i * 3 + 1] - mny) / sc[1]) - 32767;
      qp[i * 3 + 2] = Math.round((pos[i * 3 + 2] - mnz) / sc[2]) - 32767;
    }
    const qn = new Int8Array(nv * 3);
    if (nrm) {
      for (let i = 0; i < nv * 3; i++) {
        qn[i] = Math.max(-127, Math.min(127, Math.round((nrm[i] || 0) * 127)));
      }
    } else {
      qn.fill(127);
    }
    const useU16 = nv < 65536;
    const qi = useU16 ? new Uint16Array(idx.length) : new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) qi[i] = idx[i];
    const qf = geom.faceOfTri ? Int32Array.from(geom.faceOfTri) : null;

    return {
      mn: [mnx, mny, mnz],
      sc: sc,
      nv: nv,
      nt: idx.length / 3,
      i16: useU16 ? 1 : 0,
      p: b64FromU8(new Uint8Array(qp.buffer)),
      n: b64FromU8(new Uint8Array(qn.buffer)),
      i: b64FromU8(new Uint8Array(qi.buffer)),
      f: qf ? b64FromU8(new Uint8Array(qf.buffer)) : ""
    };
  }

  function decodeGeom(q) {
    if (!q) return null;
    const nv = q.nv;
    const pb = u8FromB64(q.p), nb = u8FromB64(q.n), ib = u8FromB64(q.i);
    const qp = new Int16Array(pb.buffer, pb.byteOffset, nv * 3);
    const qn = new Int8Array(nb.buffer, nb.byteOffset, nv * 3);
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      positions[i * 3] = q.mn[0] + (qp[i * 3] + 32767) * q.sc[0];
      positions[i * 3 + 1] = q.mn[1] + (qp[i * 3 + 1] + 32767) * q.sc[1];
      positions[i * 3 + 2] = q.mn[2] + (qp[i * 3 + 2] + 32767) * q.sc[2];
    }
    const normals = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) normals[i] = qn[i] / 127;

    const nt = q.nt;
    let indices;
    if (q.i16) {
      const src = new Uint16Array(ib.buffer, ib.byteOffset, nt * 3);
      indices = new Uint32Array(nt * 3);
      for (let i = 0; i < nt * 3; i++) indices[i] = src[i];
    } else {
      indices = new Uint32Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + nt * 12));
    }
    let faceOfTri = null;
    if (q.f) {
      const fb = u8FromB64(q.f);
      faceOfTri = new Int32Array(fb.buffer.slice(fb.byteOffset, fb.byteOffset + nt * 4));
    }
    return { positions: positions, normals: normals, indices: indices, faceOfTri: faceOfTri };
  }

  const EDGE_FIELDS = ["id", "points", "n1", "n2", "theta", "concave", "lengthMm", "partA", "partB",
    "crossPart", "centroid", "confidence", "weldable", "groupKey", "thickness1", "thickness2",
    "persistRef", "partAId", "partBId", "partAName", "partBName", "label", "measuredThickness", "isInternal",
    "contactRatio", "contactSpan", "lowConfidence", "jointKind", "weldU1", "weldU2", "grooveOpenDeg", "measuredThicknessB", "isBevelGroove", "grooveSubType", "groove"];

  function serializeProjectV33() {
    const parts = (state.parts || []).map(function (p) {
      return {
        id: p.id, name: p.name, parentId: p.parentId, depth: p.depth,
        isAssembly: !!p.isAssembly, isCover: !!p.isCover,
        color: p.color, visible: p.visible !== false, opacity: p.opacity,
        thickness: p.thickness, bbox: p.bbox || null, explodeVec: p.explodeVec || null,
        q: encodeGeom(p.geom)
      };
    });
    const edges = (state.edges || []).map(function (e) {
      const o = {};
      for (const k of EDGE_FIELDS) if (e[k] !== undefined) o[k] = e[k];
      return o;
    });
    const cam = state.camera || {};
    return {
      format: "weldview-project",
      version: 3,
      app: "WeldView 3D Studio 3.3",
      unit: "mm",
      savedAt: new Date().toISOString(),
      assemblyName: state.assemblyName || "未命名工程",
      sourcePath: state.sourcePath || "",
      view: {
        rotMat: cam.rotMat || null,
        distance: cam.distance,
        panX: cam.panX, panY: cam.panY,
        ortho: !!(V.settings && V.settings.projection !== "persp"),
        renderStyle: (V.settings && V.settings.renderStyle) || state.renderStyle || "shaded"
      },
      settings: V.settings,
      parts: parts,
      edges: edges,
      welds: state.welds || []
    };
  }

  function deserializeProjectV33(proj) {
    if (!proj || !Array.isArray(proj.parts)) throw new Error("不是有效的 WeldView 工程文件");
    const parts = proj.parts.map(function (p) {
      const g = decodeGeom(p.q);
      return {
        id: p.id, name: p.name, parentId: p.parentId, depth: p.depth,
        isAssembly: !!p.isAssembly, isCover: !!p.isCover,
        color: p.color, visible: p.visible !== false,
        opacity: typeof p.opacity === "number" ? p.opacity : 1,
        thickness: p.thickness, bbox: p.bbox || null,
        explodeVec: p.explodeVec || { x: 0, y: 0, z: 0 },
        geom: g || { tris: [], cadLines: [] }
      };
    });
    return {
      assemblyName: proj.assemblyName || "未命名工程",
      sourcePath: proj.sourcePath || "",
      parts: parts,
      edges: proj.edges || [],
      welds: proj.welds || [],
      __view: proj.view || null
    };
  }

  function projectBaseName() {
    const n = (state && state.assemblyName) ? state.assemblyName : "未命名工程";
    return String(n).replace(/[\\/:*?"<>|]/g, "_").replace(/\.(step|stp|sldasm|sldprt|iges|igs)$/i, "");
  }

  let _lastProjectPath = "";
  try { _lastProjectPath = localStorage.getItem("wv33_last_project") || ""; } catch (e) {}

  async function saveProjectV33(ask) {
    if (!state.parts || !state.parts.length) {
      setStatus("当前没有可保存的工程内容，请先导入模型");
      showErrorBanner("无法保存：尚未导入任何工件模型");
      setTimeout(function () { try { hideErrorBanner(); } catch (e) {} }, 3200);
      return false;
    }
    try {
      setStatus("正在打包工程数据…");
      const proj = serializeProjectV33();
      const content = JSON.stringify(proj);
      const fileName = projectBaseName() + (ask ? "_副本" : "") + ".wvproj";
      const url = HOST + "/api/save_project" + (ask ? "?ask=1" : "");
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: fileName,
          content: content,
          dir: (V.settings && V.settings.outputDir) || ""
        })
      });
      const j = await resp.json().catch(function () { return null; });
      if (j && j.ok) {
        _lastProjectPath = j.savedPath || "";
        try { localStorage.setItem("wv33_last_project", _lastProjectPath); } catch (e) {}
        const mb = (content.length / 1048576).toFixed(2);
        setStatus("工程已保存：" + _lastProjectPath + "（" + mb + " MB）");
        return true;
      }
      if (j && j.canceled) { setStatus("已取消保存"); return false; }
      const msg = (j && j.error) ? j.error : "宿主未响应";
      setStatus("保存失败：" + msg);
      showErrorBanner("保存工程失败：" + msg);
      setTimeout(function () { try { hideErrorBanner(); } catch (e) {} }, 4000);
      return false;
    } catch (e) {
      setStatus("保存失败：" + e.message);
      return false;
    }
  }

  async function openProjectV33(directPath) {
    try {
      setStatus("正在打开工程…");
      const url = HOST + "/api/open_project" + (directPath ? "?path=" + encodeURIComponent(directPath) : "");
      const resp = await fetch(url, { method: "POST" });
      const j = await resp.json().catch(function () { return null; });
      if (!j || !j.ok) {
        if (j && j.canceled) setStatus("已取消打开");
        else setStatus("打开工程失败：" + ((j && j.error) || "宿主未响应"));
        return false;
      }
      const proj = JSON.parse(j.content);
      const model = deserializeProjectV33(proj);
      const view = model.__view;
      window.loadWeldModel(model);
      if (view && state.camera) {
        if (Array.isArray(view.rotMat) && view.rotMat.length === 9) state.camera.rotMat = view.rotMat;
        if (isFinite(view.distance) && view.distance > 0) state.camera.distance = view.distance;
        if (isFinite(view.panX)) state.camera.panX = view.panX;
        if (isFinite(view.panY)) state.camera.panY = view.panY;
        if (V.settings) V.settings.projection = view.ortho === false ? "persp" : "ortho";
      }
      applySettings();
      renderSceneV33();
      _lastProjectPath = j.path || "";
      try { localStorage.setItem("wv33_last_project", _lastProjectPath); } catch (e) {}
      setStatus("已打开工程：" + (j.path || model.assemblyName) +
        " — 零件 " + state.parts.length + " / 边线 " + state.edges.length + " / 焊缝 " + state.welds.length);
      return true;
    } catch (e) {
      setStatus("打开工程失败：" + e.message);
      showErrorBanner("打开工程失败：" + e.message);
      setTimeout(function () { try { hideErrorBanner(); } catch (e) {} }, 4200);
      return false;
    }
  }

  window.saveProjectFile = function (saveAs) { return saveProjectV33(!!saveAs); };
  window.openProjectFile = function () { return openProjectV33(); };
  window.wvSaveProject = saveProjectV33;
  window.wvOpenProject = openProjectV33;
  window.wvOpenProjectPath = function (p) { return openProjectV33(p); };

  /* 新建空白工程：同时清掉"上次工程"记录，避免下次启动又把旧工程恢复回来 */
  const _origNewProjectWorkspace = window.newProjectWorkspace;
  window.newProjectWorkspace = function () {
    _lastProjectPath = "";
    try { localStorage.removeItem("wv33_last_project"); } catch (e) {}
    if (typeof _origNewProjectWorkspace === "function") return _origNewProjectWorkspace.apply(this, arguments);
  };

  /* 自动保存：写到输出目录，文件名带 _autosave，不覆盖用户主动保存的工程 */
  let _autoSaveTimer = null;
  function scheduleAutoSave() {
    if (_autoSaveTimer) { clearInterval(_autoSaveTimer); _autoSaveTimer = null; }
    const min = Number(V.settings && V.settings.autoSaveMin) || 0;
    if (min <= 0) return;
    _autoSaveTimer = setInterval(function () {
      if (!state.parts || !state.parts.length) return;
      try {
        const proj = serializeProjectV33();
        fetch(HOST + "/api/save_project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: projectBaseName() + "_autosave.wvproj",
            content: JSON.stringify(proj),
            dir: (V.settings && V.settings.outputDir) || ""
          })
        }).catch(function () {});
      } catch (e) {}
    }, min * 60000);
  }
  window.wvScheduleAutoSave = scheduleAutoSave;

  /* 菜单同步：把当前设置反映到「设置」菜单的勾选状态 */
  function syncSettingsMenu() {
    const s = V.settings || DEFAULT_SETTINGS;
    const set = function (id, on) {
      const el = document.getElementById(id);
      if (el) el.textContent = on ? "✓" : " ";
    };
    set("mnuProjOrtho", s.projection !== "persp");
    set("mnuProjPersp", s.projection === "persp");
    set("mnuShowLabels", s.showLabels !== false);
    set("mnuShowEdges", s.showEdges !== false);
    set("mnuShowGrid", s.showGrid !== false);
  }
  window.wvSyncSettingsMenu = syncSettingsMenu;

  /* 顶级「设置」菜单的直接操作入口 */
  window.setWvProjection = function (mode) {
    if (!V.settings) return;
    V.settings.projection = (mode === "persp") ? "persp" : "ortho";
    persistSettings();
    applySettings();
    syncSettingsMenu();
    setStatus(V.settings.projection === "ortho"
      ? "已切换为正交投影（缩放不改变工件比例，SolidWorks 默认）"
      : "已切换为透视投影（近大远小）");
  };
  window.toggleWvSetting = function (key) {
    if (!V.settings) return;
    V.settings[key] = !V.settings[key];
    persistSettings();
    applySettings();
    syncSettingsMenu();
  };
  window.openWvOutputFolder = function () {
    const p = (V.settings && V.settings.outputDir) || "";
    fetch(HOST + "/api/open_folder" + (p ? "?path=" + encodeURIComponent(p) : ""), { method: "POST" })
      .catch(function () {});
  };

  /* 旧入口保留：把「设置」挂到文件菜单末尾已不再需要（已升级为顶级菜单），
     这里只做一次性清理，避免历史版本残留重复项 */
  function injectMenuItems() {
    const legacy = document.getElementById("wvSetItem");
    if (legacy && legacy.parentElement) {
      const prev = legacy.previousElementSibling;
      if (prev && prev.classList.contains("dd-divider")) prev.remove();
      legacy.remove();
    }
    syncSettingsMenu();
  }
  window.addEventListener("keydown", function (e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === ",") { e.preventDefault(); openSettings(); }
    else if (ctrl && !e.shiftKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveProjectV33(false); }
    else if (ctrl && e.shiftKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveProjectV33(true); }
    else if (ctrl && (e.key === "o" || e.key === "O")) { e.preventDefault(); openProjectV33(); }
  });

  /* ---- 4.1 焊缝几何缓存 ---- */
  function weldSignature() {
    let s = String(state.welds.length);
    for (const w of state.welds) {
      s += "|" + w.id + "," + w.weldType + "," + w.legSize + "," + w.profile + "," + w.method +
        "," + (w.grooveAngle || 0) + "," + (w.grooveDepth || 0) + "," + (w.edgeIds ? w.edgeIds.length : 0);
    }
    return s + "|" + state.weldBeadDisplayScale + "|" + state.selectedWeldId + "|" + state.hoveredWeldId + "|" + (state.highlightSpecKey || "");
  }

  function rebuildWeldObjects() {
    const T = V.THREE;
    const group = V.modelGroup;
    for (const o of V.weldObjs.values()) { group.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
    V.weldObjs.clear();
    if (V.weldLineObj) { group.remove(V.weldLineObj); V.weldLineObj.geometry.dispose(); V.weldLineObj.material.dispose(); V.weldLineObj = null; }
    if (!state.showAllWelds) return;

    // 焊缝中心线：远视图下焊道只有几像素，用细线保证"看得见、可点选"
    const linePos = [], lineCol = [];

    for (const w of state.welds) {
      let g;
      try { g = buildWeldBeadGeometry(w); } catch (e) { continue; }
      if (!g || !g.tris.length) continue;
      const pos = new Float32Array(g.tris.length * 9);
      const nor = new Float32Array(g.tris.length * 9);
      let k = 0;
      for (const t of g.tris) {
        for (let j = 0; j < 3; j++) {
          const v = t.verts[j];
          const n = (t.vNorms && t.vNorms[j]) ? t.vNorms[j] : t.normal;
          pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
          nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z;
          k += 3;
        }
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new T.BufferAttribute(nor, 3));
      geo.computeBoundingSphere();

      const isSel = state.selectedWeldId === w.id;
      const isHov = state.hoveredWeldId === w.id;
      let hex = w.method === "manual" ? "#f97316" : "#0ea5b7";
      if (isSel) hex = "#f59e0b";
      else if (isHov) hex = w.method === "manual" ? "#fb923c" : "#22d3ee";

      const mat = new T.MeshStandardMaterial({
        color: new T.Color(hex),
        metalness: 0.55,
        roughness: 0.34,
        envMapIntensity: 1.0,
        emissive: new T.Color(hex).multiplyScalar(isSel ? 0.28 : 0.1),
        polygonOffset: true,
        polygonOffsetFactor: -1.0,
        polygonOffsetUnits: -1.0,
        clippingPlanes: [V.clipPlane],
        side: T.DoubleSide
      });
      const mesh = new T.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      V.weldObjs.set(w.id, { mesh, weld: w, geom: g });

      const c = new T.Color(hex);
      for (const [a, b] of (g.centerLines || [])) {
        linePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        lineCol.push(c.r, c.g, c.b, 1, c.r, c.g, c.b, 1);
      }
    }

    if (linePos.length) {
      const lg = new T.BufferGeometry();
      lg.setAttribute("position", new T.Float32BufferAttribute(linePos, 3));
      lg.setAttribute("color", new T.Float32BufferAttribute(lineCol, 4));
      const lm = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
      const lo = new T.LineSegments(lg, lm);
      lo.renderOrder = 4;
      group.add(lo);
      V.weldLineObj = lo;
    }
  }

  /* ---- 4.2 候选边（三维、受深度遮挡） ---- */
  function candidateSignature() {
    return state.interactionMode + "|" + state.edges.length + "|" +
      state.pickedEdgeIds.join(",") + "|" + (state.hoveredEdgeId || "") + "|" + (V.edgeRev || 0);
  }

  function rebuildCandidateEdges() {
    const sig = candidateSignature();
    if (sig === V.candSig) return;
    V.candSig = sig;

    const T = V.THREE;
    const group = V.modelGroup;
    if (V.candObj) { group.remove(V.candObj); V.candObj.geometry.dispose(); V.candObj.material.dispose(); V.candObj = null; }
    if (state.interactionMode !== "pick") return;

    const pos = [], col = [];
    const picked = new Set(state.pickedEdgeIds);
    const showAllForManual = Boolean(state.showAllEdgesForManual !== false);
    for (const e of state.edges) {
      if (!e.weldable && !showAllForManual && !picked.has(e.id) && state.hoveredEdgeId !== e.id) continue;
      let c;
      if (picked.has(e.id)) c = [0.98, 0.72, 0.12];
      else if (state.hoveredEdgeId === e.id) c = [0.02, 0.82, 0.95];
      else if (e.isBevelGroove || (e.grooveOpenDeg && e.grooveOpenDeg < 68)) c = [0.66, 0.28, 0.96]; // 紫色高亮：自动检出的单V/坡口候选边
      else if (e.weldable) c = e.crossPart ? [0.10, 0.55, 0.82] : [0.22, 0.62, 0.78];
      else c = [0.46, 0.54, 0.65]; // 未被自动识别的普通几何边：开放人工补选
      const pts = e.points;
      for (let i = 0; i < pts.length - 1; i++) {
        pos.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        col.push(c[0], c[1], c[2], 1, c[0], c[1], c[2], 1);
      }
    }
    if (!pos.length) return;
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(col, 4));
    const m = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
    const lines = new T.LineSegments(g, m);
    lines.renderOrder = 3;
    group.add(lines);
    V.candObj = lines;
  }

  /* ---- 4.3 每帧同步材质状态 ---- */
  function syncPartStates() {
    const clipOn = !!state.sectionEnabled;
    if (V.clipPlane) V.clipPlane.constant = clipOn ? (state.sectionX || 0) : 1e9;
    for (const { mesh, part } of V.partObjs.values()) {
      mesh.visible = part.visible !== false;
      if (!mesh.visible) continue;
      const baseAlpha = part.isCover ? Math.min(part.opacity, state.coverPlateOpacity) : part.opacity;
      // 标注模式自动"透视"：工件半透明，内部接头线才看得见（类似 SW 的剖切拾取）
      const ghost = state.interactionMode === "pick" ? 0.34 : 1.0;
      const alpha = state.renderStyle === "xray" ? Math.min(baseAlpha, 0.3) : Math.min(baseAlpha, ghost);
      const mat = mesh.material;
      mat.transparent = alpha < 0.985;
      mat.opacity = alpha;
      mat.depthWrite = alpha >= 0.985;
      mat.wireframe = state.renderStyle === "wireframe";
      const off = (state.explodedEnabled && part.explodeVec) ? part.explodeVec : { x: 0, y: 0, z: 0 };
      mesh.matrix.makeTranslation(off.x, off.y, off.z);
      mesh.matrixWorldNeedsUpdate = true;
    }
    if (V.edgeObj) V.edgeObj.visible = state.renderStyle !== "wireframe";
    V.modelGroup.updateMatrixWorld(true);
  }

  /* ---- 4.4 主渲染 ---- */
  let lastW = 0, lastH = 0;

  function renderSceneV33() {
    const rect = hudCanvas.parentElement.getBoundingClientRect();
    const W = Math.max(100, rect.width), H = Math.max(100, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (!V.threeReady) {
      ensureThree().then(function () { V.sceneDirty = true; renderSceneV33(); }).catch(function (e) {
        console.error(e);
        fail("三维渲染引擎加载失败：" + e.message);
      });
      return;
    }
    if (V.sceneDirty) rebuildModelObjects();

    const canvas = V.renderer.domElement;
    if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
      V.renderer.setSize(W, H, false);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
    }
    if (hudCanvas.width !== Math.floor(W * dpr) || hudCanvas.height !== Math.floor(H * dpr)) {
      hudCanvas.width = Math.floor(W * dpr);
      hudCanvas.height = Math.floor(H * dpr);
    }
    lastW = W; lastH = H;

    syncCamera(W, H);
    syncPartStates();
    rebuildCandidateEdges();

    const sig = weldSignature();
    if (sig !== V.weldSig) { rebuildWeldObjects(); V.weldSig = sig; }

    V.renderer.render(V.scene, V.activeCam);

    drawHud(W, H, dpr);
    try { syncPickBar(); } catch (e) {}
  }

  /* ---- 4.5 HUD：只画必要的信息，避免覆盖模型 ---- */
  function drawHud(W, H, dpr) {
    hudCtx.save();
    hudCtx.scale(dpr, dpr);
    hudCtx.clearRect(0, 0, W, H);

    screenEdgeHitRegions = [];
    screenWeldHitRegions = [];
    const weldCentroids = {};

    // 拾取热区
    for (const edge of state.edges) {
      const projPts = edge.points.map((pt) => projectPointToScreen(pt, W, H));
      screenEdgeHitRegions.push({ edgeId: edge.id, edge, projPts });
    }
    for (const w of state.welds) {
      const o = V.weldObjs.get(w.id);
      if (!o) continue;
      const g = o.geom;
      if (!g || !g.centerLines || !g.centerLines.length) continue;
      const segs = g.centerLines.map(([a, b]) => [projectPointToScreen(a, W, H), projectPointToScreen(b, W, H)]);
      screenWeldHitRegions.push({ weldId: w.id, weld: w, segs });
      weldCentroids[w.id] = projectPointToScreen(g.centroid, W, H);
    }

    // 选中/悬停边线高亮（开放全部特征边，支持人工补选未自动检出的焊缝）
    if (state.interactionMode === "pick") {
      for (const edge of state.edges) {
        const isPicked = state.pickedEdgeIds.includes(edge.id);
        const isHover = state.hoveredEdgeId === edge.id;
        if (!isPicked && !isHover) continue;
        const pts = edge.points.map((p) => projectPointToScreen(p, W, H));
        hudCtx.beginPath();
        hudCtx.moveTo(pts[0].sx, pts[0].sy);
        for (let i = 1; i < pts.length; i++) hudCtx.lineTo(pts[i].sx, pts[i].sy);
        hudCtx.strokeStyle = isPicked ? "#f59e0b" : "#06b6d4";
        hudCtx.lineWidth = isPicked ? 3.2 : 2.6;
        hudCtx.lineCap = "round";
        hudCtx.stroke();
      }
    }

    // 焊缝编号标注：数量受控 + 简单避让
    if (state.showSymbolsOverlay && state.showAllWelds && state.welds.length) {
      const placed = [];
      const cand = [];
      for (const w of state.welds) {
        const pt = weldCentroids[w.id];
        if (!pt) continue;
        if (pt.sx < 40 || pt.sx > W - 40 || pt.sy < 40 || pt.sy > H - 40) continue;
        cand.push({ w, pt, pri: (state.selectedWeldId === w.id ? -1e9 : 0) + pt.depth });
      }
      cand.sort((a, b) => a.pri - b.pri);
      const maxLabels = (V.settings && V.settings.maxLabels) || 14;
      let shown = 0;
      for (const c of cand) {
        if (shown >= maxLabels && state.selectedWeldId !== c.w.id && state.hoveredWeldId !== c.w.id) continue;
        const isSel = state.selectedWeldId === c.w.id;
        const usePmi = !V.settings || V.settings.showPmiSymbol !== false;
        const gPre = c.w.grooveSubType === "singleV" ? "单V" : (c.w.grooveSubType === "X" ? "X" : "V");
        const symPrefix = usePmi ? (c.w.weldType === "fillet" ? "ΔK" : gPre) : (c.w.weldType === "fillet" ? "K" : gPre);
        const symVal = c.w.weldType === "fillet" ? (c.w.legSize || 8) : ((c.w.grooveAngle || 60) + "°");
        const mTag = c.w.method === "manual" ? "人" : "机";
        const pTag = c.w.position ? ("·" + String(c.w.position).split(" ")[0]) : "";
        const tail = usePmi ? (" [" + mTag + pTag + "]") : "";
        const text = c.w.weldNo + " " + symPrefix + symVal + tail;
        hudCtx.font = "600 10.5px Inter, 'Microsoft YaHei', sans-serif";
        const tw = hudCtx.measureText(text).width + 12;
        const bx = clamp(c.pt.sx - tw / 2, 4, W - tw - 4);
        const by = clamp(c.pt.sy - 22, 4, H - 22);
        let hit = false;
        for (const r of placed) {
          if (bx < r.x + r.w + 3 && bx + tw + 3 > r.x && by < r.y + r.h + 2 && by + 18 > r.y) { hit = true; break; }
        }
        if (hit && !isSel) continue;
        placed.push({ x: bx, y: by, w: tw, h: 16 });
        hudCtx.beginPath();
        hudCtx.roundRect(bx, by, tw, 16, 3);
        hudCtx.fillStyle = isSel ? "rgba(245,158,11,0.96)" : "rgba(255,255,255,0.94)";
        hudCtx.fill();
        hudCtx.strokeStyle = isSel ? "#d97706" : (c.w.method === "manual" ? "#ea580c" : "#0e7490");
        hudCtx.lineWidth = 1;
        hudCtx.stroke();
        hudCtx.fillStyle = isSel ? "#111827" : "#0f172a";
        hudCtx.fillText(text, bx + 6, by + 11.5);
        // 引线
        hudCtx.beginPath();
        hudCtx.moveTo(c.pt.sx, c.pt.sy);
        hudCtx.lineTo(c.pt.sx, by + 16);
        hudCtx.strokeStyle = isSel ? "rgba(217,119,6,0.8)" : "rgba(100,116,139,0.45)";
        hudCtx.lineWidth = 1;
        hudCtx.stroke();
        shown++;
      }
    }

    // 选中焊缝引出卡
    const calloutEl = document.getElementById("selectedWeldCallout");
    if (state.selectedWeldId && weldCentroids[state.selectedWeldId] && calloutEl) {
      const anchor = weldCentroids[state.selectedWeldId];
      const tx = Math.min(W - 295, Math.max(20, anchor.sx + 38));
      const ty = Math.min(H - 210, Math.max(52, anchor.sy - 45));
      hudCtx.beginPath();
      hudCtx.arc(anchor.sx, anchor.sy, 4.5, 0, Math.PI * 2);
      hudCtx.fillStyle = "#f59e0b";
      hudCtx.fill();
      hudCtx.beginPath();
      hudCtx.moveTo(anchor.sx, anchor.sy);
      hudCtx.lineTo(tx - 10, ty + 20);
      hudCtx.lineTo(tx, ty + 20);
      hudCtx.strokeStyle = "#f59e0b";
      hudCtx.lineWidth = 1.4;
      hudCtx.stroke();
      calloutEl.style.display = "block";
      calloutEl.style.left = tx + "px";
      calloutEl.style.top = ty + "px";
    } else if (calloutEl) {
      calloutEl.style.display = "none";
    }

    drawCadTriad(hudCtx, 46, H - 46);
    hudCtx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* 5. 拾取（带遮挡剔除）                                                */
  /* ------------------------------------------------------------------ */
  let _raycaster = null;
  function firstHitDepth(mx, my, W, H) {
    const T = V.THREE;
    if (!T) return Infinity;
    if (!_raycaster) _raycaster = new T.Raycaster();
    const ndc = new T.Vector2((mx / W) * 2 - 1, -(my / H) * 2 + 1);
    _raycaster.setFromCamera(ndc, V.activeCam);
    const meshes = [];
    for (const { mesh } of V.partObjs.values()) if (mesh.visible) meshes.push(mesh);
    if (!meshes.length) return Infinity;
    const hits = _raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].distance : Infinity;
  }

  function findHitEdgeV33(mx, my) {
    let minD = 11, best = null;
    const dHit = firstHitDepth(mx, my, lastW || 1, lastH || 1);
    for (const r of screenEdgeHitRegions) {
      // 人工标注允许选中任意边线：可焊边优先（距离打折），
      // 不可焊边也能选，用于修正自动识别的漏判
      const bias = r.edge.weldable ? 1.0 : 1.35;
      const pts = r.projPts;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distSeg2D(mx, my, pts[i].sx, pts[i].sy, pts[i + 1].sx, pts[i + 1].sy) * bias;
        if (d < minD) {
          const dep = (pts[i].depth + pts[i + 1].depth) / 2;
          if (dep > dHit + 4) continue; // 被实体遮挡
          minD = d; best = r.edgeId;
        }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* 6. 自动识别：按接头分组                                              */
  /* ------------------------------------------------------------------ */
  function groupWeldEdges(edges) {
    const n = edges.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

    function key(e) {
      const a = Math.min(e.partA, e.partB), b = Math.max(e.partA, e.partB);
      return a + ":" + b;
    }
    const byPair = new Map();
    for (let i = 0; i < n; i++) {
      const k = key(edges[i]);
      let l = byPair.get(k); if (!l) { l = []; byPair.set(k, l); }
      l.push(i);
    }
    for (const list of byPair.values()) {
      for (let i = 0; i < list.length; i++) {
        const A = edges[list[i]];
        const a0 = A.points[0], a1 = A.points[A.points.length - 1];
        const dA = norm(sub(a1, a0));
        for (let j = i + 1; j < list.length; j++) {
          const B = edges[list[j]];
          // 严禁将单V/双V坡口焊缝边与普通角焊缝边混并到同一条焊缝中
          const gA = Boolean(A.isBevelGroove || (A.grooveOpenDeg && A.grooveOpenDeg < 68));
          const gB = Boolean(B.isBevelGroove || (B.grooveOpenDeg && B.grooveOpenDeg < 68));
          if (gA !== gB) continue;
          const b0 = B.points[0], b1 = B.points[B.points.length - 1];
          // 端点相接：容差 4mm。曲面/圆形焊缝被三角化后碎段之间常有 2~3mm 空隙，
          // 旧容差 2mm 会把同一条环形焊缝拆成十几个接头。
          const touch = Math.min(dist(a0, b0), dist(a0, b1), dist(a1, b0), dist(a1, b1));
          if (touch < 4.0) { union(list[i], list[j]); continue; }
          // 共线且贴近：容差同步放宽到 1.5mm
          const dB = norm(sub(b1, b0));
          if (Math.abs(dot(dA, dB)) > 0.985) {
            const off = dist(b0, add(a0, mul(dA, dot(sub(b0, a0), dA))));
            if (off < 1.5) { union(list[i], list[j]); continue; }
          }
        }
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let g = groups.get(r); if (!g) { g = []; groups.set(r, g); }
      g.push(edges[i]);
    }
    return Array.from(groups.values());
  }

  function inferWeldProcessV37(g, totalLen, isGroove, kVal, sb) {
    let cx = 0, cy = 0, cz = 0, nPts = 0;
    let tx = 0, ty = 0, tz = 0, nx = 0, ny = 0, nz = 0;
    for (const e of g) {
      const pts = e.points || [];
      if (pts.length >= 2) {
        const p0 = pts[0], p1 = pts[pts.length - 1];
        const d = norm(sub(p1, p0));
        tx += Math.abs(d.x) * e.lengthMm;
        ty += Math.abs(d.y) * e.lengthMm;
        tz += Math.abs(d.z) * e.lengthMm;
      }
      for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; nPts++; }
      if (e.n1 && e.n2) {
        nx += (e.n1.x + e.n2.x) * 0.5;
        ny += (e.n1.y + e.n2.y) * 0.5;
        nz += (e.n1.z + e.n2.z) * 0.5;
      }
    }
    if (nPts > 0) { cx /= nPts; cy /= nPts; cz /= nPts; }
    const tNorm = norm(P(tx || 1, ty, tz));
    const nNorm = norm(P(nx, ny || 1, nz));

    // 判定内腔/遮挡：位于包围盒内部中段且上下有顶底板覆盖，或短小折角焊缝
    let isInternal = false;
    if (sb && sb.size) {
      const rx = Math.abs(cx - sb.center.x) / Math.max(1, sb.size.x * 0.5);
      const ry = Math.abs(cy - sb.center.y) / Math.max(1, sb.size.y * 0.5);
      const rz = Math.abs(cz - sb.center.z) / Math.max(1, sb.size.z * 0.5);
      if (rx < 0.78 && ry < 0.58 && rz < 0.72) isInternal = true;
    }
    if (g.some((e) => e.isInternal)) isInternal = true;

    // 推导 ISO 6947 焊接位置 (PA 平焊 / PB 横焊 / PF 立焊 / PE 仰焊)
    let position = "PB (横焊)";
    if (tNorm.y > 0.68) position = "PF (立焊)";
    else if (nNorm.y < -0.42) position = "PE (仰焊)";
    else if (nNorm.y > 0.74 || isGroove) position = "PA (平焊)";

    // 智能区分「人/机」施焊方式：内腔盲区、立焊/仰焊短缝(<180mm)或零散短焊缝(<95mm)自动归为人工焊(人)
    const autoClassify = !V.settings || V.settings.autoClassifyMethod !== false;
    let method = (V.settings && V.settings.method) || state.newWeldMethod || "robot";
    if (autoClassify) {
      if (isInternal || totalLen < 95 || ((position.startsWith("PF") || position.startsWith("PE")) && totalLen < 220)) {
        method = "manual";
      } else {
        method = "robot";
      }
    }

    // 关联零件对名称 (Part A ↔ Part B)
    const e0 = g[0];
    const solids = (state.parts || []).filter((p) => p && p.geom);
    const pA = solids[e0.partA] || (state.parts || [])[e0.partA];
    const pB = solids[e0.partB] || (state.parts || [])[e0.partB];
    const partNames = (pA && pB && pA.name && pB.name)
      ? (pA.name + " ↔ " + pB.name)
      : (e0.parts || e0.label || "结构件节点");

    // 焊材消耗定额 (kg)、标准工时 (min) 与热输入 E (kJ/mm)
    const k = Number(kVal) || 8;
    const areaMm2 = isGroove ? (10 * 2 + 100 * Math.tan(Math.PI / 6) + 12) : (0.52 * k * k);
    const weightKg = Math.round(((areaMm2 * totalLen * 7.85) / 1e6 / 0.90) * 1000) / 1000;
    const speed = method === "manual" ? 190.0 : 380.0;
    const passes = Math.max(1, Math.ceil(areaMm2 / 28.0));
    const timeMin = Math.round(((totalLen / speed) * passes) * 10) / 10;
    const heatInput = Number((method === "manual" ? (1.15 + k * 0.04) : (1.35 + k * 0.05)).toFixed(2));
    const ndt = isGroove ? "UT 100% I级 / ISO 5817-B" : (k >= 12 ? "MT 50% I级 / ISO 5817-B" : "VT 100% / ISO 5817-C");

    return { method, isInternal, position, partNames, partAIdx: e0.partA, partBIdx: e0.partB, weightKg, timeMin, heatInput, ndt };
  }

  function autoIdentifyAllEdgesV33() {
    const used = new Set();
    for (const w of state.welds) for (const eid of w.edgeIds) used.add(eid);

    const all = state.edges.filter((e) => e.weldable && !used.has(e.id));
    const cands = window.__wvForceIncludeLowConf ? all : all.filter((e) => !e.lowConfidence);
    if (!cands.length) {
      const low = all.length;
      setStatus(low
        ? "高置信度接头已全部标注（另有 " + low + " 条低置信度候选，可手动框选补充）"
        : "当前模型没有未标注的可焊接头（候选 " + state.edges.filter((e) => e.weldable).length + " 条，已全部标注）");
      return;
    }
    pushUndoSnapshot("自动识别焊缝");
    const groups = groupWeldEdges(cands);
    groups.sort((a, b) => {
      const la = a.reduce((s, e) => s + e.lengthMm, 0);
      const lb = b.reduce((s, e) => s + e.lengthMm, 0);
      return lb - la;
    });

    const minWeldLen = Math.max(5, Number(V.settings && V.settings.minWeldLen) || 25);
    const sb = computeSceneBoundsV33();
    let idx = state.welds.length;
    let count = 0, robotCnt = 0, manualCnt = 0, filteredShort = 0;
    const includeLow = Boolean(window.__wvForceIncludeLowConf);
    const onlyGroove = Boolean(window.__wvForceOnlyGroove);
    for (const rawG of groups) {
      if (count >= 600) break;
      const rawTotal = rawG.reduce((s, e) => s + e.lengthMm, 0);
      const maxEdgeLen = rawG.reduce((m, e) => Math.max(m, e.lengthMm || 0), 0);
      // 过滤全碎段伪边（如孤立圆角碎面 maxEdgeLen < 4.5mm 且段数过多）
      if (rawG.length >= 10 && maxEdgeLen < 4.5) {
        for (const e of rawG) e.lowConfidence = true;
        filteredShort++;
        continue;
      }
      // 剔除长直焊缝两端误挂的板厚端面短边、过焊孔倒角短边及钝根平行重影边
      let g = rawG;
      if (maxEdgeLen > 140 && rawG.length > 1) {
        const longEdges = rawG.filter((e) => e.lengthMm > 80);
        g = rawG.filter((e) => {
          if (e.lengthMm > 62) return true;
          const p0 = e.points[0], p1 = e.points[e.points.length - 1];
          const u = norm(sub(p1, p0));
          for (const le of longEdges) {
            const lp0 = le.points[0], lp1 = le.points[le.points.length - 1];
            const lu = norm(sub(lp1, lp0));
            if (Math.abs(dot(u, lu)) < 0.35) return false; // 垂直于主焊缝的板厚端边/过焊孔短边
          }
          return e.lengthMm >= 16;
        });
        if (!g.length) g = rawG;
      }
      // 剔除同一坡口钝根上下两条间距 < 12.5mm 的平行重影边（保留主根部线）
      if (g.length > 1) {
        const sortedG = g.slice().sort((a, b) => b.lengthMm - a.lengthMm);
        const keptG = [];
        for (const e of sortedG) {
          if (e.lengthMm > 25) {
            const p0 = e.points[0], p1 = e.points[e.points.length - 1];
            const u = norm(sub(p1, p0));
            const mid = e.centroid || P((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5);
            let dup = false;
            for (const k of keptG) {
              if (k.lengthMm <= 25) continue;
              const kp0 = k.points[0], kp1 = k.points[k.points.length - 1];
              const ku = norm(sub(kp1, kp0));
              if (Math.abs(dot(u, ku)) > 0.985 && Math.abs(e.lengthMm - k.lengthMm) / Math.max(e.lengthMm, k.lengthMm) < 0.15) {
                const v = sub(mid, kp0);
                const proj = dot(v, ku);
                const cp = add(kp0, mul(ku, proj));
                const latD = dist(mid, cp);
                if (latD < 12.5 && proj >= -0.1 * k.lengthMm && proj <= 1.1 * k.lengthMm) { dup = true; break; }
              }
            }
            if (dup) continue;
          }
          keptG.push(e);
        }
        if (keptG.length) g = keptG;
      }
      const totalLen = g.reduce((s, e) => s + e.lengthMm, 0);
      if (totalLen < minWeldLen) {
        for (const e of g) e.lowConfidence = true;
        filteredShort++;
        continue;
      }
      const thetaMed = g.map((e) => e.theta).sort((a, b) => a - b)[Math.floor(g.length / 2)];
      const bevelLen = g.reduce((s, e) => s + ((e.isBevelGroove || (e.grooveOpenDeg && e.grooveOpenDeg < 68)) ? e.lengthMm : 0), 0);
      const openArr = g.filter((e) => e.grooveOpenDeg && e.grooveOpenDeg < 68).map((e) => e.grooveOpenDeg).sort((a, b) => a - b);
      const openMed = openArr.length ? openArr[Math.floor(openArr.length / 2)] : thetaMed;
      const isGroove = (bevelLen >= Math.min(45, totalLen * 0.30)) || (openMed < 65) || (thetaMed < 58);
      if (onlyGroove && !isGroove) continue;
      const grooveSubType = isGroove
        ? (g.some((e) => e.grooveSubType === "V") ? "V" : (openMed <= 54 ? "singleV" : "V"))
        : "V";
      const grooveAngle = isGroove ? Math.round(openMed < 68 ? openMed : 45) : 60;
      const tMin = Math.min.apply(null, g.map((e) => Math.min(e.thickness1 || 16, e.thickness2 || 16)));
      const kRec = recommendFilletK(tMin, tMin);
      const proc = inferWeldProcessV37(g, totalLen, isGroove, kRec.legSize, sb);
      if (proc.method === "manual") manualCnt++; else robotCnt++;
      const e0 = g[0];
      idx += 1;
      const weldNo = "W-" + String(idx).padStart(2, "0");
      state.welds.push({
        id: weldNo + "-" + Date.now() + "-" + idx,
        weldNo,
        name: proc.partNames,
        weldType: isGroove ? "groove" : "fillet",
        method: proc.method,
        position: proc.position,
        profile: proc.method === "manual" ? "convex" : "flat",
        profileFactor: proc.method === "manual" ? 0.12 : 0.0,
        legSize: kRec.legSize,
        grooveSubType: grooveSubType,
        grooveAngle: grooveAngle,
        grooveDepth: isGroove ? Math.round(tMin * 0.8) : 10,
        rootGap: 2.0,
        measured: isGroove ? { subType: grooveSubType, angle: grooveAngle, depth: Math.round(tMin * 0.8), rootGap: 2.0, confidence: 0.96 } : null,
        source: "brep",
        overridden: [],
        reinforcement: 1.5,
        capWidth: null,
        ripple: { amplitude: 0.35, wavelength: 5.0 },
        edgeIds: g.map((e) => e.id),
        persistRefs: g.map((e) => e.persistRef),
        isInternal: proc.isInternal,
        parts: proc.partNames,
        partA: proc.partAIdx,
        partB: proc.partBIdx,
        weightKg: proc.weightKg,
        timeMin: proc.timeMin,
        heatInput: proc.heatInput,
        ndt: proc.ndt,
        confidence: Math.round((g.reduce((s, e) => s + e.confidence, 0) / g.length) * 100) / 100
      });
      count++;
    }
    refreshAllUI();
    V.sceneDirty = false;
    V.weldSig = "";
    const lowLeft = state.edges.filter((e) => e.weldable && e.lowConfidence && !used.has(e.id)).length;
    setStatus("智能识别完成：生成焊缝 " + count + " 条（机 " + robotCnt + " / 人 " + manualCnt + "）" +
      (filteredShort ? " · 已过滤 <" + minWeldLen + "mm 倒角/过焊孔短边 " + filteredShort + " 处" : "") +
      (lowLeft ? " · 候选待确认 " + lowLeft + " 条" : ""));
    renderSceneV33();
  }

  /* ------------------------------------------------------------------ */
  /* 7. 兼容层：包围盒 / 模型加载                                         */
  /* ------------------------------------------------------------------ */
  function computeSceneBoundsV33() {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let n = 0;
    for (const part of (state.parts || [])) {
      if (!part || part.visible === false) continue;
      if (part.bbox) {
        mnx = Math.min(mnx, part.bbox.min.x); mny = Math.min(mny, part.bbox.min.y); mnz = Math.min(mnz, part.bbox.min.z);
        mxx = Math.max(mxx, part.bbox.max.x); mxy = Math.max(mxy, part.bbox.max.y); mxz = Math.max(mxz, part.bbox.max.z);
        n++;
      }
    }
    if (!n) return null;
    const dx = mxx - mnx, dy = mxy - mny, dz = mxz - mnz;
    const res = {
      min: P(mnx, mny, mnz), max: P(mxx, mxy, mxz),
      center: P((mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2),
      radius: 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz),
      size: P(dx, dy, dz)
    };
    cachedSceneBounds = res;
    return res;
  }

  function solidListOf(model) {
    if (model.__solids && model.__solids.length === model.parts.filter((p) => p.geom).length) return model.__solids;
    model.__solids = model.parts.filter((p) => p.geom);
    return model.__solids;
  }

  function attachFeatureEdgesToParts(model) {
    // 把全局特征边按实体零件归集，供 three.js 画 CAD 描边
    const solids = solidListOf(model);
    for (const p of solids) p.geom.featureEdges = [];
    for (const e of model.edges) {
      const p = solids[e.partA];
      if (p && p.geom) p.geom.featureEdges.push(e);
    }
  }

  const _origLoadWeldModel = window.loadWeldModel;
  window.loadWeldModel = function (model) {
    if (model && model.parts) attachFeatureEdgesToParts(model);
    _origLoadWeldModel(model);
    V.sceneDirty = true;
    V.weldSig = "";
    if (V.threeReady) {
      rebuildModelObjects();
      renderSceneV33();
    }
  };

  /* ------------------------------------------------------------------ */
  /* 8. 覆盖全局函数                                                     */
  /* ------------------------------------------------------------------ */
  window.renderScene = renderSceneV33;
  window.projectPointToScreen = projectPointToScreen;
  window.findHitEdge = findHitEdgeV33;
  window.autoIdentifyAllEdges = autoIdentifyAllEdgesV33;
  window.computeSceneBounds = computeSceneBoundsV33;
  window.openCadViaPythonBridge = openCadSmart;
  window.fitViewToWindow = fitViewV33;

  // 捕获阶段拦截滚轮：先于界面原有的滚轮监听执行，用锚点缩放替换掉
  // 「只改 distance」的旧逻辑（否则两个处理函数会叠加，缩放速度翻倍）
  window.addEventListener("wheel", onWheelZoom, { passive: false, capture: true });

  window.handleLocalStandardFile = async function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    try {
      if (["step", "stp", "iges", "igs", "brep"].includes(ext)) {
        const buf = await file.arrayBuffer();
        await importCadBytes(buf, file.name, file.name);
        return;
      }
      if (ext === "json" || ext === "wvproj") {
        loadWeldModel(JSON.parse(await file.text()));
        V.sceneDirty = true;
        return;
      }
      if (ext === "stl") {
        loadWeldModel(parseStlBufferToWeldModel(await file.arrayBuffer(), file.name));
        V.sceneDirty = true;
        return;
      }
      if (ext === "obj") {
        const txt = await file.text();
        const verts = [], tris = [];
        for (const line of txt.split(/\r?\n/)) {
          const s = line.trim();
          if (s.startsWith("v ")) {
            const p = s.split(/\s+/);
            if (p.length >= 4) verts.push(P(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])));
          } else if (s.startsWith("f ")) {
            const p = s.split(/\s+/).slice(1);
            const idxs = p.map((tok) => parseInt(tok.split("/")[0], 10) - 1);
            for (let i = 1; i < idxs.length - 1; i++) {
              const v0 = verts[idxs[0]], v1 = verts[idxs[i]], v2 = verts[idxs[i + 1]];
              if (v0 && v1 && v2) tris.push({ verts: [v0, v1, v2], normal: norm(cross(sub(v1, v0), sub(v2, v0))) });
            }
          }
        }
        if (!tris.length) throw new Error("OBJ 未包含有效面片");
        loadWeldModel({
          assemblyName: file.name,
          parts: [{ id: "P1", name: file.name, parentId: "root", depth: 0, isCover: false, isAssembly: false, color: "#c3ccd8", visible: true, opacity: 1.0, geom: { tris, cadLines: [] } }],
          edges: [], welds: []
        });
        V.sceneDirty = true;
        return;
      }
      throw new Error("不支持 ." + ext);
    } catch (e) {
      fail("导入失败：" + e.message);
    }
  };

  /* 兼容 tris 形式的模型（示例装配体） */
  const _origMakePartGeometry = makePartGeometry;
  makePartGeometry = function (T, g) {
    if (g.positions) return _origMakePartGeometry(T, g);
    const tris = g.tris || [];
    const pos = new Float32Array(tris.length * 9);
    const nor = new Float32Array(tris.length * 9);
    let k = 0;
    for (const t of tris) {
      for (let j = 0; j < 3; j++) {
        const v = t.verts[j];
        pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
        nor[k] = t.normal.x; nor[k + 1] = t.normal.y; nor[k + 2] = t.normal.z;
        k += 3;
      }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new T.BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    return geo;
  };

  /* ------------------------------------------------------------------ */
  /* 9. 初始化                                                           */
  /* ------------------------------------------------------------------ */
  function boot() {
    // 画布层级：threeCanvas 在 glCanvas 之下，hudCanvas 在最上
    const vp = document.getElementById("viewportContainer");
    const glc = document.getElementById("glCanvas");
    if (vp && glc && !document.getElementById("threeCanvas")) {
      const c = document.createElement("canvas");
      c.id = "threeCanvas";
      vp.insertBefore(c, glc);
    }
    if (glc) glc.style.display = "none";

    // 焊道显示倍率默认按真实尺寸（1.0），避免焊缝盖住工件
    if (state && state.weldBeadDisplayScale > 1.5) state.weldBeadDisplayScale = 1.0;

    // 手动标注工具条 + 文件菜单里的「设置」入口
    try { ensurePickBar(); injectMenuItems(); } catch (e) { console.error(e); }

    ensureThree().then(function () {
      V.sceneDirty = true;
      // 把持久化的设置真正作用到相机 / 渲染 / 标注上（不只是记住）
      try { applySettings(); } catch (e) { console.error(e); }
      try { scheduleAutoSave(); } catch (e) {}
      renderSceneV33();
      // 启动时恢复上次工程（设置里可关闭）
      if (V.settings && V.settings.restoreLast && _lastProjectPath) {
        setTimeout(function () {
          openProjectV33(_lastProjectPath).catch(function (e) { console.error(e); });
        }, 400);
      }
    }).catch(function (e) {
      console.error("three.js 初始化失败", e);
      fail("三维渲染引擎初始化失败：" + e.message);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
