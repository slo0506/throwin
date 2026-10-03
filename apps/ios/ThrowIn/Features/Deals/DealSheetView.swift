import LocalAuthentication
import SwiftUI

/// The Deal Sheet: every Deal reaches the user here, never as a chat message.
/// What you give (warm) and what you get (cool), the fairness line, who's in the Loop, why
/// the GM likes it, and hold-to-approve with Face ID.
struct DealSheetView: View {
    var deal: DealSheet

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var phase: HoldToApproveButton.Phase = .idle
    @State private var rippleOrigin: CGPoint = .zero
    @State private var rippleTrigger = 0
    @State private var celebrate = 0
    @State private var approveCenter: CGPoint = .zero
    @State private var showCounter = false
    @State private var errorText: String?

    private var scaleMax: Int {
        let highs = (deal.give + deal.receive).compactMap(\.value?.highCents)
        return Int(Double(highs.max() ?? 10000) * 1.15)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Palette.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    topBar
                    title
                    side(title: "You give", items: deal.give, tint: Palette.give)
                    fairness
                    side(title: "You get", items: deal.receive, tint: Palette.receive)
                    loopParticipants
                    why
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, 200)
            }
            .scrollIndicators(.hidden)

            actions
        }
        .rippleRing(at: rippleOrigin, trigger: rippleTrigger, strength: 1.2)
        .overlay {
            CelebrationBurst(trigger: celebrate, origin: UnitPoint(x: 0.5, y: 0.82))
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showCounter) {
            CounterSheet(deal: deal)
                .presentationDetents([.medium])
                .presentationCornerRadius(32)
        }
        .onAppear {
            if model.approvedDealIDs.contains(deal.id) { phase = .done }
        }
    }

    // MARK: Sections

    private var topBar: some View {
        HStack {
            Pill(
                text: deal.isLoop ? "\(deal.participants.count)-way Loop" : "Swap",
                symbol: "arrow.triangle.2.circlepath",
                tint: Palette.iris
            )
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.ink)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("Close")
        }
        .padding(.top, Space.sm)
    }

    private var title: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Deal Sheet").sectionLabel()
            Text(deal.receive.first?.title ?? "Trade")
                .font(Typo.title)
                .tracking(-0.4)
                .foregroundStyle(Palette.ink)
            Text("Expires in \(deal.expiresInHours) hours if not everyone approves.")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkTertiary)
        }
    }

    private func side(title: String, items: [ShelfItem], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 8, height: 8)
                Text(title).sectionLabel()
            }
            ForEach(items) { item in
                HStack(spacing: Space.md) {
                    ItemArtwork(item: item, cornerRadius: 18)
                        .frame(width: 76, height: 76)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.title)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                        if let grade = item.conditionGrade {
                            GradeChip(grade: grade)
                        }
                        if let value = item.value {
                            ValueRangeBar(range: value, tint: tint, scaleMax: scaleMax, showsLabels: false)
                            Text(value.label)
                                .font(Typo.caption.monospacedDigit())
                                .foregroundStyle(Palette.inkSecondary)
                        }
                    }
                }
                .padding(Space.sm)
                .background {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Palette.surface)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(tint.opacity(0.35), lineWidth: 1.5)
                }
            }
        }
    }

    private var fairness: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "equal")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Palette.mint)
                .frame(width: 40, height: 40)
                .background(Palette.mint.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(fairnessLine(deal))
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if deal.throwInCents > 0 {
                    Text("The \(Money.dollars(deal.throwInCents)) Throw-In is only charged after you confirm the handoff.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(Space.md)
        .background(Palette.mint.opacity(0.07), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var loopParticipants: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Who's in the Loop")
            HStack(spacing: 0) {
                ForEach(Array(deal.participants.enumerated()), id: \.element.id) { index, person in
                    VStack(spacing: 6) {
                        Avatar(person: person, size: 44)
                        Text(person.name)
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                        HStack(spacing: 2) {
                            Image(systemName: "star.fill").font(.system(size: 9))
                            Text(person.rating.formatted(.number.precision(.fractionLength(1))))
                        }
                        .font(Typo.caption)
                        .foregroundStyle(Palette.inkSecondary)
                        Text(person.circle)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Palette.inkTertiary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    if index < deal.participants.count - 1 {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Palette.inkTertiary)
                            .offset(y: -22)
                    }
                }
            }
            .padding(.vertical, Space.md)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
    }

    private var why: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            GMOrbView(mood: .idle, size: 32, showsGlow: false)
            VStack(alignment: .leading, spacing: 4) {
                Text("Why your GM likes it").sectionLabel()
                Text(deal.why)
                    .font(Typo.body)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(spacing: Space.sm) {
            if let errorText {
                Text(errorText)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.danger)
            }
            HoldToApproveButton(phase: phase) {
                approve()
            }
            .onGeometryChange(for: CGPoint.self) { proxy in
                let frame = proxy.frame(in: .global)
                return CGPoint(x: frame.midX, y: frame.midY)
            } action: { center in
                approveCenter = center
            }

            if phase != .done {
                HStack(spacing: Space.sm) {
                    Button {
                        dismiss()
                    } label: {
                        Text("Decline").frame(maxWidth: .infinity).frame(height: 30)
                    }
                    .buttonStyle(.glass)
                    Button {
                        showCounter = true
                    } label: {
                        Text("Counter").frame(maxWidth: .infinity).frame(height: 30)
                    }
                    .buttonStyle(.glass)
                }
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.ink)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else {
                Text("Your GM will find a time and place that works for all 3 of you.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, Space.gutter)
        .padding(.top, Space.lg)
        .padding(.bottom, Space.sm)
        .background {
            LinearGradient(colors: [Palette.canvas.opacity(0), Palette.canvas, Palette.canvas], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        }
        .animation(Motion.bouncy, value: phase)
    }

    private func approve() {
        phase = .confirming
        errorText = nil
        Task {
            let confirmed = await DeviceConfirmation.confirm(reason: "Approve this trade")
            guard confirmed else {
                phase = .idle
                errorText = "Approval needs Face ID or your passcode."
                return
            }
            rippleOrigin = approveCenter
            rippleTrigger += 1
            celebrate += 1
            phase = .done
            model.markApproved(deal)
        }
    }
}

/// A fresh device-bound confirmation before approving (PRD: Face ID or passcode).
enum DeviceConfirmation {
    static func confirm(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // Simulator without enrolled biometrics or passcode: allow in debug builds only.
            #if DEBUG
            return true
            #else
            return false
            #endif
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}

/// Counter: a different Throw-In or item. Re-runs matching instead of opening a chat thread.
private struct CounterSheet: View {
    var deal: DealSheet

    @Environment(\.dismiss) private var dismiss
    @State private var throwIn: Double = 10
    @State private var sent = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("Counter").font(Typo.title2)
            Text("Change the Throw-In and your GM will re-run the Loop with everyone else's limits.")
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)

            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Text("Your Throw-In").sectionLabel()
                    Spacer()
                    Text(Money.dollars(Int(throwIn) * 100))
                        .font(Typo.valueLarge)
                        .contentTransition(.numericText(value: throwIn))
                        .animation(Motion.snappy, value: throwIn)
                }
                Slider(value: $throwIn, in: 0...20, step: 1)
                    .tint(Palette.gold)
                    .sensoryFeedback(.selection, trigger: throwIn)
            }

            Button {
                withAnimation(Motion.bouncy) { sent = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.1))
                    dismiss()
                }
            } label: {
                PrimaryLabel(sent ? "Sent to the Loop" : "Send counter", symbol: sent ? "checkmark" : "arrow.triangle.2.circlepath")
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .disabled(sent)
        }
        .padding(Space.xl)
    }
}

#Preview {
    DealSheetView(deal: DemoData.deal)
        .environment(AppModel())
}
