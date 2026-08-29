import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { deleteJobCompletely } from "../lib/cleanup";

export interface FolderRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

const FOLDER_FIELDS = `id, user_id, parent_id, name, created_at, updated_at`;

export async function getFolder(db: D1Database, id: string): Promise<FolderRow | null> {
  const row = await db
    .prepare(`SELECT ${FOLDER_FIELDS} FROM folders WHERE id = ?`)
    .bind(id)
    .first<FolderRow>();
  return row ?? null;
}

export async function listFolders(db: D1Database, userId: string): Promise<FolderRow[]> {
  const rows = await db
    .prepare(`SELECT ${FOLDER_FIELDS} FROM folders WHERE user_id = ? ORDER BY name`)
    .bind(userId)
    .all<FolderRow>();
  return rows.results ?? [];
}

/** Reject empty/oversized names, path-hostile chars and the reserved "root". */
export function validateFolderName(name: string): string | null {
  const n = name.trim();
  if (n.length < 1 || n.length > 100) return "Name must be 1–100 characters";
  if (/[\\/:*?"<>|]/.test(n)) return "Name contains invalid characters";
  if (Array.from(n).some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return "Name contains invalid characters";
  }
  if (n.toLowerCase() === "root") return "Reserved name";
  return null;
}

/** The folder id plus every descendant id (recursive CTE). */
export async function collectFolderDescendants(db: D1Database, folderId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `WITH RECURSIVE descs(id) AS (
         SELECT id FROM folders WHERE id = ?
         UNION ALL
         SELECT f.id FROM folders f JOIN descs d ON f.parent_id = d.id
       ) SELECT id FROM descs`
    )
    .bind(folderId)
    .all<{ id: string }>();
  return (rows.results ?? []).map((r) => r.id);
}

/** Permanently delete a folder and everything under it (jobs + their R2 objects). */
export async function deleteFolderCompletely(env: Env, folderId: string): Promise<{ folders: number; jobs: number }> {
  const ids = await collectFolderDescendants(env.DB, folderId);
  if (!ids.length) return { folders: 0, jobs: 0 };

  const placeholders = ids.map(() => "?").join(",");
  const jobRows = await env.DB
    .prepare(`SELECT id FROM jobs WHERE folder_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string }>();

  let jobs = 0;
  for (const j of jobRows.results ?? []) {
    if (await deleteJobCompletely(env, j.id)) jobs += 1;
  }
  await env.DB.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).bind(...ids).run();
  return { folders: ids.length, jobs };
}
