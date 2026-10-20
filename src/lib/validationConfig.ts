// Validation is split into named categories. Each category is configured
// across three separate naming spaces that don't share exact key names:
//   - fieldConfig.validation_urls   (e.g. "headline_check")
//   - fieldConfig.validation_fields (e.g. "headlines")
//   - the ValidationFeedback content type's own field uids (e.g. "headline_feedback")
// There's no way to derive one from another, so this table is the single
// place that ties all three together. Add a category by adding a row here
// (and matching entries in the field config + content type).
export interface ValidationCategoryDef {
  key: string;
  urlConfigKey: string;
  fieldsConfigKey: string;
  feedbackFieldUid: string;
  label: string;
}

export const VALIDATION_CATEGORIES: ValidationCategoryDef[] = [
  { key: 'headline', urlConfigKey: 'headline_check', fieldsConfigKey: 'headlines', feedbackFieldUid: 'headline_feedback', label: 'Headline' },
  { key: 'url', urlConfigKey: 'url_check', fieldsConfigKey: 'urls', feedbackFieldUid: 'url_feedback', label: 'URL' },
  { key: 'author', urlConfigKey: 'author_check', fieldsConfigKey: 'authors', feedbackFieldUid: 'authors_feedback', label: 'Author' },
  { key: 'featured_image', urlConfigKey: 'featured_image_check', fieldsConfigKey: 'featured_images', feedbackFieldUid: 'featured_image_feedback', label: 'Featured Media' },
  { key: 'seo', urlConfigKey: 'seo_check', fieldsConfigKey: 'seos', feedbackFieldUid: 'seo_feedback', label: 'SEO' },
  { key: 'sections_and_tags', urlConfigKey: 'section_and_tag_check', fieldsConfigKey: 'sections_and_tags', feedbackFieldUid: 'sections_and_tags_feedback', label: 'Sections & Tags' },
  { key: 'article_text', urlConfigKey: 'article_text_check', fieldsConfigKey: 'article_text', feedbackFieldUid: 'article_text_feedback', label: 'Article Text' },
];

export const DEFAULT_REFRESH_RATE_MS = 5_000;
// Floor so a typo like `refresh_rate: 5` (meant as seconds) can't turn the
// result poll into a request flood against the Management API.
const MIN_REFRESH_RATE_MS = 500;
// Floor for the continuous background refresh. Unlike refresh_rate this
// loop runs for as long as the entry is open, and the Management API is
// rate limited (~100 requests per window), so a tiny value is clamped up.
const MIN_REFRESH_POLL_TIME_MS = 2_000;

const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

export interface ValidationConfig {
  statusUrl: string;
  apiKey: string;
  authorization: string;
  /** How often (ms) to poll statusUrl for results while a validation is pending. */
  refreshRateMs: number;
  /**
   * Interval (ms) for continuously re-fetching the validation report in the
   * background, whether or not a validation is pending — from the field
   * config's `refresh-poll-time`, which is written in *seconds*. `null`
   * means the option is off (not set, zero, or invalid).
   */
  refreshPollTimeMs: number | null;
  /** Run a full validation automatically when the app loads (for an already-saved entry). */
  runAtLoad: boolean;
  /**
   * category key -> that category's own validation endpoint. Only
   * well-formed http(s) URLs are kept — a leftover placeholder such as
   * "featured_image_check_url" would otherwise be treated as a configured
   * endpoint and POSTed to as a relative URL on the app's own host.
   */
  categoryUrls: Record<string, string>;
  /**
   * Entry field path -> the category it belongs to, for the
   * auto-trigger-on-edit watcher. entry.onChange is the only signal
   * available for this — entry.getData() was tried as a higher-frequency
   * fallback for `[]`-wildcarded (reference/multi-field-group) paths, but
   * turned out to have the exact same limitation: neither reflects an edit
   * made inside a collapsed Global Field/multi-field group until that
   * group is collapsed again (or the entry is saved). So all paths, plain
   * or wildcarded, rely on this one map.
   */
  fieldPathToCategory: Map<string, string>;
  /**
   * category key -> its required field paths (validation_fields only), for
   * the "is this category filled out" check. Watch-only paths from
   * validation_watch_fields are deliberately left out of this.
   */
  categoryFieldPaths: Record<string, string[]>;
  /**
   * category key -> whether it has any field paths at all (required or
   * watch-only). A category needs this, plus a URL, to count as configured.
   * A category with only watch-only paths is valid: it always runs, which
   * is what you want when the check itself is "these fields must be set".
   */
  categoryHasFields: Record<string, boolean>;
}

