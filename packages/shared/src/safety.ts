import { z } from "zod";

/**
 * What Throw-In can't trade (PRD "Trust and safety controls" and the published prohibited
 * list), as stable codes the Appraiser, the GM's resolver and the server share. The models
 * judge; these codes are how their judgment reaches code that enforces it.
 */
export const ProhibitedReason = z.enum([
  "person",
  "live_animal",
  "weapon",
  "drugs",
  "alcohol",
  "tobacco",
  "adult",
  "hazardous",
  "counterfeit",
  "recalled",
  "personal_data",
]);
export type ProhibitedReason = z.infer<typeof ProhibitedReason>;

/** How each reason reads in a sentence: "Throw-In can't trade live animals." */
export const PROHIBITED_WORDS: Record<ProhibitedReason, string> = {
  person: "people",
  live_animal: "live animals",
  weapon: "weapons or ammunition",
  drugs: "drugs or medicine",
  alcohol: "alcohol",
  tobacco: "tobacco or vapes",
  adult: "adult content",
  hazardous: "hazardous materials",
  counterfeit: "counterfeits",
  recalled: "recalled products",
  personal_data: "anything with someone's personal information",
};

/**
 * A last line of defense behind the prompts: model-written labels and titles that can only
 * mean a prohibited thing. Kept to unambiguous words on purpose, since a false match costs
 * someone a real Item: toys and props ("Nerf blaster", "water pistol", "toy rifle"), empty
 * collectibles ("cigar box"), games ("Gin Rummy") and brands ("Rifle Paper Co.") stay
 * tradeable. People and live animals are left to the models: "dog" alone is as likely a
 * figurine as a pet.
 */
const BACKSTOP: [ProhibitedReason, RegExp][] = [
  [
    "weapon",
    /\b(firearms?|handguns?|revolvers?|shotguns?|ammunition|ammo|gun (magazines?|parts?)|silencers?|suppressors?|stun guns?|tasers?|brass knuckles?|switchblades?)\b/,
  ],
  [
    "weapon",
    /(?<!\b(water|nerf|toy|cap|squirt|airsoft|bb) )\b(pistols?|rifles?)\b(?! (paper|scope covers?))/,
  ],
  [
    "tobacco",
    /\b(vapes?|vape pens?|vaporizers?|e-?cig(arette)?s?|cigarettes?|nicotine|juul|chewing tobacco)\b|\bcigars?\b(?! (box|boxes|humidors?))/,
  ],
  [
    "drugs",
    /\b(cannabis|marijuana|thc|psilocybin|magic mushrooms|cocaine|opioids?|weed (edibles?|pens?|cartridges?))\b/,
  ],
  [
    "alcohol",
    /\b(bottles? of|sealed|unopened|full) (wine|whiske?y|vodka|tequila|bourbon|rum|gin|scotch|sake|champagne|liquor|beer)\b|\b(wine|whiske?y|vodka|tequila|bourbon|scotch|liquor) bottles?\b(?! (openers?|stoppers?|racks?|holders?|lamps?|lights?))/,
  ],
];

/** The prohibited reason these words can only mean, or null. */
export function prohibitedByWords(
  ...texts: (string | null | undefined)[]
): ProhibitedReason | null {
  const text = texts.filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ");
  for (const [reason, re] of BACKSTOP) {
    if (re.test(text)) return reason;
  }
  return null;
}

/** "Throw-In can't trade live animals." */
export const cantTrade = (reason: ProhibitedReason) =>
  `Throw-In can't trade ${PROHIBITED_WORDS[reason]}.`;
