# Production FrameForge — Full-Stack Implementation Task

You are a senior full-stack engineer and cloud architect.

I have an existing Python/Tkinter application called **FrameForge v3.1**, provided in the project as the existing Python source file.

Your job is to transform this existing desktop application into a **production-ready multi-user web application** while preserving the existing frame-extraction functionality.

IMPORTANT: Do NOT simply rewrite the application from scratch. First inspect the existing code carefully and reuse its working extraction logic wherever possible.

---

# 1. BUSINESS REQUIREMENT — VERY IMPORTANT

The application has TWO completely separate parts.

## PART A — USER PORTAL

Normal users can ONLY:

1. Login/authenticate
2. Upload a video
3. See upload progress
4. See their uploaded videos
5. See upload status

Normal users MUST NOT see or access:

- FPS controls
- Smart Scene controls
- Sharpness controls
- Frame extraction controls
- Frame gallery
- Frame selection
- Frame deletion
- Frame preview
- ZIP generation
- Processing controls
- Other users' videos
- Admin panel
- Admin APIs

The user experience should basically be:

Upload video → upload completes → video waits for admin processing.

Users do NOT automatically perform the second processing step.

---

# 2. ADMIN PORTAL — PRIVATE

There must be a completely separate Admin Portal.

Only authorized admin users can access it.

The admin portal must allow:

1. Login
2. View uploaded videos from all users
3. Search/filter uploaded videos
4. Select a video
5. Start processing
6. Select extraction mode/FPS
7. Configure Smart Scene detection
8. Configure image sharpness
9. Monitor processing progress
10. View extracted frame gallery
11. Select frames
12. Select all / deselect all
13. Delete selected frames from the current job
14. Open full frame preview
15. Navigate previous/next frame
16. Download individual JPEG
17. Generate/download ZIP of all frames
18. Generate/download ZIP of selected frames
19. See processing errors
20. See completed/processing/failed status

The existing Tkinter FrameForge UI should become the conceptual basis of this private Admin Portal.

---

# 3. SECURITY REQUIREMENT

DO NOT rely on hiding buttons in the frontend.

Authorization MUST be enforced server-side.

A normal user calling an admin API manually must receive:

HTTP 401/403

depending on authentication/authorization state.

Every admin endpoint must verify:

- authenticated user
- admin role/permission

Users must only be able to access their own uploaded videos.

Admin users can access all videos/jobs according to their permissions.

R2 must remain private.

Never expose Cloudflare R2 access keys/secrets to the browser.

Never put secrets in frontend JavaScript.

---

# 4. TARGET ARCHITECTURE

Use this architecture:

Browser
    ↓
Cloudflare Worker API
    ↓
D1 Database
    +
R2 Object Storage
    ↓
Python Serverless/Container Processing Service
    ↓
R2 Frames/Exports
    ↓
Admin Portal

IMPORTANT:

Cloudflare Worker is NOT the OpenCV processing runtime.

The Python processing service must run:

- Python
- OpenCV
- Pillow
- NumPy

The Worker handles API/authentication/storage metadata/job orchestration.

The Python processing service handles CPU/memory-intensive video processing.

---

# 5. NO VPS

Do NOT build the system around a traditional VPS.

Do not require:

- Nginx VPS
- Gunicorn VPS
- Redis VPS
- Celery VPS
- permanent Python server

The processing layer should be serverless/container-based and capable of scaling independently.

If the chosen Python compute platform has a queue/concurrency limitation, design the application so jobs can remain queued in D1 and be processed when compute capacity becomes available.

Do NOT pretend that R2 or Workers can execute OpenCV Python.

---

# 6. CLOUDFLARE R2

Use Cloudflare R2 for large objects.

Suggested structure:

users/{user_id}/videos/{job_id}/original/{filename}

users/{user_id}/jobs/{job_id}/frames/frame_0000.jpg

users/{user_id}/jobs/{job_id}/frames/frame_0001.jpg

users/{user_id}/jobs/{job_id}/frames/...

users/{user_id}/jobs/{job_id}/exports/frames_all.zip

users/{user_id}/jobs/{job_id}/exports/frames_selected.zip

Keep R2 private.

Do not store large video/frame binary data in D1.

