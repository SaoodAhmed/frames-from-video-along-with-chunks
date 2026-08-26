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
   */
  async function uploadVideo(file, onProgress) {
    const createRes = await request("/api/uploads/create", {
      method: "POST",
      body: { filename: file.name, size: file.size, mimeType: file.type || "video/mp4" },
    });
    const { jobId, uploadId, chunkSize } = createRes;

    const etags = [];
    let uploadedBytes = 0;
    const partCount = Math.max(1, Math.ceil(file.size / chunkSize));
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const resp = await fetch(`/api/uploads/part/${jobId}/${partNumber}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token()}`, "X-Upload-Id": uploadId },
        body: blob,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`Part ${partNumber} failed (${resp.status})${data.error ? `: ${data.error}` : ""}`);
      }
      if (!data.etag) throw new Error(`Part ${partNumber} returned no ETag`);
      etags.push({ partNumber, etag: data.etag });
      uploadedBytes += blob.size;
      if (onProgress) onProgress(uploadedBytes / file.size);
    }

    const complete = await request("/api/uploads/complete", {
      method: "POST",
      body: { jobId, uploadId, parts: etags },
    });
    return complete;
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
    request, login, register, logout, uploadVideo,
    token, setToken, clearToken, getUser, setUser,
    fmtBytes, fmtDuration, fmtTimestamp, statusLabel,
  };
})();
