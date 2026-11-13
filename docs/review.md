# Review: variants for a project, decided in Home Hub

Agents propose variants of a screen, a 3D unit, a track or a video. The owner opens them in Home Hub next to
the project and its tickets, compares A/B/C side by side, pins comments on exact elements, and saves one
decision per item ("A, but with these changes"). The agent reads that decision through MCP and publishes the
next round. It sits between paper.design (a canvas that is real HTML) and Claude artifacts (self-contained
pages), but it is attached to a project instead of a chat.

Status: phases 1, 2 and 3 are implemented.

## Phases

| Phase | Content |
|---|---|
| 1 | Review sets per project and tickets, HTML mockups and images, element and point pins, one saved decision per item, MCP read and publish, `scripts/review-push.mjs`, project type |
| 2 | 3D: `.glb` with Google `<model-viewer>` vendored in `public/vendor/` (accepted 2026-11-08), surface pins with the camera pose, synchronised cameras across variants, animations |
| 3 | Video and audio (2026-11-11): clips and tracks played in sync across variants, one variant audible at a time, swipe for aligned clips, comments pinned to a time (and, in a clip, a place) |

## Where things live

- **Variants under review**: the hub's filesystem, `state/review/`. They are content-addressed blobs
  (`blobs/<sha256>`) plus the index, one row per set in `state/hub.db` ([storage.md](storage.md)). This is not git: most variants are thrown away, and
  renders, music and video would stay in history forever (deleting from Git LFS means stopping the git server). `state/` is
  already in the daily NAS backup.
- **The chosen, finished asset**: the project's own repository (Git LFS for large assets). The agent
  commits it after the decision and may put the commit in the next round's notes or the ticket.
- **Rendering**: on whatever machine has the GPU and the tools (Godot, Blender). The hub only displays the results.

## Model

```
set R-<n>  {project, title, description, tickets[], status open|archived, rev, rounds[]}
  round <n> {notes, addresses[comment ids], publishedAt, publishedBy, items[], feedback{itemId → decision}}
    item    {id, title, description, kind html|image|model|video|audio, mode choose|approve, aligned?, variants[]}
      variant {id a..f, label, title, description, reference?, media[]}
        media {sha256, type, size, name, caption, viewport?{width,height}, poster?{sha256,type,size}}
  decision {rev, variant|null, status pending|accept|revise|reject, approvals?{variantId → approved|changes}, note, comments[], attachments[], updatedAt, updatedBy}
    attachment {sha256, type image/*, size, name}
    comment {id, variant, anchor, text, attachments?[], by, at, editedAt?}   (text may be empty when it has a screenshot)
```

- **Two kinds of item.** `mode:"choose"` (the default) shows alternatives and the owner takes one. `mode:"approve"`
  shows deliverables to sign off one by one: the screens of a flow, clips, contact sheets. Each gets ✓ Approve,
  or comments that send it back. The decision then has no `variant`; `approvals` maps each variant to `approved` or
  `changes`, and the status follows: `accept` when all are approved, `revise` when any has changes, `pending`
  otherwise (`reject` = redo the whole item, as before). Use approve whenever the variants are not alternatives.
- `aligned:true` (image and video items) says every variant is the same shot: the same camera, framing and pixel
  size (and, for clips, the same timing), such as one unit rendered before and after a fix. The page opens such an item in *Swipe*. A contact sheet or grid
  is never aligned, even of the same subject, because its cells differ between variants: to make a before/after
  swipeable, publish one aligned item per shot rather than one sheet per variant.
- `reference:true` marks a variant shown only for comparison, such as what is in production now. It can be commented
  on, but never taken or approved. In a choose item, leave "what we have now" as a normal variant if keeping it is
  a valid answer.
- All variants of one item share one kind, so a row compares like with like. The page header switches between
  the kinds that are present.
- `anchor` for HTML is `{kind:'element', mockId?, selector, x, y, snippet}`. The coordinates are document
  pixels in the mockup's fixed viewport, and `snippet` is the start of the element's `outerHTML`, so the agent
  knows which element was meant. For images it is `{kind:'point', x, y}` with fractions in 0..1. For clips it is `{kind:'frame', t, x, y}`: the
  time in seconds and the point as fractions. For audio it is `{kind:'time', t}`. For 3D models
  it is `{kind:'surface', …}` (see below). It may also be `null`, a comment on the whole variant.
- A decision is saved in one request, guarded by `rev`: the chosen variant, the status and the new comments.
  `accept` means take it as it is. `revise` means take it, plus the comments. `reject` means none of these;
  make new ones (it needs a note or a comment). `pending` saves comments without deciding.