D1 should contain metadata only.

---

# 7. DIRECT-TO-R2 UPLOAD

Do NOT send large videos through the Worker request body if it can be avoided.

Implement a secure upload flow:

1. Browser requests upload authorization from Worker.
2. Worker authenticates the user.
3. Worker creates a job/upload record in D1.
4. Worker returns a secure temporary upload mechanism.
5. Browser uploads video directly to R2.
6. Browser notifies Worker when upload is complete.
7. Worker verifies/records the uploaded object.
8. Job becomes `uploaded`.

Design this carefully for large files.

Support resumable/multipart upload if appropriate for the chosen implementation.

Never trust filename, MIME type, or client-provided file size without validation.

---

# 8. D1 DATABASE

Create proper D1 migrations.

At minimum design tables for:

## users

- id
- email/identifier
- role
- created_at
- updated_at

## jobs/videos

- id
- user_id
- original_filename
- r2_video_key
- file_size
- mime_type
- status
- source_fps
- duration
- width
- height
- total_source_frames
- extraction_fps
- extraction_mode
- sharpness
- scene_threshold
- extracted_frames
- error_message
- created_at
- updated_at
- completed_at

## frames

- id
- job_id
- frame_number
- source_frame_number
- timestamp
- r2_key
- width
- height
- deleted
- created_at

Add proper indexes for:

- user_id
- job_id
- status
- created_at

Use foreign keys where appropriate.

Use transactions for related metadata changes.

---

# 9. JOB STATUS

Use a clear state machine.

For example:

uploaded
queued
processing
completed
failed
cancelled

Do not allow invalid state transitions.

The frontend must display meaningful status.

Example:

Uploaded
Processing
Completed
Failed

---

# 10. PYTHON PROCESSOR

Extract the reusable processing logic from the existing FrameForge Python application.

The existing application already contains functionality for:

- Every Frame
- 10 FPS
- 5 FPS
- 3 FPS
- 2 FPS
- 1 FPS
- Smart Scene
- 1 per 5 seconds
- Thumb Strip
- Custom FPS

Preserve these behaviors unless a change is required for server-side execution.

Existing Smart Scene histogram difference logic should be preserved.

Existing sharpness enhancement should be preserved.

Existing frame limit/safety logic should be preserved, but make limits configurable.

---

# 11. IMPORTANT PROCESSING CHANGE

The current desktop app stores extracted frame data in memory.

Do NOT copy that architecture directly to production.

Do NOT keep thousands of full-resolution frames permanently in Python RAM.

Instead:

Video from R2
    ↓
OpenCV
    ↓
Extract one frame
    ↓
Encode JPEG
    ↓
Upload JPEG to R2
    ↓
Store frame metadata in D1
    ↓
Release memory
    ↓
Next frame

Use streaming/chunked/temp-file approaches where appropriate.

Keep memory usage predictable.

---

# 12. FRAME GALLERY

The admin gallery must NOT receive all full-resolution frame bytes from the Worker.

Use:

D1 metadata
+
authorized/signed R2 URLs or an appropriate secure delivery mechanism

The browser should load thumbnails directly from R2 where possible.

For thumbnails, consider storing separate thumbnail objects:

frames/thumbs/frame_0000.jpg

and full frames:

frames/full/frame_0000.jpg

This should be implemented if it materially improves performance.

The gallery must remain responsive with thousands of frames.

Use pagination or virtualized/lazy loading rather than rendering thousands of DOM elements simultaneously.

---

# 13. FRAME SELECTION

Implement:

- Select frame
- Deselect frame
- Select all
- Deselect all
- Delete selected
- Selected count

Do not store selection state only in the browser if it must survive refreshes.

If persistent selection is necessary, store it in D1 or another appropriate persistent mechanism.

Deleting a frame must properly update metadata and the corresponding R2 object.

Never leave orphaned R2 objects unnecessarily.

---

# 14. PREVIEW

Admin can open a frame preview.

Requirements:

- large preview
- previous
- next
- frame number
- timestamp
- original dimensions
- download JPEG

Do not download the entire video to the browser just to preview a frame.

---

# 15. ZIP GENERATION

