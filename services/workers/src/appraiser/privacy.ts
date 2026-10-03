/**
 * A last line of defense behind the prompts: words that mean a detection or reading is a
 * private or excluded thing (medication, hygiene, documents, fixtures). Matching drops it
 * before identification (saving a call) or before it is saved. Kept narrow on purpose:
 * "card", "case" and "remote" alone are tradeable (trading cards, a game case, an RC car).
 */
const PRIVATE_TERMS = [
  // Not bare "pill": the Beats Pill is a speaker people trade.
  /\bpills\b/,
  /\bpill ?(bottle|box|organi[sz]er|case|container)s?\b/,
  /\bprescription\b/,
  /\bmedications?\b/,
  /\bmedicines?\b/,
  /\bpharmacy\b/,
  // Not bare "supplement": a D&D supplement is a book people trade.
  /\b(dietary|protein|herbal|vitamin|fish oil) supplements?\b/,
  /\bsupplement (bottle|jar|tub|container)s?\b/,
  /\bvitamins?\b/,
  /\bmultivitamins?\b/,
  /\bprobiotics?\b/,
  /\binhalers?\b/,
  /\bsyringes?\b/,
  /\bglucose\b/,
  /\bhearing aids?\b/,
  /\bretainers?\b/,
  /\bmouth ?guards?\b/,
  /\bnight ?guards?\b/,
  /\b(clear|dental|teeth) aligners?\b/,
  /\btooth ?brush(es)?\b/,
  /\bcontact lens(es)? case\b/,
  /\bpassports?\b/,
  /\bdriver'?s licen[cs]e\b/,
  /\b(id|identity|credit|debit|bank|insurance|social security) cards?\b/,
  /\b(air ?conditioner|a\/?c|ac|fan|thermostat|tv|television|light) remotes?\b/,
  /\bremote for (the )?(air ?conditioner|a\/?c|fan|tv|lights?)\b/,
  /\bthermostats?\b/,
  /\blight switch(es)?\b/,
  /\b(power|wall|electrical) outlets?\b/,
  /\bsmoke (detector|alarm)s?\b/,
];

export function looksPrivate(...texts: (string | null | undefined)[]): boolean {
  const text = texts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_/-]+/g, (m) => (m === "/" ? "/" : " "));
  return PRIVATE_TERMS.some((re) => re.test(text));
}
