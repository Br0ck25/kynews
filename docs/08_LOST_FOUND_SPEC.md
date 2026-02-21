# Lost and Found Specification

## Goals
- Provide a practical community utility without requiring user accounts.
- Prevent abuse through mandatory moderation and basic anti-spam controls.

## Submission Workflow
1. User fills form: `type`, `title`, `description`, `county`, `contactEmail`.
2. Optional image uploaded via upload URL handshake.
3. Submission saved as `pending` in `lost_found_posts`.
4. Contact email encrypted at rest.

## Moderation Workflow
1. Admin opens queue (`/api/admin/lost-found?status=pending`).
2. Admin approves or rejects each post.
3. Approved posts become publicly visible.
4. Rejected posts remain private with moderation note.
5. All actions logged to `admin_audit_log`.

## Visibility Rules
- Public listing endpoint returns approved posts only.
- Contact email shown publicly only when `show_contact=1`.
- Admin queue always sees decrypted contact email.

## Abuse Controls
- Submission rate limit: 5 per IP per hour.
- Public reporting endpoint for problematic posts.
- Optional Turnstile enforcement gate (`REQUIRE_TURNSTILE=1`).

## Media Handling
- Upload metadata via `/api/uploads/lost-found-url`.
- Binary image upload via `PUT /api/uploads/lost-found/:key`.
- Local dev stores files under `data/uploads/lost-found`.
- Cloud target: R2 object storage with signed URLs.

## Lifecycle
- Default expiry: 30 days from submission.
- Future enhancement: admin renew/archive actions.
