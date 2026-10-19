// ── FEATURED IMAGE ───────────────────────────────────────────────────
// Code step for the Validate_Featured_Image automation (paste into its
// "JavaScript Code" step; this file is the source of truth).
//
// Inputs:
//   entry          ->  {{1.body}}   (the app POSTs the entry JSON as the body)
//   api_key        ->  stack API key
//   authorization  ->  management token
//   cma_host       ->  optional, e.g. "eu-api.contentstack.com" for an EU
//                      stack; defaults to "api.contentstack.io" (NA)
// Returns: { group, findings: [...] }
//
// The api_key/authorization inputs are used to read the image_credit field's
// regex from the Featured Media global field schema, and to look up the
// image asset when the entry only carries its uid.
//
// Works with both classic CMS Assets (uids "blt…", image assets carry a
// `dimension`) and Assets 2.0 (uids "am…", no `dimension`). The image size
// comes from, in order: the asset's `dimension`, the image file's own header
// (read from the asset `url`), or a /v3/assets lookup for a bare uid — which
// serves both asset types — followed by one of the first two.

const CAT = "Featured Image";
const CMA = "https://" + String(input.cma_host || "api.contentstack.io").replace(/^https?:\/\//, "").replace(/\/+$/, "") + "/v3";

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
  // An empty api_key comes back as a bare 412, which is easy to misread, so
  // name the missing input instead.
  if (!headers.api_key) throw new Error("the api_key input isn't set on the code step");
  if (!headers.authorization) throw new Error("the authorization input isn't set on the code step");
  const res = await fetch(url, { headers: headers });
  if (!res.ok) throw new Error("GET " + url.replace(CMA, "") + " returned " + res.status);
  return res.json();
};

// A file field can arrive as a bare asset uid string, a stub ({ uid }), or a
// full asset object depending on where the payload came from, so normalize
// to { uid, dimension, url }. Asset Management assets (uids starting "am")
// carry a url but no dimension, and aren't served by /v3/assets.
const readImage = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim() ? { uid: raw.trim(), dimension: null, url: "", filename: "" } : null;
  if (typeof raw === "object" && raw.uid) return { uid: raw.uid, dimension: raw.dimension || null, url: raw.url || "", filename: raw.filename || "" };
  return null;
};

// Reads width/height from the start of a JPEG, PNG, GIF or WebP file.
// Returns null if the header isn't in the bytes given.
const sizeFromBytes = (b) => {
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i, n) => String.fromCharCode.apply(null, Array.from(b.subarray(i, i + n)));

  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return { width: u32be(16), height: u32be(20) };
  if (ascii(0, 3) === "GIF") return { width: u16le(6), height: u16le(8) };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === "VP8L") return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments to the first SOFn marker (skipping DHT/JPG/DAC).
    // Camera photos are often stored sideways with an EXIF Orientation tag
    // (5–8 = rotated 90°) that browsers apply when displaying, so swap the
    // stored width/height for those to get the orientation readers see.
    let i = 2;
    let rotated = false;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xe1 && ascii(i + 4, 4) === "Exif") {
        const t = i + 10;                                // TIFF header
        const le = ascii(t, 2) === "II";
        const r16 = (k) => le ? u16le(k) : u16be(k);
        const r32 = (k) => le ? (u16le(k) + (u16le(k + 2) << 16)) >>> 0 : u32be(k);
        const ifd = t + r32(t + 4);
        for (let n = 0, count = r16(ifd); n < count && ifd + 14 + n * 12 <= b.length; n++) {
          const tag = ifd + 2 + n * 12;
          if (r16(tag) === 0x0112) rotated = r16(tag + 8) >= 5 && r16(tag + 8) <= 8;
        }
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const w = u16be(i + 7), h = u16be(i + 5);
        return rotated ? { width: h, height: w } : { width: w, height: h };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
};

// Downloads just the start of the image (enough for the header in almost
// every file), and falls back to the whole file if a large metadata block
// pushes the size header further in.
const sizeFromUrl = async (url) => {
  const read = async (range) => {
    const res = await fetch(url, range ? { headers: { Range: "bytes=0-131071" } } : {});
    if (!res.ok) throw new Error("image download returned " + res.status);
    return new Uint8Array(await res.arrayBuffer());
  };
  return sizeFromBytes(await read(true)) || sizeFromBytes(await read(false));
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
          if (!image.url) {
            const data = await getJson(CMA + "/assets/" + encodeURIComponent(image.uid));
            const asset = (data && data.asset) || {};
            dimension = asset.dimension || null;
            image.url = asset.url || "";
            image.filename = image.filename || asset.filename || "";
          }
          if (!dimension && image.url) dimension = await sizeFromUrl(image.url);
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
