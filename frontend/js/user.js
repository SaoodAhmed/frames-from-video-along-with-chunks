/* KENDUIT — user portal logic: folders, gallery, selection, upload+dedup, preview. */
(() => {
  const $ = (id) => document.getElementById(id);
  const API = window.API;

  const TERMINAL = ["completed", "failed", "cancelled"];
  let polling = false;

  // ── View state ──────────────────────────────────────────────────────────
  let folders = [];                 // flat list from /api/folders
  let folderMap = new Map();        // id -> folder
  let currentFolder = null;         // null = All Media (every folder)
  let currentType = "all";          // all | image | video
  let page = 1, perPage = 60, total = 0;
  let jobs = [];                    // current page jobs
  let selected = new Set();         // selected job ids (current page scope)
  let previewList = [];             // jobs navigable in the preview modal
  let previewIndex = 0;
  let searchQuery = "";

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
    loadFolders();
  }

  $("btn-logout").addEventListener("click", () => {
    API.logout();
    stopPolling();
    showAuth();
  });

  // ── Folders ─────────────────────────────────────────────────────────────
  async function loadFolders() {
    try {
      const data = await API.listFolders();
      folders = data.folders || [];
      folderMap = new Map(folders.map((f) => [f.id, f]));
      renderFolderTree();
      await loadVideos(true);
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
      else toast("Failed to load folders: " + err.message, "err");
    }
  }

  function folderPath(folderId) {
    const out = [];
    let id = folderId;
    let guard = 0;
    while (id && folderMap.has(id) && guard++ < 50) {
      const f = folderMap.get(id);
      out.unshift(f);
      id = f.parent_id;
    }
    return out;
  }

  function renderFolderTree() {
    const tree = $("folder-tree");
    tree.innerHTML = "";
    // root "All Media" nav item is in the static sidebar; folder rows go below.
    const byParent = new Map();
    for (const f of folders) {
      const key = f.parent_id || "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(f);
    }
    const childrenOf = (pid) => (byParent.get(pid || "") || []).sort((a, b) => a.name.localeCompare(b.name));
    const expanded = new Set();
    const pathIds = folderPath(currentFolder).map((f) => f.id);
    pathIds.forEach((id) => expanded.add(id));

    const renderNode = (folder, depth) => {
      const kids = childrenOf(folder.id);
      const hasKids = kids.length > 0;
      const isOpen = expanded.has(folder.id);
      const row = document.createElement("div");
      row.className = "folder-row" + (currentFolder === folder.id ? " active" : "");
      row.style.paddingLeft = (8 + depth * 16) + "px";
      row.dataset.folderId = folder.id;
      row.innerHTML = `
        <button class="folder-toggle ${hasKids ? "" : "empty"}" type="button">${hasKids ? (isOpen ? "▾" : "▸") : "·"}</button>
        <button class="folder-name" type="button">📁 <span>${escapeHtml(folder.name)}</span></button>
        <span class="folder-count">${folder.file_count || ""}</span>
        <span class="folder-ops">
          <button class="op" data-op="add" title="New subfolder">+</button>
          <button class="op" data-op="rename" title="Rename">✏️</button>
          <button class="op" data-op="del" title="Delete">🗑️</button>
        </span>`;
      tree.appendChild(row);
      row.querySelector(".folder-name").addEventListener("click", () => selectFolder(folder.id));
      row.querySelector(".folder-toggle").addEventListener("click", (e) => {
        e.stopPropagation();
        if (!hasKids) return;
        if (expanded.has(folder.id)) expanded.delete(folder.id); else expanded.add(folder.id);
        renderFolderTree();
      });
      row.querySelector('[data-op="add"]').addEventListener("click", (e) => { e.stopPropagation(); promptNewFolder(folder.id); });
      row.querySelector('[data-op="rename"]').addEventListener("click", (e) => { e.stopPropagation(); promptRename(folder); });
      row.querySelector('[data-op="del"]').addEventListener("click", (e) => { e.stopPropagation(); confirmDeleteFolder(folder); });
      if (isOpen) for (const kid of kids) renderNode(kid, depth + 1);
    };
    for (const root of childrenOf("")) renderNode(root, 0);

    document.querySelectorAll('.nav-item[data-folder-id=""]').forEach((el) => {
      el.classList.toggle("active", currentFolder === null);
    });
  }

  function selectFolder(id) {
    currentFolder = id;
    selected.clear();
    renderFolderTree();
    loadVideos(true);
  }
  $('.nav-item[data-folder-id=""]').addEventListener("click", () => selectFolder(null));

  function promptNewFolder(parentId) {
    const name = prompt("New folder name:");
    if (name == null) return;
    createFolderNow(name.trim(), parentId);
  }
  $("btn-new-folder").addEventListener("click", () => promptNewFolder(currentFolder));

  async function createFolderNow(name, parentId) {
    if (!name) return;
    try {
      await API.createFolder(name, parentId);
      toast("Folder created.", "ok");
      await loadFolders();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  function promptRename(folder) {
    const name = prompt("Rename folder:", folder.name);
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder.name) return;
    API.updateFolder(folder.id, { name: trimmed })
      .then(() => { toast("Renamed.", "ok"); loadFolders(); })
      .catch((err) => toast(err.message, "err"));
  }

  function confirmDeleteFolder(folder) {
    if (!confirm(`Delete folder “${folder.name}” and everything inside it? This permanently removes its files, frames, chunks and optimized versions.`)) return;
    API.deleteFolder(folder.id)
      .then((res) => {
        toast(`Deleted ${res.deleted.jobs} file(s) in ${res.deleted.folders} folder(s).`, "ok");
        if (currentFolder === folder.id) currentFolder = null;
        loadFolders();
      })
      .catch((err) => toast(err.message, "err"));
  }

  // ── Gallery ─────────────────────────────────────────────────────────────
  $("#media-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-type]");
    if (!btn) return;
    currentType = btn.dataset.type;
    document.querySelectorAll("#media-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    loadVideos(true);
  });
  $("gallery-search").addEventListener("input", () => {
    searchQuery = ($("gallery-search").value || "").trim().toLowerCase();
    loadVideos(true);
  });

  async function loadVideos(resetPage = false) {
    if (resetPage) page = 1;
    try {
      const data = await API.listVideos({ folderId: currentFolder, type: currentType, page, perPage });
      jobs = data.jobs || [];
      total = data.total || 0;
      selected.clear();
      previewList = jobs;
      updateSelectionBar();
      renderGallery();
      renderPager();
      const hasLive = jobs.some((j) => !TERMINAL.includes(j.status));
      if (hasLive) startPolling(); else stopPolling();
    } catch (err) {
      if (err.status === 401) { API.logout(); showAuth(); }
      else toast("Failed to load media: " + err.message, "err");
    }
  }

  function viewTitle() {
    if (currentFolder && folderMap.has(currentFolder)) return folderMap.get(currentFolder).name;
    return "All Media";
  }

  function renderGallery() {
    $("view-title").textContent = viewTitle();
    // Breadcrumb
    const crumb = $("breadcrumb");
    const path = folderPath(currentFolder);
    crumb.innerHTML = '<a href="#" data-bc="">All Media</a>';
    path.forEach((f) => {
      const a = document.createElement("a");
      a.href = "#";
      a.dataset.bc = f.id;
      a.textContent = " / " + f.name;
      crumb.appendChild(a);
    });
    crumb.querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      selectFolder(a.dataset.bc || null);
    }));

    const jobsList = searchQuery ? jobs.filter((j) => (j.original_filename || "").toLowerCase().includes(searchQuery)) : jobs;
    const typeLabel = currentType === "image" ? "images" : currentType === "video" ? "videos" : "files";
    $("library-note").textContent = total ? `${total} ${typeLabel}${currentFolder ? " in this folder" : ""}` : "—";
    $("empty-text").textContent = searchQuery
      ? `No media match “${escapeHtml(searchQuery)}”.`
      : "No media here yet. Upload files or a folder and they'll appear here.";

    $("videos-empty").classList.toggle("hidden", jobsList.length > 0);
    $("gallery").classList.toggle("hidden", jobsList.length === 0);
    const gallery = $("gallery");
    gallery.innerHTML = "";
    if (!jobsList.length) return;

    for (const j of jobsList) {
      const isImage = j.media_type === "image";
      const thumb = isImage ? (j.thumbUrl || "") : (j.videoThumbUrl || "");
      const badge = isImage
        ? { cls: j.optimize_status || "uploaded", label: API.statusLabel(j.optimize_status || "uploaded") }
        : { cls: j.status, label: API.statusLabel(j.status) };
      const card = document.createElement("div");
      card.className = "media-card" + (selected.has(j.id) ? " selected" : "");
      card.innerHTML = `
        <label class="media-check"><input type="checkbox" data-check="${j.id}" ${selected.has(j.id) ? "checked" : ""} /></label>
        <div class="media-thumb" data-preview="${j.id}">
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
        </div>`;
      gallery.appendChild(card);
    }
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(total / perPage));
    const pager = $("gallery-pager");
    pager.classList.toggle("hidden", pages <= 1);
    if (pages <= 1) { pager.innerHTML = ""; return; }
    pager.innerHTML = `<button class="btn small ghost" id="pg-prev" ${page <= 1 ? "disabled" : ""}>‹ Prev</button>
      <span class="pager-num">Page ${page} of ${pages}</span>
      <button class="btn small ghost" id="pg-next" ${page >= pages ? "disabled" : ""}>Next ›</button>`;
    $("pg-prev").addEventListener("click", () => { if (page > 1) { page--; loadVideos(); } });
    $("pg-next").addEventListener("click", () => { if (page < pages) { page++; loadVideos(); } });
  }

  // ── Selection + bulk actions ────────────────────────────────────────────
  $("gallery").addEventListener("click", (e) => {
    const preview = e.target.closest("[data-preview]");
    if (preview && !e.target.closest("input[type=checkbox]")) {
      openPreview(preview.dataset.preview);
      return;
    }
  });
  $("gallery").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-check]");
    if (!box) return;
    if (box.checked) selected.add(box.dataset.check);
    else selected.delete(box.dataset.check);
    box.closest(".media-card").classList.toggle("selected", box.checked);
    updateSelectionBar();
  });

  function currentPageIds() {
    return jobs.filter((j) => !searchQuery || (j.original_filename || "").toLowerCase().includes(searchQuery)).map((j) => j.id);
  }
  $("sel-all").addEventListener("click", () => {
    currentPageIds().forEach((id) => selected.add(id));
    renderGallery();
    updateSelectionBar();
  });
  $("sel-none").addEventListener("click", () => { selected.clear(); renderGallery(); updateSelectionBar(); });

  function updateSelectionBar() {
    const bar = $("selection-bar");
    const n = selected.size;
    bar.classList.toggle("hidden", n === 0);
    $("sel-count").textContent = `${n} selected`;
  }

  function selectedJobs() {
    return jobs.filter((j) => selected.has(j.id));
  }

  $("sel-download").addEventListener("click", () => {
    const list = selectedJobs();
    if (!list.length) return;
    let opened = 0;
    for (const j of list) {
      const url = j.optimizedUrl || j.originalUrl;
      if (!url) continue;
      const a = document.createElement("a");
      a.href = url;
      a.download = j.original_filename;
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
      opened++;
    }
    if (!opened) toast("Nothing ready to download.", "err");
  });

  $("sel-zip").addEventListener("click", async () => {
    const list = selectedJobs();
    if (!list.length) return;
    $("sel-zip").disabled = true;
    try {
      if (currentFolder && currentFolder !== null) {
        const res = await API.folderExport(currentFolder);
        toast("Folder ZIP queued.", "ok");
        pollExport(res.exportId);
      } else {
        let n = 0;
        for (const j of list) {
          const res = await API.jobExport(j.id, null);
          pollExport(res.exportId);
          n++;
        }
        toast(`${n} ZIP export(s) queued.`, "ok");
      }
    } catch (err) {
      toast(err.message, "err");
    } finally {
      $("sel-zip").disabled = false;
    }
  });

  async function pollExport(exportId, tries = 40) {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const st = await API.exportStatus(exportId);
        if (st.status === "completed" && st.downloadUrl) {
          const a = document.createElement("a");
          a.href = st.downloadUrl;
          a.download = "export.zip";
          a.target = "_blank";
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast("ZIP ready — downloading.", "ok");
          return;
        }
        if (st.status === "failed") { toast("ZIP failed: " + (st.error_message || "unknown"), "err"); return; }
      } catch { /* transient — keep polling */ }
    }
    toast("ZIP is still processing — check later.", "ok");
  }

  $("sel-delete").addEventListener("click", async () => {
    const list = selectedJobs();
    if (!list.length) return;
    if (!confirm(`Delete ${list.length} file(s) permanently? This removes their frames, chunks and optimized versions.`)) return;
    $("sel-delete").disabled = true;
    try {
      for (const j of list) await API.deleteJob(j.id);
      toast(`Deleted ${list.length} file(s).`, "ok");
      selected.clear();
      await loadVideos();
    } catch (err) {
      toast("Delete failed: " + err.message, "err");
    } finally {
      $("sel-delete").disabled = false;
    }
  });

  // ── Preview modal ───────────────────────────────────────────────────────
  function openPreview(id) {
    const idx = previewList.findIndex((j) => j.id === id);
    if (idx < 0) return;
    previewIndex = idx;
    $("preview-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    renderPreview();
  }
  function closePreview() {
    $("preview-modal").classList.add("hidden");
    document.body.style.overflow = "";
    const body = $("preview-body");
    body.innerHTML = "";
  }
  $("preview-close").addEventListener("click", closePreview);
  $("preview-backdrop").addEventListener("click", closePreview);
  $("preview-prev").addEventListener("click", (e) => { e.stopPropagation(); stepPreview(-1); });
  $("preview-next").addEventListener("click", (e) => { e.stopPropagation(); stepPreview(1); });
  document.addEventListener("keydown", (e) => {
    if ($("preview-modal").classList.contains("hidden")) return;
    if (e.key === "Escape") closePreview();
    if (e.key === "ArrowLeft") stepPreview(-1);
    if (e.key === "ArrowRight") stepPreview(1);
  });

  function stepPreview(dir) {
    if (!previewList.length) return;
    previewIndex = (previewIndex + dir + previewList.length) % previewList.length;
    renderPreview();
  }

  function renderPreview() {
    const j = previewList[previewIndex];
    if (!j) return;
    const body = $("preview-body");
    body.innerHTML = "";
    const isImage = j.media_type === "image";
    if (isImage) {
      const img = document.createElement("img");
      img.src = j.originalUrl || j.optimizedUrl || "";
      img.alt = j.original_filename;
      body.appendChild(img);
    } else {
      const vid = document.createElement("video");
      vid.src = j.originalUrl || "";
      if (j.videoThumbUrl) vid.poster = j.videoThumbUrl;
      vid.controls = true;
      vid.autoplay = true;
      body.appendChild(vid);
    }
    $("preview-caption").textContent = `${isImage ? "Image" : "Video"} · ${j.original_filename} · ${API.fmtBytes(j.file_size)} (${previewIndex + 1}/${previewList.length})`;
  }

  // ── Upload (with streaming hash + dedup) ────────────────────────────────
  const dropzone = $("dropzone");
  const fileInput = $("file-input");
  const folderInput = $("folder-input");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = [];
    if (e.dataTransfer.items && e.dataTransfer.items.length) {
      for (const it of e.dataTransfer.items) {
        if (it.kind !== "file") continue;
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) await walkEntry(entry, "", files);
        else if (it.getAsFile()) files.push(it.getAsFile());
      }
    } else if (e.dataTransfer.files.length) {
      files.push(...e.dataTransfer.files);
    }
    if (files.length) startUpload(files);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) startUpload([...fileInput.files]);
  });
  folderInput.addEventListener("change", () => {
    if (folderInput.files.length) startUpload([...folderInput.files]);
    folderInput.value = "";
  });
  $("btn-upload").addEventListener("click", () => {
    const panel = $("upload-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      const path = folderPath(currentFolder).map((f) => f.name).join(" / ");
      $("upload-folder-label").textContent = currentFolder ? (path || viewTitle()) : "All Media";
    }
  });
  $("empty-upload").addEventListener("click", () => $("upload-panel").classList.remove("hidden"));

  function walkEntry(entry, path, out) {
    if (entry.isFile) {
      return new Promise((res) => {
        entry.file((file) => {
          file._relPath = path ? `${path}/${file.name}` : file.name;
          out.push(file);
          res();
        }, () => res());
      });
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      return new Promise((res) => {
        const readBatch = () => reader.readEntries((entries) => {
          if (!entries.length) return res();
          Promise.all(entries.map((e2) => walkEntry(e2, path ? `${path}/${entry.name}` : entry.name, out))).then(readBatch);
        }, () => res());
        readBatch();
      });
    }
    return Promise.resolve();
  }

  async function startUpload(files) {
    $("upload-panel").classList.remove("hidden");
    const wrap = $("upload-batch");
    wrap.classList.remove("hidden");
    wrap.innerHTML = "";
    $("upload-err").textContent = "";
    const folderId = currentFolder;
    let ok = 0, dup = 0;

    await Promise.all(files.map((file) => uploadOne(file, folderId, wrap, (r) => { if (r === "ok") ok++; if (r === "dup") dup++; })));

    fileInput.value = "";
    const parts = [];
    if (ok) parts.push(`${ok} uploaded`);
    if (dup) parts.push(`${dup} duplicate${dup === 1 ? "" : "s"} skipped`);
    if (!ok && !dup) parts.push("nothing uploaded");
    toast(parts.join(" · "), ok ? "ok" : dup ? "ok" : "err");
    await loadVideos();
  }

  function makeUploadRow(wrap, display) {
    const row = document.createElement("div");
    row.className = "upload-row";
    row.innerHTML = `
      <div class="upload-row-head">
        <span class="upload-row-name" title="${escapeHtml(display)}">${escapeHtml(display)}</span>
        <span class="upload-row-status">…</span>
      </div>
      <div class="progress"><span></span></div>`;
    wrap.appendChild(row);
    return {
      el: row,
      bar: row.querySelector(".progress > span"),
      status: row.querySelector(".upload-row-status"),
      set(pct, label) {
        this.bar.style.width = pct + "%";
        this.status.textContent = label != null ? label : Math.round(pct) + "%";
      },
      ok() { this.el.classList.add("ok"); this.set(100, "queued"); },
      fail(msg) { this.el.classList.add("err"); this.status.textContent = "failed: " + msg; },
      dup(msg) { this.el.classList.add("dup"); this.status.textContent = msg || "duplicate skipped"; },
    };
  }

  async function uploadOne(file, folderId, wrap, report) {
    const display = file._relPath || file.name;
    const row = makeUploadRow(wrap, display);
    try {
      row.set(0, "hashing…");
      const sha = await window.SHA256.hashFile(file, (p) => row.set(p * 100, `hashing ${Math.round(p * 100)}%`));
      const chk = await API.uploadCheck(folderId, sha);
      if (chk.duplicate) {
        row.dup(chk.existing ? `duplicate — already have “${chk.existing.filename}”` : "duplicate skipped");
        report("dup");
        return;
      }
      row.set(0, "0%");
      await API.uploadVideo(file, { folderId, sha256: sha, onProgress: (p) => row.set(p * 100) });
      row.ok();
      report("ok");
    } catch (err) {
      if (err.status === 409 && err.message === "duplicate") {
        row.dup("duplicate skipped");
        report("dup");
      } else {
        row.fail(err.message);
      }
    }
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

  // ── Init ────────────────────────────────────────────────────────────────
  if (API.token()) enterApp();
  else showAuth();
})();
