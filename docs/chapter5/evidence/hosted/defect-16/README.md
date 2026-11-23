# Defect 16: phone-camera photos and the request size limit

The defect, its cause and its fix are in `../../../defects.md`, item 16.

## What is here

| File | Shows |
|---|---|
| `browser-check-local.json` | The real browser path (canvas, `createImageBitmap`) in headless Chromium on a synthetic 12-megapixel JPEG: a 7.6 MB photo became 556 KB at 1600x1200 for a form allowing two photos, and 133 KB at 1024x768 for a form allowing 13 (1.7 MB for all 13, under the 4.5 MB platform limit). The modified time, which carries the capture time stamp, is kept. A local synthetic check, not the hosted retest |

## Hosted retest

Not yet run. It needs a real phone submission of the maximum number of photos
on the hosted app after the production deploy of the fix; its result (sizes
before and after, HTTP status) will be recorded here.