- A saved comment of the latest round can be edited or deleted by the person who wrote it, in the same request
  (`editComments`, `deleteComments`). An edit keeps the comment's id and stamps `editedAt`. In the thread your own
  comments carry ✎ Edit and 🗑 Delete; deleting the only comment on the chosen variant turns `revise` back into
  `accept`. Once a later round exists the old round, and its comments, are read-only.
- The page saves on its own: picking a variant saves it, a comment saves when you leave its text box. "None of
  these — redo" opens the note box for what to redo; it takes links in the text and screenshots (paste or
  pick a file, uploaded as blobs, at most 10 per item and 20 MiB each), and the reject is saved once the box has
  a reason and you leave it. An item is framed green when a variant is taken and red when it went back for rework.
- A set is **done** (`done:true` in the summary) when every item of its latest round has a variant taken
  (`accept` or `revise`). The list shows Open (not done), Done and Archive; the bin on a card
  archives the set.
- `feedbackPending` on a set is true when any decision of the latest round is newer than that round, which
  means the agent has something to read.

## The page (`#review`)

The interface is written in Czech source strings with an English dictionary (`public/i18n-en-review.js`);
a hub without a site configuration starts in English. Dates follow the reader's language and the site's
time zone (site.json → `timeZone`, else the browser's).

- **Nothing published yet.** The list explains what Review is for, lists the steps (a service account with
  `review:write`, the push script or MCP `review_publish`), offers a prompt to copy for a coding agent and the
  MCP connection snippet. An empty tab of a hub that has sets only says why that tab is empty.
- **Comparing.** Each item with several variants has a switch: *Side by side* (the grid), *One at a time*
  (one variant at full width with A / B / C tabs; ← → move between them; the default on a phone) and, for
  image and video items whose pictures have one shape (aspect ratio within 1 %), *Swipe*: two variants in one frame with a
  divider to drag (the mouse, a finger or the arrow keys move it; pick which two with the selects). Swipe is the
  default for an `aligned` item; pictures of different shapes never get it. Pins are placed in the first two views.
- **Deciding.** A bar under the header counts the round's decisions (taken, taken with changes, redo,
  undecided) and jumps to the next undecided item, in another kind tab if need be. Each item shows its saved
  state as a badge and a coloured frame, and one line says what to do while it is still undecided.
- **Comments as a thread.** Saved comments list who wrote them, when, on which variant and place, with their
  screenshots. Under a comment that a later round listed in `addresses` the thread shows that round as the
  answer (who published it, its notes); otherwise it says the comment waits for the agent. Comments of earlier
  rounds that no round has answered stay visible under the item as "Open from earlier rounds".
- **3D.** Under each model: *Default view* (back to the framing the model loads with) and *Rotate* (a slow
  turntable), next to the animation picker.

## Video (phase 3)

An item of kind `video` has variants that are clips: `video/mp4` (H.264, the one every browser plays) or
`video/webm`. The upload check is the file's magic bytes (`ftyp` box for mp4, the EBML header for webm); a clip is
at most 256 MiB like any blob, and is served with range requests so the browser can seek. A clip may carry
`poster: {sha256, type}` like a model: the set's card cover and the still shown before it plays.

Use a clip for anything that moves (an effect, an animation, a sequence), not a sheet of frames: a sheet freezes a
few moments, a clip shows the timing. Keep the variants the same length and frame rate, with the same camera, and
mark the item `aligned` when they are the same shot; a few seconds is enough, slow motion is done by the page.

