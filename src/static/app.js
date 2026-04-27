/* Splitup frontend */
(() => {

  // ---------- constants ----------
  const FRAME_W = 1080, FRAME_H = 1920;

  // ---------- state ----------
  const state = {
    video: null,
    sceneChanges: [],
    segments: [],
    activeIdx: 0,
    jobId: null,
    transcribeJobId: null,
    words: [],
    transcribed: false,

    // absolute coordinates in the 1080×1920 frame
    text_x: 540, text_y: 200,
    caption_x: 540, caption_y: 1440,

    lastWordKey: "",
    presets: [],  // {name, factory, settings}
  };

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const drop = $("drop"), fileInput = $("file");
  const editor = $("editor"), segmentsSec = $("segments"), progressSec = $("progress");
  const meta = $("meta");

  const preview = $("preview");
  const bg = $("bg"), fg = $("fg");
  const bgDim = $("bgDim"), shadowBox = $("shadowBox");
  const overlayText = $("overlayText"), captionEl = $("caption");
  const draggingHint = $("draggingHint");

  const baseTitleEl = $("baseTitle");
  const target = $("target"), targetVal = $("targetVal");
  const fgScale = $("fgScale"), fgVal = $("fgVal");
  const blur = $("blur"), blurVal = $("blurVal");
  const bgDimRange = $("bgDimRange"), dimVal = $("dimVal");

  const showTitle = $("showTitle");
  const textSize = $("textSize"), textSizeVal = $("textSizeVal");
  const textColor = $("textColor"), textBox = $("textBox");

  const shadowOn = $("shadowOn");
  const shadowBlur = $("shadowBlur"), shadowBlurVal = $("shadowBlurVal");
  const shadowOp = $("shadowOp"), shadowOpVal = $("shadowOpVal");
  const shadowOffX = $("shadowOffX"), shadowOffY = $("shadowOffY");

  const capOn = $("capOn"), capModel = $("capModel");
  const transcribeBtn = $("transcribeBtn");
  const capStatus = $("capStatus"), capFill = $("capFill");
  const capSize = $("capSize"), capSizeVal = $("capSizeVal");
  const capColor = $("capColor"), capOutlineColor = $("capOutlineColor");
  const capOutline = $("capOutline");
  const capWPL = $("capWPL");
  const capBold = $("capBold"), capUpper = $("capUpper");
  const capPop = $("capPop");

  const presetGrid = $("presetGrid");
  const presetName = $("presetName"), presetSaveLocalBtn = $("presetSaveLocalBtn");
  const presetExportBtn = $("presetExportBtn"), presetImportFile = $("presetImportFile");

  const playBtn = $("playBtn"), scrubber = $("scrubber");
  const transportTime = $("transportTime"), muteBtn = $("muteBtn");

  const detectBtn = $("detectBtn"), rebuildBtn = $("rebuildBtn"), renderBtn = $("renderBtn");
  const revealBtn = $("revealBtn");

  const segList = $("segList"), segCount = $("segCount"), segLabel = $("segLabel");
  const seekStart = $("seekStart"), seekEnd = $("seekEnd");

  const progressFill = $("progressFill"), progressText = $("progressText");
  const progressCurrent = $("progressCurrent"), errorsEl = $("errors");
  const loader = $("loader"), loaderText = $("loaderText");

  // ---------- helpers ----------
  const fmt = s => {
    s = Math.max(0, s | 0);
    const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, sec = s % 60;
    return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
             : `${m}:${String(sec).padStart(2,"0")}`;
  };
  const showLoader = msg => { loaderText.textContent = msg || "working"; loader.classList.remove("hidden"); };
  const hideLoader = () => loader.classList.add("hidden");
  const escapeHtml = s => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function previewScale() { return preview.getBoundingClientRect().width / FRAME_W; }
  function px(framePx) { return (framePx * previewScale()).toFixed(1) + "px"; }

  function buildOutlineShadow(width, color) {
    if (width <= 0) return "none";
    const w = width * previewScale();
    const offsets = [];
    for (let dx = -w; dx <= w; dx += w) for (let dy = -w; dy <= w; dy += w)
      if (dx || dy) offsets.push(`${dx.toFixed(1)}px ${dy.toFixed(1)}px 0 ${color}`);
    return offsets.join(", ");
  }

  // ---------- drag-and-drop file upload ----------
  ["dragenter","dragover"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover"); }));
  ["dragleave","drop"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hover"); }));
  drop.addEventListener("drop", e => { if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener("change", e => { if (e.target.files?.length) handleFile(e.target.files[0]); });

  async function handleFile(file) {
    showLoader("uploading");
    const fd = new FormData(); fd.append("video", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      state.video = await r.json();
      onVideoLoaded();
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally { hideLoader(); }
  }

  function onVideoLoaded() {
    drop.classList.add("hidden");
    editor.classList.remove("hidden");

    const url = `/api/source/${state.video.id}`;
    bg.src = url; fg.src = url; bg.muted = true; fg.muted = false;

    meta.textContent =
      `${state.video.width}×${state.video.height} · ${state.video.fps}fps · ${fmt(state.video.duration)}`;

    fg.addEventListener("play",      () => { bg.play(); playBtn.textContent = "❚❚"; });
    fg.addEventListener("pause",     () => { bg.pause(); playBtn.textContent = "▶"; });
    fg.addEventListener("seeked",    () => { bg.currentTime = fg.currentTime; });
    fg.addEventListener("timeupdate", onPlayheadUpdate);
    fg.addEventListener("loadedmetadata", () => {
      scrubber.max = Math.floor(fg.duration * 100);
      transportTime.textContent = `${fmt(0)} / ${fmt(fg.duration)}`;
      // shadow box should match foreground aspect ratio
      shadowBox.style.aspectRatio = `${state.video.width} / ${state.video.height}`;
    });

    new ResizeObserver(updateOverlayLive).observe(preview);

    refreshPresetList();
    restoreLastSettings();
    updateOverlayLive();

    // auto-transcribe in the background
    autoTranscribe();
  }

  function onPlayheadUpdate() {
    if (Math.abs(bg.currentTime - fg.currentTime) > 0.25) bg.currentTime = fg.currentTime;
    if (!scrubber.matches(":active")) scrubber.value = Math.floor(fg.currentTime * 100);
    transportTime.textContent = `${fmt(fg.currentTime)} / ${fmt(fg.duration || 0)}`;
    updateCaptionLive();
  }

  // ---------- transport ----------
  playBtn.addEventListener("click", () => fg.paused ? fg.play() : fg.pause());
  muteBtn.addEventListener("click", () => {
    fg.muted = !fg.muted;
    muteBtn.textContent = fg.muted ? "🔇" : "🔊";
  });
  scrubber.addEventListener("input", () => {
    fg.currentTime = parseFloat(scrubber.value) / 100;
  });
  preview.addEventListener("dblclick", e => {
    if (e.target.closest(".overlay-text, .caption")) return;
    fg.paused ? fg.play() : fg.pause();
  });

  // ---------- live preview ----------
  function updateOverlayLive() {
    const scale = previewScale();

    // foreground / background
    fg.style.width = fgScale.value + "%";

    bg.style.filter = `blur(${(parseFloat(blur.value) * 0.6).toFixed(1)}px)`;
    bgDim.style.opacity = (parseFloat(bgDimRange.value) / 100).toFixed(2);

    // drop shadow (CSS preview matches FG aspect ratio)
    if (shadowOn.checked) {
      shadowBox.style.opacity = (parseFloat(shadowOp.value) / 100).toFixed(2);
      shadowBox.style.width = fgScale.value + "%";
      shadowBox.style.filter = `blur(${(parseFloat(shadowBlur.value) * scale).toFixed(1)}px)`;
      const ox = parseFloat(shadowOffX.value) * scale;
      const oy = parseFloat(shadowOffY.value) * scale;
      shadowBox.style.transform = `translate(calc(-50% + ${ox.toFixed(1)}px), calc(-50% + ${oy.toFixed(1)}px))`;
    } else {
      shadowBox.style.opacity = 0;
    }

    // title — anchored at (text_x, text_y) where text_y is the TOP of the text
    const tSize = parseInt(textSize.value, 10);
    overlayText.style.fontSize = px(tSize);
    overlayText.style.color = textColor.value;
    overlayText.style.left = px(state.text_x);
    overlayText.style.top  = px(state.text_y);
    overlayText.style.transform = "translateX(-50%)";  // center horizontally on text_x
    overlayText.style.right = "auto"; overlayText.style.bottom = "auto";

    const seg = state.segments[state.activeIdx];
    const titleStr = seg?.title || baseTitleEl.value || "Your title";
    overlayText.classList.toggle("hidden-overlay", !showTitle.checked);
    overlayText.classList.toggle("draggable", true);
    overlayText.innerHTML = textBox.checked
      ? `<span class="pill">${escapeHtml(titleStr)}</span>`
      : escapeHtml(titleStr);

    // value labels
    targetVal.textContent      = `${target.value}s`;
    fgVal.textContent          = `${fgScale.value}%`;
    blurVal.textContent        = blur.value;
    dimVal.textContent         = `${bgDimRange.value}%`;
    textSizeVal.textContent    = `${textSize.value}px`;
    shadowBlurVal.textContent  = shadowBlur.value;
    shadowOpVal.textContent    = `${shadowOp.value}%`;
    capSizeVal.textContent     = `${capSize.value}px`;

    updateCaptionLive();
    saveLastSettings();
  }

  function updateCaptionLive() {
    const enabled = capOn.checked && state.words.length > 0;
    captionEl.classList.toggle("hidden-overlay", !enabled);
    if (!enabled) return;

    const t = fg.currentTime;
    const wpl = Math.max(1, parseInt(capWPL.value, 10));
    let activeText = "", key = "";
    if (wpl === 1) {
      const w = state.words.find(w => t >= w.start && t < w.end);
      if (w) { activeText = w.word; key = `${w.start.toFixed(2)}_${w.word}`; }
    } else {
      for (let i = 0; i < state.words.length; i += wpl) {
        const grp = state.words.slice(i, i + wpl);
        if (!grp.length) continue;
        const s = grp[0].start, e = grp[grp.length - 1].end;
        if (t >= s && t < e) {
          activeText = grp.map(g => g.word).join(" ");
          key = `${s.toFixed(2)}_${activeText}`;
          break;
        }
      }
    }
    if (capUpper.checked) activeText = activeText.toUpperCase();

    // styling
    const cSize = parseInt(capSize.value, 10);
    captionEl.style.color = capColor.value;
    captionEl.style.fontSize = px(cSize);
    captionEl.style.fontWeight = capBold.checked ? "800" : "500";
    captionEl.style.textShadow = buildOutlineShadow(parseInt(capOutline.value, 10), capOutlineColor.value);
    captionEl.style.left = px(state.caption_x);
    captionEl.style.top = px(state.caption_y);
    captionEl.style.right = "auto"; captionEl.style.bottom = "auto";
    captionEl.style.transform = "translate(-50%, -50%)";
    captionEl.classList.add("draggable");

    // pop-in: re-render only when active word changes
    if (key !== state.lastWordKey) {
      state.lastWordKey = key;
      if (activeText) {
        const wantPop = capPop.checked;
        captionEl.innerHTML = `<span class="word ${wantPop ? "popping" : ""}">${escapeHtml(activeText)}</span>`;
      } else {
        // placeholder when no current word — keeps the caption box draggable when paused
        const sample = state.words[0]?.word || "CAPTIONS";
        captionEl.innerHTML = `<span class="word placeholder">${escapeHtml(capUpper.checked ? sample.toUpperCase() : sample)}</span>`;
      }
    }
  }

  // ---------- inputs wiring ----------
  const liveInputs = [target, fgScale, blur, bgDimRange,
    showTitle, textSize, textColor, textBox,
    shadowOn, shadowBlur, shadowOp, shadowOffX, shadowOffY,
    capOn, capSize, capColor, capOutlineColor, capOutline,
    capWPL, capBold, capUpper, capPop, capModel];
  liveInputs.forEach(el => el.addEventListener("input", updateOverlayLive));
  baseTitleEl.addEventListener("input", () => { refreshSegmentTitles(); updateOverlayLive(); });

  function refreshSegmentTitles() {
    const base = baseTitleEl.value || "Clip";
    state.segments.forEach((s, i) => {
      if (/Part \d+$/.test(s.title)) s.title = `${base} Part ${i + 1}`;
    });
    renderSegments();
  }

  // ---------- anchor buttons ----------
  document.querySelectorAll(".anchor").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target, pos = btn.dataset.pos;
      if (target === "title") {
        const sz = parseInt(textSize.value, 10);
        if (pos === "top")    state.text_y = 160;
        if (pos === "center") state.text_y = Math.round((FRAME_H - sz * 1.4) / 2);
        if (pos === "bottom") state.text_y = FRAME_H - 160 - Math.round(sz * 1.4);
      } else {
        if (pos === "top")    state.caption_y = 240;
        if (pos === "center") state.caption_y = FRAME_H / 2;
        if (pos === "lower")  state.caption_y = FRAME_H - 480;
        if (pos === "bottom") state.caption_y = FRAME_H - 240;
      }
      updateOverlayLive();
    });
  });

  // ---------- drag-to-move overlays ----------
  function startDrag(el, getPos, setPos, axis = "y") {
    let startX, startY, origX, origY;
    el.addEventListener("mousedown", e => {
      if (!showTitle.checked && el === overlayText) return;
      e.preventDefault();
      const scale = previewScale();
      const orig = getPos();
      origX = orig.x; origY = orig.y;
      startX = e.clientX; startY = e.clientY;
      el.classList.add("dragging");

      function onMove(ev) {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        const nx = clamp(origX + dx, 50, FRAME_W - 50);
        const ny = clamp(origY + dy, 0, FRAME_H);
        setPos(nx, ny);
        draggingHint.textContent = `x ${nx | 0}  ·  y ${ny | 0}`;
        draggingHint.classList.add("show");
        updateOverlayLive();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        el.classList.remove("dragging");
        draggingHint.classList.remove("show");
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  startDrag(
    overlayText,
    () => ({ x: state.text_x, y: state.text_y }),
    (x, y) => { state.text_x = x; state.text_y = y; },
  );
  startDrag(
    captionEl,
    () => ({ x: state.caption_x, y: state.caption_y }),
    (x, y) => { state.caption_x = x; state.caption_y = y; },
  );

  // ---------- segment seek ----------
  seekStart.addEventListener("click", () => { const s = state.segments[state.activeIdx]; if (s) fg.currentTime = s.start; });
  seekEnd.addEventListener("click",   () => { const s = state.segments[state.activeIdx]; if (s) fg.currentTime = Math.max(0, s.end - 0.2); });

  // ---------- transcription ----------
  async function autoTranscribe() {
    if (!state.video) return;
    capStatus.textContent = "starting transcription…";
    capFill.style.width = "0%";
    try {
      const r = await fetch("/api/transcribe", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id: state.video.id, model: capModel.value }),
      });
      const data = await r.json();
      if (data.cached) {
        await loadWords();
        capStatus.textContent = `cached transcript · ${state.words.length} words`;
        return;
      }
      state.transcribeJobId = data.job_id;
      pollTranscribe();
    } catch (e) {
      capStatus.textContent = "error: " + e.message;
    }
  }

  transcribeBtn.addEventListener("click", async () => {
    if (!state.video) return;
    if (!confirm("Re-transcribe with " + capModel.value + "? This deletes the cached transcript.")) return;
    await fetch(`/api/words/${state.video.id}`, { method: "DELETE" });
    state.words = [];
    autoTranscribe();
  });

  async function pollTranscribe() {
    try {
      const r = await fetch(`/api/transcribe/${state.transcribeJobId}`);
      const d = await r.json();
      capStatus.textContent = d.msg || d.status;
      capFill.style.width = ((d.progress || 0) * 100).toFixed(1) + "%";
      if (d.status === "done") {
        await loadWords();
        capStatus.textContent = `${state.words.length} words ready`;
        return;
      }
      if (d.status === "error") return;
    } catch (e) { console.warn(e); }
    setTimeout(pollTranscribe, 800);
  }

  async function loadWords() {
    const r = await fetch(`/api/words/${state.video.id}`);
    const d = await r.json();
    state.words = d.words || [];
    state.transcribed = !!d.ready;
    capFill.style.width = "100%";
    updateCaptionLive();
  }

  // ---------- detect / segments ----------
  detectBtn.addEventListener("click", async () => {
    if (!state.video) return;
    showLoader("analyzing scenes");
    try {
      const r = await fetch("/api/analyze", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id: state.video.id, threshold: 0.35 }),
      });
      const data = await r.json();
      state.sceneChanges = data.scene_changes || [];
      await buildSegments();
    } catch (err) { alert("Analyze failed: " + err.message); }
    finally { hideLoader(); }
  });
  rebuildBtn.addEventListener("click", () => buildSegments());

  async function buildSegments() {
    if (!state.video) return;
    showLoader("building segments");
    try {
      const r = await fetch("/api/segments", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          duration: state.video.duration,
          target: parseInt(target.value, 10),
          scene_changes: state.sceneChanges,
          title: baseTitleEl.value || "Clip",
        }),
      });
      state.segments = (await r.json()).segments || [];
      state.activeIdx = 0;
      segmentsSec.classList.remove("hidden");
      renderSegments(); updateOverlayLive();
    } finally { hideLoader(); }
  }

  function renderSegments() {
    segList.innerHTML = "";
    segCount.textContent = `(${state.segments.length})`;
    state.segments.forEach((seg, i) => {
      const row = document.createElement("div");
      row.className = "seg" + (i === state.activeIdx ? " active" : "");
      row.innerHTML = `
        <div class="seg-idx">${String(i + 1).padStart(2,"0")}</div>
        <input class="seg-title" type="text" value="${escapeHtml(seg.title)}" />
        <div class="seg-time">${fmt(seg.start)} → ${fmt(seg.end)}<br><span class="muted">${(seg.end - seg.start).toFixed(1)}s</span></div>
        <div class="seg-actions">
          <button data-act="preview">▶</button>
          <button data-act="del">✕</button>
        </div>`;
      const titleEl = row.querySelector(".seg-title");
      titleEl.addEventListener("input", () => { seg.title = titleEl.value; if (i === state.activeIdx) updateOverlayLive(); });
      titleEl.addEventListener("focus", () => setActive(i));
      row.addEventListener("click", () => setActive(i));
      row.querySelector('[data-act="preview"]').addEventListener("click", e => {
        e.stopPropagation(); setActive(i); fg.currentTime = seg.start; fg.play();
      });
      row.querySelector('[data-act="del"]').addEventListener("click", e => {
        e.stopPropagation();
        state.segments.splice(i, 1);
        if (state.activeIdx >= state.segments.length) state.activeIdx = Math.max(0, state.segments.length - 1);
        renderSegments();
      });
      segList.appendChild(row);
    });
  }
  function setActive(i) {
    state.activeIdx = i;
    const s = state.segments[i]; if (!s) return;
    fg.currentTime = s.start;
    segLabel.textContent = `${fmt(s.start)} → ${fmt(s.end)}`;
    [...document.querySelectorAll(".seg")].forEach((el, j) => el.classList.toggle("active", i === j));
    updateOverlayLive();
  }

  // ---------- settings serialize ----------
  function getSettings() {
    return {
      target: parseInt(target.value, 10),
      base_title: baseTitleEl.value || "Clip",
      fg_scale: parseInt(fgScale.value, 10) / 100,
      blur: parseFloat(blur.value),
      bg_dim: parseFloat(bgDimRange.value) / 100,
      show_title: showTitle.checked,
      text_size: parseInt(textSize.value, 10),
      text_color: textColor.value,
      text_x: state.text_x, text_y: state.text_y,
      text_box: textBox.checked,
      shadow: {
        enabled: shadowOn.checked,
        blur: parseFloat(shadowBlur.value),
        opacity: parseFloat(shadowOp.value) / 100,
        offset_x: parseInt(shadowOffX.value, 10),
        offset_y: parseInt(shadowOffY.value, 10),
      },
      captions: {
        enabled: capOn.checked,
        model: capModel.value,
        font: "Inter",
        size: parseInt(capSize.value, 10),
        color: capColor.value,
        outline_color: capOutlineColor.value,
        outline: parseInt(capOutline.value, 10),
        shadow: 2,
        caption_x: state.caption_x,
        caption_y: state.caption_y,
        words_per_line: parseInt(capWPL.value, 10),
        bold: capBold.checked,
        italic: false,
        uppercase: capUpper.checked,
        pop_in: capPop.checked,
      },
    };
  }

  function applySettings(s) {
    if (!s) return;
    if (s.target != null) target.value = s.target;
    if (s.base_title) baseTitleEl.value = s.base_title;
    if (s.fg_scale != null) fgScale.value = Math.round(s.fg_scale * 100);
    if (s.blur != null) blur.value = s.blur;
    if (s.bg_dim != null) bgDimRange.value = Math.round(s.bg_dim * 100);
    if (s.show_title != null) showTitle.checked = !!s.show_title;
    if (s.text_size != null) textSize.value = s.text_size;
    if (s.text_color) textColor.value = s.text_color;
    if (s.text_box != null) textBox.checked = !!s.text_box;

    // migrate old text_pos+offset → text_y if needed
    if (s.text_y != null) state.text_y = s.text_y;
    else if (s.text_pos) {
      const sz = s.text_size || 76;
      const off = s.text_offset || 180;
      if (s.text_pos === "top") state.text_y = off;
      else if (s.text_pos === "bottom") state.text_y = FRAME_H - off - Math.round(sz * 1.4);
      else state.text_y = (FRAME_H - Math.round(sz * 1.4)) / 2;
    }
    state.text_x = s.text_x != null ? s.text_x : 540;

    const sh = s.shadow || {};
    if (sh.enabled != null) shadowOn.checked = !!sh.enabled;
    if (sh.blur != null) shadowBlur.value = sh.blur;
    if (sh.opacity != null) shadowOp.value = Math.round(sh.opacity * 100);
    if (sh.offset_x != null) shadowOffX.value = sh.offset_x;
    if (sh.offset_y != null) shadowOffY.value = sh.offset_y;

    const c = s.captions || {};
    if (c.enabled != null) capOn.checked = !!c.enabled;
    if (c.model) capModel.value = c.model;
    if (c.size != null) capSize.value = c.size;
    if (c.color) capColor.value = c.color;
    if (c.outline_color) capOutlineColor.value = c.outline_color;
    if (c.outline != null) capOutline.value = c.outline;
    if (c.words_per_line != null) capWPL.value = c.words_per_line;
    if (c.bold != null) capBold.checked = !!c.bold;
    if (c.uppercase != null) capUpper.checked = !!c.uppercase;
    if (c.pop_in != null) capPop.checked = !!c.pop_in;

    if (c.caption_y != null) state.caption_y = c.caption_y;
    else if (c.position) {
      const sz = c.size || 110, mv = c.margin_v || 700;
      if (c.position === "top")    state.caption_y = mv + sz / 2;
      else if (c.position === "bottom") state.caption_y = FRAME_H - mv - sz / 2;
      else state.caption_y = FRAME_H / 2;
    }
    state.caption_x = c.caption_x != null ? c.caption_x : 540;

    updateOverlayLive();
  }

  // ---------- presets ----------
  async function refreshPresetList() {
    try {
      const r = await fetch("/api/presets");
      const d = await r.json();
      state.presets = d.presets || [];
      renderPresetCards();
    } catch {}
  }

  function renderPresetCards() {
    presetGrid.innerHTML = "";
    state.presets.forEach(p => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "preset-card" + (p.factory ? "" : " user");
      card.innerHTML = `
        <div class="preset-name">${escapeHtml(p.name)}</div>
        <div class="preset-tag">${p.factory ? "factory" : "user"}</div>
        ${p.factory ? "" : `<button class="preset-del" data-name="${escapeHtml(p.name)}" title="delete">✕</button>`}
      `;
      card.addEventListener("click", e => {
        if (e.target.classList.contains("preset-del")) return;
        applySettings(p.settings);
      });
      const delBtn = card.querySelector(".preset-del");
      if (delBtn) {
        delBtn.addEventListener("click", async e => {
          e.stopPropagation();
          if (!confirm(`Delete preset "${p.name}"?`)) return;
          await fetch(`/api/presets/${encodeURIComponent(p.name)}`, { method: "DELETE" });
          await refreshPresetList();
        });
      }
      presetGrid.appendChild(card);
    });
  }

  presetSaveLocalBtn.addEventListener("click", async () => {
    const name = (presetName.value || "").trim();
    if (!name) return alert("name?");
    const r = await fetch("/api/presets", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ name, settings: getSettings() }),
    });
    if (!r.ok) return alert(await r.text());
    presetName.value = "";
    await refreshPresetList();
  });

  presetExportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(getSettings(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (baseTitleEl.value || "splitup") + ".preset.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
  presetImportFile.addEventListener("change", async e => {
    const f = e.target.files?.[0]; if (!f) return;
    try { applySettings(JSON.parse(await f.text())); }
    catch (err) { alert("Couldn't load preset: " + err.message); }
    e.target.value = "";
  });

  function saveLastSettings() {
    try { localStorage.setItem("splitup.last", JSON.stringify(getSettings())); } catch {}
  }
  function restoreLastSettings() {
    try {
      const s = localStorage.getItem("splitup.last");
      if (s) applySettings(JSON.parse(s));
    } catch {}
  }

  // ---------- render ----------
  renderBtn.addEventListener("click", async () => {
    if (!state.segments.length) return alert("No segments to render");
    if (capOn.checked && !state.words.length) {
      const ok = confirm("Captions enabled but transcript not ready. Render without captions?");
      if (!ok) return;
    }
    const r = await fetch("/api/render", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ id: state.video.id, segments: state.segments, settings: getSettings() }),
    });
    state.jobId = (await r.json()).job_id;
    progressSec.classList.remove("hidden");
    errorsEl.textContent = "";
    revealBtn.disabled = true;
    pollRender();
  });

  async function pollRender() {
    if (!state.jobId) return;
    try {
      const r = await fetch(`/api/render/${state.jobId}`);
      const data = await r.json();
      const pct = data.total ? (data.done / data.total) * 100 : 0;
      progressFill.style.width = pct + "%";
      progressText.textContent = `${data.done || 0} / ${data.total || 0} clips`;
      progressCurrent.textContent = data.current || "";
      if (data.errors?.length) errorsEl.textContent = data.errors.join("\n\n");
      if (data.status === "done") {
        progressCurrent.textContent = "complete";
        revealBtn.disabled = false;
        revealBtn.dataset.path = data.output_dir || "";
        return;
      }
      if (data.status === "error") { progressCurrent.textContent = "error"; return; }
    } catch (e) { console.warn(e); }
    setTimeout(pollRender, 800);
  }

  revealBtn.addEventListener("click", async () => {
    await fetch("/api/reveal", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ path: revealBtn.dataset.path || "" }),
    });
  });

  // initial render
  refreshPresetList();
  updateOverlayLive();
})();
