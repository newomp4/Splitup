/* Splitup frontend */
(() => {

  // ---------- state ----------
  const state = {
    video: null,
    sceneChanges: [],
    segments: [],
    activeIdx: 0,
    jobId: null,
    transcribeJobId: null,
    words: [],          // [{word, start, end}]
    transcribed: false,
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);

  const drop = $("drop"), fileInput = $("file");
  const editor = $("editor"), segmentsSec = $("segments"), progressSec = $("progress");
  const meta = $("meta");

  const preview = $("preview");
  const bg = $("bg"), fg = $("fg");
  const bgDim = $("bgDim");
  const shadowBox = $("shadowBox");
  const overlayText = $("overlayText");
  const captionEl = $("caption");

  const baseTitleEl = $("baseTitle");
  const target = $("target"), targetVal = $("targetVal");
  const fgScale = $("fgScale"), fgVal = $("fgVal");
  const blur = $("blur"), blurVal = $("blurVal");
  const bgDimRange = $("bgDimRange"), dimVal = $("dimVal");

  const showTitle = $("showTitle");
  const textSize = $("textSize"), textSizeVal = $("textSizeVal");
  const textColor = $("textColor");
  const textPos = $("textPos");
  const textOffset = $("textOffset");
  const textBox = $("textBox");

  const shadowOn = $("shadowOn");
  const shadowBlur = $("shadowBlur"), shadowBlurVal = $("shadowBlurVal");
  const shadowOp = $("shadowOp"), shadowOpVal = $("shadowOpVal");
  const shadowOffX = $("shadowOffX"), shadowOffY = $("shadowOffY");

  const capOn = $("capOn");
  const capModel = $("capModel");
  const transcribeBtn = $("transcribeBtn");
  const capStatus = $("capStatus"), capFill = $("capFill");
  const capSize = $("capSize"), capSizeVal = $("capSizeVal");
  const capColor = $("capColor");
  const capOutlineColor = $("capOutlineColor");
  const capOutline = $("capOutline");
  const capShadow = $("capShadow");
  const capPos = $("capPos");
  const capMarginV = $("capMarginV");
  const capWPL = $("capWPL");
  const capBold = $("capBold");
  const capUpper = $("capUpper");

  const presetName = $("presetName");
  const presetList = $("presetList");
  const presetSaveLocalBtn = $("presetSaveLocalBtn");
  const presetLoadBtn = $("presetLoadBtn");
  const presetDeleteBtn = $("presetDeleteBtn");
  const presetExportBtn = $("presetExportBtn");
  const presetImportFile = $("presetImportFile");

  const detectBtn = $("detectBtn"), rebuildBtn = $("rebuildBtn"), renderBtn = $("renderBtn");
  const revealBtn = $("revealBtn");

  const segList = $("segList"), segCount = $("segCount"), segLabel = $("segLabel");
  const seekStart = $("seekStart"), seekEnd = $("seekEnd");

  const progressFill = $("progressFill"), progressText = $("progressText");
  const progressCurrent = $("progressCurrent"), errorsEl = $("errors");
  const loader = $("loader"), loaderText = $("loaderText");

  // ---------- helpers ----------
  const fmt = (s) => {
    s = Math.max(0, s | 0);
    const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, sec = s % 60;
    return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
             : `${m}:${String(sec).padStart(2,"0")}`;
  };
  const showLoader = (msg = "working") => { loaderText.textContent = msg; loader.classList.remove("hidden"); };
  const hideLoader = () => loader.classList.add("hidden");
  const escapeHtml = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

  // ratio between preview pixels and the 1080×1920 render canvas
  function previewScale() { return preview.getBoundingClientRect().width / 1080; }
  function px(targetPx) { return (targetPx * previewScale()).toFixed(1) + "px"; }
  function buildOutlineShadow(width, color) {
    if (width <= 0) return "none";
    const w = width * previewScale();
    const offsets = [];
    for (let dx = -w; dx <= w; dx += w) for (let dy = -w; dy <= w; dy += w) if (dx || dy) offsets.push(`${dx.toFixed(1)}px ${dy.toFixed(1)}px 0 ${color}`);
    return offsets.join(", ");
  }

  // ---------- drag & drop ----------
  ["dragenter","dragover"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover"); })
  );
  ["dragleave","drop"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hover"); })
  );
  drop.addEventListener("drop", e => {
    if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", e => {
    if (e.target.files?.length) handleFile(e.target.files[0]);
  });

  async function handleFile(file) {
    showLoader("uploading");
    const fd = new FormData(); fd.append("video", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      state.video = data;
      onVideoLoaded();
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally { hideLoader(); }
  }

  function onVideoLoaded() {
    drop.classList.add("hidden");
    editor.classList.remove("hidden");

    const url = `/api/source/${state.video.id}`;
    bg.src = url; fg.src = url; bg.muted = true;

    meta.textContent =
      `${state.video.width}×${state.video.height} · ${state.video.fps}fps · ${fmt(state.video.duration)}`;

    fg.addEventListener("play",   () => bg.play());
    fg.addEventListener("pause",  () => bg.pause());
    fg.addEventListener("seeked", () => { bg.currentTime = fg.currentTime; });
    fg.addEventListener("timeupdate", () => {
      if (Math.abs(bg.currentTime - fg.currentTime) > 0.25) bg.currentTime = fg.currentTime;
      updateCaptionLive();
    });

    // resize observer to keep px scaling correct
    new ResizeObserver(() => updateOverlayLive()).observe(preview);

    refreshPresetList();
    restoreLastSettings();
    updateOverlayLive();
  }

  // ---------- live preview ----------
  function updateOverlayLive() {
    // foreground / background
    fg.style.width = fgScale.value + "%";

    const pxBlur = (parseFloat(blur.value) * 0.6).toFixed(1) + "px";
    bg.style.filter = `blur(${pxBlur})`;
    bgDim.style.opacity = (parseFloat(bgDimRange.value) / 100).toFixed(2);

    // drop shadow
    if (shadowOn.checked) {
      shadowBox.style.opacity = (parseFloat(shadowOp.value) / 100).toFixed(2);
      shadowBox.style.width = fgScale.value + "%";
      shadowBox.style.filter = `blur(${(parseFloat(shadowBlur.value) * previewScale()).toFixed(1)}px)`;
      const ox = parseFloat(shadowOffX.value) * previewScale();
      const oy = parseFloat(shadowOffY.value) * previewScale();
      shadowBox.style.transform = `translate(calc(-50% + ${ox.toFixed(1)}px), calc(-50% + ${oy.toFixed(1)}px))`;
    } else {
      shadowBox.style.opacity = 0;
    }

    // title text
    overlayText.style.color = textColor.value;
    overlayText.style.fontSize = px(parseInt(textSize.value, 10));
    overlayText.style.top = "auto";
    overlayText.style.bottom = "auto";
    overlayText.style.transform = "none";
    const off = px(parseInt(textOffset.value || 0, 10));
    if (textPos.value === "top")    overlayText.style.top = off;
    if (textPos.value === "bottom") overlayText.style.bottom = off;
    if (textPos.value === "center") {
      overlayText.style.top = "50%";
      overlayText.style.transform = "translateY(-50%)";
    }

    const seg = state.segments[state.activeIdx];
    const title = seg?.title || baseTitleEl.value || "Your title";
    overlayText.style.display = showTitle.checked ? "block" : "none";
    overlayText.innerHTML = textBox.checked
      ? `<span class="pill">${escapeHtml(title)}</span>`
      : escapeHtml(title);

    // value labels
    targetVal.textContent  = `${target.value}s`;
    fgVal.textContent      = `${fgScale.value}%`;
    blurVal.textContent    = blur.value;
    dimVal.textContent     = `${bgDimRange.value}%`;
    textSizeVal.textContent = `${textSize.value}px`;
    shadowBlurVal.textContent = shadowBlur.value;
    shadowOpVal.textContent = `${shadowOp.value}%`;
    capSizeVal.textContent = `${capSize.value}px`;

    updateCaptionLive();
    saveLastSettings();
  }

  function updateCaptionLive() {
    if (!capOn.checked || !state.words.length) {
      captionEl.style.display = "none";
      return;
    }
    captionEl.style.display = "block";

    const t = fg.currentTime;
    const wpl = Math.max(1, parseInt(capWPL.value, 10));
    let activeText = "";
    if (wpl === 1) {
      const w = state.words.find(w => t >= w.start && t < w.end);
      if (w) activeText = w.word;
    } else {
      // group every wpl words
      for (let i = 0; i < state.words.length; i += wpl) {
        const grp = state.words.slice(i, i + wpl);
        if (!grp.length) continue;
        const s = grp[0].start, e = grp[grp.length - 1].end;
        if (t >= s && t < e) {
          activeText = grp.map(g => g.word).join(" ");
          break;
        }
      }
    }
    if (capUpper.checked) activeText = activeText.toUpperCase();

    // styling
    captionEl.style.color = capColor.value;
    captionEl.style.fontSize = px(parseInt(capSize.value, 10));
    captionEl.style.fontWeight = capBold.checked ? "800" : "500";
    captionEl.style.textShadow = buildOutlineShadow(parseInt(capOutline.value, 10), capOutlineColor.value);
    captionEl.style.top = "auto";
    captionEl.style.bottom = "auto";
    captionEl.style.transform = "none";
    const mv = px(parseInt(capMarginV.value, 10));
    if (capPos.value === "top") captionEl.style.top = mv;
    else if (capPos.value === "bottom") captionEl.style.bottom = mv;
    else { captionEl.style.top = "50%"; captionEl.style.transform = "translateY(-50%)"; }

    captionEl.innerHTML = activeText ? `<span class="word">${escapeHtml(activeText)}</span>` : "";
  }

  // wire all the inputs
  const liveInputs = [target, fgScale, blur, bgDimRange,
    showTitle, textSize, textColor, textPos, textOffset, textBox,
    shadowOn, shadowBlur, shadowOp, shadowOffX, shadowOffY,
    capOn, capSize, capColor, capOutlineColor, capOutline, capShadow,
    capPos, capMarginV, capWPL, capBold, capUpper, capModel];
  liveInputs.forEach(el => el.addEventListener("input", updateOverlayLive));
  baseTitleEl.addEventListener("input", () => { refreshSegmentTitles(); updateOverlayLive(); });

  function refreshSegmentTitles() {
    const base = baseTitleEl.value || "Clip";
    state.segments.forEach((s, i) => {
      if (/Part \d+$/.test(s.title)) s.title = `${base} Part ${i + 1}`;
    });
    renderSegments();
  }

  // ---------- preview seek ----------
  seekStart.addEventListener("click", () => { const s = state.segments[state.activeIdx]; if (s) fg.currentTime = s.start; });
  seekEnd.addEventListener("click",   () => { const s = state.segments[state.activeIdx]; if (s) fg.currentTime = Math.max(0, s.end - 0.2); });

  // ---------- transcription ----------
  transcribeBtn.addEventListener("click", async () => {
    if (!state.video) return alert("Upload a video first.");
    transcribeBtn.disabled = true;
    capStatus.textContent = "queued";
    capFill.style.width = "0%";
    try {
      const r = await fetch("/api/transcribe", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id: state.video.id, model: capModel.value }),
      });
      const data = await r.json();
      if (data.cached) {
        await loadWords(); capStatus.textContent = `cached (${state.words.length} words)`; transcribeBtn.disabled = false; return;
      }
      state.transcribeJobId = data.job_id;
      pollTranscribe();
    } catch (e) {
      capStatus.textContent = "error: " + e.message;
      transcribeBtn.disabled = false;
    }
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
        transcribeBtn.disabled = false;
        return;
      }
      if (d.status === "error") {
        transcribeBtn.disabled = false;
        return;
      }
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

  // ---------- detect & segments ----------
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
      const data = await r.json();
      state.segments = data.segments || [];
      state.activeIdx = 0;
      segmentsSec.classList.remove("hidden");
      renderSegments();
      updateOverlayLive();
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
      text_pos: textPos.value,
      text_offset: parseInt(textOffset.value, 10),
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
        shadow: parseInt(capShadow.value, 10),
        position: capPos.value,
        margin_v: parseInt(capMarginV.value, 10),
        words_per_line: parseInt(capWPL.value, 10),
        bold: capBold.checked,
        italic: false,
        uppercase: capUpper.checked,
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
    if (s.text_pos) textPos.value = s.text_pos;
    if (s.text_offset != null) textOffset.value = s.text_offset;
    if (s.text_box != null) textBox.checked = !!s.text_box;
    const sh = s.shadow || {};
    shadowOn.checked = !!sh.enabled;
    if (sh.blur != null) shadowBlur.value = sh.blur;
    if (sh.opacity != null) shadowOp.value = Math.round(sh.opacity * 100);
    if (sh.offset_x != null) shadowOffX.value = sh.offset_x;
    if (sh.offset_y != null) shadowOffY.value = sh.offset_y;
    const c = s.captions || {};
    capOn.checked = !!c.enabled;
    if (c.model) capModel.value = c.model;
    if (c.size != null) capSize.value = c.size;
    if (c.color) capColor.value = c.color;
    if (c.outline_color) capOutlineColor.value = c.outline_color;
    if (c.outline != null) capOutline.value = c.outline;
    if (c.shadow != null) capShadow.value = c.shadow;
    if (c.position) capPos.value = c.position;
    if (c.margin_v != null) capMarginV.value = c.margin_v;
    if (c.words_per_line != null) capWPL.value = c.words_per_line;
    if (c.bold != null) capBold.checked = !!c.bold;
    if (c.uppercase != null) capUpper.checked = !!c.uppercase;
    updateOverlayLive();
  }

  // ---------- presets ----------
  async function refreshPresetList() {
    try {
      const r = await fetch("/api/presets");
      const d = await r.json();
      presetList.innerHTML = `<option value="">— select —</option>`
        + (d.presets || []).map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
    } catch {}
  }

  presetSaveLocalBtn.addEventListener("click", async () => {
    const name = (presetName.value || "preset").trim();
    if (!name) return;
    await fetch("/api/presets", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ name, settings: getSettings() }),
    });
    await refreshPresetList();
    presetList.value = name;
  });
  presetLoadBtn.addEventListener("click", async () => {
    const name = presetList.value; if (!name) return;
    const r = await fetch(`/api/presets/${encodeURIComponent(name)}`);
    if (r.ok) applySettings(await r.json());
  });
  presetDeleteBtn.addEventListener("click", async () => {
    const name = presetList.value; if (!name) return;
    if (!confirm(`Delete preset "${name}"?`)) return;
    await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: "DELETE" });
    await refreshPresetList();
  });

  presetExportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(getSettings(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (baseTitleEl.value || "splitup") + ".preset.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
  presetImportFile.addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const txt = await f.text();
      applySettings(JSON.parse(txt));
    } catch (err) {
      alert("Couldn't load preset: " + err.message);
    }
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
      const ok = confirm("Captions are enabled but no transcript exists yet. Render without captions?");
      if (!ok) return;
    }
    const r = await fetch("/api/render", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        id: state.video.id,
        segments: state.segments,
        settings: getSettings(),
      }),
    });
    const data = await r.json();
    state.jobId = data.job_id;
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

  updateOverlayLive();
})();