Do NOT copy the existing Tkinter `BytesIO()` ZIP architecture for large production jobs.

The existing application currently creates the ZIP in memory.

Replace this with a production-safe approach.

For large ZIP exports:

Frames
    ↓
Python export process
    ↓
ZIP
    ↓
R2 exports/
    ↓
Admin download

Do not hold an enormous ZIP entirely in RAM.

If the platform supports streaming ZIP generation, use it.

Otherwise use temporary disk/object-storage based processing safely.

---

# 16. MULTIPLE USERS

The system must support multiple users uploading simultaneously.

Example:

User A → Video A
User B → Video B
User C → Video C
User D → Video D

All can upload independently.

Their uploads must not block each other unnecessarily.

R2 handles video storage.

D1 tracks metadata.

The processing system must support queued jobs.

Multiple processing jobs may run concurrently depending on the available serverless compute concurrency.

Do not assume unlimited CPU.

Implement a queue/state mechanism.

---

# 17. IMPORTANT SEPARATION OF UPLOAD AND PROCESSING

This is a core business requirement.

Uploading DOES NOT automatically start frame extraction.

Correct flow:

USER:

Login
↓
Upload
↓
Upload complete
↓
Waiting for processing

ADMIN:

Login
↓
View uploaded videos
↓
Choose video
↓
Configure extraction
↓
Start processing
↓
Monitor processing
↓
Review frames
↓
Export ZIP

---

# 18. ADMIN VIDEO LIST

Create a professional admin table:

Columns:

- User
- Filename
- Size
- Duration
- Resolution
- Upload date
- Status
- Extracted frames
- Actions

Actions:

View
Process
Resume
Retry
Delete

Only show actions appropriate for the current state.

---

# 19. PROGRESS

Processing must provide progress.

Python processor should periodically update D1.

Example:

processed_frames = 750
total_source_frames = 3000

Frontend displays:

25%

750 / 3000 frames

Do not update D1 on every single video frame.

Throttle progress updates to avoid excessive database writes.

---

# 20. ERROR HANDLING

Implement production-level errors.

Examples:

- invalid video
- unsupported format
- corrupted video
- R2 upload failure
- R2 download failure
- OpenCV failure
- Python processing timeout
- D1 failure
- ZIP generation failure
- job cancellation
- duplicate job
- missing R2 object

Errors should be:

- logged
- associated with the job
- visible to admin
- safe for users

Do not expose secrets or stack traces to normal users.

---

# 21. CANCELLATION

Admin should be able to cancel a running processing job.

Python processor should periodically check job state/cancellation signal.

On cancellation:

- stop processing
- release resources
- mark job cancelled
- clean up partial files where appropriate

---

# 22. RETRY

Admin should be able to retry failed processing.

Retry should not create inconsistent duplicate records.

Either:

- reuse the same job safely, or
- create a new processing attempt/job linked to the original upload.

Choose the cleaner production architecture and explain the decision.

---

# 23. AUTHENTICATION

Use a production-ready authentication solution.

Do not invent an insecure password system.

The application needs:

- user authentication
- admin authentication
- role-based authorization

Admin routes must be protected server-side.

Users must only see their own uploads.

Admin can see all uploads.

If an external authentication provider is needed, explain why before introducing unnecessary dependencies.

---

# 24. FRONTEND

Use:

HTML
CSS
JavaScript

unless there is a strong technical reason to use a framework.

Keep the UI modern, responsive, fast and production-quality.

Do NOT make the frontend look like a generic dashboard template.

The existing FrameForge visual identity can be preserved/adapted:

- dark interface
- strong accent
- clean cards
- responsive gallery
- professional typography
- clear status indicators

But improve usability for web.

---

# 25. USER PORTAL UI

User should see something like:

FrameForge

My Videos

+ Upload Video

Upload area:

Drag & Drop video
or
Browse

Upload progress

After upload:

Filename
Size
Duration if available
Uploaded
Waiting for processing

Do NOT show extraction controls.

---

# 26. ADMIN UI

Admin should have:

Sidebar:

Dashboard
Uploads
Processing
Completed
Failed

Main:

Video/job table

Then processing screen:

Video information
FPS presets
Smart Scene
Sharpness
Extraction settings
Start Processing

