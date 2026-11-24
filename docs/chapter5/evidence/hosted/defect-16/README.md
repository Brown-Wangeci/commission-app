# Defect 16: phone-camera photos and the request size limit

The defect, its cause and its fix are in `../../../defects.md`, item 16.

## What is here

| File | Shows |
|---|---|
| `retest-hosted.json` | The hosted retest with a real phone: activation LF-000066, submitted 2026-11-24 07:15:25 UTC (10:15 EAT) after the fix was in production. Seven photos stored, the most this job allows (3 + 3 + proof), 74,679 to 170,166 bytes each, 767,533 bytes in all |
| `browser-check-local.json` | The real browser path (canvas, `createImageBitmap`) in headless Chromium on a synthetic 12-megapixel JPEG: a 7.6 MB photo became 556 KB at 1600x1200 for a form allowing two photos, and 133 KB at 1024x768 for a form allowing 13. A local synthetic check, not the hosted retest |

## Hosted retest: passed

Read only from the hosted database and the private Blob store. Times are UTC
with EAT beside them in the JSON.

| Check | Result |
|---|---|
| Submission accepted | Yes. LF-000066 and all 7 evidence rows exist, so the request reached the app and returned 201. No 413. This is inferred from the records: the Vercel request log is not retained on the Hobby plan this long |
| Photos stored | 7 of 7, which is this job's maximum (field_1 up to 3, field_2 up to 3, one proof photo) |
| Stored size | 74,679 to 170,166 bytes each; 767,533 bytes in total, against the 4.5 MB platform limit and the 3.5 MB budget |
| Shrunk | Every photo is 721x1600: the longest side is exactly 1600 px and none has an EXIF block (re-encoding drops it). Stored checksums match the database |
| Capture stamps kept | Six photos carry capture times of 07:08:13 to 07:09:56 UTC, six to seven minutes before the upload at 07:15:30, so they are the camera's times, not the time of shrinking. Each has a device location. The proof photo has no stamp by design |

**Not established.**
- The sizes before shrinking: the original camera files were not supplied.
- Whether the same submission would have failed before the fix. Seven camera
  photos of 3 to 8 MB each would have been far over 4.5 MB, but these particular
  files were not measured.
- All seven photos are 721x1600, a 9:20 shape that is unusual for a camera
  photo (it matches a tall phone screen). The records do not say what they show.
  The test shows the submission path and the shrinking, not how the photos were
  taken.

Not part of defect 16, but visible in the same records: T0 scoring timed out
three times inline (07:15:45, 07:16:01 and 07:16:17 UTC) and succeeded on the
cron retry at 07:17:01 UTC in 823 ms. See `../step18/cron-failure.md`.
