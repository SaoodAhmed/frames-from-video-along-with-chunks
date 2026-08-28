export type Role = "user" | "admin";

export type JobStatus =
  | "uploaded"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

/** Independent chunk-splitting state (job.status stays 'completed'). */
export type ChunkStatus = "none" | "queued" | "processing" | "completed" | "failed" | "cancelled";

/** Independent optimization state (H.264 compress for videos / resize+WebP-JPEG for images). */
export type OptimizeStatus = "none" | "queued" | "processing" | "completed" | "failed" | "cancelled";

/** What an export ZIP bundles: extracted frames or scene-based chunk videos. */
export type ExportKind = "frames" | "chunks";

export type MediaType = "video" | "image";

export interface User {
  id: string;
  email: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  user_id: string;
  original_filename: string;
  r2_video_key: string;
  file_size: number;
  mime_type: string;
  media_type: MediaType;
  status: JobStatus;
  source_fps: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  total_source_frames: number | null;
  extraction_fps: number | null;
  extraction_mode: string | null;
  sharpness: number | null;
  scene_threshold: number | null;
  extracted_frames: number;
  processed_frames: number;
  error_message: string | null;
  chunk_status: ChunkStatus;
  chunk_count: number;
  chunk_processed: number;
  chunk_total: number;
  chunk_error: string | null;
  optimize_status: OptimizeStatus;
  opt_crf: number | null;
  opt_max_dim: number | null;
  optimized_key: string | null;
  optimized_size: number | null;
  optimized_duration: number | null;
  optimized_thumb_key: string | null;
  opt_format: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Frame {
  id: string;
  job_id: string;
  frame_number: number;
  source_frame_number: number;
  timestamp: number;
  r2_key: string;
  width: number;
  height: number;
  deleted: number;
  created_at: string;
}

export interface Chunk {
  id: string;
  job_id: string;
  chunk_number: number;
  start_sec: number;
  end_sec: number;
  duration: number;
  r2_key: string;
  file_size: number;
  width: number | null;
  height: number | null;
  source_fps: number | null;
  deleted: number;
  created_at: string;
}

export interface JwtUser {
  sub: string;
  email: string;
  role: Role;
}

// R2 key layout
export const r2Keys = {
  originalVideo: (userId: string, jobId: string, filename: string) =>
    `users/${userId}/videos/${jobId}/original/${filename}`,
  optimizedVideo: (userId: string, jobId: string) =>
    `users/${userId}/videos/${jobId}/optimized/optimized.mp4`,
  originalImage: (userId: string, jobId: string, filename: string) =>
    `users/${userId}/images/${jobId}/original/${filename}`,
  optimizedImage: (userId: string, jobId: string) =>
    `users/${userId}/images/${jobId}/optimized/optimized.webp`,
  thumbImage: (userId: string, jobId: string) =>
    `users/${userId}/images/${jobId}/thumb.jpg`,
  fullFrame: (userId: string, jobId: string, n: number) =>
    `users/${userId}/jobs/${jobId}/frames/full/frame_${String(n).padStart(4, "0")}.jpg`,
  thumbFrame: (userId: string, jobId: string, n: number) =>
    `users/${userId}/jobs/${jobId}/frames/thumbs/frame_${String(n).padStart(4, "0")}.jpg`,
  chunkVideo: (userId: string, jobId: string, n: number) =>
    `users/${userId}/jobs/${jobId}/chunks/chunk_${String(n).padStart(4, "0")}.mp4`,
  exportAll: (userId: string, jobId: string, kind: ExportKind = "frames") =>
    `users/${userId}/jobs/${jobId}/exports/${kind}_all.zip`,
  exportSelected: (userId: string, jobId: string, kind: ExportKind = "frames") =>
    `users/${userId}/jobs/${jobId}/exports/${kind}_selected.zip`,
};

// Chunk state machine — allowed transitions
export const CHUNK_TRANSITIONS: Record<ChunkStatus, ChunkStatus[]> = {
  none: ["queued"],
  queued: ["processing", "failed", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransitionChunk(from: ChunkStatus, to: ChunkStatus): boolean {
  return CHUNK_TRANSITIONS[from]?.includes(to) ?? false;
}

// Optimization state machine — allowed transitions
export const OPTIMIZE_TRANSITIONS: Record<OptimizeStatus, OptimizeStatus[]> = {
  none: ["queued"],
  queued: ["processing", "failed", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransitionOptimize(from: OptimizeStatus, to: OptimizeStatus): boolean {
  return OPTIMIZE_TRANSITIONS[from]?.includes(to) ?? false;
}

// Status state machine — allowed transitions
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  uploaded: ["queued"],
  queued: ["processing", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

// Extraction presets (mirrors the Tkinter app)
export type ExtractionMode =
  | "every_frame"
  | "fps"
  | "smart_scene"
  | "one_per_5s"
  | "thumb_strip"
  | "custom";

export const PRESETS: Array<{
  name: string;
  mode: ExtractionMode;
  fps?: number;
  desc: string;
}> = [
  { name: "Every Frame", mode: "every_frame", desc: "Full fidelity — every single frame" },
  { name: "10 fps", mode: "fps", fps: 10.0, desc: "Fine detail — dense sampling, fast action" },
  { name: "5 fps", mode: "fps", fps: 5.0, desc: "High-rate — smooth motion coverage" },
  { name: "3 fps", mode: "fps", fps: 3.0, desc: "Motion detail — balanced speed & coverage" },
  { name: "2 fps", mode: "fps", fps: 2.0, desc: "Action moments — good for dialogue/action" },
  { name: "1 fps", mode: "fps", fps: 1.0, desc: "Key moments — one frame per second" },
  { name: "Smart Scene", mode: "smart_scene", desc: "Scene cuts only — histogram-diff detection" },
  { name: "1 per 5 s", mode: "one_per_5s", desc: "Scene level — broad story overview" },
  { name: "Thumb Strip", mode: "thumb_strip", desc: "Auto-scaled strip — quick overview" },
  { name: "Custom FPS", mode: "custom", desc: "You choose — enter any rate below" },
];
