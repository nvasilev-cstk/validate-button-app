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
  /** entry field uid -> the category it belongs to, for the auto-trigger-on-edit watcher */
  fieldUidToCategory: Map<string, string>;
}

// validation_fields entries are expected as string arrays, e.g.
// `["headline_field_1_uid", "headline_field_2_uid"]`, but tolerate a single
// comma-joined string in one array slot too (e.g. `["a_uid, b_uid"]`) since
// that's an easy mistake to make when hand-editing the config JSON.
function normalizeFieldUidList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((uid) => uid.trim())
    .filter(Boolean);
}

export function parseValidationConfig(fieldConfig: Record<string, unknown> | undefined): ValidationConfig {
  const cfg = fieldConfig ?? {};
  const validationUrls = (cfg.validation_urls as Record<string, unknown> | undefined) ?? {};
  const validationFields = (cfg.validation_fields as Record<string, unknown> | undefined) ?? {};

  const categoryUrls: Record<string, string> = {};
  const fieldUidToCategory = new Map<string, string>();

  for (const def of VALIDATION_CATEGORIES) {
    const url = validationUrls[def.urlConfigKey];
    if (typeof url === 'string' && url) {
      categoryUrls[def.key] = url;
    }

    for (const uid of normalizeFieldUidList(validationFields[def.fieldsConfigKey])) {
      fieldUidToCategory.set(uid, def.key);
    }
  }

  return {
    triggerUrl: (cfg.url as string | undefined) ?? '',
    statusUrl: (cfg.statusUrl as string | undefined) ?? '',
    apiKey: (cfg.api_key as string | undefined) ?? '',
    authorization: (cfg.authorization as string | undefined) ?? '',
    categoryUrls,
    fieldUidToCategory,
  };
}
