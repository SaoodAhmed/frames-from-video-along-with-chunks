# Refactor & Complete the Existing Media Management System

The existing application already has most of the required functionality implemented, including the User Dashboard, Admin Dashboard, Cloudflare R2 storage, file uploads, galleries, image optimization, video optimization, and media processing.

**Do NOT build a completely new system.**

First, thoroughly analyze the existing codebase, understand the current frontend, backend, database, R2 structure, APIs, components, upload logic, gallery logic, optimization logic, video processing, and admin/user workflows.

The current logic works partially but is not organized systematically, and several important features and relationships are missing.

The goal is to **refactor and improve the existing implementation into a clean, scalable, production-ready media management system without breaking existing working functionality.**

---

# 1. GENERAL ARCHITECTURE

The system should be organized around the concept of:

```text
User
  ↓
Folder
  ↓
Original Media
  ↓
Generated/Processed Media
```

Generated media must always maintain a relationship with its original media.

For example:

```text
Original Video
 ├── Optimized Videos
 ├── Video Chunks
 └── Extracted Frames
       └── Optimized Frame Variants
```

Similarly:

```text
Original Image
 └── Optimized Image Variants
```

Do not rely only on filenames to establish these relationships.

Use proper database IDs/relationships and metadata.

---

# 2. USER DASHBOARD

The User Dashboard already has a root-folder/gallery concept.

Keep this concept and improve the UI/UX rather than creating another file-management system.

The user's default root folder should be based on their email identity.

Expected flow:

```text
User Dashboard
    ↓
Root Folder
    ↓
Folders
    ↓
Gallery
       ├── All
       ├── Images
       └── Videos
```

The user should be able to:

* Create folders
* Rename folders
* Delete folders
* Open folders
* Upload multiple files
* Upload multiple images
* Upload multiple videos
* Upload a media folder containing images/videos
* View files in a gallery
* Preview images
* Play videos
* Select individual files
* Select multiple files
* Select all files
* Download files
* Create ZIP files
* Delete selected files

Do not unnecessarily change working functionality.

---

# 3. LARGE FILE UPLOADS

Make sure large files, especially large videos, can be uploaded reliably.

Use the existing upload architecture where possible, but fix it if necessary.

Requirements:

* Multipart/resumable uploads where appropriate
* Upload progress
* Retry handling
* Failed upload recovery
* No browser memory issues
* No corrupted partial files
* Proper duplicate detection
* Proper upload cancellation
* Proper backend/R2 synchronization

---

# 4. DUPLICATE FILE PROTECTION

A user must not be able to accidentally upload the same file multiple times into the same folder.

Do not rely only on filenames.

Use a reliable file identity such as:

```text
file hash/checksum
```

combined with the correct folder/user scope.

The same file may exist in different folders if that is allowed by the application's intended behavior, but it should not be duplicated unnecessarily inside the same folder.

Handle race conditions properly.

---

# 5. ADMIN DASHBOARD — REMOVE THE CURRENT FRAGMENTED WORKFLOW

The Admin Dashboard currently has separate file-level screens where individual files can be viewed and processed.

This is not the desired workflow.

Do not make the admin depend on separate standalone file dashboards.

Instead, use the same gallery-based concept as the User Dashboard.

Expected workflow:

```text
Admin
  ↓
Users
  ↓
Select User
  ↓
Select Folder
  ↓
Open Gallery
  ↓
All / Images / Videos
```

From the gallery, the admin should be able to select media and perform actions.

---

# 6. ADMIN MEDIA SELECTION

Admin should be able to:

```text
Select One
Select Multiple
Select All
Deselect All
```

Actions should dynamically depend on the selected media type.

For example:

```text
Images selected:
[ Optimize ]

Videos selected:
[ Optimize ] [ Chunk ] [ Extract Frames ]

Mixed media:
[ Optimize ]
```

Do not show irrelevant actions.

---

# 7. IMAGE OPTIMIZATION

Admin should be able to optimize:

* One image
* Multiple images
* All selected images

Supported formats should be configurable and extensible, for example:

```text
JPG / JPEG
PNG
WebP
AVIF
```

The system should not hardcode the gallery around only these formats.

Future formats should be able to appear automatically.

---

# 8. IMAGE OPTIMIZATION OVERWRITE LOGIC

This is extremely important.

Optimized files must be treated as **format-specific variants**.

Example:

Original:

