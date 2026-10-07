import SwiftUI

/// Photos on their way to the Shelf: the photos themselves (the scan sweeps them while the GM
/// reads them, since that's exactly what it's doing), 1 line on what's happening, and what
/// to do when they land. Shown on the Shelf, and in the chat when the GM asked for the
/// photo, so the camera can close the moment you've shot.
struct CaptureStatusCard: View {
    var capture: CaptureModel
    /// Offered once the Items land and the Refiner has questions about them.
    var onTuneUp: (() -> Void)?

    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: Space.md) {
            CaptureThumbStack(images: capture.frames.prefix(3).compactMap { capture.thumbnails[$0.id] })
                .appraiseScan(while: capture.phase.isBusy, duration: 1.6)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .id(title)
                    .transition(.blurReplace)
                Text(detail)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .lineLimit(2)
                    .contentTransition(.numericText())
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(Space.sm)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.05), radius: 14, y: 6)
        .animation(Motion.soft, value: capture.phase)
        .sensoryFeedback(.success, trigger: landed)
        .accessibilityElement(children: .combine)
    }

    private var landed: Bool {
        if case let .finished(items, _) = capture.phase { return !items.isEmpty }
        return false
    }

    private var title: String {
        switch capture.phase {
        case .collecting: return "Ready to send"
        case let .uploading(_, total): return total == 1 ? "Sending 1 photo" : "Sending \(total) photos"
        case let .working(detail): return detail
        case let .finished(items, summary): return items.isEmpty ? "Nothing to trade in these" : summary
        case .failed: return "Couldn't add these"
        }
    }

    private var detail: String {
        switch capture.phase {
        case .collecting:
            return ""
        case let .uploading(done, total):
            return "\(done) of \(total) sent. Keep going, they'll land here."
        case .working:
            let found = capture.arrivedItems.count
            return found == 0
                ? "About 20 seconds. Keep going, they'll land here."
                : found == 1 ? "Found 1 so far" : "Found \(found) so far"
        case let .finished(items, summary):
            if items.isEmpty { return summary }
            return onTuneUp != nil && app.tuneUpCount > 0
                ? "A few quick answers pin them down."
                : "Your GM is pricing them now."
        case let .failed(message):
            return message
        }
    }

    @ViewBuilder
    private var trailing: some View {
        switch capture.phase {
        case .collecting:
            EmptyView()
        case .uploading, .working:
            LoopIndicator(people: 3, size: 24)
        case let .finished(items, _):
            HStack(spacing: Space.xs) {
                if let onTuneUp, !items.isEmpty, app.tuneUpCount > 0 {
                    Button("Tune up", action: onTuneUp)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .buttonStyle(.glass)
                }
                closeButton
            }
        case .failed:
            HStack(spacing: Space.xs) {
                Button("Try again") { app.retryCapture(capture) }
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .buttonStyle(.glass)
                closeButton
            }
        }
    }

    private var closeButton: some View {
        Button {
            app.dismissCapture(capture)
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Palette.inkSecondary)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("Dismiss")
    }
}

/// Up to 3 photos fanned like a small hand of cards.
struct CaptureThumbStack: View {
    var images: [UIImage]

    var body: some View {
        ZStack {
            if images.isEmpty {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Palette.ink.opacity(0.06))
                    .frame(width: 44, height: 56)
            }
            ForEach(Array(images.enumerated()), id: \.offset) { index, image in
                let offset = Double(index) - Double(images.count - 1) / 2
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 44, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(.white.opacity(0.9), lineWidth: 1.5)
                    }
                    .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
                    .rotationEffect(.degrees(offset * 8))
                    .offset(x: offset * 7)
            }
        }
        .frame(width: 64, height: 64)
        .accessibilityHidden(true)
    }
}
