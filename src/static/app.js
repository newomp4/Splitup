/* Splitup frontend */
(() => {
  // ---------- state ----------
  const state = {
    video: null,           // {id, filename, width, height, fps, duration}
    sceneChanges: [],
    segments: [],
    activeIdx: 0,
    jobId: null,
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const drop = $("drop");
  const fileInput = $("file");
  const editor = $("editor");
  const segmentsSec = $("segments");
  const progressSec = $("progress");
  const meta = $("meta");

  const bg = $("bg");
  const fg = $("fg");
  const bgDim = $("bgDim");
  const overlayText = $("overlayText");

  const baseTitleEl = $("baseTitle");
  const target = $("target"), targetVal = $("targetVal");
  const fgScale = $("fgScale"), fgVal = $("fgVal");
  const blur = $("blur"), blurVal = $("blurVal");
  const bgDimRange = $("bgDimRange"), dimVal = $("dimVal");
  const textSize = $("textSize"), textSizeVal = $("textSizeVal");
  const textColor = $("textColor");
  const textPos = $("textPos");
  const textOffset = $("textOffset");
  const textBox = $("textBox");

  const detectBtn = $("detectBtn");
  const rebuildBtn = $("rebuildBtn");
  const renderBtn = $("renderBtn");
  const revealBtn = $("revealBtn");

  const segList = $("segList");
  const segCount = $("segCount");
  const segLabel = $("segLabel");
  const seekStart = $("seekStart");
  const seekEnd = $("seekEnd");

  const progressFill = $("progressFill");
  const progressText = $("progressText");
  const progressCurrent = $("progressCurrent");
  const errorsEl = $("errors");

  const loader = $("loader");
  const loaderText = $("loaderText");

  // ---------- helpers ----------
  const fmt = (s) => {
    s = Math.max(0, s | 0);
    const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, sec = s % 60;
    return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
             : `${m}:${String(sec).padStart(2,"0")}`;
  };

  const showLoader = (msg = "working") => {
    loaderText.textContent = msg;
    loader.classList.remove("hidden");
  };
  const hideLoader = () => loader.classList.add("hidden");

  // ---------- drag & drop ----------
  ["dragenter", "dragover"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover"); })
  );
  ["dragleave", "drop"].forEach(ev =>
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
    const fd = new FormData();
    fd.append("video", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      state.video = data;
      onVideoLoaded();
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      hideLoader();
    }
  }

  function onVideoLoaded() {
    drop.classList.add("hidden");
    editor.classList.remove("hidden");

    const url = `/api/source/${state.video.id}`;
    bg.src = url;
    fg.src = url;
    bg.muted = true;     // bg is silent — only fg plays audio

    meta.textContent = `${state.video.width}×${state.video.height} · ${state.video.fps}fps · ${fmt(state.video.duration)}`;

    // sync bg playback with fg
    fg.addEventListener("play", () => bg.play());
    fg.addEventListener("pause", () => bg.pause());
    fg.addEventListener("seeked", () => { bg.currentTime = fg.currentTime; });
    fg.addEventListener("timeupdate", () => {
      if (Math.abs(bg.currentTime - fg.currentTime) > 0.25) bg.currentTime = fg.currentTime;
    });

    updateOverlayLive();
  }

  // ---------- live preview wiring ----------
  function updateOverlayLive() {
    fg.style.width = fgScale.value + "%";

    const pxBlur = (parseFloat(blur.value) * 0.6).toFixed(1) + "px";
    bg.style.filter = `blur(${pxBlur})`;

    bgDim.style.opacity = (parseFloat(bgDimRange.value) / 100).toFixed(2);

    overlayText.style.color = textColor.value;
    overlayText.style.fontSize = (parseInt(textSize.value, 10) * 0.13).toFixed(1) + "px";
    overlayText.style.top  = "auto";
    overlayText.style.bottom = "auto";
    const offsetPx = (parseInt(textOffset.value || 0, 10) * 0.13).toFixed(1) + "px";
    if (textPos.value === "top")    overlayText.style.top    = offsetPx;
    if (textPos.value === "bottom") overlayText.style.bottom = offsetPx;
    if (textPos.value === "center") {
      overlayText.style.top = "50%";
      overlayText.style.transform = "translateY(-50%)";
    } else {
      overlayText.style.transform = "none";
    }

    // box behind text
    const seg = state.segments[state.activeIdx];
    const title = seg?.title || baseTitleEl.value || "Your title";
    overlayText.innerHTML = textBox.checked
      ? `<span class="pill">${escapeHtml(title)}</span>`
      : escapeHtml(title);

    // value labels
    targetVal.textContent  = `${target.value}s`;
    fgVal.textContent      = `${fgScale.value}%`;
    blurVal.textContent    = blur.value;
    dimVal.textContent     = `${bgDimRange.value}%`;
    textSizeVal.textContent = `${textSize.value}px`;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // wire up live updates
  [target, fgScale, blur, bgDimRange, textSize, textColor, textPos, textOffset, textBox, baseTitleEl]
    .forEach(el => el.addEventListener("input", () => {
      updateOverlayLive();
      // when base title changes and segments exist, refresh per-seg defaults
      if (el === baseTitleEl) refreshSegmentTitles();
    }));

  function refreshSegmentTitles() {
    const base = baseTitleEl.value || "Clip";
    state.segments.forEach((s, i) => {
      // only rename if the segment has a default-style title
      if (/Part \d+$/.test(s.title)) s.title = `${base} Part ${i + 1}`;
    });
    renderSegments();
  }

  // ---------- preview seek to active segment ----------
  seekStart.addEventListener("click", () => {
    const s = state.segments[state.activeIdx];
    if (s) fg.currentTime = s.start;
  });
  seekEnd.addEventListener("click", () => {
    const s = state.segments[state.activeIdx];
    if (s) fg.currentTime = Math.max(0, s.end - 0.2);
  });

  // ---------- detect & build ----------
  detectBtn.addEventListener("click", async () => {
    if (!state.video) return;
    showLoader("analyzing scenes");
    try {
      const r = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.video.id, threshold: 0.35 }),
      });
      const data = await r.json();
      state.sceneChanges = data.scene_changes || [];
      await buildSegments();
    } catch (err) {
      alert("Analyze failed: " + err.message);
    } finally {
      hideLoader();
    }
  });

  rebuildBtn.addEventListener("click", () => buildSegments());

  async function buildSegments() {
    if (!state.video) return;
    showLoader("building segments");
    try {
      const r = await fetch("/api/segments", {
        method: "POST", headers: { "Content-Type": "application/json" },
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
    } finally {
      hideLoader();
    }
  }

  function renderSegments() {
    segList.innerHTML = "";
    segCount.textContent = `(${state.segments.length})`;

    state.segments.forEach((seg, i) => {
      const row = document.createElement("div");
      row.className = "seg" + (i === state.activeIdx ? " active" : "");
      row.innerHTML = `
        <div class="seg-idx">${String(i + 1).padStart(2, "0")}</div>
        <input class="seg-title" type="text" value="${escapeHtml(seg.title)}" />
        <div class="seg-time">${fmt(seg.start)} → ${fmt(seg.end)}<br><span class="muted">${(seg.end - seg.start).toFixed(1)}s</span></div>
        <div class="seg-actions">
          <button data-act="preview" title="Preview this segment">▶</button>
          <button data-act="del" title="Remove">✕</button>
        </div>
      `;
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
    const s = state.segments[i];
    if (!s) return;
    fg.currentTime = s.start;
    segLabel.textContent = `${fmt(s.start)} → ${fmt(s.end)}`;
    [...document.querySelectorAll(".seg")].forEach((el, j) => el.classList.toggle("active", i === j));
    updateOverlayLive();
  }

  // ---------- render ----------
  renderBtn.addEventListener("click", async () => {
    if (!state.segments.length) return alert("No segments to render");
    const settings = {
      base_title: baseTitleEl.value || "Clip",
      fg_scale: parseInt(fgScale.value, 10) / 100,
      blur: parseFloat(blur.value),
      bg_dim: parseFloat(bgDimRange.value) / 100,
      text_size: parseInt(textSize.value, 10),
      text_color: textColor.value,
      text_pos: textPos.value,
      text_offset: parseInt(textOffset.value, 10),
      text_box: textBox.checked,
    };
    const r = await fetch("/api/render", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.video.id,
        segments: state.segments,
        settings,
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

      if (data.errors?.length) {
        errorsEl.textContent = data.errors.join("\n\n");
      }

      if (data.status === "done") {
        progressCurrent.textContent = "complete";
        revealBtn.disabled = false;
        revealBtn.dataset.path = data.output_dir || "";
        return;
      }
      if (data.status === "error") {
        progressCurrent.textContent = "error";
        return;
      }
    } catch (e) {
      console.warn(e);
    }
    setTimeout(pollRender, 800);
  }

  revealBtn.addEventListener("click", async () => {
    await fetch("/api/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: revealBtn.dataset.path || "" }),
    });
  });

  // initial labels
  updateOverlayLive();
})();
