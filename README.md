# Article Validation Trigger — Contentstack Custom Field

A Contentstack App Framework **Custom Field** that renders a single "Trigger Validation" button.
Clicking it POSTs the current entry's JSON payload to a configurable webhook URL to kick off an
asynchronous validation agent, then polls a separate status URL (keyed by entry ID) until the
agent's feedback is ready, and shows it inline.

## File structure

```
TIME_ArticleValidationApp/
├── manifest.json              # Contentstack App manifest (Custom Field location)
├── index.html                 # Vite entry HTML
├── package.json
├── vite.config.ts             # base: './' so assets resolve correctly on Launch
├── tsconfig.json
├── tsconfig.node.json
├── src/
│   ├── main.tsx                # React root
│   ├── App.tsx                 # SDK init, resolves the CustomField location
│   ├── index.css                # Venus-style button/status styling
│   ├── vite-env.d.ts
│   └── components/
│       └── ValidationButton.tsx  # Trigger POST + status-poll logic and UI states
└── dist/                        # Build output — upload this to Contentstack Launch
```

## Build

```bash
npm install
npm run build
```

`npm run build` runs `tsc -b` (type-check) followed by `vite build`. The compiled, deployable
app is written to the **`dist/`** folder — that's what you upload to **Contentstack Launch**.

To preview locally:

```bash
npm run dev
```

Note: `sdk.init()` requires the app to actually be running inside the Contentstack UI iframe, so
`npm run dev` alone won't produce a working button — use Launch's preview URL or the Contentstack
"Test URL" mode from Developer Hub for real testing.

## Deploying to Contentstack Launch

1. Run `npm run build`.
2. In Contentstack Launch, create a new project sourced from this repo (or deploy the `dist/`
   folder directly if using manual/file-upload deployment), with:
   - Framework preset: **Other / Static**
   - Build command: `npm run build`
   - Output directory: `dist`
3. Once deployed, copy the Launch URL.
4. In **Developer Hub**, create (or edit) the app and set its **Custom Field** location's base URL
   to the Launch URL from step 3.
5. Install the app on your stack and add the Custom Field to a content type.

## Configuring the field instance

The button reads four values from the field instance's configuration
(`sdk.location.CustomField.fieldConfig`). Set these per field instance when adding the Custom
Field to a content type in Contentstack — under the field's settings, provide a JSON config
such as:

```json
{
  "url": "https://your-validation-service.example.com/validate",
  "statusUrl": "https://api.contentstack.io/v3/content_types/validation_feedback/entries",
  "api_key": "your-stack-api-key",
  "authorization": "your-management-token-or-auth-token"
}
```

- **`url`** — the trigger endpoint. Receives a `POST` with the full entry JSON and is expected
  to queue the validation job (its response body isn't used, only the HTTP status).
- **`statusUrl`** — a Contentstack Management API "query entries" endpoint for the
  `validation_feedback` content type, e.g.
  `https://api.contentstack.io/v3/content_types/validation_feedback/entries`. The app appends
  a CMA query string keyed by entry ID:
  `GET {statusUrl}?query={"entryid":"<entry.uid>"}`, and expects back
  `{ "entries": [ { ..., "feedback": "..." } ] }` (an empty `entries` array means validation
  hasn't finished yet).
- **`api_key`** / **`authorization`** — sent as the `api_key` and `authorization` headers on
  every polling request, as required by Contentstack's Management API.

If `url` or `statusUrl` is missing, the button shows an inline error instead of attempting a
request. `api_key`/`authorization` are optional from the app's point of view — if omitted, the
corresponding header is simply not sent, so requests will fail with an auth error from the
Management API rather than from the app itself.

## How it works

1. `App.tsx` calls `ContentstackAppSDK.init()` and grabs `sdk.location.CustomField`.
2. `ValidationButton.tsx` reads `customField.fieldConfig.url`, `.statusUrl`, `.api_key`, and
   `.authorization`.
3. **Unsaved entries are blocked.** A brand-new entry has no `uid` until it's saved for the
   first time. Since `entryid` would serialize to an empty CMA query (`query={}`, matching
   *any* entry) if sent without a real uid, the button stays disabled — with a "Save this entry
   before running validation" hint — and no status/trigger requests are made at all until
   `customField.entry.getData().uid` exists. `entry.onSave(...)` flips this open automatically
   the moment the entry is first saved, no reload needed.
4. **On first render** (once there's a saved uid), it does a single, silent
   `GET {statusUrl}?query={"entryid":"<entry.uid>"}` check (with the `api_key`/`authorization`
   headers attached) — if feedback already exists (e.g. the editor reopened an entry that was
   validated earlier), it's shown immediately with no click required. If nothing comes back, the
   button just starts idle.
5. On click: it calls `customField.entry.getData()` to get the full entry JSON, then `POST`s it
   to `url` with `Content-Type: application/json`. This only queues the job — the validation
   agent runs asynchronously, so the response has no usable result yet.
6. Once queued, it waits 20 seconds (`INITIAL_POLL_DELAY_MS` in `ValidationButton.tsx`) before
   its first check, then polls the same CMA query URL (again with `api_key`/`authorization`
   headers) every 10 seconds after that (`POLL_INTERVAL_MS`), for up to 18 attempts
   (`MAX_POLL_ATTEMPTS`, i.e. ~3 minutes total), looking for a response whose first entry has a
   non-empty `feedback` field. The response is expected in the CMA `{ "entries": [...] }` shape,
   but a bare entry object or `{ "entry": {...} }` are also accepted.
7. The button stays clickable throughout, including while polling — clicking again cancels the
   in-flight poll and starts over, so the UI can never get permanently stuck.
8. On success, the agent's `feedback` text is rendered as markdown (via `react-markdown`) inline
   and stays visible until the next click. On failure or timeout (after all 18 attempts, i.e.
   ~3 minutes), an error message appears and clears automatically after 8 seconds.

### The `ValidationFeedback` lookup content type

Per the supplied content type schema, the status endpoint is expected to resolve to (or query
for) an entry shaped like:

| Field       | UID        | Notes                                   |
|-------------|------------|------------------------------------------|
| Title       | `title`    | required, unique                          |
| EntryID     | `entryid`  | the `uid` of the entry that was validated |
| Feedback    | `feedback` | markdown text with the agent's feedback   |

`feedback` is rendered as markdown via `react-markdown` (headings, lists, bold/italic, links,
inline code, etc. all render as formatted HTML rather than raw syntax).

### A note on refreshing the entry editor

There is no step that reloads/refreshes the entry itself — the automation's results are shown
directly in this custom field's own UI once polling succeeds, rather than by writing to another
field and refreshing the editor. `@contentstack/app-sdk@2.4.1` doesn't ship a `reload`/`refresh`
method on `Entry` (only `getData()`, `setData()`, `getDraftData()`, `getField()`, and the `on*`
listeners exist) — if you later want the feedback to also land in a separate field visible
elsewhere on the entry, you'd need `entry.setData()` (partial merge, requires host support) or
have editors refresh manually.

## Dependencies

- `@contentstack/app-sdk` — Contentstack App Framework SDK (location, entry, field APIs)
- `react` / `react-dom` — UI
- `lucide-react` — icons (spinner, success/error/shield icons)
- `react-markdown` — renders the agent's `feedback` text as formatted markdown