- **Playing in sync.** Under the item one bar drives every clip (🔈 on a variant's header picks whose sound you hear): ▶/⏸, one frame back and forward (1/30 s), a
  scrub bar, the time, the speed (1×, 0.5×, 0.25×) and the sound (off, or the soundtrack of one variant, so two
  never play over each other). The first visible clip leads and the others follow it; a shorter clip loops on its
  own. A click on a clip plays or pauses. Clips loop and start muted.
- **Swipe** works as for images, with the two clips playing in step under the divider.
- **Pins.** In comment mode a click pauses the clips and pins the comment to that time and point
  (`{kind:'frame', t, x, y}`). A pin is drawn while the clip is within a quarter of a second of its time; a click on
  the comment in the thread seeks every clip there.
- The page policy allows it: `media-src 'self' blob:` (`blob:` is for the tracker's preview of a file that is not uploaded yet).

## Audio (phase 3)

An item of kind `audio` has variants that are tracks: `audio/mpeg` (mp3), `audio/wav`, `audio/ogg` (Vorbis or Opus),
`audio/flac`, `audio/mp4` (m4a) or `audio/webm`, checked by their magic bytes. Keep the variants the same length and
loudness, so a switch between them compares the music, not the volume. Audio items are never `aligned`.

- **Waveforms.** Each variant shows its waveform (decoded in the browser; a track over 64 MiB shows a flat line),
  a playhead and its pins. A click on a waveform seeks there.
- **One audible at a time.** All tracks play in sync on one clock, like clips, and exactly one variant is heard:
  the first at the start. 🔈 *Listen to B* on a variant switches the sound to it at the same moment; 🔊 on the
  variant you hear mutes it and hands the sound to the next one. The sound select in the bar does the same, and
  can also turn the sound off.
- **Pins.** In comment mode a click on the waveform pauses and pins the comment to that time (`{kind:'time', t}`).

Both video and audio items stop playing when they scroll out of sight, and only one item plays at a time: starting
one pauses the other.

## HTML mockups are sandboxed

A mockup is one self-contained HTML file, in the same spirit as an artifact: inline CSS and JS, images and
fonts as `data:` URIs. Home Hub never runs it inside its own page:

- `/api/review/frame/<sha>` serves it with `Content-Security-Policy: sandbox allow-scripts`, without
  `allow-same-origin`. The browser treats it as a foreign, opaque origin: no cookies, no session, no Home Hub
  API. The same header applies even if someone opens the URL directly.
- `default-src 'none'` plus only `'unsafe-inline'` scripts and styles, and `data:`/`blob:` images, fonts and
  media. A mockup cannot fetch, post, beacon or load anything. `frame-ancestors 'self'` allows only Home Hub to
  embed it.
- Home Hub injects one small helper script. It reports the document height, hover over `[data-mock-id]` (or
  any element), and in comment mode the click target, all through `postMessage`. The page accepts messages
  only from that iframe's own window and only with the expected shape. Pins are drawn by Home Hub over the
  iframe, never by the mockup.
- Agents should mark meaningful elements with `data-mock-id="cta-button"`. That id is what the comment
  carries.

Blobs (images) are served with `Content-Security-Policy: sandbox; default-src 'none'` and `nosniff`, and only
when a published set references them with a type checked against the file's magic bytes. SVG is not accepted.

## 3D models (phase 2)

An item of kind `model` has variants that are binary glTF files (`.glb`, type `model/gltf-binary`). They are
shown with Google [`<model-viewer>`](https://modelviewer.dev) 4.4.0 (Apache 2.0), vendored as one file in
`public/vendor/model-viewer.min.js` (license next to it). The browser loads it only when a Review set with a model
item is opened; no other page imports it, and it never loads anything from the network.

- **Upload checks.** The file must start with the GLB header (`glTF`, container version 2) and the length in the
  header must equal the file size. A model is at most 128 MiB (`LIMITS.model`).
- **Poster.** A model may carry `poster: {sha256, type}`, a rendered still (png, jpeg or webp). It is the set's
  card cover and what the viewer shows while the model loads.
- **Viewer.** Orbit (drag), zoom (wheel or pinch), pan (right drag or two fingers). If the file has animations,
  a picker under the model plays them. With several variants, **🔗 Views linked** in the item header moves all
  cameras together, so A/B/C are seen from the same side. **⤢ Enlarge** shows one variant full width.
- **Pins.** In comment mode a click on the surface (not a drag) pins a comment. The anchor is

  ```
  {kind:'surface', media, position:{x,y,z}, normal:{x,y,z},
   camera:{theta, phi, radius, target:{x,y,z}, fov}, node, mesh, material, surface|null, animation:{name,time}|null}
  ```

  `position` and `normal` are in the model's own glTF coordinates (metres, Y up). `camera` is the orbit when the pin
  was made: `theta` and `phi` in radians, `radius` in metres, `fov` in degrees. A click on the comment brings the
  camera back to that view, and to that animation frame. `node` is the glTF node path of the hit (root first,
  `" / "`-separated), `mesh` the hit object and `material` its material. These three come from the names in the
  `.glb`, so **name nodes and materials in Godot or Blender**. `node` and `mesh` are read from model-viewer's
  internal scene and may be empty, but the position always comes from the public API. `surface` is
  model-viewer's surface id, which lets the pin follow an animated mesh.
- **CSP.** The page policy stays `script-src 'self'`. Two things are added for the viewer: `img-src blob:` and
  `connect-src blob:`, because GLB textures are decoded from blob URLs. Also, model-viewer's single fixed
  `<style>` block in its shadow DOM is allowed by its `sha256` hash, which the server computes from the vendored
  file at start-up. There is no `'unsafe-inline'`, no workers and no WebAssembly. So Draco, meshopt and KTX2
  compressed models do not load. Export without them.

### Export on the rendering machine

**Godot 4** (from a scene or an imported unit). Run it as an `@tool` script or from the editor's script runner:

```gdscript
var doc := GLTFDocument.new()
var state := GLTFState.new()
var root := load("res://units/unit.tscn").instantiate()
doc.append_from_scene(root, state)              # node names become glTF node names; keep them meaningful
doc.write_to_filesystem(state, "/tmp/review/unit-a.glb")   # .glb = binary glTF
```

For the poster, render the same unit to a `SubViewport` and save `get_texture().get_image().save_png(...)`, or use
`--headless` with a small capture script.

**Blender** (headless):

```bash
blender -b unit.blend --python-expr "import bpy; bpy.ops.export_scene.gltf(filepath='/tmp/review/unit-a.glb', export_format='GLB', export_animations=True, export_draco_mesh_compression_enable=False)"
blender -b unit.blend -o /tmp/review/unit-a -F PNG -f 1     # poster: renders frame 1 → unit-a0001.png
```

Then a manifest for the push script:

```json
{"project":"my-game","title":"Transport unit","tickets":["GAME-7"],
 "items":[{"id":"transport","title":"Transport unit","kind":"model","variants":[
   {"id":"a","title":"Heavy","media":[{"file":"unit-a.glb","poster":"unit-a.png"}]},
   {"id":"b","title":"Light","media":[{"file":"unit-b.glb","poster":"unit-b.png"}]}]}]}
```

## HTTP API

Reads need any sign-in. Writes need write permission; API keys need the `review:write` scope. Error codes:
`400/403/404/409/413 REVIEW_FAILED`.

- `GET /api/review?project=&ticket=&status=open|active|done|archived|all` → `{sets:[summary]}`. The default
  status is `open` (not archived); `active` is open and not done, `done` is open and done.
- `GET /api/review/sets/<R-n>` → the full set with all rounds.
- `HEAD|GET /api/review/blobs/<sha256>` → the file (range requests supported). `404` until a published set
  references it. For an API key `HEAD` also answers for uploaded, unpublished blobs, so the push script can
  skip them.
- `PUT /api/review/blobs/<sha256>?offset=<n>&size=<total>` with an `application/octet-stream` chunk of at
  most 8 MiB → `{received, size, complete}`. Chunks append in order. A wrong offset returns `409` with
  `received`, so the client can resume. The final chunk is hash-checked before the blob becomes visible.
  Blobs are at most 256 MiB, and the whole store is at most `REVIEW_MAX_BYTES` (20 GiB by default). Partial
  uploads older than a day are removed.
- `GET /api/review/frame/<sha256>` → the sandboxed HTML mockup with the helper.
- `POST /api/review/publish` `{project, set?, title?, description?, tickets?, notes?, addresses?, items}` →
  `201` new set, or `200` new round of `set`. Media reference uploaded blobs by `sha256`, or carry a small
  HTML mockup inline (`{type:'text/html', html}`). The body may be up to 64 kB.
- `POST /api/review/feedback` `{set, round, item, rev, variant, status, note?, comments?, attachments?, editComments?, deleteComments?}` → the
  decision. `attachments` replaces the list: `[{sha256, type, name?}]`, images uploaded first with `PUT`.
  `editComments` `[{id, text}]` replaces the text of saved comments, `deleteComments` `[id]` removes them; both only
  for the caller's own comments (`403` otherwise), an unknown id or one id in both lists is `400`.
  `rev` is the decision's rev (0 before the first save). Body up to 64 kB.
- `POST /api/review/sets` `{id, rev, status?, title?}` → changes or archives a set.

## MCP

- `review_list` (`read`): sets by project, ticket or status, or only those with `feedbackPending`.
- `review_get` (`read`): a set with one round (latest by default): items, variants, decisions and comments
  with anchors.
- `review_publish` (`review:write`): a new set or a new round. Binary files are uploaded first with
  `scripts/review-push.mjs`. Small HTML mockups can be passed inline.

## Push script

```bash
HOME_HUB_URL=https://… HOME_HUB_TOKEN=hhk_… node scripts/review-push.mjs path/to/review.json
```

The token is a service-account key with the `review:write` scope (Users and API → Service accounts), and the
`project` in the manifest must exist in the Project Tracker. `review.json` uses the same shape as `review_publish`, but media name local files (`"file":
"mockups/login-a.html"`, relative to the manifest). Tracks are `.mp3`, `.wav`, `.ogg`, `.opus`, `.flac` or
`.m4a`. A `.glb` model or a clip (`.mp4`, `.m4v`, `.webm`) may name its poster the same way (`"poster": "unit-a.png"`). The script hashes the files, skips blobs the hub already
has, uploads the rest in chunks, publishes, and prints the set id and its URL. It has no dependencies.

## Project type

Projects get `type`: `app`, `game` or `other` (`null` until set). It is shown in the tracker and is the
default review tab (game → images first). It is not otherwise enforced.
