# Article Validation Trigger — Contentstack Custom Field

A Contentstack App Framework **Custom Field** that runs entry validation across several
independent categories (headline, URL, author, featured image, SEO, sections/tags, article
text). A "Trigger Validation" button runs all categories at once; editing a field also
auto-triggers just the one category that field belongs to. Each category's feedback — a
findings report written back to a lookup content type by your validation agents — is displayed
inline as a checklist as soon as it's available, and omitted entirely while there's nothing to
show.

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
│   ├── main.tsx                    # React root
│   ├── App.tsx                     # SDK init, resolves the CustomField location
│   ├── index.css                   # Venus-style button/status styling
│   ├── vite-env.d.ts
│   ├── components/
│   │   └── ValidationButton.tsx    # Button + per-category feedback UI (presentational)
│   ├── hooks/
│   │   └── useValidation.ts        # All trigger/poll/auto-trigger state and side effects
│   └── lib/
│       ├── validationConfig.ts     # The category table + field-config parsing
│       └── validationApi.ts        # fetch helpers + JSON RTE -> sanitized HTML rendering
└── dist/                           # Build output — upload this to Contentstack Launch
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

## Validation categories

Everything is organized around 7 fixed categories, defined in
[`src/lib/validationConfig.ts`](src/lib/validationConfig.ts):

| Category key        | `validation_urls` key   | `validation_fields` key | Feedback field uid            |
|----------------------|--------------------------|---------------------------|--------------------------------|
| `headline`           | `headline_check`         | `headlines`                | `headline_feedback`            |
| `url`                | `url_check`               | `urls`                      | `url_feedback`                 |
| `author`             | `author_check`            | `authors`                   | `authors_feedback`             |
| `featured_image`     | `featured_image_check`    | `featured_images`           | `featured_image_feedback`      |
| `seo`                | `seo_check`               | `seos`                      | `seo_feedback`                 |
| `sections_and_tags`  | `section_and_tag_check`   | `sections_and_tags`         | `sections_and_tags_feedback`   |
| `article_text`       | `article_text_check`      | `article_text`              | `article_text_feedback`        |

