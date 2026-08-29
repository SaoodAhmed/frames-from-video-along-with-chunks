import type { ExportKind } from "../types";

export type VideoContainer = "mp4" | "mkv" | "webm";
export type ImageFormat = "webp" | "jpeg" | "avif" | "png";

export const IMAGE_EXT: Record<ImageFormat, string> = {
  webp: "webp",
  jpeg: "jpg",
  avif: "avif",
  png: "png",
};

export const VIDEO_CONTAINERS: VideoContainer[] = ["mp4", "mkv", "webm"];
export const IMAGE_FORMATS: ImageFormat[] = ["webp", "jpeg", "avif", "png"];

/** Sentinel used in the R2 path when a file lives in the user's email root. */
export const ROOT_FOLDER = "root";

/** R2 path segment for a job: its user folder id, or ROOT_FOLDER when in the email root. */
export function folderPath(folderId: string | null | undefined): string {
  return folderId || ROOT_FOLDER;
}

/**
 * R2 object key layout. The first path segment is the user's **segment** (email);
 * the second is the **user folder** — the folder's id (rename/move is DB-only, so
 * R2 objects never move) or `root` for the email root. Everything for a job hangs
 * off `users/{seg}/{folder|root}/jobs/{jobId}/...`; media type lives in DB, not the
 * path. Must match processor/config.py.
 */
export const r2Keys = {
  originalVideo: (seg: string, folderId: string | null, jobId: string, filename: string) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/original/${filename}`,
  originalImage: (seg: string, folderId: string | null, jobId: string, filename: string) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/original/${filename}`,
  optimizedVideo: (seg: string, folderId: string | null, jobId: string, container: VideoContainer = "mp4") =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/optimized/optimized.${container}`,
  optimizedImage: (seg: string, folderId: string | null, jobId: string, format: ImageFormat = "webp") =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/optimized/optimized.${IMAGE_EXT[format]}`,
  thumbImage: (seg: string, folderId: string | null, jobId: string) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/thumb.jpg`,
  videoThumb: (seg: string, folderId: string | null, jobId: string) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/thumbnail.jpg`,
  fullFrame: (seg: string, folderId: string | null, jobId: string, n: number) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/frames/full/frame_${String(n).padStart(4, "0")}.jpg`,
  thumbFrame: (seg: string, folderId: string | null, jobId: string, n: number) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/frames/thumbs/frame_${String(n).padStart(4, "0")}.jpg`,
  optimizedFrame: (seg: string, folderId: string | null, jobId: string, format: ImageFormat, n: number) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/frames/optimized/${format}/frame_${String(n).padStart(4, "0")}.${IMAGE_EXT[format]}`,
  chunkVideo: (seg: string, folderId: string | null, jobId: string, n: number) =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/chunks/chunk_${String(n).padStart(4, "0")}.mp4`,
  exportAll: (seg: string, folderId: string | null, jobId: string, kind: ExportKind = "frames") =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/exports/${kind}_all.zip`,
  exportSelected: (seg: string, folderId: string | null, jobId: string, kind: ExportKind = "frames") =>
    `users/${seg}/${folderPath(folderId)}/jobs/${jobId}/exports/${kind}_selected.zip`,
};

/** Extract the user segment from a stored job key (`users/{segment}/{folder}/...`). */
export function userSegmentFromKey(key: string): string {
  const parts = key.split("/");
  return parts[1] ?? "";
}

/** Extract the folder path segment (`users/{seg}/{folder}/...`). Returns "root" for email root. */
export function folderSegmentFromKey(key: string): string {
  const parts = key.split("/");
  return parts[2] || ROOT_FOLDER;
}

/** true when a container is a WebM (forces AV1, mirroring tikinn-2.py). */
export function isWebmContainer(container: string | null | undefined): boolean {
  return container === "webm";
}
