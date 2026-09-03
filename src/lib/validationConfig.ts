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
  { key: 'featured_image', urlConfigKey: 'featured_image_check', fieldsConfigKey: 'featured_images', feedbackFieldUid: 'featured_image_feedback', label: 'Featured Image' },
  { key: 'seo', urlConfigKey: 'seo_check', fieldsConfigKey: 'seos', feedbackFieldUid: 'seo_feedback', label: 'SEO' },
  { key: 'sections_and_tags', urlConfigKey: 'section_and_tag_check', fieldsConfigKey: 'sections_and_tags', feedbackFieldUid: 'sections_and_tags_feedback', label: 'Sections & Tags' },
  { key: 'article_text', urlConfigKey: 'article_text_check', fieldsConfigKey: 'article_text', feedbackFieldUid: 'article_text_feedback', label: 'Article Text' },
];

export interface ValidationConfig {
  /** "Run everything" endpoint — POSTed to by the manual button. */
  triggerUrl: string;
  statusUrl: string;
  apiKey: string;
  authorization: string;
  /** category key -> that category's own validation endpoint */
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
  /** category key -> its configured field paths, for the "is this category filled out" check */
  categoryFieldPaths: Record<string, string[]>;
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

export function parseValidationConfig(fieldConfig: Record<string, unknown> | undefined): ValidationConfig {
  const cfg = fieldConfig ?? {};
  const validationUrls = (cfg.validation_urls as Record<string, unknown> | undefined) ?? {};
  const validationFields = (cfg.validation_fields as Record<string, unknown> | undefined) ?? {};

  const categoryUrls: Record<string, string> = {};
  const fieldPathToCategory = new Map<string, string>();
  const categoryFieldPaths: Record<string, string[]> = {};

  for (const def of VALIDATION_CATEGORIES) {
    const url = validationUrls[def.urlConfigKey];
    if (typeof url === 'string' && url) {
      categoryUrls[def.key] = url;
    }

    const paths = normalizeFieldPathList(validationFields[def.fieldsConfigKey]);
    categoryFieldPaths[def.key] = paths;
    for (const path of paths) {
      fieldPathToCategory.set(path, def.key);
    }
  }

  return {
    triggerUrl: (cfg.url as string | undefined) ?? '',
    statusUrl: (cfg.statusUrl as string | undefined) ?? '',
    apiKey: (cfg.api_key as string | undefined) ?? '',
    authorization: (cfg.authorization as string | undefined) ?? '',
    categoryUrls,
    fieldPathToCategory,
    categoryFieldPaths,
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
