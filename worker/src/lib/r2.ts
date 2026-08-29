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

/**
 * R2 object key layout. The first path segment is the user's **segment** — for
 * new uploads that is the user's email (`users/{email}/...`); for legacy rows it
 * is the user UUID. Every key elsewhere is derived from the segment parsed out of
 * the job's stored `r2_video_key` (see `userSegmentFromKey`), so re-processing a
 * legacy job keeps pointing at its existing objects. Must match processor/config.py.
 */
export const r2Keys = {
  originalVideo: (seg: string, jobId: string, filename: string) =>
    `users/${seg}/videos/${jobId}/original/${filename}`,
  optimizedVideo: (seg: string, jobId: string, container: VideoContainer = "mp4") =>
    `users/${seg}/videos/${jobId}/optimized/optimized.${container}`,
  originalImage: (seg: string, jobId: string, filename: string) =>
    `users/${seg}/images/${jobId}/original/${filename}`,
  optimizedImage: (seg: string, jobId: string, format: ImageFormat = "webp") =>
    `users/${seg}/images/${jobId}/optimized/optimized.${IMAGE_EXT[format]}`,
  thumbImage: (seg: string, jobId: string) =>
    `users/${seg}/images/${jobId}/thumb.jpg`,
  videoThumb: (seg: string, jobId: string) =>
    `users/${seg}/jobs/${jobId}/thumbnail.jpg`,
  fullFrame: (seg: string, jobId: string, n: number) =>
    `users/${seg}/jobs/${jobId}/frames/full/frame_${String(n).padStart(4, "0")}.jpg`,
  thumbFrame: (seg: string, jobId: string, n: number) =>
    `users/${seg}/jobs/${jobId}/frames/thumbs/frame_${String(n).padStart(4, "0")}.jpg`,
  optimizedFrame: (seg: string, jobId: string, format: ImageFormat, n: number) =>
    `users/${seg}/jobs/${jobId}/frames/optimized/${format}/frame_${String(n).padStart(4, "0")}.${IMAGE_EXT[format]}`,
  chunkVideo: (seg: string, jobId: string, n: number) =>
    `users/${seg}/jobs/${jobId}/chunks/chunk_${String(n).padStart(4, "0")}.mp4`,
  exportAll: (seg: string, jobId: string, kind: ExportKind = "frames") =>
    `users/${seg}/jobs/${jobId}/exports/${kind}_all.zip`,
  exportSelected: (seg: string, jobId: string, kind: ExportKind = "frames") =>
    `users/${seg}/jobs/${jobId}/exports/${kind}_selected.zip`,
};

/** Extract the user segment from a stored job key (`users/{segment}/{jobId}/...`). */
export function userSegmentFromKey(key: string): string {
  const parts = key.split("/");
  return parts[1] ?? "";
}

/** true when a container is a WebM (forces AV1, mirroring tikinn-2.py). */
export function isWebmContainer(container: string | null | undefined): boolean {
  return container === "webm";
}
