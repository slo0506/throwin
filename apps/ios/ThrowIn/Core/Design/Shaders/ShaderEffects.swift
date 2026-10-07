import SwiftUI

// SwiftUI wrappers for Shaders.metal. Each effect switches itself off when the shader is
// idle and respects Reduce Motion.

// MARK: - GM orb

enum OrbMood: Equatable {
    case idle
    case thinking
    case speaking

    var energy: Double {
        switch self {
        case .idle: 0
        case .thinking: 0.55
        case .speaking: 1
        }
    }
}

/// The GM's face. A glass sphere of Loop-colored liquid that breathes, swirls while thinking,
/// and brightens while speaking.
struct GMOrbView: View {
    var mood: OrbMood = .idle
    var size: CGFloat = 56
    var showsGlow: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var energyFrom: Double = 0
    @State private var energyTo: Double = 0
    @State private var changedAt = Date.distantPast

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: reduceMotion)) { context in
            let now = context.date
            let time = reduceMotion ? 2.0 : now.timeIntervalSince(start)
            let energy = currentEnergy(at: now)
            Rectangle()
                .fill(.white)
                .colorEffect(
                    ShaderLibrary.default.gmOrb(
                        .boundingRect,
                        .float(time),
                        .float(energy)
                    )
                )
                .scaleEffect(1 + 0.04 * energy)
        }
        .frame(width: size, height: size)
        .background {
            if showsGlow {
                Circle()
                    .fill(Palette.loopAngular)
                    .blur(radius: size * 0.32)
                    .opacity(0.45)
                    .scaleEffect(0.9)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Your GM")
        .onChange(of: mood, initial: true) { _, newMood in
            let now = Date()
            energyFrom = currentEnergy(at: now)
            energyTo = newMood.energy
            changedAt = now
        }
    }

    private func currentEnergy(at date: Date) -> Double {
        let progress = min(1, max(0, date.timeIntervalSince(changedAt) / 0.8))
        let eased = progress * progress * (3 - 2 * progress)
        return energyFrom + (energyTo - energyFrom) * eased
    }
}

// MARK: - Liquid ripple
//
// True displacement. Only for pure SwiftUI content (shapes, images, text): layer effects
// can't sample UIKit-backed views such as scroll views. For full screens use rippleRing.

struct LiquidRippleModifier: ViewModifier {
    var origin: CGPoint
    var trigger: Int
    var amplitude: Double = 14

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startDate: Date?

    private let duration: TimeInterval = 1.6

    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: nil, paused: startDate == nil)) { context in
            let elapsed = startDate.map { context.date.timeIntervalSince($0) } ?? 0
            content.layerEffect(
                ShaderLibrary.default.liquidRipple(
                    .float2(origin),
                    .float(elapsed),
                    .float(amplitude),
                    .float(14),
                    .float(5.5),
                    .float(1100)
                ),
                maxSampleOffset: CGSize(width: amplitude, height: amplitude),
                isEnabled: startDate != nil && elapsed < duration
            )
        }
        .onChange(of: trigger) { _, _ in
            guard !reduceMotion else { return }
            startDate = Date()
        }
        .task(id: trigger) {
            guard trigger > 0 else { return }
            try? await Task.sleep(for: .seconds(duration + 0.1))
            startDate = nil
        }
    }
}

extension View {
    /// Sends a damped liquid ripple across this view from `origin` each time `trigger` changes.
    func liquidRipple(at origin: CGPoint, trigger: Int, amplitude: Double = 14) -> some View {
        modifier(LiquidRippleModifier(origin: origin, trigger: trigger, amplitude: amplitude))
    }
}

// MARK: - Ripple ring (safe on any content)

/// Draws an expanding Loop-tinted ring over the view and gives the content a small
/// physical bump. Unlike `liquidRipple`, it never rasterizes the content, so it is safe on
/// screens with scroll views, text fields and other UIKit-backed views.
struct RippleRingModifier: ViewModifier {
    var origin: CGPoint
    var trigger: Int
    var strength: Double = 1

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startDate: Date?
    @State private var bump = false

    private let duration: TimeInterval = 1.4

