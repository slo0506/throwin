import SwiftUI

// Streaming text that blooms in. Each glyph rises, sharpens and fades in, wrapped in a
// Loop-colored glow that cools to ink. Built on TextRenderer (iOS 18+).

/// Marks a run of text with the moment it arrived from the stream.
nonisolated struct ArrivalAttribute: TextAttribute {
    var time: TimeInterval
}

nonisolated struct TokenBloomRenderer: TextRenderer {
    /// Seconds since the stream's reference date, sampled by a TimelineView.
    var now: TimeInterval
    var glowColors: [Color]
    var reduceMotion: Bool

    /// How long a glyph takes to settle, and the stagger between glyphs in a token.
    private let settle: TimeInterval = 0.55
    private let glowFade: TimeInterval = 0.9
    private let stagger: TimeInterval = 0.018

    /// Room for the glow and blur to spill past the text's bounds.
    var displayPadding: EdgeInsets {
        EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
    }

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        for line in layout {
            for run in line {
                guard let arrival = run[ArrivalAttribute.self], !reduceMotion else {
                    ctx.draw(run)
                    continue
                }
                let runAge = now - arrival.time
                if runAge > glowFade + stagger * Double(run.count) {
                    ctx.draw(run)
                    continue
                }
                for (index, slice) in run.enumerated() {
                    let age = runAge - stagger * Double(index)
                    drawGlyph(slice, age: age, index: index, in: &ctx)
                }
            }
        }
    }

    private func drawGlyph(_ slice: Text.Layout.RunSlice, age: TimeInterval, index: Int, in ctx: inout GraphicsContext) {
        guard age > 0 else { return }
        let p = min(1, age / settle)
        let eased = 1 - pow(1 - p, 3)

        var glyph = ctx
        glyph.opacity = eased
        glyph.translateBy(x: 0, y: (1 - eased) * 7)
        if eased < 1 {
            glyph.addFilter(.blur(radius: (1 - eased) * 5))
        }

        let glow = max(0, 1 - age / glowFade)
        if glow > 0, !glowColors.isEmpty {
            let color = glowColors[index % glowColors.count]
            var halo = glyph
            halo.addFilter(.shadow(color: color.opacity(0.85 * glow), radius: 6 * glow + 1))
            halo.opacity = eased * glow * 0.9
            halo.draw(slice)
        }
        glyph.draw(slice)
    }
}

/// A piece of streamed text with arrival times, ready to render with TokenBloomRenderer.
struct StreamedText: Equatable {
    struct Chunk: Equatable {
        var text: String
        var arrival: TimeInterval
    }

    var chunks: [Chunk] = []

    var plain: String { chunks.map(\.text).joined() }

    mutating func append(_ text: String, at arrival: TimeInterval) {
        chunks.append(Chunk(text: text, arrival: arrival))
    }

    var text: Text {
        var result = Text(verbatim: "")
        for chunk in chunks {
            result = result + Text(verbatim: chunk.text).customAttribute(ArrivalAttribute(time: chunk.arrival))
        }
        return result
    }

    var lastArrival: TimeInterval { chunks.last?.arrival ?? 0 }
}

/// Renders streamed text with the bloom while any glyph is still settling, then goes static.
struct BloomingText: View {
    var streamed: StreamedText
    /// The reference date that chunk arrival times are measured from.
    var epoch: Date
    var font: Font = Typo.body
    var color: Color = Palette.ink

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Bumped once the last glyph settles so the timeline re-evaluates and pauses.
    @State private var settledGeneration = 0

    var body: some View {
        let _ = settledGeneration
        TimelineView(.animation(minimumInterval: nil, paused: !isSettling(at: Date()))) { context in
            let now = context.date.timeIntervalSince(epoch)
            streamed.text
                .font(font)
                .foregroundStyle(color)
                .lineSpacing(3)
                .textRenderer(
                    TokenBloomRenderer(now: now, glowColors: Palette.loop, reduceMotion: reduceMotion)
                )
        }
        .accessibilityLabel(streamed.plain)
        .task(id: streamed.lastArrival) {
            try? await Task.sleep(for: .seconds(1.7))
            settledGeneration += 1
        }
    }

    private func isSettling(at date: Date) -> Bool {
        guard !reduceMotion, !streamed.chunks.isEmpty else { return false }
        return date.timeIntervalSince(epoch) - streamed.lastArrival < 1.6
    }
}
