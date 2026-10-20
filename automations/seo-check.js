// ── SEO ──────────────────────────────────────────────────────────────
// Code step for the Validate_SEO automation (paste into its "JavaScript
// Code" step; this file is the source of truth).
//
// Inputs:
//   entry  ->  {{1.body}}   (the app POSTs the entry JSON as the body)
// Returns: { group, version, findings: [...] }
//
// Rules: SEO title, SEO description, social title and social description
// must each be filled in and stay within a maximum length.

const CAT = "SEO";
// Written into every report, so the stored feedback shows which version of
// this code Automate actually ran. Bump it whenever the code changes.
const CODE_VERSION = "2026-10-20.1";

// Map to your real field UIDs.
const F = {
  group: "seo"                          // global field uid on the article
};

// Maximum lengths, in characters. TIME hasn't finalized these yet ("TK"):
// the numbers below are placeholders taken from the field descriptions in
// the SEO global field. Set one to null to skip that length check.
const FIELDS = [
  { uid: "meta_title",       name: "SEO title",          max: 60,   fix: "Add the title search engines should show for this article." },
  { uid: "meta_description", name: "SEO description",    max: 140,  fix: "Add a short summary for search engine results." },
  { uid: "og_title",         name: "social title",       max: 95,   fix: "Add the title to show on social media cards." },
  { uid: "og_description",   name: "social description", max: null, fix: "Add the summary to show on social media cards." }
];

const parse = (v, d) => {
  try { return typeof v === "string" ? JSON.parse(v) : (v == null ? d : v); }
  catch (e) { return d; }
};

const findings = [];
const add = (f) => findings.push(Object.assign(
  { category: CAT, status: "pass", field: "", message: "", found: "", fix: "" }, f
));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Counts characters the way an editor would (an emoji is one character).
const length = (s) => Array.from(s).length;

try {
  const entry = parse(input.entry, {});
  let seo = entry[F.group];
  if (Array.isArray(seo)) seo = seo[0];
  seo = seo || {};

  for (const def of FIELDS) {
    const value = String(seo[def.uid] == null ? "" : seo[def.uid]).trim();
    const key = def.uid;
    const field = F.group + "." + def.uid;

    add({
      id: "seo." + key + ".present",
      label: cap(def.name) + " is filled in",
      field: field,
      status: value ? "pass" : "fail",
      message: value ? "" : "The " + def.name + " is empty.",
      fix: value ? "" : def.fix
    });

    if (value && def.max != null) {
      const n = length(value);
      const ok = n <= def.max;
      add({
        id: "seo." + key + ".length",
        label: cap(def.name) + " is " + def.max + " characters or fewer",
        field: field,
        status: ok ? "pass" : "fail",
        message: ok ? "" : "The " + def.name + " is " + n + " characters, over the " + def.max + "-character limit.",
        found: ok ? "" : value,
        fix: ok ? "" : "Shorten it by " + (n - def.max) + " character" + (n - def.max === 1 ? "" : "s") + "."
      });
    }
  }
} catch (e) {
  add({
    id: "seo.group_error",
    label: "SEO checks",
    status: "warn",
    message: "This group of checks could not run: " + e.message,
    fix: "Re-run the review. If it keeps happening, flag it to an admin."
  });
}

return { group: CAT, version: CODE_VERSION, findings: findings };
