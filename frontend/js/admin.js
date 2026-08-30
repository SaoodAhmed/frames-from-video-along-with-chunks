/* KENDUIT — admin portal logic. */
(() => {
  const $ = (id) => document.getElementById(id);
  const API = window.API;

  const VIEWS = ["view-videos", "view-media", "view-users", "view-optimized", "view-chunks", "view-frames", "view-optframes"];

  const state = {
    view: "dashboard",
    filter: "all",
    jobsPage: 1,
    jobsPerPage: 20,
    jobsTotal: 0,
    search: "",
    media: { type: "all", page: 1, total: 0, items: [], sel: new Set() },
    users: { userId: null, folderId: null, search: "" },
    opt: { format: "All" },
    chunks: { video: "All", jobId: null },
    frames: { video: "All", jobId: null, items: [] },
    optframes: { format: "All" },
    previewNav: null,
    previewIdx: 0,
    exportId: null,
    exportTimer: null,
    extractTargets: [],
    optTargets: [],
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
    go("dashboard");
  }

  // ── Navigation ────────────────────────────────────────────
  document.querySelectorAll(".nav a[data-view]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      go(a.dataset.view);
    });
  });

  function go(view) {
    stopAllTimers();
    state.view = view;
    syncNav();
    showView(view);
    if (view === "dashboard") { loadStats(); loadJobs(); }
    else if (view === "media") { state.media.page = 1; loadMedia(); }
    else if (view === "users") loadUsers();
    else if (view === "optimized") loadOptimized();
    else if (view === "chunks") loadChunks();
    else if (view === "frames") loadFrameGroups();
    else if (view === "optframes") loadOptFrames();
  }

  function syncNav() {
    document.querySelectorAll(".nav a").forEach((a) => {
      a.classList.toggle("active", a.dataset.view === state.view);
    });
  }

  function showView(name) {
    VIEWS.forEach((v) => $(v).classList.add("hidden"));
    const id = name === "dashboard" ? "view-videos" : `view-${name}`;
    const el = $(id);
    if (el) el.classList.remove("hidden");
    if (name === "dashboard") $("view-title").textContent = "Dashboard";
  }

  // ── Helpers ───────────────────────────────────────────────
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function toast(msg, type = "ok") {
    const wrap = $("toast-wrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 350); }, 3400);
  }
  function buildTabs(containerId, tabs, current, onSelect) {
    const c = $(containerId);
    if (!c) return;
    c.innerHTML = "";
    if (!tabs.includes(current)) current = "All";
    for (const t of tabs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = t === current ? "active" : "";
      b.textContent = t;
      b.addEventListener("click", () => onSelect(t));
      c.appendChild(b);
    }
  }
  function fmtTime(s) { return API.fmtTimestamp(Number(s) || 0); }

  // ── Dashboard: backend-backed processing status ───────────
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
  $("empty-clear-filter").addEventListener("click", () => {
    state.filter = "all";
    state.search = "";
    $("search-input").value = "";
    state.jobsPage = 1;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.remove("active"));
    document.querySelector('.nav a[data-view="dashboard"]').classList.add("active");
    loadJobs(); loadStats();
  });

  async function loadJobs() {
    const q = new URLSearchParams({ page: state.jobsPage, perPage: state.jobsPerPage });
    if (state.filter !== "all") q.set("status", state.filter);
    if (state.search) q.set("search", state.search);
    const body = $("jobs-body");
    body.innerHTML = `<tr class="loading"><td colspan="11">Loading jobs…</td></tr>`;
    $("jobs-empty").classList.add("hidden");
    $("jobs-table").classList.remove("hidden");
    try {
      const data = await API.request(`/api/admin/videos?${q}`);
      state.jobsTotal = data.total;
      renderJobs(data.jobs || []);
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
        <td class="small muted">${esc(j.user_email)}</td>
        <td class="mono">${esc(j.original_filename)}</td>
        <td>${API.fmtBytes(j.file_size)}</td>
        <td class="mono">${API.fmtDuration(j.duration)}</td>
        <td class="mono">${j.width && j.height ? `${j.width}x${j.height}` : "—"}</td>
        <td class="mono small muted">${new Date(j.created_at).toLocaleString()}</td>
        <td><span class="badge ${j.status}">${API.statusLabel(j.status)}</span></td>
        <td class="mono">${j.extracted_frames}</td>
        <td>${renderChunkCell(j)}</td>
        <td>${renderOptCell(j)}</td>
        <td>
          <div class="row gap-8">
            ${j.status === "failed" ? `<button class="btn ghost small act-retry" data-id="${j.id}">Retry</button>` : ""}
            <button class="btn danger small act-delete" data-id="${j.id}">Delete</button>
          </div>
        </td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll(".act-retry").forEach((b) => b.addEventListener("click", () => retryJob(b.dataset.id)));
    body.querySelectorAll(".act-delete").forEach((b) => b.addEventListener("click", () => deleteJob(b.dataset.id)));
    $("page-info").textContent = `Page ${state.jobsPage} of ${Math.max(1, Math.ceil(state.jobsTotal / state.jobsPerPage))}`;
  }

  function renderChunkCell(j) {
    if (!j.chunk_status || j.chunk_status === "none") return '<span class="muted small">—</span>';
    const cls = j.chunk_status === "completed" ? "completed" : j.chunk_status === "failed" ? "failed" : "queued";
    const label = j.chunk_status === "completed"
      ? (j.chunk_count ? `${j.chunk_count} chunks` : "done")
      : API.statusLabel(j.chunk_status);
    return `<span class="badge ${cls}">${label}</span>`;
  }
  function renderOptCell(j) {
    if (!j.optimize_status || j.optimize_status === "none") return '<span class="muted small">—</span>';
    return `<span class="badge ${j.optimize_status === "completed" ? "completed" : j.optimize_status === "failed" ? "failed" : "queued"}">${j.opt_format || API.statusLabel(j.optimize_status)}</span>`;
  }

  async function retryJob(id) {
    try { await API.request(`/api/jobs/${id}/retry`, { method: "POST" }); toast("Retried."); loadJobs(); }
    catch (err) { alert("Retry failed: " + err.message); }
  }
  async function deleteJob(id) {
    if (!confirm("Permanently delete this job, its variants, frames and chunks?")) return;
    try {
      await API.request(`/api/admin/jobs/${id}`, { method: "DELETE" });
      toast("Job deleted.", "err");
      loadJobs(); loadStats();
    } catch (err) { alert("Delete failed: " + err.message); }
  }

  // ── Media gallery (all users, gallery-based) ──────────────
  $("media-prev").addEventListener("click", () => { if (state.media.page > 1) { state.media.page--; loadMedia(); } });
  $("media-next").addEventListener("click", () => { if (state.media.page * 60 < state.media.total) { state.media.page++; loadMedia(); } });
  $("media-sel-all").addEventListener("click", () => { state.media.items.forEach((j) => state.media.sel.add(j.id)); renderMedia(); });
  $("media-sel-none").addEventListener("click", () => { state.media.sel.clear(); renderMedia(); });
  $("media-opt").addEventListener("click", () => openOptimizeModal([...state.media.sel], selTypes()));
  $("media-extract").addEventListener("click", () => openExtractModal([...state.media.sel]));
  $("media-chunk").addEventListener("click", chunkSelected);
  $("media-download").addEventListener("click", () => {
    const items = state.media.items.filter((j) => state.media.sel.has(j.id));
    for (const j of items) if (j.originalUrl) window.open(j.originalUrl, "_blank");
  });
  $("media-delete").addEventListener("click", deleteSelectedMedia);
  $("media-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    state.media.type = b.dataset.type;
    state.media.page = 1;
    document.querySelectorAll("#media-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    loadMedia();
  });

  function selTypes() {
    const types = new Set(state.media.items.filter((j) => state.media.sel.has(j.id)).map((j) => j.media_type));
    return [...types];
  }

  async function loadMedia() {
    const q = new URLSearchParams({ page: state.media.page, perPage: "60" });
    if (state.media.type !== "all") q.set("type", state.media.type);
    $("media-gallery").classList.remove("hidden");
    $("media-empty").classList.add("hidden");
    $("media-gallery").innerHTML = `<div class="empty-state"><div class="empty-icon">🗂️</div><div>Loading…</div></div>`;
    try {
      const data = await API.request(`/api/admin/videos?${q}`);
      state.media.items = data.jobs || [];
      state.media.total = data.total;
      state.media.sel = new Set([...state.media.sel].filter((id) => state.media.items.some((j) => j.id === id)));
      renderMedia();
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
      else $("media-gallery").innerHTML = `<div class="auth-err">${esc(err.message)}</div>`;
    }
  }

  function renderMedia() {
    const items = state.media.items;
    $("media-empty").classList.toggle("hidden", items.length > 0);
    $("media-gallery").classList.toggle("hidden", items.length === 0);
    $("media-note").textContent = `${state.media.total} item${state.media.total === 1 ? "" : "s"}`;
    $("media-page-info").textContent = `Page ${state.media.page} of ${Math.max(1, Math.ceil(state.media.total / 60))}`;
    const grid = $("media-gallery");
    grid.innerHTML = "";
    for (const j of items) {
      grid.appendChild(mediaCard(j));
    }
    grid.querySelectorAll("input[data-check]").forEach((box) => box.addEventListener("change", () => {
      if (box.checked) state.media.sel.add(box.dataset.check); else state.media.sel.delete(box.dataset.check);
      box.closest(".media-card").classList.toggle("selected", box.checked);
      updateMediaActions();
    }));
    updateMediaActions();
  }

  function mediaCard(j) {
    const isImage = j.media_type === "image";
    const thumb = isImage ? (j.thumbUrl || j.originalUrl || "") : (j.videoThumbUrl || "");
    const sel = state.media.sel.has(j.id);
    const card = document.createElement("div");
    card.className = "media-card" + (sel ? " selected" : "");
    card.innerHTML = `
      <label class="media-check"><input type="checkbox" data-check="${j.id}" ${sel ? "checked" : ""} /></label>
      <div class="media-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : `<div class="media-thumb-fallback">${isImage ? "🖼️" : "🎬"}</div>`}</div>
      <div class="media-info">
        <div class="media-name" title="${esc(j.original_filename)}">${esc(j.original_filename)}</div>
        <div class="media-meta">${esc(j.user_email)} · ${API.fmtBytes(j.file_size)} · ${isImage ? "image" : "video"}</div>
        <div class="media-meta">status: <span class="badge ${j.status}">${API.statusLabel(j.status)}</span></div>
      </div>
      <div class="media-actions">
        <button class="btn small ghost act-preview" data-id="${j.id}">Preview</button>
      </div>`;
    card.querySelector(".act-preview").addEventListener("click", () => {
      const idx = itemsIndex(state.media.items, j.id);
      openPreviewList(state.media.items, idx, "original");
    });
    return card;
  }

  function itemsIndex(list, id) { return list.findIndex((x) => x.id === id); }

  function updateMediaActions() {
    const n = state.media.sel.size;
    $("media-selection-bar").classList.toggle("hidden", n === 0);
    if (!n) return;
    $("media-sel-count").textContent = `${n} selected`;
    const types = selTypes();
    const onlyVideos = types.length === 1 && types[0] === "video";
    $("media-extract").classList.toggle("hidden", !onlyVideos);
    $("media-chunk").classList.toggle("hidden", !onlyVideos);
  }

  async function deleteSelectedMedia() {
    if (!state.media.sel.size) return;
    if (!confirm(`Delete ${state.media.sel.size} item(s) permanently (originals + all variants)?`)) return;
    for (const id of [...state.media.sel]) await API.request(`/api/admin/jobs/${id}`, { method: "DELETE" });
    toast("Deleted.", "err");
    state.media.sel.clear();
    loadMedia();
  }

  async function chunkSelected() {
    if (!state.media.sel.size) return;
    const vids = state.media.items.filter((j) => state.media.sel.has(j.id) && j.media_type === "video");
    if (!vids.length) return;
    if (!confirm(`Split ${vids.length} video(s) into chunks by background change?`)) return;
    let ok = 0, bad = 0;
    for (const v of vids) {
      try { await API.request(`/api/jobs/${v.id}/chunk`, { method: "POST" }); ok++; }
      catch (err) { bad++; console.error(err); }
    }
    toast(`Queued ${ok} chunk split${ok === 1 ? "" : "s"}${bad ? `, ${bad} skipped` : ""}.`, ok ? "ok" : "err");
  }

  // ── Extract frames modal ──────────────────────────────────
  $("extract-close").addEventListener("click", () => $("extract-modal").classList.add("hidden"));
  $("extract-mode").addEventListener("change", () => {
    $("extract-fps-wrap").classList.toggle("hidden", $("extract-mode").value !== "Custom FPS");
  });
  $("extract-submit").addEventListener("click", async () => {
    const mode = $("extract-mode").value;
    const body = { mode };
    if (mode === "Custom FPS") body.fps = parseFloat($("extract-fps").value);
    $("extract-err").textContent = "";
    $("extract-submit").disabled = true;
    try {
      let ok = 0, bad = 0;
      for (const id of state.extractTargets) {
        try { await API.request(`/api/jobs/${id}/process`, { method: "POST", body }); ok++; }
        catch (err) { bad++; }
      }
      $("extract-modal").classList.add("hidden");
      toast(`Queued frame extraction for ${ok} video${ok === 1 ? "" : "s"}${bad ? `, ${bad} skipped` : ""}.`, ok ? "ok" : "err");
    } finally {
      $("extract-submit").disabled = false;
    }
  });

  function openExtractModal(jobIds) {
    state.extractTargets = jobIds;
    $("extract-err").textContent = "";
    $("extract-modal").classList.remove("hidden");
  }

  // ── Optimize modal (bulk) ─────────────────────────────────
  $("optimize-close").addEventListener("click", () => $("optimize-modal").classList.add("hidden"));
  $("optimize-submit").addEventListener("click", async () => {
    const maxDimRaw = $("opt-maxdim").value;
    const maxDim = maxDimRaw ? parseInt(maxDimRaw, 10) : null;
    const format = $("opt-format").value;
    const quality = parseInt($("opt-quality").value, 10) || 85;
    const container = $("opt-container").value;
    const codec = $("opt-codec").value;
    const crf = parseInt($("opt-crf").value, 10) || 23;
    $("optimize-err").textContent = "";
    $("optimize-submit").disabled = true;
    try {
      const res = await API.optimizeBatch(state.optTargets, { format, quality, container, codec, crf, maxDim });
      const skipped = (res.skipped || []).map((s) => `${s.id}: ${s.reason}`).join("; ");
      $("optimize-modal").classList.add("hidden");
      toast(res.queued.length
        ? `Queued ${res.queued.length} for optimization.${res.skipped.length ? ` Skipped: ${skipped}` : ""}`
        : `Nothing queued${res.skipped.length ? ` — ${skipped}` : "."}`, res.queued.length ? "ok" : "err");
      if (state.view === "media") { state.media.sel.clear(); loadMedia(); }
      else if (state.view === "users" && state.users.folderId !== undefined) loadUserFolderFiles(state.users.userId, state.users.folderId);
    } catch (err) {
      $("optimize-err").textContent = err.message;
    } finally {
      $("optimize-submit").disabled = false;
    }
  });

  function openOptimizeModal(targets, types) {
    state.optTargets = targets;
    $("optimize-err").textContent = "";
    const hasImg = types.includes("image");
    const hasVid = types.includes("video");
    $("opt-fields-video").classList.toggle("hidden", !hasVid);
    $("opt-fields-image").classList.toggle("hidden", !hasImg);
    $("opt-field-maxdim").classList.remove("hidden");
    $("optimize-title").textContent = `Optimize ${targets.length} item${targets.length === 1 ? "" : "s"}`;
    $("optimize-modal").classList.remove("hidden");
  }

  // ── Users tree ────────────────────────────────────────────
  $("users-search").addEventListener("input", () => {
    state.users.search = $("users-search").value.trim().toLowerCase();
    if (!state.users.userId) loadUsers();
  });
  $("users-back").addEventListener("click", () => {
    if (state.users.folderId) { state.users.folderId = null; loadUserFolders(state.users.userId); }
    else { state.users.userId = null; state.users.folderId = undefined; $("users-back").classList.add("hidden"); $("users-title").textContent = "Users"; loadUsers(); }
  });

  async function loadUsers() {
    const body = $("users-body");
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><div>Loading users…</div></div>`;
    try {
      const data = await API.request("/api/admin/users");
      const users = (data.users || []).filter((u) => !state.users.search || (u.email || "").toLowerCase().includes(state.users.search));
      if (!users.length) { body.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><div>No users.</div></div>`; return; }
      body.innerHTML = `<div class="table-wrap table-scroll"><table>
        <thead><tr><th>Email</th><th>Role</th><th>Folders</th><th>Files</th><th>Size</th></tr></thead>
        <tbody>${users.map((u) => `
          <tr class="clickable" data-uid="${esc(u.id)}">
            <td>${esc(u.email)}</td><td>${esc(u.role)}</td>
            <td>${u.folder_count ?? 0}</td><td>${u.file_count ?? 0}</td><td>${API.fmtBytes(u.total_size)}</td>
          </tr>`).join("")}</tbody></table></div>`;
      body.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => loadUserFolders(tr.dataset.uid)));
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else body.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  async function loadUserFolders(userId) {
    state.users.userId = userId;
    state.users.folderId = null;
    $("users-back").classList.remove("hidden");
    const body = $("users-body");
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">📂</div><div>Loading folders…</div></div>`;
    try {
      const [uRes, fRes] = await Promise.all([
        API.request("/api/admin/users"),
        API.request(`/api/admin/folders?userId=${encodeURIComponent(userId)}`),
      ]);
      const u = (uRes.users || []).find((x) => x.id === userId);
      $("users-title").textContent = `${u ? u.email : "User"} — folders`;
      const folders = fRes.folders || [];
      const rootCount = (u && u.file_count) || 0;
      if (!folders.length && !rootCount) { body.innerHTML = `<div class="empty-state"><div class="empty-icon">📂</div><div>No folders for this user.</div></div>`; return; }
      const rows = [];
      if (u && rootCount) rows.push(`<tr class="clickable" data-root="1"><td>📁 <b>root</b></td><td>—</td><td>${rootCount}</td><td>${API.fmtBytes(u.total_size)}</td></tr>`);
      rows.push(...folders.map((f) => `
        <tr class="clickable" data-root="0" data-fid="${esc(f.id)}">
          <td>📁 <b>${esc(f.name)}</b></td><td>${esc(f.parent_id || "root")}</td>
          <td>${f.file_count ?? 0}</td><td>${API.fmtBytes(f.size)}</td>
        </tr>`));
      body.innerHTML = `<div class="table-wrap table-scroll"><table>
        <thead><tr><th>Folder</th><th>Parent</th><th>Files</th><th>Size</th></tr></thead>
        <tbody>${rows.join("")}</tbody></table></div>`;
      body.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => {
        if (tr.dataset.root === "1") loadUserFolderFiles(userId, null);
        else loadUserFolderFiles(userId, tr.dataset.fid);
      }));
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else body.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  let adminSel = new Set();
  async function loadUserFolderFiles(userId, folderId) {
    state.users.folderId = folderId;
    adminSel.clear();
    const body = $("users-body");
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼️</div><div>Loading files…</div></div>`;
    try {
      const q = new URLSearchParams({ userId, page: "1", perPage: "200" });
      if (folderId) q.set("folderId", folderId);
      const data = await API.request(`/api/admin/jobs?${q.toString()}`);
      const files = data.jobs || [];
      const uRes = await API.request("/api/admin/users");
      const u = (uRes.users || []).find((x) => x.id === userId);
      const fRes = folderId ? await API.request(`/api/admin/folders?userId=${encodeURIComponent(userId)}`) : null;
      const folder = folderId && fRes ? (fRes.folders || []).find((f) => f.id === folderId) : null;
      $("users-title").textContent = folder ? `${folder.name}` : (u ? u.email : "User");
      if (!files.length) { body.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼️</div><div>No files here.</div></div>`; return; }
      body.innerHTML = `
        <div class="selection-bar">
          <span id="admin-sel-count">0 selected</span>
          <div class="spacer"></div>
          <button class="btn ghost small" id="admin-sel-all" type="button">Select all</button>
          <button class="btn ghost small" id="admin-sel-none" type="button">Deselect</button>
          <button class="btn small" id="admin-sel-opt" type="button">Optimize</button>
          <button class="btn small hidden" id="admin-sel-extract" type="button">Extract Frames</button>
          <button class="btn small hidden" id="admin-sel-chunk" type="button">Chunk</button>
          <button class="btn small danger" id="admin-sel-del" type="button">Delete</button>
        </div>
        <div class="gallery media-gallery" id="admin-files"></div>`;
      const grid = $("admin-files");
      for (const j of files) grid.appendChild(adminFileCard(j));
      grid.querySelectorAll("input[data-check]").forEach((box) => box.addEventListener("change", () => {
        if (box.checked) adminSel.add(box.dataset.check); else adminSel.delete(box.dataset.check);
        box.closest(".media-card").classList.toggle("selected", box.checked);
        renderAdminSel(files);
      }));
      $("admin-sel-all").addEventListener("click", () => { files.forEach((f) => adminSel.add(f.id)); renderAdminSel(files); });
      $("admin-sel-none").addEventListener("click", () => { adminSel.clear(); renderAdminSel(files); });
      $("admin-sel-opt").addEventListener("click", () => {
        if (!adminSel.size) return toast("Select files first.", "err");
        openOptimizeModal([...adminSel], adminSelTypes(files));
      });
      $("admin-sel-extract").addEventListener("click", () => {
        if (!adminSel.size) return toast("Select files first.", "err");
        openExtractModal([...adminSel]);
      });
      $("admin-sel-chunk").addEventListener("click", async () => {
        if (!adminSel.size) return toast("Select files first.", "err");
        const vids = files.filter((f) => adminSel.has(f.id) && f.media_type === "video");
        if (!confirm(`Split ${vids.length} video(s) into chunks?`)) return;
        for (const v of vids) await API.request(`/api/jobs/${v.id}/chunk`, { method: "POST" });
        toast("Chunk splits queued.");
      });
      $("admin-sel-del").addEventListener("click", async () => {
        if (!adminSel.size) return toast("Select files first.", "err");
        if (!confirm(`Delete ${adminSel.size} file(s) permanently?`)) return;
        for (const id of [...adminSel]) await API.request(`/api/admin/jobs/${id}`, { method: "DELETE" });
        toast("Deleted.", "err");
        loadUserFolderFiles(userId, folderId);
      });
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else body.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  function adminSelTypes(files) {
    const types = new Set(files.filter((f) => adminSel.has(f.id)).map((f) => f.media_type));
    return [...types];
  }

  function adminFileCard(j) {
    const isImage = j.media_type === "image";
    const thumb = isImage ? (j.thumbUrl || j.originalUrl || "") : (j.videoThumbUrl || "");
    const card = document.createElement("div");
    card.className = "media-card";
    card.innerHTML = `
      <label class="media-check"><input type="checkbox" data-check="${j.id}" /></label>
      <div class="media-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : `<div class="media-thumb-fallback">${isImage ? "🖼️" : "🎬"}</div>`}</div>
      <div class="media-info">
        <div class="media-name" title="${esc(j.original_filename)}">${esc(j.original_filename)}</div>
        <div class="media-meta">${API.fmtBytes(j.file_size)} · ${isImage ? "image" : "video"} · <span class="badge ${j.status}">${API.statusLabel(j.status)}</span></div>
      </div>
      <div class="media-actions">
        <button class="btn small ghost act-preview" data-id="${j.id}">Preview</button>
      </div>`;
    card.querySelector(".act-preview").addEventListener("click", () => {
      const list = [j];
      openPreviewList(list, 0, "original");
    });
    return card;
  }

  function renderAdminSel(files) {
    const grid = $("admin-files");
    if (grid) grid.querySelectorAll("input[data-check]").forEach((box) => {
      box.checked = adminSel.has(box.dataset.check);
      box.closest(".media-card").classList.toggle("selected", box.checked);
    });
    const n = adminSel.size;
    const c = $("admin-sel-count");
    if (c) c.textContent = `${n} selected`;
    const types = adminSelTypes(files);
    const onlyVideos = types.length === 1 && types[0] === "video";
    const ex = $("admin-sel-extract"), ch = $("admin-sel-chunk");
    if (ex) ex.classList.toggle("hidden", !onlyVideos);
    if (ch) ch.classList.toggle("hidden", !onlyVideos);
  }

  // ── Optimization Gallery ──────────────────────────────────
  $("optgal-refresh").addEventListener("click", loadOptimized);
  async function loadOptimized() {
    const q = state.opt.format !== "All" ? `?format=${encodeURIComponent(state.opt.format)}` : "";
    const grid = $("optgal-grid");
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚡</div><div>Loading…</div></div>`;
    try {
      const data = await API.request(`/api/admin/optimizations${q}`);
      const formats = ["All", ...(data.formats || []).map((f) => f.format)];
      buildTabs("optgal-tabs", formats, state.opt.format, (fmt) => { state.opt.format = fmt; loadOptimized(); });
      const items = data.items || [];
      $("optgal-note").textContent = `${items.length} variant${items.length === 1 ? "" : "s"}`;
      $("optgal-empty").classList.toggle("hidden", items.length > 0);
      grid.innerHTML = "";
      for (const it of items) grid.appendChild(variantCard(it));
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else grid.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  function variantCard(it) {
    const isImage = it.media_type === "image";
    const thumb = isImage ? (it.thumbUrl || it.url || "") : (it.thumbUrl || "");
    const fmtLabel = isImage ? it.format : `${it.format}/${it.codec || "h264"}`;
    const card = document.createElement("div");
    card.className = "media-card";
    card.innerHTML = `
      <div class="media-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : `<div class="media-thumb-fallback">${isImage ? "🖼️" : "🎬"}</div>`}</div>
      <div class="media-info">
        <div class="media-name" title="${esc(it.original_filename)}">${esc(it.original_filename)}</div>
        <div class="media-meta">${esc(it.user_email)}</div>
        <div class="media-meta">${API.fmtBytes(it.file_size)} → ${API.fmtBytes(it.size)} · <span class="chip">${esc(fmtLabel)}</span></div>
        ${it.savedPct != null ? `<div class="saved-pct">${it.savedPct}% saved</div>` : ""}
      </div>
      <div class="media-actions">
        <button class="btn small act-preview" data-url="${it.url}" data-name="${esc(it.original_filename)}" data-img="${isImage}">Preview</button>
        ${it.url ? `<a class="btn small ghost" href="${it.url}" download target="_blank" rel="noopener">Download</a>` : ""}
        <button class="btn small danger act-del" data-id="${it.id}">Delete</button>
      </div>`;
    card.querySelector(".act-preview").addEventListener("click", () =>
      openPreview({ url: it.url, name: it.original_filename, isImage }));
    card.querySelector(".act-del").addEventListener("click", async () => {
      if (!confirm(`Delete this ${isImage ? "image" : "video"} variant? (other formats are kept)`)) return;
      await API.request(`/api/admin/optimizations/${it.id}`, { method: "DELETE" });
      toast("Variant deleted.", "err");
      loadOptimized();
    });
    return card;
  }

  // ── Chunks Gallery ────────────────────────────────────────
  async function loadChunks() {
    const q = state.chunks.video !== "All" && state.chunks.jobId ? `?videoId=${encodeURIComponent(state.chunks.jobId)}` : "";
    const grid = $("chunks-grid");
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">✂️</div><div>Loading…</div></div>`;
    try {
      const data = await API.request(`/api/admin/chunk-groups${q}`);
      const groups = data.groups || [];
      const tabs = ["All", ...groups.map((g) => g.title)];
      buildTabs("chunks-tabs", tabs, state.chunks.video, (v) => {
        const g = groups.find((x) => x.title === v);
        state.chunks.video = v;
        state.chunks.jobId = g ? g.job_id : null;
        loadChunks();
      });
      const chunks = data.chunks || [];
      $("chunks-note").textContent = `${chunks.length} chunk${chunks.length === 1 ? "" : "s"} · ${(data.groups || []).length} video(s)`;
      $("chunks-empty").classList.toggle("hidden", chunks.length > 0);
      grid.innerHTML = "";
      for (const c of chunks) {
        const card = document.createElement("div");
        card.className = "frame-card chunk-card";
        card.innerHTML = `
          <video class="chunk-video" src="${c.playUrl}" preload="metadata" controls playsinline></video>
          <div class="chunk-meta"><span>#${String(c.chunk_number).padStart(4, "0")}</span><span class="chip">${fmtTime(c.start_sec)} – ${fmtTime(c.end_sec)}</span></div>
          <div class="fc-bar">
            <span>${c.duration ? API.fmtDuration(c.duration) : "—"}${c.file_size ? " · " + API.fmtBytes(c.file_size) : ""}</span>
            <a class="small" href="${c.playUrl}" download target="_blank" rel="noopener">⬇</a>
          </div>`;
        grid.appendChild(card);
      }
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else grid.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  // ── Frames Gallery ────────────────────────────────────────
  $("frames-zip").addEventListener("click", () => {
    if (!state.frames.jobId) return;
    startExport(`/api/jobs/${state.frames.jobId}/export`, { type: "all" });
  });
  async function loadFrameGroups() {
    const q = state.frames.video !== "All" && state.frames.jobId ? `?videoId=${encodeURIComponent(state.frames.jobId)}` : "";
    const grid = $("frames-grid");
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼️</div><div>Loading…</div></div>`;
    try {
      const data = await API.request(`/api/admin/frame-groups${q}`);
      const groups = data.groups || [];
      const tabs = ["All", ...groups.map((g) => g.title)];
      buildTabs("frames-tabs", tabs, state.frames.video, (v) => {
        const g = groups.find((x) => x.title === v);
        state.frames.video = v;
        state.frames.jobId = g ? g.job_id : null;
        loadFrameGroups();
      });
      state.frames.items = data.frames || [];
      const total = state.frames.items.length;
      $("frames-note").textContent = `${total} frame${total === 1 ? "" : "s"} · ${groups.length} video(s)`;
      $("frames-empty").classList.toggle("hidden", total > 0);
      $("frames-zip").classList.toggle("hidden", !state.frames.jobId);
      grid.innerHTML = "";
      state.frames.items.forEach((f, i) => grid.appendChild(frameCard(f, i)));
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else grid.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  function frameCard(f, idx) {
    const card = document.createElement("div");
    card.className = "frame-card";
    card.innerHTML = `
      <img src="${f.thumbUrl}" alt="frame" loading="lazy" />
      <div class="fc-bar">
        <span>#${String(f.frame_number).padStart(4, "0")} ${fmtTime(f.timestamp)}</span>
      </div>`;
    card.querySelector("img").addEventListener("click", () => openPreviewList(state.frames.items, idx, "frame"));
    return card;
  }

  // ── Optimized Frames Gallery ──────────────────────────────
  async function loadOptFrames() {
    const q = state.optframes.format !== "All" ? `?format=${encodeURIComponent(state.optframes.format)}` : "";
    const grid = $("optframes-grid");
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼️</div><div>Loading…</div></div>`;
    try {
      const data = await API.request(`/api/admin/optframes${q}`);
      const formats = ["All", ...(data.formats || []).map((f) => f.format)];
      buildTabs("optframes-tabs", formats, state.optframes.format, (fmt) => { state.optframes.format = fmt; loadOptFrames(); });
      const items = data.items || [];
      $("optframes-note").textContent = `${items.length} optimized frame${items.length === 1 ? "" : "s"}`;
      $("optframes-empty").classList.toggle("hidden", items.length > 0);
      grid.innerHTML = "";
      for (const it of items) {
        const card = document.createElement("div");
        card.className = "frame-card";
        card.innerHTML = `
          <img src="${it.thumbUrl}" alt="opt frame" loading="lazy" />
          <div class="chunk-meta"><span>#${String(it.frame_number).padStart(4, "0")}</span><span class="chip">${esc(it.format)}</span></div>
          <div class="fc-bar">
            <span>${it.size ? API.fmtBytes(it.size) : `${it.width}x${it.height}`}${it.quality ? ` · q${it.quality}` : ""}</span>
            <button class="btn danger small act-del" type="button">✕</button>
          </div>`;
        card.querySelector("img").addEventListener("click", () => openPreview({ url: it.url, name: it.filename, isImage: true }));
        card.querySelector(".act-del").addEventListener("click", async () => {
          if (!confirm("Delete this optimized frame?")) return;
          await API.request(`/api/admin/optframes/delete`, {
            method: "POST",
            body: { job_id: it.job_id, format: it.format, frameNumbers: [it.frame_number] },
          });
          toast("Optimized frame deleted.", "err");
          loadOptFrames();
        });
        grid.appendChild(card);
      }
    } catch (err) { if (err.status === 401) { API.logout(); showAuth(); } else grid.innerHTML = `<div class="auth-err">${esc(err.message)}</div>`; }
  }

  // ── Preview (image + video) ───────────────────────────────
  $("preview-close").addEventListener("click", () => { $("preview-video").pause(); $("preview-modal").classList.add("hidden"); });
  $("preview-prev").addEventListener("click", () => state.previewNav && state.previewNav(-1));
  $("preview-next").addEventListener("click", () => state.previewNav && state.previewNav(1));

  function openPreview({ url, name, isImage }) {
    const img = $("preview-img"), vid = $("preview-video");
    img.classList.toggle("hidden", !isImage);
    vid.classList.toggle("hidden", isImage);
    img.src = isImage ? url : "";
    vid.src = isImage ? "" : url;
    vid.load();
    $("preview-title").textContent = name || "Preview";
    const dl = $("preview-download");
    dl.href = url || "";
    dl.setAttribute("download", name ? name.replace(/[^a-zA-Z0-9._-]/g, "_") : "media");
    $("preview-pager").classList.add("hidden");
    state.previewNav = null;
    $("preview-modal").classList.remove("hidden");
  }

  // Preview a list of media/frames with prev/next navigation.
  function openPreviewList(list, startIdx, kind) {
    if (!list.length) return;
    state.previewNav = (delta) => {
      const next = list[state.previewIdx + delta];
      if (next) { state.previewIdx = state.previewIdx + delta; showListItem(list, state.previewIdx, kind); }
    };
    state.previewIdx = startIdx;
    showListItem(list, startIdx, kind);
  }

  function showListItem(list, idx, kind) {
    const item = list[idx];
    if (!item) return;
    const isImage = kind === "frame" ? true : item.media_type === "image";
    const url = kind === "frame" ? item.fullUrl : (isImage ? (item.originalUrl || item.url) : (item.originalUrl || item.url));
    const name = item.original_filename || item.filename || `Item ${idx + 1}`;
    const img = $("preview-img"), vid = $("preview-video");
    img.classList.toggle("hidden", !isImage);
    vid.classList.toggle("hidden", isImage);
    img.src = isImage ? url : "";
    vid.src = isImage ? "" : url;
    if (vid.src) vid.load();
    $("preview-title").textContent = name;
    $("preview-download").href = url || "";
    $("preview-download").setAttribute("download", name.replace(/[^a-zA-Z0-9._-]/g, "_"));
    $("preview-pager").classList.toggle("hidden", list.length < 2);
    $("preview-info").textContent = `${idx + 1} / ${list.length}`;
    $("preview-modal").classList.remove("hidden");
  }

  // ── Export (frames ZIP) ───────────────────────────────────
  $("export-close").addEventListener("click", closeExport);
  function closeExport() {
    if (state.exportTimer) clearInterval(state.exportTimer);
    state.exportTimer = null;
    $("export-modal").classList.add("hidden");
  }

  function startExport(url, body) {
    $("export-modal").classList.remove("hidden");
    $("export-footer").style.display = "none";
    $("export-status-row").classList.remove("hidden");
    $("export-status-text").textContent = "Creating ZIP…";
    $("export-err").textContent = "";
    API.request(url, { method: "POST", body }).then((data) => {
      state.exportId = data.exportId;
      pollExport();
      toast("ZIP export started.");
    }).catch((err) => {
      $("export-err").textContent = err.message;
      $("export-status-row").classList.add("hidden");
    });
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

  function stopAllTimers() {
    if (state.exportTimer) { clearInterval(state.exportTimer); state.exportTimer = null; }
  }

  // ── Init ──────────────────────────────────────────────────
  if (API.token()) {
    const u = API.getUser();
    if (u && u.role === "admin") enterApp(); else { API.logout(); showAuth(); }
  } else showAuth();
})();