Then:

Progress

Then:

Frame gallery

Then:

Preview / selection / ZIP export

---

# 27. API DESIGN

Create clean API routes.

Example:

POST /api/uploads/create
POST /api/uploads/complete

GET /api/videos
GET /api/videos/:id

GET /api/jobs/:id
POST /api/jobs/:id/process
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry

GET /api/jobs/:id/frames

POST /api/jobs/:id/frames/delete

POST /api/jobs/:id/export

GET /api/exports/:id

Separate admin-only routes where appropriate.

Do not expose internal storage keys unnecessarily.

---

# 28. CLOUDFLARE WORKER

Worker responsibilities:

- authentication middleware
- authorization middleware
- user APIs
- admin APIs
- D1 operations
- R2 operations
- upload authorization
- signed URL generation
- job creation
- job status
- rate limiting where appropriate
- input validation
- CORS
- security headers

Keep Worker code modular.

Do not create one giant index.ts.

---

# 29. PYTHON SERVICE

Structure Python cleanly:

processor/
    app.py
    extractor.py
    scene_detection.py
    frame_encoder.py
    r2_storage.py
    job_manager.py
    config.py
    requirements.txt

Separate:

- video extraction
- image encoding
- R2 storage
- job state
- configuration

Use environment variables for secrets.

---

# 30. DO NOT PUT THESE IN GIT

Never commit:

- R2 access keys
- Cloudflare API tokens
- authentication secrets
- JWT secrets
- database secrets
- production credentials

Create:

.env.example

with placeholders.

---

# 31. CONFIGURATION

Use environment variables for:

R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
D1_DATABASE_ID
AUTH_SECRET
PROCESSOR configuration
MAX_UPLOAD_SIZE
MAX_FRAMES
etc.

Do not hardcode credentials.

---

# 32. DATABASE MIGRATIONS

Create proper SQL migration files.

Example:

migrations/
001_initial.sql
002_indexes.sql

Document how to apply them to Cloudflare D1.

---

# 33. CLOUDFLARE CONFIG

Create proper Wrangler configuration.

Use bindings for:

D1
R2

Do not expose bindings to the frontend.

Create separate development/production configuration where appropriate.

---

# 34. LOCAL DEVELOPMENT

The project must be easy to run locally.

Provide:

1. Worker local development
2. D1 local development
3. R2 development/testing strategy
4. Python processor local development
5. Frontend local development

Create clear README instructions.

---

# 35. PRODUCTION DEPLOYMENT

Document the exact deployment order:

1. Create R2 bucket
2. Create D1 database
3. Apply D1 migrations
4. Configure Worker bindings
5. Configure secrets
6. Deploy Worker
7. Deploy frontend
8. Deploy Python processing service
9. Configure processor environment
10. Test upload
11. Test admin processing
12. Test frame gallery
13. Test ZIP export
14. Test authorization

---

# 36. DO NOT BREAK EXISTING EXTRACTION LOGIC

Before modifying anything, inspect the existing FrameForge Python source carefully.

Identify and preserve:

- get_preset_fps()
- scene detection
- histogram comparison
- FPS extraction
- custom FPS
- sharpness enhancement
- frame numbering
- timestamps
- JPEG quality
- MAX_FRAMES safety
- extraction progress behavior

The current application uses OpenCV and Pillow and stores compressed JPEG bytes for memory efficiency. Preserve the useful parts of that design while adapting storage to R2. 

---

# 37. PRODUCTION MEMORY REQUIREMENTS

The original application intentionally changed full frames from raw PIL images to compressed JPEG bytes to reduce memory usage.

For the web/serverless version, improve this further:

Do not accumulate every full frame in memory.

Process:

frame → encode → upload R2 → release

Use bounded memory.

Do not load a multi-GB video entirely into memory.

---

# 38. OBSERVABILITY

Implement structured logging.

Each log should include:

- job_id
- user_id where appropriate
- event
- timestamp
- status
- error code

Never log secrets.

---

# 39. CLEANUP

Implement cleanup strategy for:

- failed uploads
- abandoned uploads
- cancelled jobs
- temporary processor files
- failed ZIP exports
- old exports

