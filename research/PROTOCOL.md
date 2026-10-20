# Goodnotes sync protocol (reverse-engineered, read side)

From the web app's traffic and its WASM build (`WASMGoodNotesApp-*.wasm`, Goodnotes' Swift code compiled for the browser, so likely the same code as the iPad and Mac apps). Verified on a 13-page doc: decoded ink matches the rendered page stroke for stroke. `decode.py` implements all of it.

## Endpoints (share link alias = the part after `/s/`)

| Call | Returns |
|---|---|
| `GET /v3/documents/{alias}` | JSON, no auth. `documentToken` (JWT, `"p":"ro"` for view links), `pageIds` (in order), `pages[id]` with `groupId`, `dimension` (pt), `lastModified`, PDF `attachment` |
| `POST /v3/document/{alias}/getNotes/{GROUPID}?documentToken=…` | all items on one page. Body `{2: 10000}` (page size). Headers `Content-Type`/`Accept: application/protobuf` |
| `POST /v3/document/{alias}/getEvents?documentToken=…` | document-level state: doc title, pages, attachments. Body `{3: 10000, 4: ""}` |
| `GET /users/{uid}/documents/{docId}/{shareId}/attachments/{attId}/redirect?documentToken=…` | image attachments (redirects to S3) |
| `wss://api.goodnotescloud.com/notifications/ws` | change notifications, auth with `document.notification.token` |

Write endpoints exist in the WASM but are untested: `writeNotesV3(docAlias, groupId, documentToken, notes, schemaVersion, auth)` → `v3/document/{docAlias}/notes/{groupId}`, and `writeEvents(...)` → `/document/{docAlias}/events`. They need a token with write permission (an edit link or a signed-in session).

## getNotes response

A stream of varint-length-prefixed protobuf messages. Each is `{1: item}` or `{3: cursor}` (pagination, last message).

```
item     { 1: header, 2: content }
header   { 1: item uuid, 2: {1: version counter, 2: hash}, 8: author id, 9: sequence, 11: uuid, 12/13: {1: uuid, 2: document id}, 14, 16 }
content  { 7: stroke } | { 1: box }      # box = rect {2: frame, 3: bounds} + 4: attachment id (pasted images)
stroke   { 1: uuid, 2: points blob, 4: color {1:r 2:g 3:b 4:a f32 0..1}, 6: offset {1: dx, 2: dy f32}, 7: {1: z order, 2: hash}, 15: version, 21 }
```

Stroke field 6 is a translation from lasso moves. It must be applied, or moved strokes render at their old spot.

## Stroke points blob

Apple `compression_lz4` (`bv41` u32 raw size, u32 compressed size, LZ4 block, repeated; ends with `bv4$`), containing a small self-describing format:

```
"tpl\0" u32 total_len  signature\0  values
signature: vuA(v)A(S(uu))A(S(uuuu))vA(f)
  v = u16, u/f = f32, A(x) = u32 count + items, S(..) = struct
values:  pen type (2 = pen), width (pt), per-point flags [0,1,1,..], start point [(x,y)],
         quadratic Bézier segments [(cx,cy,x,y), ...], v, A(f) (empty so far)
```

Coordinates are page points, origin top left. One other signature (`vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)`) showed up once; not decoded yet.

## Not covered yet

PDF page backgrounds (served from `tile.goodnotescloud.com/pdfs/...?token=<tileToken>`), image boxes, text boxes, shapes, highlighter, the second stroke signature, and pagination past 10000 items.