    func body(content: Content) -> some View {
        content
            .scaleEffect(bump ? 0.985 : 1, anchor: UnitPoint(x: 0.5, y: 0.7))
            .overlay {
                TimelineView(.animation(minimumInterval: nil, paused: startDate == nil)) { context in
                    let elapsed = startDate.map { context.date.timeIntervalSince($0) } ?? 0
                    Rectangle()
                        .fill(.white)
                        .colorEffect(
                            ShaderLibrary.default.rippleRing(
                                .float2(origin),
                                .float(elapsed),
                                .float(900),
                                .float(strength)
                            ),
                            isEnabled: startDate != nil && elapsed < duration
                        )
                        .opacity(startDate != nil && elapsed < duration ? 1 : 0)
                }
                .ignoresSafeArea()
                .allowsHitTesting(false)
            }
            .onChange(of: trigger) { _, _ in
                guard !reduceMotion else { return }
                startDate = Date()
                withAnimation(.spring(response: 0.16, dampingFraction: 0.9)) { bump = true }
                withAnimation(Motion.bouncy.delay(0.12)) { bump = false }
            }
            .task(id: trigger) {
                guard trigger > 0 else { return }
                try? await Task.sleep(for: .seconds(duration + 0.1))
                startDate = nil
            }
    }
}

extension View {
    /// An expanding glass ring from `origin` each time `trigger` changes. Safe on any screen.
    func rippleRing(at origin: CGPoint, trigger: Int, strength: Double = 1) -> some View {
        modifier(RippleRingModifier(origin: origin, trigger: trigger, strength: strength))
    }
}

// MARK: - Appraisal scan

/// The scan means 1 thing: the GM is looking at this photo right now. It never plays just
/// because a photo appeared on screen.
struct AppraiseScanModifier: ViewModifier {
    /// Changing this to a positive number plays 1 sweep. 0 never plays.
    var trigger: Int = 0
    /// Sweeps on a loop while true, and lets the last sweep land when it turns false.
    var isActive: Bool = false
    var duration: TimeInterval = 1.8

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startDate: Date?

    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: nil, paused: startDate == nil)) { context in
            let elapsed = startDate.map { context.date.timeIntervalSince($0) } ?? duration
            let linear = min(1, max(0, elapsed / duration))
            // Ease in and out so the band lingers a beat at the top, then lands softly.
            let progress = linear * linear * (3 - 2 * linear)
            content.layerEffect(
                ShaderLibrary.default.appraiseScan(
                    .boundingRect,
                    .float(progress),
                    .float(elapsed)
                ),
                maxSampleOffset: CGSize(width: 8, height: 8),
                isEnabled: startDate != nil && linear < 1
            )
        }
        .task(id: trigger) {
            guard trigger > 0, !reduceMotion else { return }
            await sweep()
        }
        .task(id: isActive) {
            guard isActive, !reduceMotion else { return }
            while !Task.isCancelled {
                await sweep()
                try? await Task.sleep(for: .milliseconds(350))
            }
        }
    }

    private func sweep() async {
        let start = Date()
        startDate = start
        try? await Task.sleep(for: .seconds(duration + 0.05))
        guard Task.isCancelled else {
            if startDate == start { startDate = nil }
            return
        }
        // Stopped mid-sweep: let the band land instead of cutting it off halfway down.
        let remaining = duration + 0.05 - Date().timeIntervalSince(start)
        Task {
            if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
            if startDate == start { startDate = nil }
        }
    }
}

extension View {
    /// Plays 1 holographic appraisal sweep each time `trigger` changes to a positive number.
    func appraiseScan(trigger: Int, duration: TimeInterval = 1.8) -> some View {
        modifier(AppraiseScanModifier(trigger: trigger, duration: duration))
    }

    /// Sweeps the appraisal scan for as long as the GM is working on this photo.
    func appraiseScan(while isActive: Bool, duration: TimeInterval = 1.8) -> some View {
        modifier(AppraiseScanModifier(isActive: isActive, duration: duration))
    }
}

// MARK: - Paper grain

struct PaperGrainModifier: ViewModifier {
    var strength: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: reduceMotion)) { context in
            let time = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1000)
            content.colorEffect(ShaderLibrary.default.paperGrain(.float(time), .float(strength)))
        }
    }
}

extension View {
    func paperGrain(strength: Double = 0.035) -> some View {
        modifier(PaperGrainModifier(strength: strength))
    }
}

// MARK: - Loop shimmer

struct LoopShimmerModifier: ViewModifier {
    var isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()

    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: nil, paused: !isActive || reduceMotion)) { context in
            content.colorEffect(
                ShaderLibrary.default.loopShimmer(
                    .boundingRect,
                    .float(context.date.timeIntervalSince(start))
                ),
                isEnabled: isActive && !reduceMotion
            )
        }
    }
}

extension View {
    /// A Loop-colored highlight that sweeps across text while the GM is working.
    func loopShimmer(_ isActive: Bool = true) -> some View {
        modifier(LoopShimmerModifier(isActive: isActive))
    }
}

#Preview("Orb moods") {
    HStack(spacing: 24) {
        GMOrbView(mood: .idle, size: 72)
        GMOrbView(mood: .thinking, size: 72)
        GMOrbView(mood: .speaking, size: 72)
    }
    .padding(40)
    .background(Palette.canvas)
}