These three naming spaces (the two field-config sections and the ValidationFeedback content
type's own field uids) don't share exact key names, so there's no way to derive one from
another automatically — this table is the one place that ties them together. **To add, rename,
or remove a category, edit this table** (and the matching entries in the field config + content
type) — nothing else in the code needs to change.

## Configuring the field instance

The button reads its configuration from `sdk.location.CustomField.fieldConfig`, set as a JSON
config on the field instance when you add the Custom Field to a content type:

```json
{
  "url": "https://your-agent-orchestrator.example.com/execute",
  "statusUrl": "https://api.contentstack.io/v3/content_types/validation_feedback/entries",
  "api_key": "your-stack-api-key",
  "authorization": "your-management-token-or-auth-token",
  "validation_urls": {
    "headline_check": "https://.../headline-check",
    "url_check": "https://.../url-check",
    "author_check": "https://.../author-check",
    "featured_image_check": "https://.../featured-image-check",
    "seo_check": "https://.../seo-check",
    "section_and_tag_check": "https://.../section-and-tag-check",
    "article_text_check": "https://.../article-text-check"
  },
  "validation_fields": {
    "headlines": ["headline_field_1_uid", "headline_field_2_uid"],
    "urls": ["slug_field_uid"],
    "authors": ["author_field_uid"],
    "featured_images": ["featured_image_field_uid"],
    "seos": ["seo_field_uid"],
    "sections_and_tags": ["field1_uid", "field2_uid"],
    "article_text": ["article_text_field_uid"]
  }
}
```

- **`url`** — the "run everything" endpoint. The manual button `POST`s the full entry JSON here
  and treats it as queuing every category at once (its response body isn't used, only the HTTP
  status).
- **`statusUrl`** — a Contentstack Management API "query entries" endpoint for the
  `validation_feedback` content type (see below). The app queries it by entry ID:
  `GET {statusUrl}?query={"entryid":"<entry.uid>"}`.
- **`api_key`** / **`authorization`** — sent as-is as the `api_key` and `authorization` headers
  on every request to `statusUrl`, as required by Contentstack's Management API. Optional from
  the app's point of view — if omitted, the header is simply not sent and requests will fail
  with an auth error from the Management API rather than from the app itself.
- **`validation_urls`** — one endpoint per category (see the table above for the exact keys).
  Each is `POST`ed the full entry JSON when that single category is auto-triggered by a field
  edit. A category missing here just never gets auto-triggered (and isn't touched by the "run
  everything" button either, which only depends on `url`).
- **`validation_fields`** — which entry field uid(s) belong to each category, used only to
  decide which category to auto-trigger when a field changes. Each value should be an array of
  field uid strings; a single comma-joined string in one array slot (e.g.
  `["a_uid, b_uid"]`) is also tolerated and split automatically, but prefer separate array
  elements.

If `url` or `statusUrl` is missing, the manual button shows an inline error instead of
attempting a request.

## How it works

1. `App.tsx` calls `ContentstackAppSDK.init()` and grabs `sdk.location.CustomField`, then renders
   `<ValidationButton customField={...} />`.
2. `ValidationButton.tsx` is purely presentational — all the logic lives in the
   `useValidation(customField)` hook.
3. **Unsaved entries are blocked.** A brand-new entry has no `uid` until it's saved for the
   first time. Since `entryid` would serialize to an empty CMA query (`query={}`, matching *any*
   entry) if sent without a real uid, the button stays disabled — with a "Save this entry before
   running validation" hint — and no status/trigger requests are made at all until
   `customField.entry.getData().uid` exists. `entry.onSave(...)` flips this open automatically
   the moment the entry is first saved, no reload needed.
4. **On first render** (once there's a saved uid), it does a single, silent status check and
   shows any feedback that already exists (e.g. the editor reopened an entry that was validated
   earlier) — no click required.
5. **Manual trigger**: clicking the button `POST`s the entry to `url`, then marks *all 7*
   categories as pending and starts the shared polling loop.
6. **Auto-trigger per field edit**: `entry.onChange` fires on every real edit (unlike
   `field.onChange`, which only fires on programmatic writes from other apps — not from someone
   typing in the editor). The hook diffs each change against the previous snapshot, maps any
   changed field uid to its category via `validation_fields`, and — after a 1.5s debounce so
   typing a full sentence doesn't fire a request per keystroke — `POST`s the entry to that one
   category's `validation_urls` endpoint and marks just that category pending.
   - **Every POST body — manual or auto-triggered — is built from the live entry snapshot
     handed to `entry.onChange`, not from calling `entry.getData()` at POST time.**
     `entry.getData()` reflects the last *saved* state, so calling it fresh would send stale
     data for whichever field the editor just changed but hasn't saved yet — exactly the field
     the auto-trigger is meant to validate. The hook keeps a ref updated on every `onChange` and
     sends that.
7. **Polling**: all pending categories share one loop (rather than one per category) — it checks
   `statusUrl` every 10 seconds, for up to 18 attempts per category (~3 minutes), and resolves
   each category independently as soon as its feedback field is non-empty. A category joining
   mid-loop is picked up on the next shared tick rather than getting its own precisely-timed
   first check — simpler to reason about with several categories potentially triggered at
   different times.
8. **Display**: each category with feedback renders its own block — a category label followed
   by a checklist of findings (pass/fail/unknown icon + label, with `message`/`found`/`fix`
   shown only when present, typically on failing findings) — and stays visible across
   re-triggers; a re-check shows a small "Re-checking…" note under the existing findings rather
   than clearing them. A category with no feedback and nothing in progress is omitted entirely.
   A pending category with no feedback yet shows "Waiting for results…"; a failed/timed-out one
   shows an error that clears automatically after 8 seconds (existing feedback for other
   categories is unaffected).

### The `ValidationFeedback` lookup content type

Per the supplied content type schema, `statusUrl` is expected to resolve to (or query for) an
entry shaped like:

| Field                        | UID                            | Notes                                     |
|-------------------------------|----------------------------------|---------------------------------------------|
| Title                          | `title`                          | required, unique                              |
| EntryID                        | `entryid`                        | the `uid` of the entry that was validated     |
| Headline Feedback              | `headline_feedback`              | JSON — findings report (see below)            |
| URL Feedback                   | `url_feedback`                   | JSON — findings report                        |
| Authors Feedback               | `authors_feedback`               | JSON — findings report                        |
| Featured Image Feedback        | `featured_image_feedback`        | JSON — findings report                        |
| SEO Feedback                   | `seo_feedback`                   | JSON — findings report                        |
| Sections and Tags Feedback     | `sections_and_tags_feedback`     | JSON — findings report                        |
| Article Text Feedback          | `article_text_feedback`          | JSON — findings report                        |

Each `*_feedback` field is a `json`-typed field (rendered in the Contentstack entry editor by
its own custom-field extension, which doesn't affect what the Management API returns to this
app) holding a findings report shaped like:

```json
{
  "group": "Headline",
  "findings": [
    {
      "category": "Headline",
      "status": "pass",
      "field": "title",
      "message": "",
      "found": "",
      "fix": "",
      "id": "headline.present",
      "label": "Headline is filled in"
    }
  ]
}
```

`message`/`found`/`fix` are plain text (not HTML or markdown) and are typically only populated
on non-passing findings — `extractFeedbackByField` in
[`src/lib/validationApi.ts`](src/lib/validationApi.ts) treats a field as "has feedback" only
when it parses to this shape with a non-empty `findings` array; anything else (missing, empty,
or malformed) is treated as no feedback yet, per spec.

The legacy `feedback`/`markdown` text fields on this content type (from an earlier version of
this schema) are no longer read by the app — feedback is now sourced entirely from the 7
category-specific fields above.

### A note on refreshing the entry editor

There is no step that reloads/refreshes the entry itself — results are shown directly in this
custom field's own UI once polling succeeds, rather than by writing to another field and
refreshing the editor. `@contentstack/app-sdk@2.4.1` doesn't ship a `reload`/`refresh` method on
`Entry` (only `getData()`, `setData()`, `getDraftData()`, `getField()`, and the `on*` listeners
exist) — if you later want feedback to also land in a separate field visible elsewhere on the
entry, you'd need `entry.setData()` (partial merge, requires host support) or have editors
refresh manually.

## Dependencies

- `@contentstack/app-sdk` — Contentstack App Framework SDK (location, entry, field APIs)
- `react` / `react-dom` — UI
- `lucide-react` — icons (spinner, pass/fail/unknown finding icons, shield icon)