```text
photo.png
```

Optimized variants:

```text
photo.webp
photo.avif
photo.jpg
```

These are independent variants.

If the admin optimizes the same original image again as WebP with different optimization settings, the existing WebP variant should be updated/overwritten according to the optimization identity.

Example:

```text
Original:
photo.png

Existing:
photo.webp
Quality: 80
```

Then admin runs:

```text
WebP
Quality: 60
```

The existing WebP version should be replaced/updated.

However, if the admin selects:

```text
AVIF
Quality: 60
```

the existing WebP file must remain untouched.

Final state:

```text
photo.webp
photo.avif
```

Similarly:

```text
photo.jpg
photo.webp
photo.avif
photo.png
```

can coexist as separate variants.

Never allow a format change to accidentally overwrite another format.

---

# 9. OPTIMIZATION IDENTITY

Create a reliable optimization identity using database metadata rather than filename assumptions.

At minimum track:

```text
original_file_id
output_format
optimization settings
quality/compression
output path
status
created_at
updated_at
```

The exact schema can follow the existing architecture, but the relationship must be reliable.

---

# 10. OPTIMIZATION GALLERY

Create a dedicated Admin sidebar section:

```text
Optimization Gallery
```

This gallery should contain all optimized/generated image and video variants according to the application's intended organization.

Provide dynamic format tabs.

For example, if the system currently contains:

```text
WebP
AVIF
PNG
JPG
```

the UI should automatically generate:

```text
All
WebP
AVIF
PNG
JPG
```

Do NOT hardcode these tabs.

If a new supported format appears later, it should automatically appear in the gallery.

If a format has no files, do not unnecessarily show an empty hardcoded tab.

---

# 11. OPTIMIZED IMAGE PREVIEW

Every optimized image must be viewable directly in the gallery.

Admin should be able to:

* View thumbnail
* Open full preview
* Zoom where appropriate
* View format
* View original size
* View optimized size
* View optimization status
* View compression/quality information where available

---

# 12. OPTIMIZED VIDEO PROCESSING

Admin should be able to select:

* One video
* Multiple videos

and optimize them.

The processing should happen asynchronously/backgrounded where appropriate.

Display:

```text
Pending
Processing
Completed
Failed
```

with proper UI states.

Do not unnecessarily overwrite original videos.

---

# 13. OPTIMIZED VIDEO MUST BE PLAYABLE

This is mandatory.

An optimized video must not simply appear as a downloadable file.

It must be playable in the browser through the same type of preview experience used for normal videos/chunks.

For every optimized video:

```text
Thumbnail/Poster
Play
Pause
Seek
Volume
Fullscreen where supported
```

should work correctly.

The admin must be able to open the optimized video from the gallery and actually play it.

Make sure the backend/R2 response headers, MIME types, range requests, CORS, and streaming behavior are correctly configured so large videos can play properly.

Do not consider the video optimization feature complete until the optimized video has been tested in the browser.

---

# 14. VIDEO CHUNKING

Add/fix the missing video chunking workflow.

Admin should be able to select a video from the main gallery:

```text
Select Video
    ↓
Chunk Video
    ↓
Configure Chunk Settings
    ↓
Process
    ↓
Generate Chunks
```

Chunking should preserve the relationship:

```text
Original Video
    ↓
Chunk 001
Chunk 002
Chunk 003
...
```

Each chunk must be associated with the original video.

---

# 15. CHUNKS GALLERY

Create a dedicated Admin sidebar section:

```text
Chunks Gallery
```

This must support **multiple videos dynamically**.

If chunks have been generated for:

```text
Video A
Video B
Video C
```

the Chunks Gallery should automatically generate tabs/groups such as:

```text
All
Video A
Video B
Video C
```

Do NOT hardcode video tabs.

The tabs/groups must be generated dynamically from actual chunked videos.

If another video is chunked later:

```text
Video D
```

the UI should automatically include:

```text
Video D
```

without requiring a frontend code change.

---

# 16. CHUNK GALLERY VIEW

When the admin selects a video tab:

```text
Video A
```

show only the chunks belonging to Video A.

Example:

```text
Video A
 ├── Chunk 001
 ├── Chunk 002
 ├── Chunk 003
 └── Chunk 004
```

Each chunk should display:

* Chunk number
* Thumbnail/poster
* Duration
* File size
* Preview/play
* Download
* Processing status

Chunks must be playable in the browser.

