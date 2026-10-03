import SwiftUI

// MARK: - Item artwork

/// Placeholder "photo" for an Item until real capture lands in Milestone 1: a soft tinted
/// tile with a dimensional symbol. Category picks the symbol and the tint.
struct ItemArtwork: View {
    var item: ShelfItem
    var cornerRadius: CGFloat = Radius.tile
    var symbolScale: CGFloat = 0.38

    var body: some View {
        let style = ArtworkStyle(category: item.category)
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                LinearGradient(
                    colors: [style.tint.opacity(0.22), style.tint.opacity(0.08)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                Circle()
                    .fill(style.tint.opacity(0.18))
                    .frame(width: side * 0.9)
                    .blur(radius: side * 0.18)
                    .offset(x: side * 0.22, y: -side * 0.2)
                Image(systemName: style.symbol)
                    .font(.system(size: side * symbolScale, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(style.tint)
                    .shadow(color: style.tint.opacity(0.35), radius: side * 0.06, y: side * 0.04)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct ArtworkStyle {
    var symbol: String
    var tint: Color

    init(category: String?) {
        switch category ?? "" {
        case let c where c.hasPrefix("toys/lego"):
            symbol = "cube.transparent.fill"; tint = Palette.tangerine
        case "video_games":
            symbol = "gamecontroller.fill"; tint = Palette.iris
        case "sneakers":
            symbol = "shoe.fill"; tint = Palette.bubblegum
        case "trading_cards":
            symbol = "rectangle.stack.fill"; tint = Palette.gold
        case "books":
            symbol = "book.closed.fill"; tint = Palette.pool
        default:
            symbol = "shippingbox.fill"; tint = Palette.mint
        }
    }
}

// MARK: - Loop indicator

/// Prospecting status: 2 to 4 dots orbiting a ring, 1 per person in the candidate Loop.
/// Replaces every spinner in the app.
struct LoopIndicator: View {
    var people: Int = 3
    var size: CGFloat = 28
    var isActive: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !isActive || reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Canvas { ctx, canvasSize in
                let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
                let radius = canvasSize.width * 0.36
                let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
                ctx.stroke(ring, with: .color(Palette.ink.opacity(0.1)), lineWidth: 1.5)

                let count = max(2, min(4, people))
                let spin = isActive && !reduceMotion ? t * 1.6 : 0
                for i in 0..<count {
                    let base = Double(i) / Double(count) * 2 * .pi
                    // Each dot breathes a little so the orbit feels alive, not mechanical.
                    let wobble = isActive && !reduceMotion ? sin(t * 3 + Double(i)) * 0.18 : 0
                    let angle = base + spin + wobble
                    let point = CGPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius)
                    let dot = canvasSize.width * 0.16
                    let color = Palette.loop[i % Palette.loop.count]
                    ctx.fill(
                        Path(ellipseIn: CGRect(x: point.x - dot / 2, y: point.y - dot / 2, width: dot, height: dot)),
                        with: .color(color)
                    )
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Mesh backdrop

/// Slow-drifting Loop-tinted mesh for onboarding and the GM's hello.
struct MeshBackdrop: View {
    var intensity: Double = 1

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            MeshGradient(
                width: 3,
                height: 3,
                points: points(at: t),
                colors: colors,
                smoothsColors: true
            )
            .opacity(colorScheme == .dark ? 0.8 : 1)
        }
        .ignoresSafeArea()
    }

    private func points(at t: Double) -> [SIMD2<Float>] {
        let row1: [SIMD2<Float>] = [
            SIMD2(0, drift(0.5, t, 0.9, 0.08)),
            SIMD2(drift(0.5, t, 1.3, 0.12), drift(0.5, t, 1.1, 0.1)),
            SIMD2(1, drift(0.5, t, 0.7, 0.08)),
        ]
        let row0: [SIMD2<Float>] = [SIMD2(0, 0), SIMD2(0.5, 0), SIMD2(1, 0)]
        let row2: [SIMD2<Float>] = [SIMD2(0, 1), SIMD2(drift(0.5, t, 0.8, 0.1), 1), SIMD2(1, 1)]
        return row0 + row1 + row2
    }

    private var colors: [Color] {
        let base = Palette.canvas
        let k = intensity
        return [
            base, Palette.bubblegum.opacity(0.55 * k), base,
            Palette.tangerine.opacity(0.5 * k), Palette.iris.opacity(0.45 * k), Palette.pool.opacity(0.5 * k),
            base, Palette.iris.opacity(0.3 * k), base,
        ]
    }

    private func drift(_ center: Float, _ t: Double, _ speed: Double, _ amount: Float) -> Float {
        center + Float(sin(t * speed * 0.35)) * amount
    }
}

// MARK: - Celebration burst

/// Loop-colored confetti dots that burst from a point. Plays once per `trigger`.
struct CelebrationBurst: View {
    var trigger: Int
    var origin: UnitPoint = .center

    @State private var startDate: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Particle {
        var angle: Double
        var speed: Double
        var size: Double
        var spin: Double
        var colorIndex: Int
    }

    private static let particles: [Particle] = (0..<46).map { i in
        let golden = Double(i) * 2.399963
        return Particle(
            angle: golden,
            speed: 260 + Double((i * 37) % 160),
            size: 5 + Double((i * 13) % 8),
            spin: Double((i * 29) % 7) - 3,
            colorIndex: i % 4
        )
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: startDate == nil)) { context in
            let elapsed = startDate.map { context.date.timeIntervalSince($0) } ?? 0
            Canvas { ctx, size in
                guard startDate != nil, elapsed < 1.6 else { return }
                let o = CGPoint(x: size.width * origin.x, y: size.height * origin.y)
                for p in Self.particles {
                    let t = elapsed
                    let dx = cos(p.angle) * p.speed * t
                    let dy = sin(p.angle) * p.speed * t + 520 * t * t * 0.5 - 140 * t
                    let fade = max(0, 1 - t / 1.6)
                    let s = p.size * (0.6 + 0.4 * fade)
                    var c = ctx
                    c.opacity = fade
                    c.translateBy(x: o.x + dx, y: o.y + dy)
                    c.rotate(by: .radians(p.spin * t))
                    let rect = CGRect(x: -s / 2, y: -s / 2, width: s, height: p.colorIndex % 2 == 0 ? s : s * 0.5)
                    c.fill(Path(roundedRect: rect, cornerRadius: s * 0.3), with: .color(Palette.loop[p.colorIndex]))
                }
            }
        }
        .allowsHitTesting(false)
        .onChange(of: trigger) { _, _ in
            guard !reduceMotion else { return }
            startDate = Date()
        }
        .task(id: trigger) {
            guard trigger > 0 else { return }
            try? await Task.sleep(for: .seconds(1.7))
            startDate = nil
        }
    }
}

#Preview("Expressive") {
    VStack(spacing: 24) {
        LoopIndicator(people: 3, size: 44)
        ItemArtwork(item: DemoData.shelf[0]).frame(width: 140, height: 140)
    }
    .padding()
    .background(Palette.canvas)
}
