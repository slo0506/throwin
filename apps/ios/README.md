# Throw-In iOS

SwiftUI, Swift 6, iOS 26+ (Liquid Glass), Metal shaders. No third-party packages yet.

## Run it
1. Open `apps/ios/ThrowIn.xcodeproj` in Xcode 26.
2. Pick the `ThrowIn` scheme and an iPhone 17 Pro simulator.
3. Press Run.

The project uses folder-synced groups: any file you add under `ThrowIn/` is in the target automatically, including `.metal` files.

## Demo mode
With no backend configured the app runs fully on device with sample data: onboarding, the Shelf (tap "Try a sample capture"), an Ask with live prospecting status, a 3-way Deal Sheet with hold-to-approve, a scripted GM chat, Circles and settings with account deletion.

## Live mode
Set `THROWIN_API_BASE_URL` (for example `http://localhost:8787`) in the scheme's Run environment variables. The app then calls `/v1/me`, `/v1/items` and `DELETE /v1/me`. Live sign-in needs Sign in with Apple, which waits on the Apple Developer account (see `Core/Auth/Auth.swift`).

## Where things live
| Path | What |
| --- | --- |
| `Core/Design/Theme.swift` | Color, type, spacing, radii and spring tokens from `docs/design.md` |
| `Core/Design/Shaders/Shaders.metal` | `gmOrb`, `appraiseScan`, `liquidRipple`, `rippleRing`, `paperGrain`, `loopShimmer` |
| `Core/Design/Shaders/TokenBloom.swift` | Streaming text renderer (per-glyph bloom) |
| `Core/Design/Components/` | Tab bar, hold-to-approve, value range bar, Loop indicator, cards |
| `Features/` | Onboarding, Home, Shelf, GM, Deals, Circles, Settings |