// validation_fields entries are field *paths*, not just top-level uids —
// a field nested inside a group isn't a key on the entry object directly,
// so it needs a dot path to reach it, e.g. "featured_media.image". A field
// nested inside a *multi-field group* (an array of group items, like a
// "credits" group containing an "authors" multi-group, each item having its
// own "author" reference) needs a `[]` marker on the array segment to reach
// into every item, e.g. "credits.authors[].author" — this resolves to one
// value per item in the array (see resolvePath below), and a change in any
// of them counts as "this field changed". Without the `[]` marker (e.g. just
// "credits.authors"), the path resolves to the whole array as a single
// value, and only a change to the array itself (not into what's inside it)
// would normally be picked up by identity — resolvePath still uses a deep
// compare either way, so both forms work, but `[]` is the precise one when
// what you actually care about is one specific field inside each item.
// Entries are expected as string arrays, e.g.
// `["headline_field_1_uid", "headline_field_2_uid"]`, but tolerate a single
// comma-joined string in one array slot too (e.g. `["a_uid, b_uid"]`) since
// that's an easy mistake to make when hand-editing the config JSON.
function normalizeFieldPathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((path) => path.trim())
    .filter(Boolean);
}

// `refresh_rate` is in milliseconds. Accepts a number or a numeric string
// (config JSON is hand-edited); anything missing/non-numeric/non-positive
// falls back to the default, and tiny values are clamped to the floor.
function parseRefreshRate(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_REFRESH_RATE_MS;
  return Math.max(value, MIN_REFRESH_RATE_MS);
}

// `refresh-poll-time` is in seconds (unlike `refresh_rate`, which is ms).
// Missing, zero, negative, or non-numeric turns the background refresh off;
// positive values are converted to ms and clamped to a sane floor. The
// underscore spelling is accepted too, since hand-edited JSON configs are
// easy to get the separator wrong on.
function parseRefreshPollTime(cfg: Record<string, unknown>): number | null {
  const raw = cfg['refresh-poll-time'] ?? cfg.refresh_poll_time;
  const seconds = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(seconds * 1000, MIN_REFRESH_POLL_TIME_MS);
}

// `run_at_load` is conventionally written as the string "true" in the field
// config, but a real JSON boolean is accepted too. Anything else — missing,
// "false", "yes", etc. — is off.
function parseBooleanFlag(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

export function parseValidationConfig(fieldConfig: Record<string, unknown> | undefined): ValidationConfig {
  const cfg = fieldConfig ?? {};
  const validationUrls = (cfg.validation_urls as Record<string, unknown> | undefined) ?? {};
  const validationFields = (cfg.validation_fields as Record<string, unknown> | undefined) ?? {};
  // Optional, same keys as validation_fields. These paths re-trigger their
  // category when edited but aren't required to be filled out — e.g. the
  // featured image's credit: an empty credit is exactly what that check
  // should report, so it can't be allowed to hide the category.
  const validationWatchFields = (cfg.validation_watch_fields as Record<string, unknown> | undefined) ?? {};

  const categoryUrls: Record<string, string> = {};
  const fieldPathToCategory = new Map<string, string>();
  const categoryFieldPaths: Record<string, string[]> = {};
  const categoryHasFields: Record<string, boolean> = {};

  for (const def of VALIDATION_CATEGORIES) {
    const url = validationUrls[def.urlConfigKey];
    if (typeof url === 'string' && url.trim()) {
      if (HTTP_URL_PATTERN.test(url.trim())) {
        categoryUrls[def.key] = url.trim();
      } else {
        console.warn(
          `[Validation] Ignoring validation_urls.${def.urlConfigKey}: "${url}" is not an http(s) URL.`
        );
      }
    }

    const paths = normalizeFieldPathList(validationFields[def.fieldsConfigKey]);
    categoryFieldPaths[def.key] = paths;
    for (const path of paths) {
      fieldPathToCategory.set(path, def.key);
    }
    const watchPaths = normalizeFieldPathList(validationWatchFields[def.fieldsConfigKey]);
    for (const path of watchPaths) {
      fieldPathToCategory.set(path, def.key);
    }
    categoryHasFields[def.key] = paths.length > 0 || watchPaths.length > 0;
  }

  return {
    statusUrl: (cfg.statusUrl as string | undefined) ?? '',
    apiKey: (cfg.api_key as string | undefined) ?? '',
    authorization: (cfg.authorization as string | undefined) ?? '',
    refreshRateMs: parseRefreshRate(cfg.refresh_rate),
    refreshPollTimeMs: parseRefreshPollTime(cfg),
    runAtLoad: parseBooleanFlag(cfg.run_at_load),
    categoryUrls,
    fieldPathToCategory,
    categoryFieldPaths,
    categoryHasFields,
  };
}

interface PathSegment {
  key: string;
  /** true when this segment was written as "key[]" — map over the array at this key. */
  isArray: boolean;
}

function parsePath(path: string): PathSegment[] {
  return path.split('.').map((raw) => {
    const isArray = raw.endsWith('[]');
    return { key: isArray ? raw.slice(0, -2) : raw, isArray };
  });
}

function resolveSegments(obj: unknown, segments: PathSegment[]): unknown[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (segments.length === 0) return [obj];

  const [{ key, isArray }, ...rest] = segments;
  const value = (obj as Record<string, unknown>)[key];

  if (isArray) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => resolveSegments(item, rest));
  }

  return rest.length === 0 ? [value] : resolveSegments(value, rest);
}