The playback experience should work similarly to the optimized video playback.

---

# 17. MULTIPLE VIDEO CHUNKING

If the admin selects multiple videos and batch chunking is supported, the system must correctly generate chunks for each video.

Example:

```text
Video A
 ├── Chunk 001
 ├── Chunk 002
 └── Chunk 003

Video B
 ├── Chunk 001
 ├── Chunk 002
 └── Chunk 003

Video C
 ├── Chunk 001
 ├── Chunk 002
 └── Chunk 003
```

The Chunks Gallery must automatically recognize these parent videos and generate dynamic tabs/groups:

```text
All
Video A
Video B
Video C
```

Never mix chunks from different videos without clearly identifying their parent.

---

# 18. VIDEO FRAME EXTRACTION

Admin should be able to select any video:

```text
Select Video
    ↓
Extract Frames
```

Frames must remain associated with the source video.

Example:

```text
Video A
 └── Frames
      ├── Frame 001
      ├── Frame 002
      ├── Frame 003
      └── ...
```

---

# 19. FRAMES GALLERY

Create a dedicated Admin sidebar section:

```text
Frames Gallery
```

This must also be fully dynamic.

If frames have been extracted from:

```text
Video A
Video B
Video C
```

automatically generate:

```text
All
Video A
Video B
Video C
```

tabs/groups.

If frames are extracted from another video later:

```text
Video D
```

automatically add:

```text
Video D
```

without hardcoded frontend changes.

---

# 20. VIDEO-SPECIFIC FRAME TABS

When the admin opens:

```text
Frames Gallery
    ↓
Video A
```

only frames generated from Video A should be displayed.

Example:

```text
Video A
 ├── Frame 001
 ├── Frame 002
 ├── Frame 003
 └── Frame 004
```

Similarly:

```text
Video B
 ├── Frame 001
 ├── Frame 002
 └── Frame 003
```

Never mix frames between videos unless the user explicitly selects the global "All" view.

---

# 21. FRAME IMAGE OPTIMIZATION

This functionality is mandatory.

Every extracted frame is an image and must be processable through the same image optimization pipeline.

Admin must be able to select:

```text
One Frame
Multiple Frames
All Frames
```

and optimize/convert them.

Example:

```text
Frame 001
 ├── WebP
 ├── AVIF
 ├── JPG
 └── PNG
```

The same optimization rules used for normal images should apply to frames.

Do not create a completely separate incompatible optimization system for frames.

Reuse the existing image optimization service/pipeline where possible.

---

# 22. FRAME OPTIMIZATION GALLERY

Create a separate dedicated gallery for optimized frame images.

Example:

```text
Optimized Frames Gallery
```

This gallery should be separate from:

```text
Frames Gallery
```

because the original extracted frames and their optimized variants should be distinguishable.

---

# 23. DYNAMIC FORMAT TABS FOR OPTIMIZED FRAMES

The Optimized Frames Gallery must have dynamic format tabs.

For example, if optimized frames currently exist in:

```text
WebP
PNG
AVIF
JPG
```

automatically display:

```text
All
WebP
PNG
AVIF
JPG
```

If later only WebP and AVIF exist:

```text
All
WebP
AVIF
```

Do not hardcode empty format tabs.

If another format is generated later, it should automatically appear.

---

# 24. FRAME OPTIMIZATION OVERWRITE RULE

Use the same independent-variant logic as normal image optimization.

Example:

```text
Frame 001
 ├── frame-001.webp
 ├── frame-001.avif
 └── frame-001.jpg
```

If WebP is optimized again with different compression:

```text
WebP
Compression 60
```

update/overwrite the WebP variant only.

Do not overwrite:

```text
AVIF
JPG
PNG
```

when processing WebP.

Format changes must never destroy another format.

---

# 25. OPTIMIZED FRAME PREVIEW

Admin must be able to open optimized frame images directly.

Provide:

* Thumbnail
* Full preview
* Format
* File size
* Original frame information
* Optimization information
* Download
* Delete where appropriate

---

# 26. DYNAMIC DATA-DRIVEN UI

All generated tabs/groups must be based on actual database/storage data.

Examples:

### Optimization formats

```text
Database:
WebP
AVIF
JPG

UI:
All | WebP | AVIF | JPG
```

### Chunked videos

```text
Database:
Video A
Video B

UI:
All | Video A | Video B
```

