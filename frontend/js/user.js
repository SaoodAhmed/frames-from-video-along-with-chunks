/* KENDUIT — user portal logic. */
(() => {
  const $ = (id) => document.getElementById(id);
  const API = window.API;

  const TERMINAL = ["completed", "failed", "cancelled"];
  let polling = false;

  const viewAuth = $("view-auth");
  const viewApp = $("view-app");
  const authErr = $("auth-err");
  const authSubmit = $("auth-submit");
  let authMode = "login";

  function showAuth() { viewAuth.classList.remove("hidden"); viewApp.classList.add("hidden"); }
  function showApp() { viewAuth.classList.add("hidden"); viewApp.classList.remove("hidden"); }

  function setAuthTab(mode) {
    authMode = mode;
    $("tab-login").classList.toggle("active", mode === "login");
    $("tab-register").classList.toggle("active", mode === "register");
    $("auth-submit").textContent = mode === "login" ? "Login" : "Create account";
    $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
    authErr.textContent = "";
  }

  $("tab-login").addEventListener("click", () => setAuthTab("login"));
  $("tab-register").addEventListener("click", () => setAuthTab("register"));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    authSubmit.disabled = true;
    authErr.textContent = "";
    try {
      if (authMode === "login") await API.login(email, password);
      else await API.register(email, password);
      enterApp();
    } catch (err) {
      authErr.textContent = err.message;
    } finally {
      authSubmit.disabled = false;
    }
  });

  function enterApp() {
    const u = API.getUser();
    $("user-email").textContent = u ? u.email : "";
    showApp();
    loadVideos();
  }

  $("btn-logout").addEventListener("click", () => {
    API.logout();
    stopPolling();
    showAuth();
  });

  // Sidebar "My Videos" — refresh the list when clicked.
  document.querySelectorAll(".nav a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll(".nav a").forEach((x) => x.classList.remove("active"));
      a.classList.add("active");
      loadVideos();
    });
  });

  // ── Upload ────────────────────────────────────────────────
  const dropzone = $("dropzone");
  const fileInput = $("file-input");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length) startUpload([...e.dataTransfer.files]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) startUpload([...fileInput.files]);
  });

  $("btn-upload").addEventListener("click", () => $("upload-panel").classList.toggle("hidden"));

  // Each file gets its own row (name + progress bar + status). One bad file
  // fails on its own row without aborting the rest of the batch.
  async function startUpload(files) {
    $("upload-panel").classList.remove("hidden");
    const wrap = $("upload-batch");
    wrap.classList.remove("hidden");
    wrap.innerHTML = "";
    $("upload-err").textContent = "";
    let ok = 0;

    await Promise.all(files.map(async (file) => {
      const row = document.createElement("div");
      row.className = "upload-row";
      row.innerHTML = `
        <div class="upload-row-head">
          <span class="upload-row-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="upload-row-status">0%</span>
        </div>
        <div class="progress"><span></span></div>`;
      wrap.appendChild(row);
      const bar = row.querySelector(".progress > span");
      const status = row.querySelector(".upload-row-status");
      const setPct = (p) => {
        bar.style.width = p + "%";
        status.textContent = p + "%";
      };

      try {
        await API.uploadVideo(file, (pct) => setPct(Math.round(pct * 100)));
        setPct(100);
        status.textContent = "queued";
        row.classList.add("ok");
        ok++;
      } catch (err) {
        status.textContent = "failed: " + err.message;
        row.classList.add("err");
      }
    }));

    fileInput.value = "";
    if (ok) {
      toast(ok === files.length ? `Uploaded ${ok} video${ok === 1 ? "" : "s"} — queued for processing.` : `${ok}/${files.length} uploaded, rest failed.`, ok === files.length ? "ok" : "err");
    } else {
      toast("Upload failed.", "err");
    }
    await loadVideos();
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

  $("empty-upload").addEventListener("click", () => $("upload-panel").classList.remove("hidden"));

  // ── Videos list ───────────────────────────────────────────
  async function loadVideos() {
    try {
      const data = await API.request("/api/videos");
      renderVideos(data.jobs || []);
      const hasLive = (data.jobs || []).some((j) => !TERMINAL.includes(j.status));
      if (hasLive) startPolling(); else stopPolling();
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
    }
  }

  function renderVideos(jobs) {
    $("videos-empty").classList.toggle("hidden", jobs.length > 0);
    $("videos-table").classList.toggle("hidden", jobs.length === 0);
    const framesTotal = jobs.reduce((a, j) => a + (j.extracted_frames || 0), 0);
    const chunksTotal = jobs.reduce((a, j) => a + (j.chunk_count || 0), 0);
    $("library-note").textContent = jobs.length
      ? `${jobs.length} video${jobs.length === 1 ? "" : "s"} · ${framesTotal} frame${framesTotal === 1 ? "" : "s"} · ${chunksTotal} chunk${chunksTotal === 1 ? "" : "s"}`
      : "—";
    const body = $("videos-body");
    body.innerHTML = "";
    for (const j of jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${escapeHtml(j.original_filename)}</td>
        <td>${API.fmtBytes(j.file_size)}</td>
        <td class="mono">${API.fmtDuration(j.duration)}</td>
        <td class="mono small muted">${new Date(j.created_at).toLocaleString()}</td>
        <td class="mono">${j.extracted_frames || 0}</td>
        <td>${renderChunkCell(j)}</td>
        <td><span class="badge ${j.status}">${API.statusLabel(j.status)}</span></td>`;
      body.appendChild(tr);
    }
  }

  function renderChunkCell(j) {
    if (!j.chunk_status || j.chunk_status === "none") return '<span class="muted small">—</span>';
    const cls = j.chunk_status === "completed" ? "completed" : j.chunk_status === "failed" ? "failed" : "queued";
    const label = j.chunk_status === "completed"
      ? (j.chunk_count ? `${j.chunk_count} chunks` : "done")
      : API.statusLabel(j.chunk_status);
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    window.setInterval(() => { if (polling) loadVideos(); }, 8000);
  }
  function stopPolling() { polling = false; }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ── Init ──────────────────────────────────────────────────
  if (API.token()) enterApp();
  else showAuth();
})();
