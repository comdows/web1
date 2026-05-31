/* =============================================================
 * YOU&I 안내판 편집기 — 자체 완결형 캔버스 에디터 (의존성 없음)
 * 좌표계: 객체 기하는 보드 기준 mm. 화면은 px/mm(scale*zoom)로 환산.
 * ============================================================= */
(function () {
  "use strict";

  const DS = window.DESIGN_SYSTEM;
  const PT_TO_MM = 0.352778;
  const HANDLE = 9; // 핸들 한 변 px
  const MIN_MM = 5; // 최소 크기 mm

  // ---- 상태 ----
  let board = makeBoardFrom(DS.boards[0]);
  let objects = [];
  let selectedId = null;
  let counter = 0;

  const view = { scale: 1, zoom: 1, offsetX: 0, offsetY: 0 };
  const ui = { showGuides: true };

  // 상호작용
  let drag = null; // { mode:'move'|'resize'|'pan', handle, startX, startY, orig }
  let spaceHeld = false;

  // ---- DOM ----
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const wrap = document.getElementById("stageWrap");
  const layersEl = document.getElementById("layers");
  const propsEl = document.getElementById("props");
  const fileInput = document.getElementById("fileInput");
  const jsonInput = document.getElementById("jsonInput");
  let textarea = null; // 인라인 텍스트 편집 오버레이

  // ================= 초기화 =================
  function makeBoardFrom(preset) {
    return {
      name: preset.name,
      widthMm: preset.widthMm,
      heightMm: preset.heightMm,
      marginMm: preset.marginMm,
      radiusMm: preset.radiusMm,
      bg: DS.color(preset.bg),
    };
  }

  function init() {
    buildToolbar();
    buildBoardControls();
    fitView();
    bindEvents();
    seedSample();
    render();
    renderLayers();
    renderProps();
  }

  // 시작 시 샘플 1개(제목)
  function seedSample() {
    addText("이곳은 안내판입니다", true);
    selectedId = null;
  }

  // ================= 좌표 변환 =================
  function eff() { return view.scale * view.zoom; }
  function toScreen(x, y) { return [view.offsetX + x * eff(), view.offsetY + y * eff()]; }
  function toBoard(sx, sy) { return [(sx - view.offsetX) / eff(), (sy - view.offsetY) / eff()]; }

  function fitView() {
    resizeCanvasToWrap();
    const pad = 60;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    view.scale = Math.min((cw - pad * 2) / board.widthMm, (ch - pad * 2) / board.heightMm);
    view.zoom = 1;
    view.offsetX = (cw - board.widthMm * view.scale) / 2;
    view.offsetY = (ch - board.heightMm * view.scale) / 2;
  }

  function resizeCanvasToWrap() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ================= 렌더링 =================
  function render() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 보드
    const [bx, by] = toScreen(0, 0);
    const bw = board.widthMm * eff(), bh = board.heightMm * eff();
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.35)";
    ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
    roundRect(ctx, bx, by, bw, bh, board.radiusMm * eff());
    ctx.fillStyle = board.bg;
    ctx.fill();
    ctx.restore();

    // 객체 클리핑(보드 밖으로 안 나가게)
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, board.radiusMm * eff());
    ctx.clip();
    for (const o of objects) if (o.visible !== false) drawObject(o);
    ctx.restore();

    // 가이드
    if (ui.showGuides) drawGuides(bx, by, bw, bh);

    // 선택 박스
    const sel = getSelected();
    if (sel) drawSelection(sel);
  }

  function drawGuides(bx, by, bw, bh) {
    ctx.save();
    ctx.strokeStyle = "rgba(80,160,255,.7)";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    const m = board.marginMm * eff();
    ctx.strokeRect(bx + m, by + m, bw - 2 * m, bh - 2 * m);
    // 존 가이드
    const L = DS.layout;
    ctx.strokeStyle = "rgba(255,180,80,.45)";
    [L.titleZone, L.bodyZone, L.footerZone].forEach((z) => {
      ctx.strokeRect(bx + m, by + bh * z.top, bw - 2 * m, bh * z.height);
    });
    ctx.restore();
  }

  function drawObject(o) {
    const [sx, sy] = toScreen(o.x, o.y);
    const w = o.w * eff(), h = o.h * eff();
    switch (o.type) {
      case "image": {
        if (o._img && o._img.complete) ctx.drawImage(o._img, sx, sy, w, h);
        else { ctx.fillStyle = "#444"; ctx.fillRect(sx, sy, w, h); }
        break;
      }
      case "rect": {
        roundRect(ctx, sx, sy, w, h, (o.radiusMm || 0) * eff());
        if (o.fill && o.fill !== "none") { ctx.fillStyle = o.fill; ctx.fill(); }
        if (o.strokeW > 0) { ctx.lineWidth = o.strokeW * eff(); ctx.strokeStyle = o.stroke; ctx.stroke(); }
        break;
      }
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse(sx + w / 2, sy + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        if (o.fill && o.fill !== "none") { ctx.fillStyle = o.fill; ctx.fill(); }
        if (o.strokeW > 0) { ctx.lineWidth = o.strokeW * eff(); ctx.strokeStyle = o.stroke; ctx.stroke(); }
        break;
      }
      case "picto": drawPicto(o, sx, sy, w, h); break;
      case "text": drawText(o, sx, sy, w, h); break;
    }
  }

  function drawText(o, sx, sy, w, h) {
    const f = DS.fonts[o.fontKey] || DS.fonts.body;
    const px = o.fontSizePt * PT_TO_MM * eff();
    ctx.save();
    ctx.font = `${o.weight || f.weight} ${px}px ${f.stack}`;
    ctx.fillStyle = o.color;
    ctx.textBaseline = "top";
    ctx.textAlign = o.align || "left";
    const lines = wrapText(ctx, o.text || "", w);
    const lh = px * (o.lineHeight || 1.25);
    let tx = sx;
    if (o.align === "center") tx = sx + w / 2;
    else if (o.align === "right") tx = sx + w;
    lines.forEach((ln, i) => ctx.fillText(ln, tx, sy + i * lh));
    ctx.restore();
  }

  function drawPicto(o, sx, sy, w, h) {
    const p = DS.pictograms.find((x) => x.id === o.pictoId);
    if (!p) return;
    const s = Math.min(w, h) / 24;
    ctx.save();
    ctx.translate(sx + (w - 24 * s) / 2, sy + (h - 24 * s) / 2);
    ctx.scale(s, s);
    const path = new Path2D(p.path);
    if (p.style === "stroke") {
      ctx.strokeStyle = o.color; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.stroke(path);
    } else { ctx.fillStyle = o.color; ctx.fill(path); }
    ctx.restore();
  }

  function drawSelection(o) {
    const [sx, sy] = toScreen(o.x, o.y);
    const w = o.w * eff(), h = o.h * eff();
    ctx.save();
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, sy, w, h);
    ctx.fillStyle = "#fff";
    for (const hd of handlePoints(sx, sy, w, h)) {
      ctx.fillRect(hd.x - HANDLE / 2, hd.y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(hd.x - HANDLE / 2, hd.y - HANDLE / 2, HANDLE, HANDLE);
    }
    ctx.restore();
  }

  function handlePoints(sx, sy, w, h) {
    return [
      { k: "nw", x: sx, y: sy }, { k: "n", x: sx + w / 2, y: sy }, { k: "ne", x: sx + w, y: sy },
      { k: "e", x: sx + w, y: sy + h / 2 }, { k: "se", x: sx + w, y: sy + h },
      { k: "s", x: sx + w / 2, y: sy + h }, { k: "sw", x: sx, y: sy + h }, { k: "w", x: sx, y: sy + h / 2 },
    ];
  }

  // ================= 유틸 =================
  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function wrapText(c, text, maxW) {
    const out = [];
    for (const para of String(text).split("\n")) {
      if (para === "") { out.push(""); continue; }
      let line = "";
      const tokens = para.split(/(\s+)/);
      for (const tok of tokens) {
        const test = line + tok;
        if (c.measureText(test).width <= maxW || line === "") { line = test; continue; }
        if (c.measureText(tok).width > maxW) {
          if (line.trim() !== "") { out.push(line); line = ""; }
          let chunk = "";
          for (const ch of tok) {
            if (c.measureText(chunk + ch).width <= maxW || chunk === "") chunk += ch;
            else { out.push(chunk); chunk = ch; }
          }
          line = chunk;
        } else { out.push(line); line = tok; }
      }
      out.push(line);
    }
    return out;
  }

  function uid() { return "o" + (++counter) + "_" + Date.now().toString(36); }
  function getSelected() { return objects.find((o) => o.id === selectedId) || null; }
  function centerXY(w, h) { return { x: (board.widthMm - w) / 2, y: (board.heightMm - h) / 2 }; }

  // ================= 객체 생성 =================
  function pushObject(o) {
    objects.push(o);
    selectedId = o.id;
    render(); renderLayers(); renderProps();
    return o;
  }

  function addText(content, big) {
    const w = board.widthMm * 0.7, h = board.heightMm * 0.12;
    const c = centerXY(w, h);
    return pushObject({
      id: uid(), type: "text", name: "텍스트", visible: true,
      x: c.x, y: big ? board.heightMm * DS.layout.titleZone.top : c.y, w, h,
      text: content || "텍스트를 입력하세요",
      fontKey: big ? "heading" : "body",
      fontSizePt: big ? 90 : 36,
      weight: (DS.fonts[big ? "heading" : "body"]).weight,
      color: DS.color(big ? "cream" : "white"),
      align: "center", lineHeight: 1.25,
    });
  }

  function addRect() {
    const w = board.widthMm * 0.4, h = board.heightMm * 0.2;
    const c = centerXY(w, h);
    return pushObject({
      id: uid(), type: "rect", name: "사각형", visible: true,
      x: c.x, y: c.y, w, h, radiusMm: DS.components.plate.radiusMm,
      fill: DS.color("terracotta"), stroke: DS.color("ink"), strokeW: 0,
    });
  }

  function addEllipse() {
    const d = board.widthMm * 0.25;
    const c = centerXY(d, d);
    return pushObject({
      id: uid(), type: "ellipse", name: "원", visible: true,
      x: c.x, y: c.y, w: d, h: d,
      fill: DS.color("woodLight"), stroke: DS.color("ink"), strokeW: 0,
    });
  }

  function addPicto(pictoId) {
    const d = board.widthMm * 0.18;
    const c = centerXY(d, d);
    const p = DS.pictograms.find((x) => x.id === pictoId) || DS.pictograms[0];
    return pushObject({
      id: uid(), type: "picto", name: "픽토그램 · " + p.name, visible: true,
      x: c.x, y: c.y, w: d, h: d, pictoId: p.id, color: DS.color("cream"),
    });
  }

  function addImageFromSrc(src, name) {
    const img = new Image();
    img.onload = () => {
      const ratio = img.height / img.width;
      let w = board.widthMm * 0.6, h = w * ratio;
      if (h > board.heightMm * 0.8) { h = board.heightMm * 0.8; w = h / ratio; }
      const c = centerXY(w, h);
      const o = {
        id: uid(), type: "image", name: name || "이미지", visible: true,
        x: c.x, y: c.y, w, h, src, _img: img,
      };
      pushObject(o);
    };
    img.onerror = () => alert("이미지를 불러오지 못했습니다: " + (name || ""));
    img.src = src;
  }

  // ================= 레이어 패널 =================
  function renderLayers() {
    layersEl.innerHTML = "";
    // 위에 있는(나중 그려진) 객체를 목록 상단에
    [...objects].reverse().forEach((o) => {
      const row = document.createElement("div");
      row.className = "layer" + (o.id === selectedId ? " sel" : "");
      row.innerHTML = `
        <button class="vis" title="표시/숨김">${o.visible === false ? "🚫" : "👁"}</button>
        <span class="lname">${escapeHtml(o.name)}${o.type === "text" ? " · " + escapeHtml((o.text || "").slice(0, 12)) : ""}</span>
        <button class="up" title="위로">▲</button>
        <button class="down" title="아래로">▼</button>
        <button class="del" title="삭제">✕</button>`;
      row.querySelector(".lname").onclick = () => { selectedId = o.id; render(); renderLayers(); renderProps(); };
      row.querySelector(".vis").onclick = (e) => { e.stopPropagation(); o.visible = o.visible === false; render(); renderLayers(); };
      row.querySelector(".up").onclick = (e) => { e.stopPropagation(); reorder(o.id, +1); };
      row.querySelector(".down").onclick = (e) => { e.stopPropagation(); reorder(o.id, -1); };
      row.querySelector(".del").onclick = (e) => { e.stopPropagation(); removeObject(o.id); };
      layersEl.appendChild(row);
    });
  }

  function reorder(id, dir) {
    const i = objects.findIndex((o) => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= objects.length) return;
    [objects[i], objects[j]] = [objects[j], objects[i]];
    render(); renderLayers();
  }

  function removeObject(id) {
    objects = objects.filter((o) => o.id !== id);
    if (selectedId === id) selectedId = null;
    closeTextarea();
    render(); renderLayers(); renderProps();
  }

  // ================= 속성 패널 =================
  function renderProps() {
    const o = getSelected();
    propsEl.innerHTML = "";
    if (!o) { propsEl.innerHTML = `<p class="hint">객체를 선택하면 속성이 표시됩니다.</p>`; return; }

    const rows = [];
    rows.push(field("이름", "text", o.name, (v) => { o.name = v; renderLayers(); }));
    rows.push(numRow("X (mm)", Math.round(o.x), (v) => { o.x = v; render(); }));
    rows.push(numRow("Y (mm)", Math.round(o.y), (v) => { o.y = v; render(); }));
    rows.push(numRow("W (mm)", Math.round(o.w), (v) => { o.w = Math.max(MIN_MM, v); render(); }));
    rows.push(numRow("H (mm)", Math.round(o.h), (v) => { o.h = Math.max(MIN_MM, v); render(); }));

    if (o.type === "text") {
      rows.push(areaRow("내용", o.text, (v) => { o.text = v; render(); renderLayers(); }));
      rows.push(selectRow("폰트", Object.keys(DS.fonts).map((k) => [k, DS.fonts[k].name]), o.fontKey, (v) => { o.fontKey = v; o.weight = DS.fonts[v].weight; render(); }));
      rows.push(numRow("크기 (pt)", o.fontSizePt, (v) => { o.fontSizePt = Math.max(6, v); render(); }));
      rows.push(numRow("자간/행간 ×", o.lineHeight, (v) => { o.lineHeight = v; render(); }, 0.05));
      rows.push(selectRow("정렬", [["left", "왼쪽"], ["center", "가운데"], ["right", "오른쪽"]], o.align, (v) => { o.align = v; render(); }));
      rows.push(colorRow("색상", o.color, (v) => { o.color = v; render(); }));
    }
    if (o.type === "rect" || o.type === "ellipse") {
      rows.push(colorRow("채움", o.fill, (v) => { o.fill = v; render(); }));
      rows.push(colorRow("선 색", o.stroke, (v) => { o.stroke = v; render(); }));
      rows.push(numRow("선 두께 (mm)", o.strokeW, (v) => { o.strokeW = Math.max(0, v); render(); }, 0.5));
      if (o.type === "rect") rows.push(numRow("모서리 (mm)", o.radiusMm || 0, (v) => { o.radiusMm = Math.max(0, v); render(); }));
    }
    if (o.type === "picto") {
      rows.push(selectRow("픽토그램", DS.pictograms.map((p) => [p.id, p.name]), o.pictoId, (v) => { o.pictoId = v; o.name = "픽토그램 · " + DS.pictograms.find(p=>p.id===v).name; render(); renderLayers(); }));
      rows.push(colorRow("색상", o.color, (v) => { o.color = v; render(); }));
    }

    rows.forEach((r) => propsEl.appendChild(r));

    // 정렬/배치 버튼
    const align = document.createElement("div");
    align.className = "btnrow";
    align.innerHTML = `<button data-a="cx">↔ 가로중앙</button><button data-a="cy">↕ 세로중앙</button>`;
    align.querySelectorAll("button").forEach((b) => b.onclick = () => {
      if (b.dataset.a === "cx") o.x = (board.widthMm - o.w) / 2;
      else o.y = (board.heightMm - o.h) / 2;
      render(); renderProps();
    });
    propsEl.appendChild(align);
  }

  // 패널 위젯 헬퍼
  function rowWrap(label, input) {
    const d = document.createElement("div"); d.className = "prow";
    const l = document.createElement("label"); l.textContent = label;
    d.appendChild(l); d.appendChild(input); return d;
  }
  function field(label, type, val, on) {
    const i = document.createElement("input"); i.type = type; i.value = val;
    i.oninput = () => on(i.value); return rowWrap(label, i);
  }
  function numRow(label, val, on, step) {
    const i = document.createElement("input"); i.type = "number"; i.value = val; i.step = step || 1;
    i.oninput = () => on(parseFloat(i.value) || 0); return rowWrap(label, i);
  }
  function areaRow(label, val, on) {
    const t = document.createElement("textarea"); t.value = val; t.rows = 3;
    t.oninput = () => on(t.value); return rowWrap(label, t);
  }
  function colorRow(label, val, on) {
    const i = document.createElement("input"); i.type = "color"; i.value = toHex(val);
    i.oninput = () => on(i.value); return rowWrap(label, i);
  }
  function selectRow(label, opts, val, on) {
    const s = document.createElement("select");
    opts.forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; if (v === val) o.selected = true; s.appendChild(o); });
    s.onchange = () => on(s.value); return rowWrap(label, s);
  }

  // ================= 마우스 상호작용 =================
  function bindEvents() {
    window.addEventListener("resize", () => { fitView(); render(); });
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTyping(e)) { spaceHeld = true; wrap.classList.add("grab"); }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !isTyping(e)) { e.preventDefault(); removeObject(selectedId); }
    });
    window.addEventListener("keyup", (e) => { if (e.code === "Space") { spaceHeld = false; wrap.classList.remove("grab"); } });

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // 드래그&드롭 이미지
    wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("dragover"); });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("dragover"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault(); wrap.classList.remove("dragover");
      const f = e.dataTransfer.files[0]; if (f) loadFile(f);
    });
  }

  function isTyping(e) {
    const t = e.target.tagName;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
  }

  function mousePos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onDown(e) {
    const [mx, my] = mousePos(e);
    if (spaceHeld) { drag = { mode: "pan", startX: e.clientX, startY: e.clientY, ox: view.offsetX, oy: view.offsetY }; return; }

    // 선택된 객체 핸들 먼저
    const sel = getSelected();
    if (sel) {
      const [sx, sy] = toScreen(sel.x, sel.y);
      const w = sel.w * eff(), h = sel.h * eff();
      for (const hd of handlePoints(sx, sy, w, h)) {
        if (Math.abs(mx - hd.x) <= HANDLE && Math.abs(my - hd.y) <= HANDLE) {
          drag = { mode: "resize", handle: hd.k, sx: mx, sy: my, orig: { ...sel } };
          return;
        }
      }
    }
    // 객체 선택(위에 있는 것 우선)
    const [bxm, bym] = toBoard(mx, my);
    let hit = null;
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.visible === false) continue;
      if (bxm >= o.x && bxm <= o.x + o.w && bym >= o.y && bym <= o.y + o.h) { hit = o; break; }
    }
    if (hit) {
      selectedId = hit.id;
      drag = { mode: "move", sx: mx, sy: my, orig: { x: hit.x, y: hit.y } };
    } else {
      selectedId = null;
    }
    closeTextarea();
    render(); renderLayers(); renderProps();
  }

  function onMove(e) {
    if (!drag) { return; }
    const [mx, my] = mousePos(e);
    if (drag.mode === "pan") {
      view.offsetX = drag.ox + (e.clientX - drag.startX);
      view.offsetY = drag.oy + (e.clientY - drag.startY);
      render(); return;
    }
    const o = getSelected(); if (!o) return;
    const dxmm = (mx - drag.sx) / eff(), dymm = (my - drag.sy) / eff();
    if (drag.mode === "move") {
      o.x = drag.orig.x + dxmm; o.y = drag.orig.y + dymm;
    } else if (drag.mode === "resize") {
      applyResize(o, drag.handle, drag.orig, dxmm, dymm);
    }
    render(); renderProps();
  }

  function onUp() { drag = null; }

  function applyResize(o, k, orig, dx, dy) {
    let x = orig.x, y = orig.y, w = orig.w, h = orig.h;
    if (k.includes("e")) w = orig.w + dx;
    if (k.includes("s")) h = orig.h + dy;
    if (k.includes("w")) { w = orig.w - dx; x = orig.x + dx; }
    if (k.includes("n")) { h = orig.h - dy; y = orig.y + dy; }
    if (w < MIN_MM) { if (k.includes("w")) x = orig.x + orig.w - MIN_MM; w = MIN_MM; }
    if (h < MIN_MM) { if (k.includes("n")) y = orig.y + orig.h - MIN_MM; h = MIN_MM; }
    o.x = x; o.y = y; o.w = w; o.h = h;
  }

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return; // 일반 스크롤은 무시
    e.preventDefault();
    const [mx, my] = mousePos(e);
    const before = toBoard(mx, my);
    view.zoom = Math.max(0.1, Math.min(8, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    const after = toBoard(mx, my);
    view.offsetX += (after[0] - before[0]) * eff();
    view.offsetY += (after[1] - before[1]) * eff();
    render();
  }

  // ================= 인라인 텍스트 편집 =================
  function onDbl(e) {
    const [mx, my] = mousePos(e);
    const [bxm, bym] = toBoard(mx, my);
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.type === "text" && bxm >= o.x && bxm <= o.x + o.w && bym >= o.y && bym <= o.y + o.h) {
        selectedId = o.id; openTextarea(o); render(); renderProps(); return;
      }
    }
  }

  function openTextarea(o) {
    closeTextarea();
    const [sx, sy] = toScreen(o.x, o.y);
    const f = DS.fonts[o.fontKey] || DS.fonts.body;
    textarea = document.createElement("textarea");
    textarea.className = "inline-edit";
    textarea.value = o.text;
    Object.assign(textarea.style, {
      left: sx + "px", top: sy + "px",
      width: o.w * eff() + "px", height: o.h * eff() + "px",
      fontFamily: f.stack, fontWeight: o.weight || f.weight,
      fontSize: o.fontSizePt * PT_TO_MM * eff() + "px",
      color: o.color, textAlign: o.align || "left",
      lineHeight: (o.lineHeight || 1.25),
    });
    textarea.oninput = () => { o.text = textarea.value; render(); };
    textarea.onblur = () => closeTextarea();
    textarea.onkeydown = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); textarea.blur(); } };
    wrap.appendChild(textarea);
    textarea.focus(); textarea.select();
  }

  function closeTextarea() {
    if (textarea) { textarea.remove(); textarea = null; renderLayers(); }
  }

  // ================= 툴바 / 컨트롤 =================
  function buildToolbar() {
    on("addText", () => addText());
    on("addRect", () => addRect());
    on("addEllipse", () => addEllipse());
    on("addImage", () => fileInput.click());
    on("exportPng", exportPng);
    on("saveJson", saveJson);
    on("loadJson", () => jsonInput.click());
    on("zoomIn", () => { view.zoom = Math.min(8, view.zoom * 1.2); render(); });
    on("zoomOut", () => { view.zoom = Math.max(0.1, view.zoom / 1.2); render(); });
    on("zoomFit", () => { fitView(); render(); });
    on("toggleGuides", (b) => { ui.showGuides = !ui.showGuides; b.classList.toggle("active", ui.showGuides); render(); });

    // 픽토그램 드롭다운
    const psel = document.getElementById("pictoSelect");
    DS.pictograms.forEach((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; psel.appendChild(o); });
    document.getElementById("addPicto").onclick = () => addPicto(psel.value);

    fileInput.onchange = () => { const f = fileInput.files[0]; if (f) loadFile(f); fileInput.value = ""; };
    jsonInput.onchange = () => { const f = jsonInput.files[0]; if (f) loadJsonFile(f); jsonInput.value = ""; };
  }

  function on(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onclick = () => fn(el);
  }

  function buildBoardControls() {
    const sel = document.getElementById("boardPreset");
    DS.boards.forEach((b) => { const o = document.createElement("option"); o.value = b.id; o.textContent = b.name; sel.appendChild(o); });
    sel.onchange = () => {
      const preset = DS.boards.find((b) => b.id === sel.value);
      board = makeBoardFrom(preset);
      syncBoardInputs(); fitView(); render(); renderProps();
    };
    const bind = (id, key) => {
      const i = document.getElementById(id);
      i.oninput = () => { board[key] = parseFloat(i.value) || 0; fitView(); render(); };
    };
    bind("bWidth", "widthMm"); bind("bHeight", "heightMm");
    bind("bMargin", "marginMm"); bind("bRadius", "radiusMm");
    const bg = document.getElementById("bBg");
    bg.oninput = () => { board.bg = bg.value; render(); };
    syncBoardInputs();
  }

  function syncBoardInputs() {
    document.getElementById("bWidth").value = board.widthMm;
    document.getElementById("bHeight").value = board.heightMm;
    document.getElementById("bMargin").value = board.marginMm;
    document.getElementById("bRadius").value = board.radiusMm;
    document.getElementById("bBg").value = toHex(board.bg);
  }

  // ================= 파일 입출력 =================
  function loadFile(f) {
    if (!f.type.startsWith("image/") && !/\.svg$/i.test(f.name)) {
      alert("이미지(PNG/JPG) 또는 SVG 파일을 올려주세요.\n일러스트(.ai)는 먼저 SVG로 내보내세요.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => addImageFromSrc(reader.result, f.name);
    reader.readAsDataURL(f);
  }

  function exportPng() {
    const dpi = parseInt(document.getElementById("exportDpi").value, 10) || 150;
    const ppmm = dpi / 25.4;
    const W = Math.round(board.widthMm * ppmm), H = Math.round(board.heightMm * ppmm);
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const c = off.getContext("2d");
    // 보드 배경
    roundRect(c, 0, 0, W, H, board.radiusMm * ppmm);
    c.fillStyle = board.bg; c.fill();
    c.save(); roundRect(c, 0, 0, W, H, board.radiusMm * ppmm); c.clip();
    // 객체 (보드 0,0 기준 ppmm 스케일로 직접 렌더)
    drawAllTo(c, ppmm);
    c.restore();
    off.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `signage_${board.widthMm}x${board.heightMm}_${dpi}dpi.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  }

  // export 전용: 보드(0,0) 기준 ppmm 스케일로 객체 직접 렌더
  function drawAllTo(c, ppmm) {
    for (const o of objects) {
      if (o.visible === false) continue;
      const x = o.x * ppmm, y = o.y * ppmm, w = o.w * ppmm, h = o.h * ppmm;
      if (o.type === "image" && o._img) c.drawImage(o._img, x, y, w, h);
      else if (o.type === "rect") {
        roundRect(c, x, y, w, h, (o.radiusMm || 0) * ppmm);
        if (o.fill && o.fill !== "none") { c.fillStyle = o.fill; c.fill(); }
        if (o.strokeW > 0) { c.lineWidth = o.strokeW * ppmm; c.strokeStyle = o.stroke; c.stroke(); }
      } else if (o.type === "ellipse") {
        c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        if (o.fill && o.fill !== "none") { c.fillStyle = o.fill; c.fill(); }
        if (o.strokeW > 0) { c.lineWidth = o.strokeW * ppmm; c.strokeStyle = o.stroke; c.stroke(); }
      } else if (o.type === "picto") {
        const p = DS.pictograms.find((x2) => x2.id === o.pictoId); if (!p) continue;
        const s = Math.min(w, h) / 24;
        c.save(); c.translate(x + (w - 24 * s) / 2, y + (h - 24 * s) / 2); c.scale(s, s);
        const path = new Path2D(p.path);
        if (p.style === "stroke") { c.strokeStyle = o.color; c.lineWidth = 2; c.lineCap = "round"; c.lineJoin = "round"; c.stroke(path); }
        else { c.fillStyle = o.color; c.fill(path); }
        c.restore();
      } else if (o.type === "text") {
        const f = DS.fonts[o.fontKey] || DS.fonts.body;
        const px = o.fontSizePt * PT_TO_MM * ppmm;
        c.save(); c.font = `${o.weight || f.weight} ${px}px ${f.stack}`; c.fillStyle = o.color;
        c.textBaseline = "top"; c.textAlign = o.align || "left";
        const lines = wrapText(c, o.text || "", w);
        const lh = px * (o.lineHeight || 1.25);
        let tx = x; if (o.align === "center") tx = x + w / 2; else if (o.align === "right") tx = x + w;
        lines.forEach((ln, i) => c.fillText(ln, tx, y + i * lh));
        c.restore();
      }
    }
  }

  function saveJson() {
    const data = {
      meta: { app: "YOU&I Sign Editor", version: DS.meta.version, savedAt: new Date().toISOString() },
      board,
      objects: objects.map((o) => { const c = { ...o }; delete c._img; return c; }),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "signage_design.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function loadJsonFile(f) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.board) { board = data.board; syncBoardInputs(); }
        objects = (data.objects || []).map((o) => {
          if (o.type === "image" && o.src) {
            const img = new Image(); img.src = o.src; o._img = img;
            img.onload = render;
          }
          return o;
        });
        selectedId = null; fitView(); render(); renderLayers(); renderProps();
      } catch (err) { alert("JSON을 읽지 못했습니다: " + err.message); }
    };
    reader.readAsText(f);
  }

  // ================= 기타 헬퍼 =================
  function toHex(v) {
    if (!v) return "#000000";
    if (v[0] === "#") return v.length === 4 ? "#" + [...v.slice(1)].map((c) => c + c).join("") : v;
    return v;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // 시작
  document.addEventListener("DOMContentLoaded", init);
})();
