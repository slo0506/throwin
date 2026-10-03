# Milestone 3 contract: Circles and invites

The shapes the API and the iOS app share for Circles. Product intent lives in `docs/prd.md` ("Wedge and growth", "First-time experience" step 1, the `circles`, `circle_members` and `invites` tables). If code and this file disagree, fix the code or change this file in the same PR.

All JSON is snake_case. Every POST accepts `Idempotency-Key`. Someone else's Circle is always a 404, never a 403, so IDs can't be probed.

## Circle

```json
{
  "id": "uuid",
  "name": "Thursday Lego",
  "category_focus": ["toys/lego"],
  "role": "owner | member",
  "member_count": 12,
  "created_at": "..."
}
```

`role` is the caller's. A Circle detail adds the roster, with first name and photo only:

```json
{ "...Circle", "members": [{ "user_id": "uuid", "first_name": "Maya", "photo_url": null, "role": "member", "joined_at": "..." }] }
```

## Invite

```json
{ "code": "k3Xf_9aQ2b", "circle_id": "uuid", "max_uses": 25, "uses": 3, "expires_at": "..." }
```

The universal link is `https://<app domain>/i/<code>` once Associated Domains are set up (needs the Apple Developer account). Codes are 10 URL-safe characters and case-sensitive.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/v1/circles` | | `{ "circles": [Circle] }`, oldest membership first |
| POST | `/v1/circles` | `{ "name": 1 to 60 chars, "category_focus"?: up to 5 paths like "toys/lego" }` | 201 Circle (caller is owner) |
| GET | `/v1/circles/{id}` | | Circle detail |
| POST | `/v1/circles/{id}/invites` | `{ "max_uses"?: 1 to 200 (default 25), "expires_in_days"?: 1 to 30 (default 14) }` | 201 Invite. Any member can invite. |
| GET | `/v1/invites/{code}` | | Invite preview (below) |
| POST | `/v1/invites/{code}/accept` | | 201 Circle detail when joined, 200 when already a member |

### Invite preview

What the landing screen shows before joining: "Jordan invited you to the Thursday Lego Circle."

```json
{ "code": "k3Xf_9aQ2b", "circle_name": "Thursday Lego", "inviter_first_name": "Jordan", "member_count": 12, "status": "open | expired | full | already_member" }
```

### Errors

| Code | Status | When |
| --- | --- | --- |
| `not_found` | 404 | The Circle doesn't exist or the caller isn't in it |
| `invite_not_found` | 404 | No such code, or its Circle is paused |
| `invite_expired` | 410 | Past `expires_at` |
| `invite_full` | 409 | `uses` reached `max_uses` |

## Rules

- Joining is atomic (`public.accept_invite`): the invite row is locked, so 2 people can't take the last use. A use counts only when someone actually joins, so retrying a join is free.
- A paused Circle's invites stop working.
- Leaving a Circle, removing members, pausing and editing a Circle are not in this contract yet.
