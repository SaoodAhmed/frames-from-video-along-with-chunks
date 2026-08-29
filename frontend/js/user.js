/* KENDUIT — user portal logic. */
(() => {
  const $ = (id) => document.getElementById(id);
  const API = window.API;

  const TERMINAL = ["completed", "failed", "cancelled"];
  let polling = false;
  let lastJobs = [];

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

  // Sidebar "My Media" — refresh the list when clicked.
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
  const folderInput = $("folder-input");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.items && e.dataTransfer.items.length) {
      const files = await getFilesFromDrop(e.dataTransfer.items);
      if (files.length) startUpload(files, files.some((f) => f._relPath && f._relPath.includes("/")) ? "Folder" : "");
    } else if (e.dataTransfer.files.length) {
      startUpload([...e.dataTransfer.files]);
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) startUpload([...fileInput.files]);
  });
  folderInput.addEventListener("change", () => {
    const files = [...folderInput.files];
    if (files.length) startUpload(files, "Folder");
    folderInput.value = "";
  });

  $("btn-upload").addEventListener("click", () => $("upload-panel").classList.toggle("hidden"));

  // Recursively walk dropped entries (webkitdirectory exposes folder trees).
  function getFilesFromDrop(items) {
    return new Promise((resolve) => {
      const out = [];
      const walk = (entry, path) => {
        if (entry && entry.isFile) {
          return new Promise((res) => {
            entry.file((file) => {
              file._relPath = path ? `${path}/${file.name}` : file.name;
              out.push(file);
              res();
            }, () => res());
          });
        }
        if (entry && entry.isDirectory) {
          const reader = entry.createReader();
          return new Promise((res) => {
            const readBatch = () => reader.readEntries((entries) => {
              if (!entries.length) return res();
              Promise.all(entries.map((e2) => walk(e2, path ? `${path}/${entry.name}` : entry.name))).then(readBatch);
            }, () => res());
            readBatch();
          });
        }
        return Promise.resolve();
      };
      const prom = [];
      for (const it of items) {
        if (it.kind === "file") {
          const e = it.webkitGetAsEntry && it.webkitGetAsEntry();
          if (e) prom.push(walk(e, ""));
        }
      }
      Promise.all(prom).then(() => resolve(out));
    });
  }

  // Each file gets its own row (name + progress bar + status). One bad file
  // fails on its own row without aborting the rest of the batch. Folder mode
  // prefixes each row with the relative path so the user can tell them apart.
  async function startUpload(files, label) {
    $("upload-panel").classList.remove("hidden");
    const wrap = $("upload-batch");
    wrap.classList.remove("hidden");
    wrap.innerHTML = "";
    $("upload-err").textContent = "";
    if (label) {
      const head = document.createElement("div");
      head.className = "upload-batch-head";
      head.textContent = `Uploading ${label} — ${files.length} file${files.length === 1 ? "" : "s"}`;
      wrap.appendChild(head);
    }
    let ok = 0;

    await Promise.all(files.map(async (file) => {
      const display = file._relPath || file.name;
      const row = document.createElement("div");
      row.className = "upload-row";
      row.innerHTML = `
        <div class="upload-row-head">
          <span class="upload-row-name" title="${escapeHtml(display)}">${escapeHtml(display)}</span>
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
      toast(ok === files.length ? `Uploaded ${ok} file${ok === 1 ? "" : "s"} — queued.` : `${ok}/${files.length} uploaded, rest failed.`, ok === files.length ? "ok" : "err");
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

  // ── Media gallery ─────────────────────────────────────────
  $("gallery-search").addEventListener("input", () => renderGallery());

  async function loadVideos() {
    try {
      const data = await API.request("/api/videos");
      lastJobs = data.jobs || [];
      renderGallery();
      const hasLive = lastJobs.some((j) => !TERMINAL.includes(j.status));
      if (hasLive) startPolling(); else stopPolling();
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
    }
  }

  function renderGallery() {
    const jobs = lastJobs;
    const query = ($("gallery-search").value || "").trim().toLowerCase();
    const filtered = query ? jobs.filter((j) => (j.original_filename || "").toLowerCase().includes(query)) : jobs;
    $("videos-empty").classList.toggle("hidden", filtered.length > 0);
    $("gallery").classList.toggle("hidden", filtered.length === 0);
    const imgCount = jobs.filter((j) => j.media_type === "image").length;
    const vidCount = jobs.length - imgCount;
    $("library-note").textContent = jobs.length
      ? `${imgCount} image${imgCount === 1 ? "" : "s"} · ${vidCount} video${vidCount === 1 ? "" : "s"}`
      : "—";
    const gallery = $("gallery");
    gallery.innerHTML = "";
    if (!filtered.length) {
      gallery.classList.remove("hidden");
      gallery.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div>No media${query ? ` match “${escapeHtml(query)}”` : " yet"}. Upload files or a folder and they'll appear here.</div></div>`;
      return;
    }
    for (const j of filtered) {
      const isImage = j.media_type === "image";
      const thumb = isImage ? (j.thumbUrl || "") : (j.videoThumbUrl || "");
      const hasDl = j.optimize_status === "completed" && j.optimizedUrl;
      const badge = isImage
        ? { cls: j.optimize_status || "uploaded", label: API.statusLabel(j.optimize_status || "uploaded") }
        : { cls: j.status, label: API.statusLabel(j.status) };
      const card = document.createElement("div");
      card.className = "media-card";
      card.innerHTML = `
        <div class="media-thumb">
          ${thumb
            ? `<img src="${thumb}" alt="" loading="lazy" />`
            : `<div class="media-thumb-fallback">${isImage ? "🖼️" : "🎬"}</div>`}
          ${isImage ? "" : '<span class="media-type-badge">video</span>'}
        </div>
        <div class="media-info">
          <div class="media-name" title="${escapeHtml(j.original_filename)}">${escapeHtml(j.original_filename)}</div>
          <div class="media-meta">${API.fmtBytes(j.file_size)} · ${new Date(j.created_at).toLocaleDateString()}</div>
          <div class="media-status">
            <span class="badge ${badge.cls}">${badge.label}</span>
            ${isImage ? "" : `<span class="badge ${j.chunk_status && j.chunk_status !== "none" && j.chunk_status !== "completed" ? "queued" : "completed"}">${j.chunk_status && j.chunk_status !== "none" ? (j.chunk_status === "completed" ? "chunks" : API.statusLabel(j.chunk_status)) : "no chunks"}</span>`}
          </div>
        </div>
        <div class="media-actions">
          ${hasDl ? `<a class="btn small" href="${j.optimizedUrl}" target="_blank" rel="noopener" download>Download</a>` : ""}
          <button class="btn small ghost danger" data-del="${j.id}" title="Delete">Delete</button>
        </div>`;
      gallery.appendChild(card);
    }
  }

  $("gallery").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    const id = btn.dataset.del;
    if (!confirm("Delete this media permanently? This also removes its frames, chunks and optimized files.")) return;
    btn.disabled = true;
    try {
      await API.request(`/api/jobs/${id}`, { method: "DELETE" });
      toast("Deleted.", "ok");
      loadVideos();
    } catch (err) {
      toast("Delete failed: " + err.message, "err");
      btn.disabled = false;
    }
  });

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
