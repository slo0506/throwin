import SwiftUI

/// The signature approve control. Press and hold: the glass capsule fills with the Loop
/// gradient over 0.9 seconds, ticking haptics as it fills. Let go early and it drains back
/// with a spring. When full, `onComplete` runs (Face ID, then the server call).
struct HoldToApproveButton: View {
    enum Phase: Equatable {
        case idle
        case holding
        case confirming
        case done
    }

    var title: String = "Hold to approve"
    var phase: Phase
    var onComplete: () -> Void

    @State private var fill: CGFloat = 0
    @State private var isPressing = false
    @State private var tick = 0
    @State private var tickTask: Task<Void, Never>?

    private let holdDuration: TimeInterval = 0.9

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                label(color: Palette.ink)

                Capsule()
                    .fill(Palette.loopGradient)
                    .frame(width: max(0, proxy.size.width * fill))
                    .overlay(alignment: .trailing) {
                        // A bright meniscus on the leading edge of the liquid.
                        Capsule()
                            .fill(.white.opacity(0.55))
                            .frame(width: 6)
                            .blur(radius: 4)
                            .opacity(fill > 0.02 && fill < 1 ? 1 : 0)
                    }

                label(color: .white)
                    .mask(alignment: .leading) {
                        Rectangle().frame(width: max(0, proxy.size.width * fill))
                    }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipShape(Capsule())
        }
        .frame(height: 60)
        .glassEffect(.regular.interactive(), in: .capsule)
        .scaleEffect(isPressing ? 0.97 : 1)
        .animation(Motion.snappy, value: isPressing)
        .contentShape(Capsule())
        .onLongPressGesture(minimumDuration: holdDuration, maximumDistance: 60) {
            complete()
        } onPressingChanged: { pressing in
            pressingChanged(pressing)
        }
        .disabled(phase == .confirming || phase == .done)
        .sensoryFeedback(.increase, trigger: tick)
        .sensoryFeedback(.success, trigger: phase) { _, newPhase in newPhase == .done }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .idle {
                withAnimation(Motion.bouncy) { fill = 0 }
            } else if newPhase == .done {
                withAnimation(Motion.snappy) { fill = 1 }
            }
        }
        .accessibilityElement()
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { complete() }
    }

    private func label(color: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .bold))
                .contentTransition(.symbolEffect(.replace))
            Text(text)
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .contentTransition(.opacity)
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(Motion.snappy, value: phase)
        .animation(Motion.snappy, value: isPressing)
    }

    private var text: String {
        switch phase {
        case .done: "Approved"
        case .confirming: "Confirming"
        case .holding, .idle: isPressing ? "Keep holding" : title
        }
    }

    private var symbol: String {
        switch phase {
        case .done: "checkmark"
        case .confirming: "faceid"
        case .holding, .idle: isPressing ? "hand.raised.fill" : "hand.tap.fill"
        }
    }

    private func pressingChanged(_ pressing: Bool) {
        guard phase == .idle || phase == .holding else { return }
        isPressing = pressing
        tickTask?.cancel()
        if pressing {
            withAnimation(.linear(duration: holdDuration)) { fill = 1 }
            tickTask = Task {
                for _ in 0..<6 {
                    try? await Task.sleep(for: .milliseconds(150))
                    if Task.isCancelled { return }
                    tick += 1
                }
            }
        } else if fill < 1 {
            withAnimation(Motion.bouncy) { fill = 0 }
        }
    }

    private func complete() {
        tickTask?.cancel()
        isPressing = false
        fill = 1
        onComplete()
    }
}

#Preview {
    struct Demo: View {
        @State var phase: HoldToApproveButton.Phase = .idle
        var body: some View {
            HoldToApproveButton(phase: phase) {
                phase = .confirming
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    phase = .done
                }
            }
            .padding(24)
            .background(Palette.canvas)
        }
    }
    return Demo()
}
