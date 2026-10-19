// ── FEATURED IMAGE ───────────────────────────────────────────────────
// Code step for the Validate_Featured_Image automation (paste into its
// "JavaScript Code" step; this file is the source of truth).
//
// Inputs:
//   entry          ->  {{1.body}}   (the app POSTs the entry JSON as the body)
//   api_key        ->  stack API key
//   authorization  ->  management token
// Returns: { group, findings: [...] }
//
// The api_key/authorization inputs are used to look up the image asset's
// dimensions (the entry payload may only carry the asset uid) and the
// image_credit field's regex from the Featured Media global field schema.

const CAT = "Featured Image";
const CMA = "https://api.contentstack.io/v3";

// Map to your real field UIDs.
const F = {
  group: "featured_media",              // global field uid on the article
  globalFieldUid: "featured_media",     // global field's own uid (for its schema)
  image: "image",
  orientation: "media_orientation",
  credit: "image_credit"
};
const path = (uid) => F.group + "." + uid;

// Fallback for TIME's credit format, used only when the image_credit field
// has no regex ("format") set in the global field schema. null = skip the
// format check entirely.
const CREDIT_PATTERN = null;

const parse = (v, d) => {
  try { return typeof v === "string" ? JSON.parse(v) : (v == null ? d : v); }
  catch (e) { return d; }
};

const findings = [];
const add = (f) => findings.push(Object.assign(
  { category: CAT, status: "pass", field: "", message: "", found: "", fix: "" }, f
));

const headers = {
  api_key: input.api_key || "",
  authorization: input.authorization || "",
  "Content-Type": "application/json"
};

const getJson = async (url) => {
  const res = await fetch(url, { headers: headers });
  if (!res.ok) throw new Error("GET " + url.replace(CMA, "") + " returned " + res.status);
  return res.json();
};

// A file field can arrive as a bare asset uid string, a stub ({ uid }), or a
// full asset object (with dimension) depending on where the payload came
// from, so normalize to { uid, dimension }.
const readImage = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim() ? { uid: raw.trim(), dimension: null } : null;
  if (typeof raw === "object" && raw.uid) return { uid: raw.uid, dimension: raw.dimension || null, filename: raw.filename || "" };
  return null;
};

const orientationOf = (d) => {
  if (!d || !d.width || !d.height) return null;
  if (d.width > d.height) return "horizontal";
  if (d.height > d.width) return "vertical";
  return "square";
};

try {
  const entry = parse(input.entry, {});
  let media = entry[F.group];
  if (Array.isArray(media)) media = media[0];
  media = media || {};

  // ── 1. Orientation matches media_orientation ──
  const image = readImage(media[F.image]);
  const wanted = String(media[F.orientation] == null ? "" : media[F.orientation]).trim().toLowerCase();

  add({
    id: "featured_image.present",
    label: "Featured image is set",
    field: path(F.image),
    status: image ? "pass" : "fail",
    message: image ? "" : "No featured image is selected.",
    fix: image ? "" : "Choose a featured image."
  });

  if (image) {
    if (!wanted) {
      add({
        id: "featured_image.orientation_set",
        label: "Media orientation is chosen",
        field: path(F.orientation),
        status: "fail",
        message: "Media Orientation is not set, so the image can't be checked against it.",
        fix: "Set Media Orientation to Horizontal or Vertical."
      });
    } else {
      let dimension = image.dimension;
      if (!dimension) {
        // Kept in its own try so a failed asset lookup doesn't skip the
        // credit checks below.
        try {
          const data = await getJson(CMA + "/assets/" + encodeURIComponent(image.uid));
          dimension = data && data.asset ? data.asset.dimension : null;
          image.filename = image.filename || (data && data.asset ? data.asset.filename : "");
        } catch (e) {
          image.filename = image.filename || e.message;
        }
      }
      const actual = orientationOf(dimension);

      if (!actual) {
        add({
          id: "featured_image.orientation_match",
          label: "Image orientation matches Media Orientation",
          field: path(F.image),
          status: "warn",
          message: "Couldn't read the image's dimensions" + (image.filename ? " (" + image.filename + ")" : "") + ".",
          fix: "Make sure the featured image is an image file."
        });
      } else {
        const ok = actual === wanted;
        add({
          id: "featured_image.orientation_match",
          label: "Image orientation matches Media Orientation",
          field: path(F.image),
          status: ok ? "pass" : "fail",
          found: ok ? "" : actual + " image (" + dimension.width + "×" + dimension.height + "), Media Orientation is " + wanted,
          message: ok ? "" : "The image is " + actual + " but Media Orientation is set to " + wanted + ".",
          fix: ok ? "" : "Choose a " + wanted + " image, or change Media Orientation to match."
        });
      }
    }
  }

  // ── 2. image_credit is filled in ──
  const credit = String(media[F.credit] == null ? "" : media[F.credit]).trim();

  add({
    id: "featured_image.credit_present",
    label: "Image credit is filled in",
    field: path(F.credit),
    status: credit ? "pass" : "fail",
    message: credit ? "" : "The image credit is empty.",
    fix: credit ? "" : "Add the photographer/agency credit for the featured image."
  });

  // ── 3. image_credit follows TIME's format ──
  // The regex comes from the image_credit field's own validation settings
  // in the global field schema, so it's maintained in one place.
  if (credit) {
    let pattern = CREDIT_PATTERN;
    let formatMessage = "";
    try {
      const gf = await getJson(CMA + "/global_fields/" + encodeURIComponent(F.globalFieldUid));
      const schema = (gf && gf.global_field && gf.global_field.schema) || [];
      const field = schema.find((s) => s.uid === F.credit) || {};
      if (field.format) pattern = field.format;
      formatMessage = (field.error_messages && field.error_messages.format) || "";
    } catch (e) {
      // Fall back to CREDIT_PATTERN if the schema can't be read.
    }

    if (pattern) {
      const ok = new RegExp(pattern).test(credit);
      add({
        id: "featured_image.credit_format",
        label: "Image credit follows TIME's format",
        field: path(F.credit),
        status: ok ? "pass" : "fail",
        found: ok ? "" : credit,
        message: ok ? "" : (formatMessage || "The image credit doesn't match TIME's credit format."),
        fix: ok ? "" : "Rewrite the credit to match TIME's format."
      });
    }
  }
} catch (e) {
  add({
    id: "featured_image.group_error",
    label: "Featured image checks",
    status: "warn",
    message: "This group of checks could not run: " + e.message,
    fix: "Re-run the review. If it keeps happening, flag it to an admin."
  });
}

return { group: CAT, findings: findings };
