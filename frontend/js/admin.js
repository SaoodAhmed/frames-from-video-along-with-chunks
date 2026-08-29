/* KENDUIT — admin portal logic. */
(() => {
  const $ = (id) => document.getElementById(id);
  const API = window.API;

  const TERMINAL = ["completed", "failed", "cancelled"];
  const state = {
    filter: "all",
    jobsPage: 1,
    jobsPerPage: 20,
    jobsTotal: 0,
    search: "",
    job: null,
    frames: [],
    framesPage: 1,
    framesPerPage: 50,
    framesTotal: 0,
    selected: new Set(),
    chunks: [],
    chunksPage: 1,
    chunksPerPage: 30,
    chunksTotal: 0,
    selectedChunks: new Set(),
    exportId: null,
    exportTimer: null,
    jobTimer: null,
    jobs: [],
    selectedJobs: new Set(),
    optBatch: null,
    frameView: "original",
    optMode: null,    // "job" | "bulk" | "frames"
    optTargets: [],   // job ids (job/bulk) or frame ids (frames)
    optPollTimer: null,
  };

  // ── Auth ──────────────────────────────────────────────────
  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    $("auth-submit").disabled = true;
    $("auth-err").textContent = "";
    try {
      const user = await API.login(email, password);
      if (user.role !== "admin") {
        API.logout();
        $("auth-err").textContent = "This account is not an administrator.";
        return;
      }
      enterApp();
    } catch (err) {
      $("auth-err").textContent = err.message;
    } finally {
      $("auth-submit").disabled = false;
    }
  });

  $("btn-logout").addEventListener("click", () => {
    API.logout();
    stopAllTimers();
    showAuth();
  });

  function showAuth() { $("view-auth").classList.remove("hidden"); $("view-app").classList.add("hidden"); }
  function enterApp() {
    const u = API.getUser();
    $("user-email").textContent = u ? u.email : "";
    $("view-auth").classList.add("hidden");
    $("view-app").classList.remove("hidden");
    loadStats();
    loadJobs();
  }

  // ── Sidebar / filters ─────────────────────────────────────
  document.querySelectorAll(".nav a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      // Navigating from a job detail back to the list: stop timers, clear the
      // job, and swap back to the videos view so the click is always visible.
      stopAllTimers();
      state.job = null;
      document.querySelectorAll(".nav a").forEach((x) => x.classList.remove("active"));
      a.classList.add("active");
      state.filter = a.dataset.filter;
      state.jobsPage = 1;
      $("view-title").textContent = a.textContent;
      $("view-job").classList.add("hidden");
      $("view-videos").classList.remove("hidden");
      loadJobs();
      loadStats();
    });
  });

  let searchTimer = null;
  $("search-input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = $("search-input").value.trim();
      state.jobsPage = 1;
      loadJobs();
    }, 350);
  });

  $("prev-page").addEventListener("click", () => { if (state.jobsPage > 1) { state.jobsPage--; loadJobs(); } });
  $("next-page").addEventListener("click", () => { if (state.jobsPage * state.jobsPerPage < state.jobsTotal) { state.jobsPage++; loadJobs(); } });

  // ── Stats ─────────────────────────────────────────────────
  async function loadStats() {
    try {
      const data = await API.request("/api/admin/stats");
      const s = data.stats || {};
      const total = Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0);
      $("stat-uploaded").textContent = s.uploaded ?? 0;
      $("stat-queued").textContent = (s.queued ?? 0) + (s.processing ?? 0);
      $("stat-completed").textContent = s.completed ?? 0;
      $("stat-total").textContent = total;
    } catch (err) { /* non-fatal */ }
  }

  // ── Jobs table ────────────────────────────────────────────
  async function loadJobs() {
    const q = new URLSearchParams({ page: state.jobsPage, perPage: state.jobsPerPage });
    if (state.filter !== "all") q.set("status", state.filter);
    if (state.search) q.set("search", state.search);
    const body = $("jobs-body");
    body.innerHTML = `<tr class="loading"><td colspan="10">Loading jobs…</td></tr>`;
    $("jobs-empty").classList.add("hidden");
    $("jobs-table").classList.remove("hidden");
    try {
      const data = await API.request(`/api/admin/videos?${q}`);
      state.jobsTotal = data.total;
      state.jobs = data.jobs || [];
      renderJobs(state.jobs);
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
    }
  }

  function renderJobs(jobs) {
    $("jobs-empty").classList.toggle("hidden", jobs.length > 0);
    $("jobs-table").classList.toggle("hidden", jobs.length === 0);
    const body = $("jobs-body");
    body.innerHTML = "";
    for (const j of jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" class="job-check" data-id="${j.id}" ${state.selectedJobs.has(j.id) ? "checked" : ""} /></td>
        <td class="small muted">${esc(j.user_email)}</td>
        <td class="mono">${esc(j.original_filename)}</td>
        <td>${API.fmtBytes(j.file_size)}</td>
        <td class="mono">${API.fmtDuration(j.duration)}</td>
        <td class="mono">${j.width && j.height ? `${j.width}x${j.height}` : "—"}</td>
        <td class="mono small muted">${new Date(j.created_at).toLocaleString()}</td>
        <td><span class="badge ${j.status}">${API.statusLabel(j.status)}</span></td>
        <td class="mono">${j.extracted_frames}</td>
        <td>${renderChunkCell(j)}</td>
        <td>
          <div class="row gap-8">
            <button class="btn ghost small act-view" data-id="${j.id}">View</button>
            ${["uploaded", "failed", "cancelled"].includes(j.status) ? `<button class="btn small act-process" data-id="${j.id}">Process</button>` : ""}
            ${j.status === "failed" ? `<button class="btn ghost small act-retry" data-id="${j.id}">Retry</button>` : ""}
            <button class="btn danger small act-delete" data-id="${j.id}">Delete</button>
          </div>
        </td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll(".act-view").forEach((b) => b.addEventListener("click", () => openJob(b.dataset.id)));
    body.querySelectorAll(".act-process").forEach((b) => b.addEventListener("click", () => openJob(b.dataset.id)));
    body.querySelectorAll(".act-retry").forEach((b) => b.addEventListener("click", () => retryJob(b.dataset.id)));
    body.querySelectorAll(".act-delete").forEach((b) => b.addEventListener("click", () => deleteJob(b.dataset.id)));
    body.querySelectorAll(".job-check").forEach((cb) => cb.addEventListener("change", (e) => {
      if (e.target.checked) state.selectedJobs.add(cb.dataset.id); else state.selectedJobs.delete(cb.dataset.id);
      updateBulkBar();
    }));
    $("jobs-select-all").checked = jobs.length > 0 && jobs.every((j) => state.selectedJobs.has(j.id));
    updateBulkBar();
    $("page-info").textContent = `Page ${state.jobsPage} of ${Math.max(1, Math.ceil(state.jobsTotal / state.jobsPerPage))}`;
  }

  function updateBulkBar() {
    const n = state.selectedJobs.size;
    $("bulk-bar").classList.toggle("hidden", n === 0);
    $("bulk-count").textContent = `${n} selected`;
  }

  $("jobs-select-all").addEventListener("change", (e) => {
    const checked = e.target.checked;
    for (const j of state.jobs) {
      if (checked) state.selectedJobs.add(j.id); else state.selectedJobs.delete(j.id);
    }
    renderJobs(state.jobs);
  });
  $("bulk-clear").addEventListener("click", () => { state.selectedJobs.clear(); renderJobs(state.jobs); });
  $("bulk-optimize").addEventListener("click", () => {
    if (state.selectedJobs.size === 0) return;
    openOptimizeModal("bulk", [...state.selectedJobs]);
  });

  function renderChunkCell(j) {
    if (!j.chunk_status || j.chunk_status === "none") return '<span class="muted small">—</span>';
    const cls = j.chunk_status === "completed" ? "completed" : j.chunk_status === "failed" ? "failed" : "queued";
    const label = j.chunk_status === "completed"
      ? (j.chunk_count ? `${j.chunk_count} chunks` : "done")
      : API.statusLabel(j.chunk_status);
    return `<span class="badge ${cls}">${label}</span>`;
  }

  // ── Job detail ────────────────────────────────────────────
  $("back-btn").addEventListener("click", () => {
    stopAllTimers();
    state.job = null;
    $("view-job").classList.add("hidden");
    $("view-videos").classList.remove("hidden");
    loadJobs();
    loadStats();
  });

  $("mode-select").addEventListener("change", () => {
    $("custom-fps-wrap").classList.toggle("hidden", $("mode-select").value !== "Custom FPS");
  });
  $("sharpness").addEventListener("input", () => { $("sharp-val").textContent = $("sharpness").value; });
  $("scene-threshold").addEventListener("input", () => { $("scene-val").textContent = $("scene-threshold").value; });
  $("start-process").addEventListener("click", startProcess);

  async function openJob(id) {
    stopAllTimers();
    try {
      const data = await API.request(`/api/jobs/${id}`);
      state.job = data.job;
      $("view-videos").classList.add("hidden");
      $("view-job").classList.remove("hidden");
      renderJob();
    } catch (err) {
      alert("Failed to open job: " + err.message);
    }
  }

  function renderJob() {
    const j = state.job;
    $("job-title").textContent = j.original_filename;
    const b = $("job-status-badge");
    b.className = "badge " + j.status;
    b.textContent = API.statusLabel(j.status);
    $("job-err").textContent = "";

    const meta = [
      ["User", j.user_email || "—"],
      ["Size", API.fmtBytes(j.file_size)],
      ["Duration", API.fmtDuration(j.duration)],
      ["Resolution", j.width && j.height ? `${j.width}x${j.height}` : "—"],
      ["Source FPS", j.source_fps ? j.source_fps.toFixed(2) : "—"],
      ["Total frames", j.total_source_frames ? `${j.total_source_frames} source` : "—"],
      ["Extracted", `${j.extracted_frames} frames`],
      ["Chunks", j.chunk_count ? `${j.chunk_count} split` : "—"],
      ["Optimize", j.optimize_status === "none" ? "—" : j.optimize_status === "completed"
        ? (j.opt_crf ? `H.264 crf ${j.opt_crf}${j.opt_max_dim ? ` · ≤${j.opt_max_dim}px` : ""}` : "done")
        : API.statusLabel(j.optimize_status)],
    ];
    if (j.error_message) meta.push(["Error", j.error_message]);
    if (j.chunk_error) meta.push(["Chunk Error", j.chunk_error]);
    $("job-meta").innerHTML = meta.map(([k, v]) => `<div><h3>${esc(k)}</h3><div class="meta-val">${esc(v)}</div></div>`).join("");

    // Chunk status badge
    const csb = $("chunk-status-badge");
    const cs = j.chunk_status;
    csb.className = "badge " + (cs === "completed" ? "completed" : cs === "failed" ? "failed" : cs === "cancelled" ? "cancelled" : ["queued", "processing"].includes(cs) ? "queued" : "");
    csb.textContent = cs === "none" ? "Not split" : "Chunks: " + API.statusLabel(cs);

    // Optimization status badge (independent of frame/chunk status)
    const osb = $("optimize-status-badge");
    const os = j.optimize_status;
    osb.className = "badge " + (os === "completed" ? "completed" : os === "failed" ? "failed" : os === "cancelled" ? "cancelled" : ["queued", "processing"].includes(os) ? "queued" : "");
    osb.textContent = os === "none" ? "" : os === "completed" ? "Optimized" : "Opt: " + API.statusLabel(os);

    // Actions
    const actions = $("job-actions");
    actions.innerHTML = "";
    // Cancel is available while frame extraction, chunk splitting OR optimization is active.
    if (["queued", "processing"].includes(j.status) || ["queued", "processing"].includes(j.chunk_status) || ["queued", "processing"].includes(j.optimize_status)) {
      addBtn(actions, "Cancel", "danger", cancelJob);
    }
    if (j.status === "failed" || j.status === "cancelled") {
      addBtn(actions, "Retry", "ghost", retryCurrent);
    }
    if (j.status === "completed" || j.status === "failed") {
      addBtn(actions, "Delete", "danger", () => deleteJob(j.id));
    }
    if (!["queued", "processing"].includes(j.status) && !["queued", "processing"].includes(j.chunk_status)) {
      addBtn(actions, "Split into Chunks", "", splitChunks);
    }
    // Optimize is an independent step; hidden while frames/chunks are actively
    // running and while an optimization is already queued/processing. Images
    // auto-optimize, so the button only appears to retry a failed one.
    const optIdle = !["queued", "processing"].includes(j.status) && !["queued", "processing"].includes(j.chunk_status) && !["queued", "processing"].includes(j.optimize_status);
    if ((j.media_type !== "image" && optIdle) || (j.media_type === "image" && j.optimize_status === "failed")) {
      addBtn(actions, j.optimize_status === "completed" ? "Re-optimize" : "Optimize", "ghost", optimizeJob);
    }
    if (j.optimize_status === "completed" && j.optimizedUrl) {
      const dl = document.createElement("a");
      dl.className = "btn small";
      dl.href = j.optimizedUrl;
      dl.download = (j.original_filename || "optimized").replace(/\.[^.]+$/, "") + "_optimized.mp4";
      dl.textContent = "Download Optimized";
      dl.target = "_blank";
      actions.appendChild(dl);
    }

    // Panels visibility
    // Start-processing is hidden while a chunk split is active (mutual exclusion).
    $("process-panel").classList.toggle("hidden", !["uploaded", "failed", "cancelled"].includes(j.status) || ["queued", "processing"].includes(j.chunk_status));
    const frameActive = ["queued", "processing"].includes(j.status);
    const chunkActive = ["queued", "processing"].includes(j.chunk_status);
    $("progress-panel").classList.toggle("hidden", !(frameActive || chunkActive));
    $("gallery-panel").classList.toggle("hidden", !["completed", "processing", "queued"].includes(j.status));
    $("chunks-panel").classList.remove("hidden");

    if (j.status === "queued" || j.status === "processing") {
      state.framesPage = 1;
      loadFrames();
      startJobPolling();
    } else if (j.status === "completed") {
      state.framesPage = 1;
      loadFrames();
    }
    if (["completed", "failed", "cancelled"].includes(j.chunk_status) || ["queued", "processing"].includes(j.chunk_status)) {
      state.chunksPage = 1;
      loadChunks();
    } else {
      state.chunks = [];
      state.chunksTotal = 0;
      state.selectedChunks.clear();
      renderChunkGallery();
    }
    if (j.chunk_status === "queued" || j.chunk_status === "processing") {
      startJobPolling();
    }
    updateProgress(j);
  }

  function addBtn(parent, text, cls, onClick) {
    const btn = document.createElement("button");
    btn.className = `btn ${cls} small`;
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
  }

  function toast(msg, type = "ok") {
    const wrap = $("toast-wrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 350);
    }, 3400);
  }

  // Empty-state CTA buttons
  $("empty-clear-filter").addEventListener("click", () => {
    document.querySelectorAll(".nav a").forEach((x) => x.classList.remove("active"));
    document.querySelector('.nav a[data-filter="all"]').classList.add("active");
    state.filter = "all";
    state.search = "";
    $("search-input").value = "";
    state.jobsPage = 1;
    $("view-title").textContent = "Dashboard";
    loadJobs();
  });
  $("empty-start-process").addEventListener("click", () => {
    $("process-panel").scrollIntoView({ behavior: "smooth" });
  });
  $("empty-split").addEventListener("click", splitChunks);

  // ── Process / cancel / retry / delete ─────────────────────
  async function startProcess() {
    const mode = $("mode-select").value;
    const body = { mode, sharpness: parseFloat($("sharpness").value) };
    if (mode === "Custom FPS") body.fps = parseFloat($("custom-fps").value);
    if (mode === "Smart Scene") body.sceneThreshold = parseFloat($("scene-threshold").value);
    $("job-err").textContent = "";
    try {
      const data = await API.request(`/api/jobs/${state.job.id}/process`, { method: "POST", body });
      state.job = data.job;
      renderJob();
      toast("Processing started — frames will appear as they extract.");
    } catch (err) {
      $("job-err").textContent = "Failed to start: " + err.message;
    }
  }

  async function cancelJob() {
    if (!confirm("Cancel this job?")) return;
    try { state.job = (await API.request(`/api/jobs/${state.job.id}/cancel`, { method: "POST" })).job; renderJob(); }
    catch (err) { $("job-err").textContent = err.message; }
  }
  async function retryCurrent() {
    try { state.job = (await API.request(`/api/jobs/${state.job.id}/retry`, { method: "POST" })).job; renderJob(); }
    catch (err) { $("job-err").textContent = err.message; }
  }
  async function retryJob(id) {
    try { await API.request(`/api/jobs/${id}/retry`, { method: "POST" }); loadJobs(); }
    catch (err) { alert("Retry failed: " + err.message); }
  }
  async function deleteJob(id) {
    if (!confirm("Permanently delete this job, its frames and files?")) return;
    try {
      await API.request(`/api/admin/jobs/${id}`, { method: "DELETE" });
      if (state.job && state.job.id === id) { state.job = null; $("view-job").classList.add("hidden"); $("view-videos").classList.remove("hidden"); }
      loadJobs(); loadStats();
      toast("Job deleted.", "err");
    } catch (err) { alert("Delete failed: " + err.message); }
  }

  // ── Job polling (covers frame extraction AND chunk splitting) ─────────────
  function startJobPolling() {
    stopJobTimer();
    state.jobTimer = setInterval(async () => {
      if (!state.job) return;
      try {
        const data = await API.request(`/api/jobs/${state.job.id}`);
        const prevStatus = state.job.status;
        const prevChunk = state.job.chunk_status;
        const prevOpt = state.job.optimize_status;
        state.job = data.job;
        updateProgress(data.job);
        if (prevStatus !== data.job.status || prevChunk !== data.job.chunk_status || prevOpt !== data.job.optimize_status) renderJob();
        const done = TERMINAL.includes(data.job.status) && ["none", "completed", "failed", "cancelled"].includes(data.job.chunk_status) && ["none", "completed", "failed", "cancelled"].includes(data.job.optimize_status);
        if (done) stopJobTimer();
      } catch (err) { /* keep polling */ }
    }, 4000);
  }
  function stopJobTimer() { if (state.jobTimer) { clearInterval(state.jobTimer); state.jobTimer = null; } }

  function updateProgress(j) {
    const frameActive = ["queued", "processing"].includes(j.status);
    const chunkActive = ["queued", "processing"].includes(j.chunk_status);
    const optActive = ["queued", "processing"].includes(j.optimize_status);

    $("progress-status-badge").className = "badge " + (chunkActive ? j.chunk_status : optActive ? j.optimize_status : j.status);
    $("progress-status-badge").textContent = chunkActive
      ? "Chunks: " + API.statusLabel(j.chunk_status)
      : optActive
        ? "Optimizing: " + API.statusLabel(j.optimize_status)
        : API.statusLabel(j.status);

    const fwrap = $("progress-bar").parentElement;
    fwrap.style.display = frameActive ? "block" : "none";
    $("progress-label").style.display = frameActive ? "block" : "none";
    if (frameActive) {
      const total = j.total_source_frames || 1;
      const pct = Math.min(100, Math.round((j.processed_frames / total) * 100));
      $("progress-bar").style.width = pct + "%";
      $("progress-label").textContent = `${j.processed_frames} / ${total} frames · ${pct}%`;
    }

    const cw = $("chunk-progress-wrap");
    const cl = $("chunk-progress-label");
    cw.style.display = chunkActive ? "block" : "none";
    cl.style.display = chunkActive ? "block" : "none";
    if (chunkActive) {
      const ctotal = j.chunk_total || 1;
      const cpct = Math.min(100, Math.round(((j.chunk_processed || 0) / ctotal) * 100));
      $("chunk-progress-bar").style.width = cpct + "%";
      cl.textContent = `Splitting chunks: ${j.chunk_processed || 0} / ${ctotal} · ${cpct}%`;
    }
  }

  // ── Frame gallery ─────────────────────────────────────────
  $("gal-prev").addEventListener("click", () => { if (state.framesPage > 1) { state.framesPage--; loadFrames(); } });
  $("gal-next").addEventListener("click", () => { if (state.framesPage * state.framesPerPage < state.framesTotal) { state.framesPage++; loadFrames(); } });
  $("select-all").addEventListener("click", () => {
    state.selected = new Set(state.frames.map((f) => f.id));
    renderGallery();
  });
  $("deselect-all").addEventListener("click", () => { state.selected.clear(); renderGallery(); });
  $("delete-selected").addEventListener("click", deleteSelectedFrames);
  $("export-all").addEventListener("click", () => exportZIP("all"));
  $("export-selected").addEventListener("click", () => {
    if (state.selected.size === 0) { alert("No frames selected."); return; }
    exportZIP("selected");
  });

  async function loadFrames() {
    if (!state.job) return;
    const q = new URLSearchParams({ page: state.framesPage, perPage: state.framesPerPage });
    try {
      const data = await API.request(`/api/jobs/${state.job.id}/frames?${q}`);
      state.frames = data.frames || [];
      state.framesTotal = data.total;
      state.optBatch = data.optBatch || null;
      state.selected = new Set([...state.selected].filter((id) => state.frames.some((f) => f.id === id)));
      renderGallery();
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
    }
  }

  function renderGallery() {
    $("gallery-empty").classList.toggle("hidden", state.frames.length > 0);
    $("gallery").innerHTML = "";
    $("sel-count").textContent = `${state.selected.size} selected`;
    $("optimize-selected-frames").classList.toggle("hidden", state.selected.size === 0);
    const batch = state.optBatch;
    const hasOpt = batch && batch.status === "completed" && state.frames.some((f) => f.optimizedUrl);
    $("opt-toggle").classList.toggle("hidden", !hasOpt);
    $("opt-export-zip").classList.toggle("hidden", !hasOpt);
    $("opt-batch-info").classList.toggle("hidden", !batch);
    if (batch) $("opt-batch-info").textContent = `opt: ${batch.format} ${batch.processed}/${batch.total}`;
    $("opt-toggle").textContent = state.frameView === "optimized" ? "View: Optimized" : "View: Original";
    for (const f of state.frames) {
      const src = state.frameView === "optimized" && f.optimizedUrl ? f.optimizedUrl : f.thumbUrl;
      const card = document.createElement("div");
      card.className = "frame-card" + (state.selected.has(f.id) ? " selected" : "");
      card.innerHTML = `
        <img src="${src}" alt="frame" loading="lazy" />
        <div class="fc-bar">
          <span>#${String(f.frame_number).padStart(4, "0")} ${API.fmtTimestamp(f.timestamp)}</span>
          <input type="checkbox" class="fc-check" ${state.selected.has(f.id) ? "checked" : ""} />
        </div>`;
      card.querySelector("img").addEventListener("click", () => openPreview(f.frame_number));
      card.querySelector(".fc-check").addEventListener("change", (e) => {
        if (e.target.checked) state.selected.add(f.id); else state.selected.delete(f.id);
        card.classList.toggle("selected", e.target.checked);
        $("sel-count").textContent = `${state.selected.size} selected`;
        $("optimize-selected-frames").classList.toggle("hidden", state.selected.size === 0);
      });
      $("gallery").appendChild(card);
    }
    $("gal-info").textContent = `${state.frames.length} of ${state.framesTotal} frames`;
  }

  $("optimize-selected-frames").addEventListener("click", () => {
    if (state.selected.size === 0) { alert("No frames selected."); return; }
    openOptimizeModal("frames", [...state.selected]);
  });
  $("opt-toggle").addEventListener("click", () => {
    state.frameView = state.frameView === "optimized" ? "original" : "optimized";
    renderGallery();
  });
  $("opt-export-zip").addEventListener("click", () => {
    if (!state.job || !state.optBatch) return;
    $("export-modal").classList.remove("hidden");
    $("export-footer").style.display = "none";
    $("export-status-row").classList.remove("hidden");
    $("export-status-text").textContent = "Creating ZIP…";
    $("export-err").textContent = "";
    API.request(`/api/jobs/${state.job.id}/exports`, {
      method: "POST",
      body: { kind: "frames_opt", batchId: state.optBatch.id },
    }).then((data) => {
      state.exportId = data.exportId;
      pollExport();
      toast("Optimized frame ZIP export started.");
    }).catch((err) => {
      $("export-err").textContent = err.message;
      $("export-status-row").classList.add("hidden");
    });
  });

  async function deleteSelectedFrames() {
    if (state.selected.size === 0) { alert("No frames selected."); return; }
    if (!confirm(`Delete ${state.selected.size} frame(s)?`)) return;
    try {
      await API.request(`/api/jobs/${state.job.id}/frames/delete`, {
        method: "POST",
        body: { frameIds: [...state.selected] },
      });
      state.selected.clear();
      loadFrames();
      const jd = await API.request(`/api/jobs/${state.job.id}`);
      state.job = jd.job;
      $("job-meta").innerHTML = "";
      toast("Frames deleted.");
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  // ── Chunks (scene-based split) ────────────────────────────
  $("chunk-prev").addEventListener("click", () => { if (state.chunksPage > 1) { state.chunksPage--; loadChunks(); } });
  $("chunk-next").addEventListener("click", () => { if (state.chunksPage * state.chunksPerPage < state.chunksTotal) { state.chunksPage++; loadChunks(); } });
  $("chunk-select-all").addEventListener("click", () => {
    state.selectedChunks = new Set(state.chunks.map((c) => c.id));
    renderChunkGallery();
  });
  $("chunk-deselect-all").addEventListener("click", () => { state.selectedChunks.clear(); renderChunkGallery(); });
  $("chunk-delete-selected").addEventListener("click", deleteSelectedChunks);
  $("chunk-export-all").addEventListener("click", () => exportChunks("all"));
  $("chunk-export-selected").addEventListener("click", () => {
    if (state.selectedChunks.size === 0) { alert("No chunks selected."); return; }
    exportChunks("selected");
  });

  async function splitChunks() {
    if (!state.job) return;
    const j = state.job;
    if (["queued", "processing"].includes(j.status) || ["queued", "processing"].includes(j.chunk_status)) {
      $("job-err").textContent = ["queued", "processing"].includes(j.chunk_status)
        ? `Chunks are already ${j.chunk_status}.`
        : "Wait for frame processing to finish before splitting into chunks.";
      return;
    }
    if (!confirm("Split this video into chunks by background change? Existing chunks will be replaced.")) return;
    $("job-err").textContent = "";
    try {
      const data = await API.request(`/api/jobs/${state.job.id}/chunk`, { method: "POST" });
      state.job = data.job;
      renderJob();
      toast("Scene split started — chunks will appear as they process.");
    } catch (err) {
      $("job-err").textContent = "Failed to start chunk split: " + err.message;
    }
  }

  function optimizeJob() {
    if (!state.job) return;
    const j = state.job;
    if (["queued", "processing"].includes(j.status) || ["queued", "processing"].includes(j.chunk_status)) {
      $("job-err").textContent = "Wait for frame extraction / chunk splitting to finish before optimizing.";
      return;
    }
    openOptimizeModal("job", [j.id]);
  }

  // ── Optimize modal (single job / bulk jobs / selected frames) ─────────────
  function openOptimizeModal(mode, targets) {
    state.optMode = mode;
    state.optTargets = targets;
    $("optimize-err").textContent = "";
    const isImageOnly = mode === "frames" ? true : mode === "job" ? (state.job && state.job.media_type === "image") : false;
    $("opt-fields-video").classList.toggle("hidden", isImageOnly);
    $("opt-fields-image").classList.toggle("hidden", mode === "job" && !isImageOnly);
    $("opt-field-maxdim").classList.remove("hidden");
    $("optimize-title").textContent =
      mode === "frames" ? "Optimize Selected Frames" :
      mode === "bulk" ? `Optimize ${targets.length} Job${targets.length === 1 ? "" : "s"}` :
      isImageOnly ? "Optimize Image" : "Optimize Video";
    $("optimize-modal").classList.remove("hidden");
  }

  function closeOptimizeModal() { $("optimize-modal").classList.add("hidden"); }
  $("optimize-close").addEventListener("click", closeOptimizeModal);

  $("optimize-submit").addEventListener("click", async () => {
    const maxDimRaw = $("opt-maxdim").value;
    const maxDim = maxDimRaw ? parseInt(maxDimRaw, 10) : null;
    const format = $("opt-format").value;
    const quality = parseInt($("opt-quality").value, 10) || 85;
    const container = $("opt-container").value;
    const codec = $("opt-codec").value;
    const crf = parseInt($("opt-crf").value, 10) || 23;

    if (state.optMode === "frames") {
      if (!state.job || state.optTargets.length === 0) return;
      $("optimize-err").textContent = "";
      $("optimize-submit").disabled = true;
      try {
        await API.framesOptimize(state.job.id, state.optTargets, { format, quality, maxDim });
        closeOptimizeModal();
        toast(`Optimizing ${state.optTargets.length} frame${state.optTargets.length === 1 ? "" : "s"} to ${format}.`);
        loadFrames();
        pollOptBatch();
      } catch (err) {
        $("optimize-err").textContent = err.message;
      } finally { $("optimize-submit").disabled = false; }
      return;
    }

    if (state.optMode === "bulk") {
      $("optimize-err").textContent = "";
      $("optimize-submit").disabled = true;
      try {
        const res = await API.optimizeBatch(state.optTargets, { format, quality, container, codec, crf, maxDim });
        const skipped = (res.skipped || []).map((s) => `${s.id}: ${s.reason}`).join("; ");
        closeOptimizeModal();
        state.selectedJobs.clear();
        renderJobs(state.jobs);
        toast(res.queued.length
          ? `Queued ${res.queued.length} job${res.queued.length === 1 ? "" : "s"} for optimization.${res.skipped.length ? ` Skipped: ${skipped}` : ""}`
          : `Nothing queued${res.skipped.length ? ` — ${skipped}` : "."}`, res.queued.length ? "ok" : "err");
      } catch (err) {
        $("optimize-err").textContent = err.message;
      } finally { $("optimize-submit").disabled = false; }
      return;
    }

    // Single job
    if (!state.job) return;
    const j = state.job;
    const body = { maxDim };
    if (j.media_type === "image") { body.format = format; body.quality = quality; }
    else { body.container = container; body.codec = codec; body.crf = crf; }
    $("optimize-err").textContent = "";
    $("optimize-submit").disabled = true;
    try {
      const data = await API.request(`/api/jobs/${j.id}/optimize`, { method: "POST", body });
      state.job = data.job;
      renderJob();
      closeOptimizeModal();
      toast("Optimization started.");
    } catch (err) {
      $("optimize-err").textContent = err.message;
    } finally { $("optimize-submit").disabled = false; }
  });

  async function loadChunks() {
    if (!state.job) return;
    const q = new URLSearchParams({ page: state.chunksPage, perPage: state.chunksPerPage });
    try {
      const data = await API.request(`/api/jobs/${state.job.id}/chunks?${q}`);
      state.chunks = data.chunks || [];
      state.chunksTotal = data.total;
      state.selectedChunks = new Set([...state.selectedChunks].filter((id) => state.chunks.some((c) => c.id === id)));
      renderChunkGallery();
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
    }
  }

  function renderChunkGallery() {
    if (!state.chunks) return;
    $("chunks-empty").classList.toggle("hidden", state.chunks.length > 0);
    // Hide the empty-state "Split" CTA while frame extraction or a chunk split is active.
    const j = state.job;
    if (j) {
      const canSplit = !["queued", "processing"].includes(j.status) && !["queued", "processing"].includes(j.chunk_status);
      $("empty-split").classList.toggle("hidden", !canSplit);
    }
    $("chunks-gallery").innerHTML = "";
    $("chunk-sel-count").textContent = `${state.selectedChunks.size} selected`;
    for (const c of state.chunks) {
      const card = document.createElement("div");
      card.className = "frame-card chunk-card" + (state.selectedChunks.has(c.id) ? " selected" : "");
      card.innerHTML = `
        <video class="chunk-video" src="${c.playUrl}" preload="metadata" controls></video>
        <div class="chunk-meta">
          <span>#${String(c.chunk_number).padStart(4, "0")}</span>
          <span class="chip">${fmtRange(c.start_sec, c.end_sec)}</span>
        </div>
        <div class="fc-bar">
          <span>${c.duration ? API.fmtDuration(c.duration) : "—"}${c.file_size ? " · " + API.fmtBytes(c.file_size) : ""}</span>
          <input type="checkbox" class="fc-check" ${state.selectedChunks.has(c.id) ? "checked" : ""} />
        </div>`;
      card.querySelector(".fc-check").addEventListener("change", (e) => {
        if (e.target.checked) state.selectedChunks.add(c.id); else state.selectedChunks.delete(c.id);
        card.classList.toggle("selected", e.target.checked);
        $("chunk-sel-count").textContent = `${state.selectedChunks.size} selected`;
      });
      $("chunks-gallery").appendChild(card);
    }
    $("chunk-info").textContent = `${state.chunks.length} of ${state.chunksTotal} chunks`;
  }

  function fmtRange(a, b) {
    return `${API.fmtTimestamp(a)} – ${API.fmtTimestamp(b)}`;
  }

  async function deleteSelectedChunks() {
    if (state.selectedChunks.size === 0) { alert("No chunks selected."); return; }
    if (!confirm(`Delete ${state.selectedChunks.size} chunk(s)?`)) return;
    try {
      await API.request(`/api/jobs/${state.job.id}/chunks/delete`, {
        method: "POST",
        body: { chunkIds: [...state.selectedChunks] },
      });
      state.selectedChunks.clear();
      loadChunks();
      toast("Chunks deleted.");
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  async function exportChunks(type) {
    if (!state.job) return;
    $("export-modal").classList.remove("hidden");
    $("export-footer").style.display = "none";
    $("export-status-row").classList.remove("hidden");
    $("export-status-text").textContent = "Creating ZIP…";
    $("export-err").textContent = "";
    try {
      const body = { type };
      if (type === "selected") body.ids = [...state.selectedChunks];
      const data = await API.request(`/api/jobs/${state.job.id}/chunks/export`, { method: "POST", body });
      state.exportId = data.exportId;
      pollExport();
      toast("Chunk ZIP export started.");
    } catch (err) {
      $("export-err").textContent = err.message;
      $("export-status-row").classList.add("hidden");
    }
  }

  // ── Preview ───────────────────────────────────────────────
  $("preview-close").addEventListener("click", () => $("preview-modal").classList.add("hidden"));
  $("preview-prev").addEventListener("click", () => previewNav(-1));
  $("preview-next").addEventListener("click", () => previewNav(1));
  $("preview-toggle-select").addEventListener("click", () => {
    const f = state.frames.find((x) => x.frame_number === state.previewIdx);
    if (!f) return;
    if (state.selected.has(f.id)) state.selected.delete(f.id); else state.selected.add(f.id);
    renderGallery();
  });

  function openPreview(frameNumber) {
    state.previewIdx = frameNumber;
    showPreviewFrame();
    $("preview-modal").classList.remove("hidden");
  }

  function previewNav(delta) {
    const idx = state.frames.findIndex((f) => f.frame_number === state.previewIdx);
    const next = state.frames[idx + delta];
    if (next) { state.previewIdx = next.frame_number; showPreviewFrame(); }
  }

  function showPreviewFrame() {
    const f = state.frames.find((x) => x.frame_number === state.previewIdx);
    if (!f) return;
    $("preview-img").src = f.fullUrl;
    $("preview-title").textContent = `Frame #${String(f.frame_number).padStart(4, "0")}`;
    $("preview-info").textContent = `#${f.frame_number} · t=${API.fmtTimestamp(f.timestamp)} · ${f.width}x${f.height}px · selected=${state.selected.has(f.id) ? "yes" : "no"}`;
    $("preview-download").href = f.fullUrl;
    $("preview-download").setAttribute("download", `frame_${String(f.frame_number).padStart(4, "0")}.jpg`);
  }

  // ── Export ────────────────────────────────────────────────
  $("export-close").addEventListener("click", closeExport);
  function closeExport() {
    if (state.exportTimer) clearInterval(state.exportTimer);
    state.exportTimer = null;
    $("export-modal").classList.add("hidden");
  }

  async function exportZIP(type) {
    if (!state.job) return;
    $("export-modal").classList.remove("hidden");
    $("export-footer").style.display = "none";
    $("export-status-row").classList.remove("hidden");
    $("export-status-text").textContent = "Creating ZIP…";
    $("export-err").textContent = "";
    try {
      const body = { type };
      if (type === "selected") body.frameIds = [...state.selected];
      const data = await API.request(`/api/jobs/${state.job.id}/export`, { method: "POST", body });
      state.exportId = data.exportId;
      pollExport();
      toast("Frame ZIP export started.");
    } catch (err) {
      $("export-err").textContent = err.message;
      $("export-status-row").classList.add("hidden");
    }
  }

  function pollExport() {
    if (state.exportTimer) clearInterval(state.exportTimer);
    state.exportTimer = setInterval(async () => {
      try {
        const data = await API.request(`/api/jobs/exports/${state.exportId}`);
        $("export-status-text").textContent = `Export status: ${data.status}`;
        if (data.status === "completed") {
          clearInterval(state.exportTimer); state.exportTimer = null;
          $("export-status-row").classList.add("hidden");
          $("export-footer").style.display = "flex";
          $("export-download").href = data.downloadUrl;
        } else if (data.status === "failed") {
          clearInterval(state.exportTimer); state.exportTimer = null;
          $("export-status-row").classList.add("hidden");
          $("export-err").textContent = data.error_message || "Export failed.";
        }
      } catch (err) {
        clearInterval(state.exportTimer); state.exportTimer = null;
        $("export-err").textContent = err.message;
      }
    }, 3000);
  }

  // Refresh the gallery + opt_batch status while a frame-optimize batch runs.
  function pollOptBatch() {
    if (state.optPollTimer) clearInterval(state.optPollTimer);
    state.optPollTimer = setInterval(async () => {
      if (!state.job || !state.optBatch) { clearInterval(state.optPollTimer); state.optPollTimer = null; return; }
      if (!["queued", "processing"].includes(state.optBatch.status)) { clearInterval(state.optPollTimer); state.optPollTimer = null; return; }
      await loadFrames();
    }, 4000);
  }

  function stopAllTimers() {
    stopJobTimer();
    if (state.exportTimer) { clearInterval(state.exportTimer); state.exportTimer = null; }
    if (state.optPollTimer) { clearInterval(state.optPollTimer); state.optPollTimer = null; }
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ── Init ──────────────────────────────────────────────────
  if (API.token()) {
    const u = API.getUser();
    if (u && u.role === "admin") enterApp(); else { API.logout(); showAuth(); }
  } else showAuth();
})();
