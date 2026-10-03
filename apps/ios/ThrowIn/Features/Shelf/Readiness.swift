import SwiftUI

// Readiness on screen: the mark on each Shelf card, the "Inventory photo" tag, and the
// 3-step meter on the product card. Never a number, only plain words and color.

extension ItemReadiness {
    var tint: Color {
        switch self {
        case .logged: Palette.ink
        case .identified: Palette.iris
        case .showcase: Palette.mint
        }
    }
}

/// A small colored dot and label in a glass capsule. Shimmers while the GM takes a look.
struct ReadinessMark: View {
    var readiness: ItemReadiness
    var isWorking: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(readiness.tint)
                .frame(width: 7, height: 7)
            Text(readiness.label)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .glassEffect(.regular, in: .capsule)
        .loopShimmer(isWorking)
        .contentTransition(.opacity)
        .accessibilityElement()
        .accessibilityLabel(readiness.label)
    }
}

/// Marks a photo below the inventory floor, so the owner can see it would never sell anything.
struct InventoryPhotoTag: View {
    var body: some View {
        Text("Inventory photo")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Palette.tangerine, in: Capsule())
            .accessibilityLabel("Inventory photo")
    }
}

/// Logged, Identified, Ready to show: 3 dots on a track that fills up to where the Item is.
struct ReadinessMeter: View {
    var readiness: ItemReadiness

    var body: some View {
        let current = readiness.step
        VStack(spacing: Space.xs) {
            GeometryReader { proxy in
                let inset: CGFloat = 11
                let span = max(0, proxy.size.width - inset * 2)
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Palette.hairline)
                        .frame(width: span, height: 4)
                        .offset(x: inset)
                    Capsule()
                        .fill(readiness.tint)
                        .frame(width: span * CGFloat(current) / 2, height: 4)
                        .offset(x: inset)
                    ForEach(ItemReadiness.allCases, id: \.self) { step in
                        dot(step, current: current)
                            .position(x: inset + span * CGFloat(step.step) / 2, y: proxy.size.height / 2)
                    }
                }
            }
            .frame(height: 22)

            HStack {
                ForEach(ItemReadiness.allCases, id: \.self) { step in
                    Text(step.label)
                        .font(.system(size: 12, weight: step.step == current ? .bold : .medium, design: .rounded))
                        .foregroundStyle(step.step <= current ? Palette.ink : Palette.inkTertiary)
                        .frame(maxWidth: .infinity, alignment: alignment(for: step))
                }
            }
        }
        .animation(Motion.bouncy, value: readiness)
        .accessibilityElement()
        .accessibilityLabel("Readiness: \(readiness.label)")
    }

    private func dot(_ step: ItemReadiness, current: Int) -> some View {
        let reached = step.step <= current
        return ZStack {
            Circle()
                .fill(reached ? readiness.tint : Palette.surface)
                .frame(width: 22, height: 22)
                .overlay(Circle().strokeBorder(reached ? .clear : Palette.hairline, lineWidth: 2))
            if step.step < current {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(Palette.surface)
            } else if step.step == current {
                Circle()
                    .fill(Palette.surface)
                    .frame(width: 8, height: 8)
            }
        }
        .scaleEffect(step.step == current ? 1.08 : 1)
    }

    private func alignment(for step: ItemReadiness) -> Alignment {
        switch step {
        case .logged: .leading
        case .identified: .center
        case .showcase: .trailing
        }
    }
}

extension ShelfItem {
    /// The 1 line under the readiness meter: what would move this Item forward.
    var nextStepLine: String {
        switch readiness {
        case .logged:
            if openQuestions > 0 {
                return openQuestions == 1
                    ? "Answer 1 quick question so your GM can pin it down."
                    : "Answer \(openQuestions) quick questions so your GM can pin it down."
            }
            return "Your GM is still pinning this down."
        case .identified:
            return "A few good photos and it's ready to show."
        case .showcase:
            return "Ready to show. Nothing to do here."
        }
    }
}

// MARK: - Quiet banner

/// Shows the AppModel's last write error as a quiet glass banner at the top, then clears it.
struct QuietBanner: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let message = model.shelfError {
                    Text(message)
                        .font(Typo.callout)
                        .padding(.horizontal, Space.md)
                        .padding(.vertical, Space.sm)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.top, Space.xs)
                        .padding(.horizontal, Space.gutter)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .task(id: message) {
                            try? await Task.sleep(for: .seconds(3))
                            withAnimation(Motion.soft) { model.shelfError = nil }
                        }
                }
            }
            .animation(Motion.bouncy, value: model.shelfError)
    }
}

extension View {
    func quietBanner() -> some View {
        modifier(QuietBanner())
    }
}
