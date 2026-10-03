# Throw-In design foundation

Throw-In sits between Meta's Muse (playful, colorful, alive) and iPhone (calm, precise, expensive). The rule that reconciles them: **the chrome is quiet and the moments are loud.** Navigation, lists and forms are clean paper and glass. Color and motion are spent on the 5 moments that matter: meeting your GM, the GM thinking, an item being appraised, a Deal arriving, and a Deal closing.

## Principles

| Principle | What it means in practice |
| --- | --- |
| Show the decision, hide the machinery | Users see "Checking 46 Shelves in 2 Circles", never a spinner without words, and never model names, tokens or confidence scores. Confidence becomes "Pretty sure" or "Need 1 more photo". |
| Ranges, not prices | Every value renders as a range bar, never a single number. |
| Give is warm, get is cool | Anything leaving your Shelf is tinted Tangerine. Anything coming to you is tinted Pool. A Deal Sheet reads left to right as warm to cool. |
| Glass for chrome, paper for content | Liquid Glass (iOS 26) is used only on floating controls: the tab bar, the composer, the capture shutter and sheet handles. Cards and items sit on opaque paper so photos stay true. |
| Every touch answers | Each tap has a spring and a haptic. Nothing changes state without motion that explains where it went. |

## Color

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `canvas` | #F6F4EF | #0B0B0E | App background (warm paper, not white) |
| `surface` | #FFFFFF | #16161B | Cards |
| `ink` | #121216 | #F4F2EE | Primary text |
| `inkSecondary` | ink at 58% | ink at 60% | Secondary text |
| `hairline` | ink at 8% | ink at 10% | Dividers, card strokes |
| `tangerine` | #FF7A2F | #FF8A45 | Give side, primary accent |
| `bubblegum` | #FF4F9A | #FF6AAB | GM energy, celebratory moments |
| `iris` | #7A5CFF | #8F76FF | GM identity, links |
| `pool` | #2FC4FF | #4FD0FF | Get side |
| `mint` | #22C997 | #3EDDAA | Fair, done, confirmed |
| `gold` | #FFB020 | #FFC24D | Cash Throw-Ins |

The **Loop gradient** (tangerine → bubblegum → iris → pool) is the brand. It appears only on the GM orb, streaming text glow, the appraisal scan and the Deal-closed celebration.

## Type

| Style | Font | Size / weight | Use |
| --- | --- | --- | --- |
| `display` | SF Pro Rounded | 40 / heavy, tracking -0.8 | Onboarding heroes, Deal closed |
| `title` | SF Pro Rounded | 28 / bold, tracking -0.4 | Screen titles |
| `headline` | SF Pro Rounded | 19 / semibold | Card titles |
| `body` | SF Pro | 17 / regular | GM chat, descriptions |
| `callout` | SF Pro | 15 / medium | Secondary lines |
| `caption` | SF Pro | 12 / semibold, uppercase, tracking 0.6 | Labels, chips |
| `value` | SF Pro Rounded | monospaced digits | Every dollar amount |

## Shape and depth

- Cards: continuous corner radius 28, 1pt hairline stroke, 2-layer soft shadow (8% at y 8 blur 24, 4% at y 1 blur 2).
- Item thumbnails: radius 20. Chips and buttons: capsules.
- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 48. Screen gutter 20.

## Motion

| Spring | Response / damping | Use |
| --- | --- | --- |
| `snappy` | 0.30 / 0.80 | Taps, toggles, chips |
| `bouncy` | 0.45 / 0.62 | Cards arriving, tab changes, orb reactions |
| `soft` | 0.60 / 0.90 | Sheets, large layout changes |

Haptics: `.selection` on toggles, `.impact(.soft)` on card pickup, `.success` on approve and handoff confirmed, `.increase` ticks while hold-to-approve fills.

## Shaders (Metal, `apps/ios/ThrowIn/Core/Design/Shaders/`)

| Shader | Kind | Moment |
| --- | --- | --- |
| `gmOrb` | colorEffect | The GM's face: domain-warped Loop gradient inside a sphere with a glass rim. Idle breathes, thinking swirls faster, speaking pulses with token rate. |
| `tokenBloom` | TextRenderer (Swift) | Streaming chat: each glyph rises, un-blurs and fades in with a staggered iridescent glow that cools to ink. |
| `appraiseScan` | layerEffect | Item appraisal: a holographic scan band with chromatic split and a dot-grid "digitize" pass sweeps the photo, then resolves clean. |
| `liquidRipple` | layerEffect | Approve, Deal arrival, tab GM tap: a damped radial ripple from the touch point. |
| `paperGrain` | colorEffect | A 2% animated grain on hero backgrounds so flat color feels printed, not rendered. |
| Mesh backdrop | `MeshGradient` | Slow-drifting Loop-tinted mesh behind onboarding and the GM's first hello. |

## Signature interactions

- **Hold to approve:** Approving a Deal is a press-and-hold on a glass capsule that fills with the Loop gradient over 0.9 seconds, ticking haptics as it fills, then asks for Face ID. Releasing early drains it with a spring. This is the "fresh device-bound confirmation" the PRD requires, made physical.
- **Pick up an item:** Long-press a Shelf card and it lifts, scales to 1.04 and tilts toward your finger with a specular highlight.
- **The GM is always 1 tap away:** The center of the tab bar is the orb. Tapping it ripples and the chat rises as a sheet, so the GM feels present, not like a separate app.
- **Loop indicator:** Prospecting shows 2 to 4 dots orbiting a ring (the number of people in the candidate Loop), instead of a spinner.

## Voice

The GM talks like a sharp, warm front-office friend. Short sentences, no exclamation-mark stacking, no jargon. "Found 1. Maya would swap her Batmobile for your Zelda plus $15." UI copy follows the same rules as specs: no em dashes, numerals for counts.
