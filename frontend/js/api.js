/* Shared API client for the KENDUIT portals. */
window.API = (() => {
  const TOKEN_KEY = "frameforge_token";
  const USER_KEY = "frameforge_user";

  const token = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  const getUser = () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
    catch { return null; }
  };
  const setUser = (u) => localStorage.setItem(USER_KEY, JSON.stringify(u));

  async function request(path, { method = "GET", body, auth = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth && token()) headers["Authorization"] = `Bearer ${token()}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  async function login(email, password) {
    const data = await request("/api/auth/login", { method: "POST", body: { email, password }, auth: false });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }

  async function register(email, password) {
    const data = await request("/api/auth/register", { method: "POST", body: { email, password }, auth: false });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }

  function logout() { clearToken(); localStorage.removeItem(USER_KEY); }

  /**
   * Upload a File in multipart parts, relayed through the Worker.
   * Each part is PUT same-origin to /api/uploads/part/:jobId/:partNumber,
   * which forwards it into the R2 multipart upload. This avoids needing a CORS
   * policy on the R2 bucket (direct browser→R2 PUTs are blocked without one).
   * folderId = destination folder (null = email root); sha256 = dedup hash.
   * Failed parts retry up to 3× each.
   */
  async function uploadVideo(file, { folderId = null, sha256 = null, onProgress } = {}) {
    const createRes = await request("/api/uploads/create", {
      method: "POST",
      body: { filename: file.name, size: file.size, mimeType: file.type || "video/mp4", folderId, sha256 },
    });
    const { jobId, uploadId, chunkSize } = createRes;

    async function putPart(partNumber, blob) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const resp = await fetch(`/api/uploads/part/${jobId}/${partNumber}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token()}`, "X-Upload-Id": uploadId },
          body: blob,
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.etag) return data.etag;
        if (attempt === 2) {
          throw new Error(`Part ${partNumber} failed (${resp.status})${data.error ? `: ${data.error}` : ""}`);
        }
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }

    const etags = [];
    let uploadedBytes = 0;
    const partCount = Math.max(1, Math.ceil(file.size / chunkSize));
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const etag = await putPart(partNumber, blob);
      etags.push({ partNumber, etag });
      uploadedBytes += blob.size;
      if (onProgress) onProgress(uploadedBytes / file.size);
    }

    return request("/api/uploads/complete", {
      method: "POST",
      body: { jobId, uploadId, parts: etags },
    });
  }

  /** Dedup guard: has a byte-identical file already been uploaded to this folder? */
  async function uploadCheck(folderId, sha256) {
    return request("/api/uploads/check", { method: "POST", body: { folderId, sha256 } });
  }

  /** User gallery listing with folder + media-type filter and pagination. */
  async function listVideos({ folderId, type = "all", page = 1, perPage = 60 } = {}) {
    const q = new URLSearchParams({ type, page: String(page), perPage: String(perPage) });
    if (folderId) q.set("folderId", folderId);
    return request(`/api/videos?${q.toString()}`);
  }

  // ── Folders ────────────────────────────────────────────────────────────
  async function listFolders() {
    return request("/api/folders");
  }
  async function createFolder(name, parentId = null) {
    return request("/api/folders", { method: "POST", body: { name, parentId } });
  }
  async function updateFolder(id, data) {
    return request(`/api/folders/${id}`, { method: "PATCH", body: data });
  }
  async function deleteFolder(id) {
    return request(`/api/folders/${id}`, { method: "DELETE" });
  }
  async function folderExport(folderId) {
    return request(`/api/folders/${folderId}/export`, { method: "POST", body: {} });
  }

  // ── Exports ────────────────────────────────────────────────────────────
  async function jobExport(jobId, ids = null) {
    const body = ids && ids.length ? { type: "selected", ids } : { type: "all" };
    return request(`/api/jobs/${jobId}/export`, { method: "POST", body });
  }
  async function exportStatus(exportId) {
    return request(`/api/jobs/exports/${exportId}`);
  }
  async function deleteJob(id) {
    return request(`/api/jobs/${id}`, { method: "DELETE" });
  }

  /** Bulk-optimize many jobs to any format (admin). */
  async function optimizeBatch(jobIds, opts) {
    return request("/api/admin/optimize-batch", { method: "POST", body: { jobIds, options: opts } });
  }

  /** Optimize selected frames of a job to a chosen format (admin). */
  async function framesOptimize(jobId, frameIds, opts) {
    return request(`/api/jobs/${jobId}/frames/optimize`, { method: "POST", body: { frameIds, ...opts } });
  }

  function fmtBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDuration(secs) {
    if (!secs && secs !== 0) return "—";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function fmtTimestamp(ts) {
    if (ts == null) return "—";
    const m = Math.floor(ts / 60);
    const s = (ts % 60).toFixed(1);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0").padStart(4, "0")}`;
  }

  function statusLabel(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : "—";
  }

  return {
    request, login, register, logout, uploadVideo, uploadCheck,
    listVideos, listFolders, createFolder, updateFolder, deleteFolder, folderExport,
    jobExport, exportStatus, deleteJob, optimizeBatch, framesOptimize,
    token, setToken, clearToken, getUser, setUser,
    fmtBytes, fmtDuration, fmtTimestamp, statusLabel,
  };
})();