Do not allow R2 to fill indefinitely with orphaned temporary files.

---

# 40. PERFORMANCE

Optimize for:

- large uploads
- multiple simultaneous users
- large videos
- thousands of frames
- lazy-loaded gallery
- direct R2 downloads
- minimal Worker bandwidth
- minimal D1 writes
- bounded Python memory
- concurrent processing where compute capacity allows

Do not make the Worker proxy large video/frame payloads unnecessarily.

---

# 41. WHAT I EXPECT FROM YOU

Work directly inside the provided project.

First:

1. Inspect all existing files.
2. Understand the existing FrameForge extraction logic.
3. Identify reusable code.
4. Identify desktop-only code that must be replaced.
5. Design the production architecture.
6. Implement the application.

Do NOT stop after giving me an architecture explanation.

Actually create the production-ready project.

---

# 42. IMPLEMENTATION ORDER

Follow this order:

PHASE 1
Project structure + configuration

PHASE 2
D1 schema + migrations

PHASE 3
R2 integration

PHASE 4
Authentication + authorization

PHASE 5
Worker API

PHASE 6
User upload portal

PHASE 7
Python processor

PHASE 8
Job queue/state management

PHASE 9
Admin portal

PHASE 10
Frame gallery

PHASE 11
Preview

PHASE 12
ZIP export

PHASE 13
Security hardening

PHASE 14
Error handling/retry/cancellation

PHASE 15
Testing

PHASE 16
Deployment documentation

---

# 43. TESTING REQUIREMENTS

Create tests for:

- authentication
- authorization
- user isolation
- admin access
- upload creation
- upload completion
- R2 object existence
- job creation
- job state transitions
- extraction presets
- Smart Scene
- custom FPS
- sharpness
- frame metadata
- frame deletion
- ZIP export
- cancellation
- retry
- failed jobs

Also test:

User A cannot access User B's video.

Normal user cannot call admin processing API.

Unauthenticated user cannot access private resources.

---

# 44. IMPORTANT DECISION RULE

If something is unclear:

1. Prefer the simplest production-safe architecture.
2. Do not introduce unnecessary services.
3. Do not introduce a VPS.
4. Do not expose private R2 objects.
5. Do not trust frontend authorization.
6. Do not store large binary files in D1.
7. Do not process OpenCV inside Cloudflare Workers.
8. Do not keep thousands of frames in RAM.
9. Do not automatically process uploads unless explicitly triggered by admin.
10. Preserve the existing FrameForge extraction behavior.

---

# 45. FINAL ACCEPTANCE CRITERIA

The implementation is complete only when this flow works:

USER:

Login
→ Upload video
→ Video goes directly to R2
→ D1 records upload
→ User sees "Uploaded / Waiting for processing"
→ User cannot see processing controls

ADMIN:

Login
→ Open private admin portal
→ See uploaded videos
→ Select video
→ Choose FPS/Smart Scene/Sharpness
→ Start processing
→ Python processor extracts frames
→ Frames stored in R2
→ Metadata stored in D1
→ Progress displayed
→ Gallery displayed
→ Preview works
→ Selection works
→ Delete works
→ ZIP generation works
→ ZIP downloads from R2

SECURITY:

Normal user cannot access admin portal or admin APIs.

USER A cannot access USER B's video or frames.

R2 credentials never reach browser.

SYSTEM:

Multiple users can upload simultaneously.

Multiple processing jobs can be queued.

Processing compute can scale independently from the Worker.

No traditional VPS is required.

---

# IMPORTANT BEFORE CODING

Do not blindly choose a Python serverless provider.

First inspect the requirements of OpenCV, Pillow, NumPy, video decoding, temporary disk, execution time, memory, concurrency and R2 connectivity.

Choose a suitable serverless/container compute option based on those requirements.

If a component cannot reliably support the workload, explain the limitation and choose a better option.

At the end provide:

1. Architecture summary
2. Files created/modified
3. Environment variables required
4. Cloudflare setup commands
5. D1 migration commands
6. R2 setup
7. Python processor deployment steps
8. Local development commands
9. Production deployment commands
10. Testing instructions
11. Security considerations
12. Known limitations

Do not claim something is production-ready if it has not actually been implemented and tested.