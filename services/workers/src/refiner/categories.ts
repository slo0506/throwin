import type { Identification } from "../appraiser/schemas.js";

/**
 * The PRD's value-driver table ("Refinement"): what moves an Item's value in each
 * category, and which angles a showcase photo set needs. The Refiner asks only about
 * drivers still unknown, and photo scoring checks the angles.
 */
export type CategoryId =
  | "sneakers"
  | "electronics"
  | "lego"
  | "trading_cards"
  | "books_media"
  | "bags_apparel"
  | "other";

export interface Driver {
  /** Stable key, stored as item_questions.driver and as the attribute name for answers. */
  key: string;
  /** How the question writer sees it. */
  label: string;
  /** Pins which product it is (brand, model, set number), not just its state. */
  identity: boolean;
  /** Read off the condition grade when the photos show it well enough. */
  wear?: boolean;
  /** Attribute names from identification that already answer it. */
  attributes: string[];
  /** Answered by these identification fields when they are set. */
  fields?: ("brand" | "model" | "variant")[];
}

export interface CategorySpec {
  id: CategoryId;
  label: string;
  drivers: Driver[];
  /** Short human labels, e.g. "Both soles". Returned as missing_angles. */
  angles: string[];
}

const d = (
  key: string,
  label: string,
  opts: Partial<Omit<Driver, "key" | "label">> = {},
): Driver => ({
  key,
  label,
  identity: opts.identity ?? false,
  attributes: opts.attributes ?? [key],
  ...(opts.wear !== undefined && { wear: opts.wear }),
  ...(opts.fields && { fields: opts.fields }),
});

export const CATEGORIES: Record<CategoryId, CategorySpec> = {
  sneakers: {
    id: "sneakers",
    label: "Sneakers",
    drivers: [
      d("brand", "Brand", { identity: true, fields: ["brand"] }),
      d("model", "Model", {
        identity: true,
        fields: ["model"],
        attributes: ["model", "style_code"],
      }),
      d("colorway", "Colorway", {
        identity: true,
        fields: ["variant"],
        attributes: ["colorway", "color", "colour"],
      }),
      d("size", "Size", { attributes: ["size", "us_size", "shoe_size"] }),
      d("sole_wear", "Sole wear", { wear: true, attributes: ["sole_wear", "soles"] }),
      d("box", "Original box", { attributes: ["box", "original_box"] }),
    ],
    angles: ["Side profile", "Both soles", "Size tag", "Toe box"],
  },
  electronics: {
    id: "electronics",
    label: "Consoles and electronics",
    drivers: [
      d("model", "Model and revision", {
        identity: true,
        fields: ["model"],
        attributes: ["model", "revision", "edition"],
      }),
      d("storage", "Storage", { attributes: ["storage", "capacity"] }),
      d("accessories", "Included accessories", {
        attributes: ["accessories", "included", "controllers", "cables"],
      }),
      d("cosmetic_wear", "Cosmetic wear", { wear: true, attributes: ["cosmetic_wear"] }),
      d("battery_health", "Battery health", { attributes: ["battery_health", "battery"] }),
    ],
    angles: ["Front", "Back with label", "Ports", "Accessories laid out"],
  },
  lego: {
    id: "lego",
    label: "LEGO",
    drivers: [
      d("set_number", "Set number", {
        identity: true,
        fields: ["model"],
        attributes: ["set_number", "set"],
      }),
      d("completeness", "Completeness", { attributes: ["completeness", "complete"] }),
      d("minifigures", "Minifigures", { attributes: ["minifigures", "minifigs"] }),
      d("box_and_manual", "Box and manual", { attributes: ["box_and_manual", "box", "manual"] }),
      d("built_or_sealed", "Built or sealed", {
        attributes: ["built_or_sealed", "sealed", "built"],
      }),
    ],
    angles: ["Box front or built set", "Minifigures", "Contents"],
  },
  trading_cards: {
    id: "trading_cards",
    label: "Trading cards",
    drivers: [
      d("set", "Set", { identity: true, attributes: ["set", "series"] }),
      d("card_number", "Card number", {
        identity: true,
        fields: ["model"],
        attributes: ["card_number", "number"],
      }),
      d("edition", "Edition", {
        identity: true,
        fields: ["variant"],
        attributes: ["edition", "printing"],
      }),
      d("surface_and_corners", "Surface and corners", {
        wear: true,
        attributes: ["surface_and_corners", "corners"],
      }),
      d("grading", "Grading", { attributes: ["grading", "graded", "grade"] }),
    ],
    angles: ["Front", "Back", "Corner close-ups"],
  },
  books_media: {
    id: "books_media",
    label: "Books and media",
    drivers: [
      d("edition", "Edition", { identity: true, fields: ["variant"], attributes: ["edition"] }),
      d("printing", "Printing", { attributes: ["printing"] }),
      d("dust_jacket", "Dust jacket", { attributes: ["dust_jacket"] }),
      d("signatures", "Signatures", { attributes: ["signatures", "signed"] }),
    ],
    angles: ["Cover", "Spine", "Copyright page"],
  },
  bags_apparel: {
    id: "bags_apparel",
    label: "Bags and apparel",
    drivers: [
      d("brand", "Brand", { identity: true, fields: ["brand"] }),
      d("model", "Model", { identity: true, fields: ["model"] }),
      d("size", "Size", { attributes: ["size"] }),
      d("material", "Material", { attributes: ["material", "fabric"] }),
      d("hardware_wear", "Hardware wear", { wear: true, attributes: ["hardware_wear"] }),
    ],
    angles: ["Front", "Back", "Label", "Hardware"],
  },
  other: {
    id: "other",
    label: "Everything else",
    drivers: [
      d("brand", "Brand", { identity: true, fields: ["brand"] }),
      d("model", "Model", { identity: true, fields: ["model"] }),
      d("completeness", "Completeness", { attributes: ["completeness", "complete"] }),
      d("wear", "Wear", { wear: true, attributes: ["wear"] }),
    ],
    angles: ["Front", "Back", "Any label"],
  },
};