### Extracted-frame videos

```text
Database:
Video A
Video C

UI:
All | Video A | Video C
```

### Optimized frame formats

```text
Database:
WebP
PNG
AVIF

UI:
All | WebP | PNG | AVIF
```

Never hardcode these dynamic tabs.

---

# 27. R2 STORAGE STRUCTURE

Clean up and standardize the existing Cloudflare R2 object structure.

Use a predictable structure similar to:

```text
users/
  {userKey}/
    folders/
      {folderId}/
        originals/
          images/
          videos/
          files/

        optimized/
          images/
          videos/

        chunks/
          {originalVideoId}/
            chunk-001
            chunk-002
            chunk-003

        frames/
          {originalVideoId}/
            originals/
            optimized/
              webp/
              avif/
              jpg/
              png/
```

The exact path can be adjusted according to the existing architecture.

The important requirement is:

* User isolation
* Folder isolation
* Original/processed separation
* Parent-child relationships
* Collision-free paths
* Predictable object keys
* Easy retrieval
* Easy cleanup

Do not use uncontrolled user-provided filenames as the complete storage key.

---

# 28. DATABASE RELATIONSHIPS

Use proper relationships such as:

```text
User
 ↓
Folder
 ↓
Original File
 ├── Optimized Variant
 ├── Optimized Variant
 ├── Video Chunk
 ├── Video Chunk
 └── Extracted Frame
       ├── Optimized Variant
       ├── Optimized Variant
       └── ...
```

Every generated asset should have enough metadata to determine:

```text
Who owns it?
Which folder does it belong to?
What original file generated it?
What type of generated asset is it?
What format is it?
What processing configuration was used?
What is its current status?
Where is it stored in R2?
```

---

# 29. ADMIN SIDEBAR INFORMATION ARCHITECTURE

Reorganize the Admin Dashboard into a clear structure.

For example:

```text
Dashboard

Users
  └── User Media

Media
  ├── All
  ├── Images
  └── Videos

Processing
  ├── Optimization Gallery
  ├── Chunks Gallery
  ├── Frames Gallery
  └── Optimized Frames Gallery
```

Adapt this according to the existing application, but remove confusing duplicate navigation.

---

# 30. UI/UX AUDIT

Perform a complete UI/UX audit of the existing Admin Dashboard and User Dashboard.

Fix:

* Confusing navigation
* Duplicate screens
* Duplicate actions
* Unnecessary file-level dashboards
* Inconsistent buttons
* Poor spacing
* Poor gallery layout
* Incorrect modal behavior
* Missing loading states
* Missing empty states
* Missing error states
* Missing processing states
* Poor responsive behavior
* Unclear selected states
* Unclear parent/child relationships
* Too many unnecessary clicks

The interface should make it immediately obvious:

```text
Where am I?
What am I viewing?
Which original file does this belong to?
What is selected?
What action can I perform?
What is currently processing?
Where is the generated result?
```

---

# 31. PROCESSING STATUS

All long-running operations should have proper status tracking.

For example:

```text
Pending
Processing
Completed
Failed
```

Apply this to:

* Image optimization
* Video optimization
* Video chunking
* Frame extraction
* Frame optimization
* Frame conversion

The frontend must not fake processing status.

Use backend/database-backed state.

---

# 32. ERROR HANDLING

Implement proper error handling for:

```text
Upload
Duplicate upload
Folder creation
Folder rename
Folder deletion
File deletion
ZIP creation
Image optimization
Video optimization
Video chunking
Frame extraction
Frame optimization
Format conversion
R2 operations
```

Errors must not leave orphaned database records or orphaned R2 objects.

Handle partial failures gracefully in batch operations.

---

# 33. PERFORMANCE

The system must support:

* Large videos
* Large image sets
* Multiple simultaneous uploads
* Batch image optimization
* Batch video optimization
* Multiple video chunk generation
* Large frame extraction jobs
* Large numbers of generated frames

Use:

* Lazy loading
* Pagination/virtualization where appropriate
* Thumbnail generation
* Efficient R2 access
* Background processing
* Queue/job architecture where appropriate
* Database indexes
* Avoid loading thousands of files into the browser at once

---

# 34. VIDEO PLAYBACK TESTING

This is a critical acceptance requirement.

After implementation, actually test:

### Original video

```text
Open → Play → Seek → Pause
```

### Optimized video

```text
Open → Play → Seek → Pause
```

