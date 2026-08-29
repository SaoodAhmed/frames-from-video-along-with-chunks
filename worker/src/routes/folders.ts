import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../middleware/auth";
import {
  getFolder,
  validateFolderName,
  collectFolderDescendants,
  deleteFolderCompletely,
} from "../db/folders";
import { notifyProcessors } from "./jobs";
import type { JwtUser } from "../types";

const folders = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// GET / — own folders (flat; frontend builds the tree) with per-folder
// file count + total size. COALESCE so the email root (folder_id NULL) maps to
// the same '' bucket the unique index uses.
folders.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await c.env.DB
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.created_at,
         (SELECT COUNT(*) FROM jobs j WHERE j.user_id = f.user_id
            AND COALESCE(j.folder_id, '') = COALESCE(f.id, '')) AS file_count,
         (SELECT COALESCE(SUM(j.file_size), 0) FROM jobs j WHERE j.user_id = f.user_id
            AND COALESCE(j.folder_id, '') = COALESCE(f.id, '')) AS size
       FROM folders f WHERE f.user_id = ? ORDER BY f.name`
    )
    .bind(user.sub)
    .all();
  return c.json({ folders: rows.results ?? [] });
});

// POST / {name, parentId?} — parentId NULL = email root.
folders.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const parentId = typeof body.parentId === "string" ? body.parentId : null;

  const err = validateFolderName(name);
  if (err) return c.json({ error: err }, 400);

  if (parentId) {
    const parent = await getFolder(c.env.DB, parentId);
    if (!parent || parent.user_id !== user.sub) return c.json({ error: "Parent folder not found" }, 404);
  }

  const dup = await c.env.DB
    .prepare("SELECT 1 FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ?")
    .bind(user.sub, parentId ?? "", name)
    .first();
  if (dup) return c.json({ error: "A folder with this name already exists here", code: "DUPLICATE_NAME" }, 409);

  const id = crypto.randomUUID();
  try {
    await c.env.DB
      .prepare("INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, user.sub, parentId, name, new Date().toISOString(), new Date().toISOString())
      .run();
  } catch (e) {
    const cause = (e as Error | undefined)?.cause as { message?: string } | undefined;
    if ((cause?.message ?? (e as Error)?.message ?? "").includes("UNIQUE constraint failed")) {
      return c.json({ error: "A folder with this name already exists here", code: "DUPLICATE_NAME" }, 409);
    }
    throw e;
  }
  return c.json({ ok: true, id, name, parent_id: parentId }, 201);
});

// PATCH /:id {name?, parentId?} — rename/move (DB-only; R2 keys never change).
folders.patch("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const folder = await getFolder(c.env.DB, id);
  if (!folder || folder.user_id !== user.sub) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const newName = typeof body.name === "string" ? body.name.trim() : null;
  const newParent = typeof body.parentId === "string" ? body.parentId : null;

  if (newName !== null) {
    const err = validateFolderName(newName);
    if (err) return c.json({ error: err }, 400);
  }
  if (newParent !== null && newParent !== folder.parent_id) {
    if (newParent === id) return c.json({ error: "A folder cannot be its own parent" }, 400);
    const parent = await getFolder(c.env.DB, newParent);
    if (!parent || parent.user_id !== user.sub) return c.json({ error: "Parent folder not found" }, 404);
    const desc = await collectFolderDescendants(c.env.DB, id);
    if (desc.includes(newParent)) return c.json({ error: "Cannot move a folder into its own descendant" }, 400);
  }

  const targetParent = newParent === null ? folder.parent_id : newParent;
  const targetName = newName ?? folder.name;

  if ((newName !== null && newName !== folder.name) || (newParent !== null && newParent !== folder.parent_id)) {
    const dup = await c.env.DB
      .prepare("SELECT 1 FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ? AND id <> ?")
      .bind(user.sub, targetParent ?? "", targetName, id)
      .first();
    if (dup) return c.json({ error: "A folder with this name already exists here", code: "DUPLICATE_NAME" }, 409);
  }

  await c.env.DB
    .prepare("UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?")
    .bind(targetName, targetParent, new Date().toISOString(), id)
    .run();
  return c.json({ ok: true, id, name: targetName, parent_id: targetParent });
});

// DELETE /:id — recursive: delete all descendant folders, their jobs and R2.
folders.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const folder = await getFolder(c.env.DB, id);
  if (!folder || folder.user_id !== user.sub) return c.json({ error: "Not found" }, 404);
  const res = await deleteFolderCompletely(c.env, id);
  return c.json({ ok: true, deleted: res });
});

// POST /:id/export — folder-level ZIP of every job's original + optimized files.
// The exports row's job_id points at the folder's first job (FK NOT NULL); the
// runner uses that job's r2_video_key to derive seg+folder and enumerates the
// folder's jobs itself. Owner only.
folders.post("/:id/export", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const folder = await getFolder(c.env.DB, id);
  if (!folder || folder.user_id !== user.sub) return c.json({ error: "Not found" }, 404);

  const rep = await c.env.DB
    .prepare("SELECT id FROM jobs WHERE user_id = ? AND COALESCE(folder_id, '') = ? LIMIT 1")
    .bind(user.sub, id)
    .first<{ id: string }>();
  if (!rep) return c.json({ error: "Folder is empty" }, 400);

  const exportId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB
    .prepare(
      `INSERT INTO exports (id, job_id, folder_id, export_type, kind, status, frame_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'all', 'folder', 'queued', NULL, ?, ?)`
    )
    .bind(exportId, rep.id, id, now, now)
    .run();

  await notifyProcessors(c, { jobId: rep.id, exportId, action: "export" });
  return c.json({ exportId, status: "queued", kind: "folder" }, 201);
});

export default folders;
