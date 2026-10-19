// ── SECTIONS & TAGS ──────────────────────────────────────────────────
// Code step for the Validate_Sections_And_Tags automation (paste into its
// "JavaScript Code" step; this file is the source of truth).
//
// Inputs:
//   entry  ->  {{1.body}}   (the app POSTs the entry JSON as the body)
// Returns: { group, version, findings: [...] }
//
// TIME's taxonomy is a global field of plain reference fields (not
// Contentstack taxonomies). Rule: Primary Section and Primary Tag must be set.

const CAT = "Sections & Tags";
// Written into every report, so the stored feedback shows which version of
// this code Automate actually ran. Bump it whenever the code changes.
const CODE_VERSION = "2026-10-19.1";

// Map to your real field UIDs.
const F = {
  group: "taxonomy",                    // global field uid on the article
  primarySection: "primary_section",
  primaryTag: "primary_topic"
};
const path = (uid) => F.group + "." + uid;

const parse = (v, d) => {
  try { return typeof v === "string" ? JSON.parse(v) : (v == null ? d : v); }
  catch (e) { return d; }
};

const findings = [];
const add = (f) => findings.push(Object.assign(
  { category: CAT, status: "pass", field: "", message: "", found: "", fix: "" }, f
));

// A single reference field still arrives as an array ([] when unset,
// [{ uid, _content_type_uid }] when set), but tolerate a bare object or
// uid string too.
const isReferenceSet = (v) => {
  if (Array.isArray(v)) return v.some(isReferenceSet);
  if (v && typeof v === "object") return Boolean(String(v.uid || "").trim());
  return typeof v === "string" && v.trim().length > 0;
};

try {
  const entry = parse(input.entry, {});
  let taxonomy = entry[F.group];
  if (Array.isArray(taxonomy)) taxonomy = taxonomy[0];
  taxonomy = taxonomy || {};

  const hasSection = isReferenceSet(taxonomy[F.primarySection]);
  add({
    id: "sections_and_tags.primary_section",
    label: "Primary Section is set",
    field: path(F.primarySection),
    status: hasSection ? "pass" : "fail",
    message: hasSection ? "" : "No Primary Section is selected.",
    fix: hasSection ? "" : "Choose the section this article mainly belongs to."
  });

  const hasTag = isReferenceSet(taxonomy[F.primaryTag]);
  add({
    id: "sections_and_tags.primary_tag",
    label: "Primary Tag is set",
    field: path(F.primaryTag),
    status: hasTag ? "pass" : "fail",
    message: hasTag ? "" : "No Primary Tag is selected.",
    fix: hasTag ? "" : "Choose the tag that best describes the article's core topic."
  });
} catch (e) {
  add({
    id: "sections_and_tags.group_error",
    label: "Sections & tags checks",
    status: "warn",
    message: "This group of checks could not run: " + e.message,
    fix: "Re-run the review. If it keeps happening, flag it to an admin."
  });
}

return { group: CAT, version: CODE_VERSION, findings: findings };
