# Contract: Home's "Next up"

`GET /v1/next-up` returns what needs the user right now, best first, at most 6, in the GM's voice. The server computes it (`services/api/src/lib/next-up.ts`) from the user's Deals, staged Deals, Asks, Shelf and Circles, so the same list can later drive notifications and the GM's check-ins. Schemas: `packages/shared/src/next-up.ts`.

```json
{
  "items": [
    {
      "id": "deal:<uuid>",
      "kind": "approve_deal",
      "title": "Bob's Galaxy Explorer for your Zelda: Tears of the Kingdom",
      "detail": "Waiting on you. Expires in 20 hours.",
      "cta": "Review",
      "deal_id": "uuid or null",
      "ask_id": "uuid or null",
      "item_id": "uuid or null",
      "angles": [],
      "thumbnail_url": "signed URL or null",
      "expires_at": "ISO date or null"
    }
  ]
}
```

## Kinds, in priority order

| Kind | When | Button goes to |
| --- | --- | --- |
| `answer_counter` | Someone countered a Deal and is waiting on the user's answer ("Maya asked for your Zelda too"), soonest to close first. | The Deal Sheet, which shows the counter |
| `approve_deal` | A Deal Sheet waits on the user's approval, soonest to expire first. Not while a counter on it is open. | The Deal Sheet |
| `showcase_photos` | A staged Deal waits for showcase photos of the user's Item ("Bob wants your LEGO Typewriter"). | The Showcase shoot, with `angles` |
| `answer_inquiry` | The Liaison asks whether an Item close to what the user asked for would work: "Would PlayStation 5 Slim work for your Xbox Series X?" Their GM answers on its own only when their taste facts settle it. | A sheet with the Item and Yes / No (`POST /v1/inquiries/{id}/answer`) |
| `offer_for_ask` | An Ask has a target but nothing offered: the GM can't look yet. | The Ask page |
| `join_circle` | Open Asks but no Circle. | Circles |
| `weak_offer` | The best single Item plus the cash ceiling can't reach the Ask's used price (`offerFit`, the same rules as the Ask page). "A long shot" below 60% of the target, else "a bit short". | The Ask page |
| `in_demand` | People in the user's Circles want something 1 of their Items could fill, and that Item isn't offered for anything yet (`circle_demand`): "Wanted in your Circles: Nintendo Switch game", "2 people are looking, and your Zelda could fill it." Counts only, never who. At most 1. | The GM, with "People in my Circles want something like my Zelda. What could I trade it for?" started |
| `tune_up` | Open Refiner questions on Items that aren't being re-read. | Tune up |
| `item_photos` | The 2 most valuable identified Items, a few photos from ready to show. | The Showcase shoot |
| `add_to_shelf` | An empty Shelf. | Capture |
| `new_ask` | No open Asks. | The GM, for a new Ask |

## Rules
- Only the user's own data and other people's first names appear. Nobody's cash ceiling, limits or Asks ever do.
- `id` is stable across refreshes, so the app animates changes instead of redrawing the list.
- The app refreshes it on Home, after GM turns, after Deals change and when a capture lands. It falls back to a list built on device (Deals waiting on you, open questions) until the server's arrives.
