import SwiftUI

/// Floating Liquid Glass tab bar. 2 capsules of tabs around the GM orb, which is always 1 tap
/// away. The selection pill slides between tabs; the orb sends a ripple through the app.
struct LoopTabBar: View {
    @Binding var selection: AppTab
    var orbMood: OrbMood = .idle
    /// Called with the orb's center in global (window) coordinates.
    var onOrbTap: (CGPoint) -> Void

    @Namespace private var selectionNamespace
    @State private var orbCenter: CGPoint = .zero
    @State private var bounces: [AppTab: Int] = [:]
    @State private var orbTaps = 0

    var body: some View {
        GlassEffectContainer(spacing: 16) {
            HStack(spacing: 12) {
                tabGroup([.home, .shelf])
                orbButton
                tabGroup([.circles, .you])
            }
        }
        .padding(.horizontal, Space.md)
        .sensoryFeedback(.selection, trigger: selection)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.8), trigger: orbTaps)
    }

    private func tabGroup(_ tabs: [AppTab]) -> some View {
        HStack(spacing: 2) {
            ForEach(tabs) { tab in
                tabButton(tab)
            }
        }
        .padding(5)
        .glassEffect(.regular.interactive(), in: .capsule)
    }

    private func tabButton(_ tab: AppTab) -> some View {
        let isSelected = selection == tab
        return Button {
            guard selection != tab else { return }
            bounces[tab, default: 0] += 1
            withAnimation(Motion.bouncy) { selection = tab }
        } label: {
            VStack(spacing: 2) {
                Image(systemName: tab.symbol)
                    .symbolVariant(isSelected ? .fill : .none)
                    .font(.system(size: 19, weight: isSelected ? .semibold : .regular))
                    .symbolEffect(.bounce.down, value: bounces[tab, default: 0])
                    .frame(height: 24)
                Text(tab.title)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
            }
            .foregroundStyle(isSelected ? Palette.ink : Palette.inkSecondary)
            .frame(width: 62, height: 50)
            .background {
                if isSelected {
                    Capsule()
                        .fill(Palette.ink.opacity(0.08))
                        .matchedGeometryEffect(id: "selection", in: selectionNamespace)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var orbButton: some View {
        Button {
            orbTaps += 1
            onOrbTap(orbCenter)
        } label: {
            GMOrbView(mood: orbMood, size: 46, showsGlow: false)
                .frame(width: 64, height: 64)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .onGeometryChange(for: CGPoint.self) { proxy in
            let frame = proxy.frame(in: .global)
            return CGPoint(x: frame.midX, y: frame.midY)
        } action: { center in
            orbCenter = center
        }
        .accessibilityLabel("Talk to your GM")
    }
}