### Video chunk

```text
Open → Play → Seek → Pause
```

### Multiple chunks

Verify each generated chunk plays correctly.

Do not mark the task complete just because the files exist in R2.

Verify that browser playback actually works.

Check:

* Correct MIME type
* HTTP Range support
* R2 response headers
* CORS
* Browser compatibility
* Video codec/container compatibility
* Streaming behavior
* Large-file playback

---

# 35. END-TO-END TESTING

After implementing the changes, perform a complete end-to-end test.

Test at minimum:

## User

```text
Create folder
Rename folder
Upload multiple images
Upload multiple videos
Upload large video
Upload duplicate file
Open gallery
Open image preview
Play video
Select multiple files
Create ZIP
Delete files
```

## Admin

```text
Open user
Open user folder
Open gallery
Select multiple images
Optimize images
Generate multiple image formats
Verify format-specific overwrite
Select multiple videos
Optimize videos
Play optimized video
Chunk video
Play chunks
Chunk multiple videos if supported
Open Chunks Gallery
Verify dynamic video tabs
Extract frames
Open Frames Gallery
Verify dynamic video tabs
Optimize frames
Open Optimized Frames Gallery
Verify dynamic format tabs
Verify format-specific overwrite
Play optimized videos
Preview optimized frames
```

Fix any discovered issues before considering the implementation complete.

---

# 36. CLEANUP

After implementation:

* Remove obsolete duplicate components.
* Remove redundant APIs.
* Remove unused routes.
* Remove dead code.
* Remove obsolete file-dashboard logic where it conflicts with the new gallery workflow.
* Remove inconsistent R2 paths.
* Remove duplicate database logic.
* Consolidate reusable gallery components.
* Consolidate reusable optimization services.
* Consolidate reusable media-processing logic.

Do not leave two different implementations of the same functionality.

---

# FINAL ARCHITECTURE

The final system should logically work like this:

```text
USER
│
└── Root Folder
     │
     ├── Folders
     │
     └── Gallery
          ├── All
          ├── Images
          └── Videos
```

Admin:

```text
ADMIN
│
├── Users
│    └── User
│         └── Folder
│              └── Gallery
│                   ├── All
│                   ├── Images
│                   └── Videos
│
├── Optimization Gallery
│    └── Dynamic Format Tabs
│         ├── WebP
│         ├── AVIF
│         ├── JPG
│         └── Any Future Format
│
├── Chunks Gallery
│    └── Dynamic Video Tabs
│         ├── Video A
│         │    ├── Chunk 001
│         │    ├── Chunk 002
│         │    └── ...
│         ├── Video B
│         │    ├── Chunk 001
│         │    └── ...
│         └── Any Future Chunked Video
│
├── Frames Gallery
│    └── Dynamic Video Tabs
│         ├── Video A
│         │    ├── Frame 001
│         │    ├── Frame 002
│         │    └── ...
│         ├── Video B
│         │    ├── Frame 001
│         │    └── ...
│         └── Any Future Video
│
└── Optimized Frames Gallery
     └── Dynamic Format Tabs
          ├── WebP
          ├── PNG
          ├── AVIF
          ├── JPG
          └── Any Future Format
```

# CRITICAL RULES

1. **Do not build a parallel application.**
2. **Analyze and refactor the existing implementation first.**
3. Preserve working functionality.
4. Use reusable components/services instead of duplicated logic.
5. Every generated asset must maintain its relationship with its original asset.
6. Optimization variants must be format-independent.
7. Re-optimizing WebP must not overwrite AVIF/JPG/PNG.
8. Dynamic format tabs must come from actual data, not hardcoded values.
9. Dynamic video tabs in Chunks Gallery must come from actual chunked videos.
10. Dynamic video tabs in Frames Gallery must come from actual videos with extracted frames.
11. Optimized Frames must have their own separate gallery.
12. Optimized Frame format tabs must be dynamically generated.
13. Multiple videos must be handled correctly without mixing their chunks or frames.
14. Optimized videos must actually play in the browser.
15. Chunks must actually play in the browser.
16. Large videos must support proper streaming/range requests.
17. R2 paths and database relationships must be consistent.
18. Frontend state must reflect real backend/database processing state.
19. Test the complete workflow instead of assuming the implementation works.
20. Do not consider the task complete until the complete User Dashboard and Admin Dashboard workflows have been tested end-to-end.