const has = (text: string, ...words: string[]) => words.some((w) => text.includes(w));

/** Maps the Appraiser's free-form category (and title) onto the PRD table. */
export function categoryOf(id: Pick<Identification, "category" | "title">): CategorySpec {
  const c = `${id.category} ${id.title}`.toLowerCase().replace(/[_/-]+/g, " ");
  if (has(c, "lego")) return CATEGORIES.lego;
  if (has(c, "sneaker", "shoe", "footwear", "trainer", "boot", "clog", "sandal")) {
    return CATEGORIES.sneakers;
  }
  if (has(c, "trading card", "pokemon card", "sports card", "card game", "tcg", "cards")) {
    return CATEGORIES.trading_cards;
  }
  if (
    has(
      c,
      "console",
      "electronic",
      "headphone",
      "earbud",
      "speaker",
      "camera",
      "tablet",
      "phone",
      "laptop",
      "controller",
      "e reader",
      "keyboard",
      "monitor",
      "playstation",
      "xbox",
      "nintendo switch",
    )
  ) {
    return CATEGORIES.electronics;
  }
  if (has(c, "book", "media", "vinyl", "record", "dvd", "blu ray", "video game", "comic")) {
    return CATEGORIES.books_media;
  }
  if (has(c, "bag", "apparel", "clothing", "jacket", "hoodie", "shirt", "hat", "backpack")) {
    return CATEGORIES.bags_apparel;
  }
  return CATEGORIES.other;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
const UNKNOWN = new Set(["", "unknown", "not sure", "unsure", "n/a", "na", "?"]);
const isKnownValue = (v: unknown) =>
  typeof v === "string" ? !UNKNOWN.has(v.trim().toLowerCase()) : v !== null && v !== undefined;

/** Whether the Item's identification already answers a driver. */
export function isKnown(driver: Driver, id: Identification) {
  if (driver.fields?.some((f) => isKnownValue(id[f]))) return true;
  if (driver.wear && id.condition_confidence >= 0.7) return true;
  const attrs = new Map(Object.entries(id.attributes).map(([k, v]) => [norm(k), v]));
  return driver.attributes.some((a) => isKnownValue(attrs.get(norm(a))));
}

/** Drivers the identification leaves open, identity drivers first. */
export function unknownDrivers(spec: CategorySpec, id: Identification) {
  const open = spec.drivers.filter((dr) => !isKnown(dr, id));
  return [...open.filter((dr) => dr.identity), ...open.filter((dr) => !dr.identity)];
}
