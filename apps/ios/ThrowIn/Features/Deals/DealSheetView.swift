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
    @State private var confirmDecline = false
    @State private var isDeclining = false
    @State private var isAnswering = false
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
                    if let counter = deal.counter { counterSection(counter) }
                    if deal.supersededBy != nil { supersededNote }
                    side(title: "You give", items: deal.give, tint: Palette.give)
                    fairness
                    side(title: "You get", items: deal.receive, tint: Palette.receive)
                    loopParticipants
                    if deal.why != nil { why }
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
        .confirmationDialog("Decline this Deal?", isPresented: $confirmDecline, titleVisibility: .visible) {
            Button("Decline", role: .destructive) { decline() }
        } message: {
            Text("Everyone's Items go back on their Shelves, and your GM keeps looking. It won't offer you this Item again.")
        }
        .onAppear {
            if model.approvedDealIDs.contains(deal.id) || deal.myApproval == .approved { phase = .done }
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
            Text(deal.getTitle ?? "Trade")
                .font(Typo.title)
                .tracking(-0.4)
                .foregroundStyle(Palette.ink)
            Text(deal.status == .approved
                 ? "Everyone approved."
                 : "Expires in \(deal.expiresInHours) hours if not everyone approves.")
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
                        if let rating = person.rating {
                            HStack(spacing: 2) {
                                Image(systemName: "star.fill").font(.system(size: 9))
                                Text(rating.formatted(.number.precision(.fractionLength(1))))
                            }
                            .font(Typo.caption)
                            .foregroundStyle(Palette.inkSecondary)
                        }
                        if let circle = person.circle {
                            Text(circle)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Palette.inkTertiary)
                                .lineLimit(1)
                        }
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

    /// An open counter: what it changes, from your side, and whose answer it waits on.
    private func counterSection(_ c: DealCounter) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.iris)
                Text(c.isMine ? "Your counter" : "\(c.proposer)'s counter").sectionLabel()
            }
            Text(counterHeadline(c))
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(c.changes) { change in
                HStack(spacing: Space.sm) {
                    ItemArtwork(item: change.item, cornerRadius: 12)
                        .frame(width: 48, height: 48)
                        .overlay(alignment: .bottomTrailing) {
                            Image(systemName: change.isAdd ? "plus.circle.fill" : "minus.circle.fill")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(.white, change.isAdd ? Palette.mint : Palette.give)
                                .offset(x: 6, y: 6)
                        }
                    Text(change.line)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                }
            }
            Text(DealCounter.cashLine(after: c.throwInCents, now: deal.throwInCents))
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.md)
        .background(Palette.iris.opacity(0.07), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func counterHeadline(_ c: DealCounter) -> String {
        let names = ListFormatter.localizedString(byJoining: c.waitingOn)
        if c.yourAnswer == .pending { return "\(c.proposer) wants to change the trade. It waits on your answer." }
        if c.isMine { return "Waiting on \(names) to answer." }
        return "Waiting on \(names) to answer it."
    }

    /// Everyone accepted a counter; the new version goes out once its photos are in.
    private var supersededNote: some View {
        Label(
            "Everyone agreed to the change. The new version goes out as soon as its photos are in.",
            systemImage: "checkmark.circle.fill"
        )
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .foregroundStyle(Palette.mint)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var why: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            GMOrbView(mood: .idle, size: 32, showsGlow: false)
            VStack(alignment: .leading, spacing: 4) {
                Text("Why your GM likes it").sectionLabel()
                Text(deal.why ?? "")
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
            if let counter = deal.counter {
                counterActions(counter)
            } else if deal.supersededBy == nil {
                approveActions
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

    /// While a counter is open nobody approves: you answer it, or take yours back.
    @ViewBuilder
    private func counterActions(_ counter: DealCounter) -> some View {
        if counter.yourAnswer == .pending {
            HStack(spacing: Space.sm) {
                Button {
                    answer(accept: false)
                } label: {
                    Text("Decline").frame(maxWidth: .infinity).frame(height: 30)
                }
                .buttonStyle(.glass)
                Button {
                    answer(accept: true)
                } label: {
                    Text(isAnswering ? "Sending" : "Accept").frame(maxWidth: .infinity).frame(height: 30)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
            }
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .disabled(isAnswering)
            Text("Accepting makes a new version everyone approves again. Declining keeps the trade as it was.")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkTertiary)
                .multilineTextAlignment(.center)
        } else if counter.isMine {
            Button {
                withdraw()
            } label: {
                Text("Take it back").frame(maxWidth: .infinity).frame(height: 30)
            }
            .buttonStyle(.glass)
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(Palette.ink)
            .disabled(isAnswering)
        }
    }

    private var approveActions: some View {
        VStack(spacing: Space.sm) {
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
                        confirmDecline = true
                    } label: {
                        Text(isDeclining ? "Declining" : "Decline").frame(maxWidth: .infinity).frame(height: 30)
                    }
                    .buttonStyle(.glass)
                    .disabled(isDeclining || phase == .confirming)
                    if deal.countersLeft > 0 {
                        Button(action: askGMToChange) {
                            Text("Change it").frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glass)
                        .disabled(phase == .confirming)
                    }
                }
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.ink)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else {
                Text(doneLine)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
            }
        }
    }

    /// Counters start with the GM: you say what you'd change, it stages a card you send.
    private func askGMToChange() {
        let title = deal.getTitle ?? "this trade"
        model.presentedDeal = nil
        Task {
            // Let the Deal Sheet finish closing before the GM opens.
            try? await Task.sleep(for: .milliseconds(450))
            model.openGM(screen: "deal_sheet", seed: "About the \(title) trade: ")
        }
    }

    private func answer(accept: Bool) {
        isAnswering = true
        errorText = nil
        Task {
            do {
                try await model.answerCounter(deal, accept: accept)
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't send your answer. Try again."
            }
            isAnswering = false
        }
    }

    private func withdraw() {
        isAnswering = true
        errorText = nil
        Task {
            do {
                try await model.withdrawCounter(deal)
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't take it back. Try again."
            }
            isAnswering = false
        }
    }

    /// After approving: who it's still waiting on, or what happens next.
    private var doneLine: String {
        let others = deal.participants.count - 1
        if deal.status == .approved {
            return others == 1
                ? "Your GM will find a time and place that works for you both."
                : "Your GM will find a time and place that works for all \(deal.participants.count) of you."
        }
        return others == 1
            ? "Approved. Waiting on the other person."
            : "Approved. Waiting on the others."
    }

    private func approve() {
        phase = .confirming
        errorText = nil
        Task {
            // The server can't verify this yet (needs App Attest or passkeys), so the check is
            // on device for now. The PRD requires it either way.
            let confirmed = await DeviceConfirmation.confirm(reason: "Approve this trade")
            guard confirmed else {
                phase = .idle
                errorText = "Approval needs Face ID or your passcode."
                return
            }
            do {
                try await model.approve(deal)
            } catch {
                phase = .idle
                errorText = (error as? APIError)?.message ?? "Couldn't approve. Try again."
                return
            }
            rippleOrigin = approveCenter
            rippleTrigger += 1
            celebrate += 1
            phase = .done
        }
    }

    private func decline() {
        isDeclining = true
        errorText = nil
        Task {
            do {
                try await model.decline(deal, reason: nil)
                dismiss()
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't decline. Try again."
            }
            isDeclining = false
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

#Preview {
    DealSheetView(deal: DemoData.deal)
        .environment(AppModel())
}
