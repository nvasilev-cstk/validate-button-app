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
  /** entry field path -> the category it belongs to, for the auto-trigger-on-edit watcher */
  fieldPathToCategory: Map<string, string>;
}

// validation_fields entries are field *paths*, not just top-level uids —
// a field nested inside a group (or a multi-field group, i.e. an array of
// group items, like a "credits" group containing an "authors" multi-group)
// isn't a key on the entry object directly, so it needs a dot path to reach
// it, e.g. "credits.authors". For a multi-field group, point at the group
// itself (its whole array), not into a specific item — items can be
// added/removed/reordered, so there's no stable index to path into; any
// change anywhere in the array is treated as "this field changed".
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

  for (const def of VALIDATION_CATEGORIES) {
    const url = validationUrls[def.urlConfigKey];
    if (typeof url === 'string' && url) {
      categoryUrls[def.key] = url;
    }

    for (const path of normalizeFieldPathList(validationFields[def.fieldsConfigKey])) {
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
  };
}

// Resolves a dot-path (e.g. "credits.authors") against an entry snapshot.
// Only walks plain object properties — a path segment is never treated as
// an array index, since a multi-field group's path should point at the
// group's whole array (see normalizeFieldPathList above), not into one of
// its items.
export function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// Reference equality isn't reliable for nested values — a group/array field
// may come back as a newly-built object on every change regardless of
// whether its own content actually changed, and could equally be reused
// unchanged depending on the host's implementation. A JSON-based deep
// compare is correct either way at the cost of some (negligible, for
// field-sized data) stringify overhead.
export function valuesDiffer(a: unknown, b: unknown): boolean {
  if (a === b) return false;
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true;
  }
}
