import SwiftUI

/// A counter your GM staged from your words ("can we get a little more?"). Nothing goes out
/// until you tap Send; then the other side answers on their Deal Sheet, and nobody can
/// approve until they do.
struct CounterCardView: View {
    var data: CounterCardData
    var isEnabled: Bool

    @Environment(AppModel.self) private var model
    @State private var sending = false
    @State private var sentHere = false
    @State private var errorText: String?

    /// The Deal as it is now, if it's still open.
    private var deal: DealSheet? { model.dealsWaiting.first { $0.id == data.dealId } }

    private enum Stage { case ready, sent, changed }

    private var stage: Stage {
        if sentHere { return .sent }
        guard let deal else { return model.isLive ? .changed : .ready }
        if let counter = deal.counter { return counter.isMine ? .sent : .changed }
        return .ready
    }

    private var changes: [DealCounter.Change] {
        let me = model.session?.userID
        return data.lines.map { line in
            DealCounter.Change(
                isAdd: line.op == "add",
                item: ShelfItem(dealItem: line.item),
                giver: line.giver.firstName ?? "someone",
                receiver: line.receiver.firstName ?? "someone",
                fromMe: line.giver.userId == me,
                toMe: line.receiver.userId == me
            )
        }
    }

    private var waitingNames: String {
        ListFormatter.localizedString(byJoining: data.waitingOn.map { $0.firstName ?? "someone" })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.iris)
                Text("Counter").sectionLabel()
                Spacer()
            }

            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(changes) { change in
                    HStack(spacing: Space.sm) {
                        ItemArtwork(item: change.item, cornerRadius: 12)
                            .frame(width: 48, height: 48)
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: change.isAdd ? "plus.circle.fill" : "minus.circle.fill")
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundStyle(.white, change.isAdd ? Palette.mint : Palette.give)
                                    .offset(x: 6, y: 6)
                            }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(change.line)
                                .font(.system(size: 15, weight: .semibold, design: .rounded))
                                .foregroundStyle(Palette.ink)
                                .lineLimit(2)
                            if let value = change.item.value {
                                Text(value.label)
                                    .font(Typo.caption.monospacedDigit())
                                    .foregroundStyle(Palette.inkSecondary)
                            }
                        }
                    }
                }
            }

            Text(Self.cashLine(after: data.cash, now: data.cashNow))
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)

            footer
        }
        .padding(Space.md)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(Palette.iris.opacity(0.25), lineWidth: 1.5)
        }
        .animation(Motion.snappy, value: sentHere)
    }

    @ViewBuilder
    private var footer: some View {
        switch stage {
        case .ready:
            VStack(alignment: .leading, spacing: Space.xs) {
                Button(action: send) {
                    PrimaryLabel(sending ? "Sending" : "Send counter", symbol: "paperplane.fill")
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .disabled(!isEnabled || sending || !model.isLive)
                Text(errorText ?? "Only goes out if you send it. \(waitingNames) answers on their Deal Sheet.")
                    .font(Typo.footnote)
                    .foregroundStyle(errorText == nil ? Palette.inkTertiary : Palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .sent:
            Label("Sent. Waiting on \(waitingNames) to answer.", systemImage: "checkmark.circle.fill")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.mint)
                .transition(.opacity)
        case .changed:
            Text("This trade has changed since. Ask your GM for a fresh look.")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkTertiary)
        }
    }

    private func send() {
        sending = true
        errorText = nil
        Task {
            do {
                try await model.sendCounter(dealID: data.dealId, changes: data.changes)
                sentHere = true
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't send it. Try again."
            }
            sending = false
        }
    }

    /// "You'd add $58 instead of $28." Amounts are whole dollars, like the Deal Sheet's.
    static func cashLine(after: APIDealSheet.Cash, now: APIDealSheet.Cash) -> String {
        DealCounter.cashLine(
            after: after.payCents - after.receiveCents,
            now: now.payCents - now.receiveCents
        )
    }
}

extension DealCounter {
    /// Positive cents: you pay; negative: you receive.
    static func cashLine(after: Int, now: Int) -> String {
        let was = now > 0
            ? "adding \(Money.dollars(now))"
            : now < 0 ? "getting \(Money.dollars(-now))" : "no cash"
        if after == now {
            return now == 0
                ? "No cash either way."
                : "Cash stays the same: \(now > 0 ? "you add" : "you get") \(Money.dollars(abs(now)))."
        }
        if after > 0 { return "You'd add \(Money.dollars(after)), instead of \(was)." }
        if after < 0 { return "You'd get \(Money.dollars(-after)), instead of \(was)." }
        return "No cash, instead of \(was)."
    }
}