// Resolves a dot-path against an entry snapshot, e.g. "featured_media.image"
// or, with a `[]` marker to map over a multi-field group's array,
// "credits.authors[].author". Always returns an array of matched values —
// one value for a plain path, one per array item for a `[]` path, and an
// empty array if any segment along the way is missing.
export function resolvePath(obj: unknown, path: string): unknown[] {
  return resolveSegments(obj, parsePath(path));
}

// Decides whether a resolved field value counts as "filled out". Field
// values come in a few different shapes depending on field type, so this
// isn't a single generic rule:
//   - string: empty if blank after trimming.
//   - number/boolean: never empty — 0 and false are real, set values.
//   - array: empty if there are no items, or every item is itself empty
//     (handles both a plain array field and a resolvePath `[]` result).
//   - object shaped like a reference/embedded-item stub ({ uid, ... }, no
//     `children`/`type`): empty iff its uid is blank — the uid *is* the
//     meaningful value there, unlike in a JSON RTE node (see below).
//   - object with a `children` or `text` key (a JSON RTE — Advanced — node):
//     its real content lives there, not in the structural `type`/`uid`/
//     `attrs`/`_version` wrapper keys, so recurse into `children`/`text`
//     specifically rather than treating the wrapper's own non-empty keys as
//     "content" (an empty RTE doc, e.g. one empty paragraph, still has a
//     `type`/`uid` set, but no real text).
//   - any other plain object (a group): empty iff every one of its own
//     values is empty.
function isFieldValueEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (typeof value === 'number' || typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.length === 0 || value.every(isFieldValueEmpty);

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('children' in obj) return isFieldValueEmpty(obj.children);
    if ('text' in obj) return isFieldValueEmpty(obj.text);
    if (typeof obj.uid === 'string' && !('type' in obj)) return isFieldValueEmpty(obj.uid);

    const values = Object.values(obj);
    return values.length === 0 || values.every(isFieldValueEmpty);
  }

  return true;
}

// A category is "filled out" when every one of its configured field paths
// resolves to at least one non-empty value. A category with no configured
// paths is treated as always filled out — there's nothing to check, so it
// shouldn't be blocked from running.
export function isCategoryFilledOut(entryData: unknown, paths: string[]): boolean {
  if (paths.length === 0) return true;
  return paths.every((path) => resolvePath(entryData, path).some((value) => !isFieldValueEmpty(value)));
}

// Reference equality isn't reliable for nested/array values — they may come
// back as newly-built objects on every change regardless of whether their
// own content actually changed, and could equally be reused unchanged
// depending on the host's implementation. A JSON-based deep compare is
// correct either way, at the cost of some (negligible, for field-sized
// data) stringify overhead.
export function valuesDiffer(a: unknown, b: unknown): boolean {
  if (a === b) return false;
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true;
  }
}
