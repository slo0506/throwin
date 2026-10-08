import SwiftUI

/// Someone in your Circles is looking for an Item you offer for nothing. Pick 1 thing they
/// offer and your GM builds the trade; both of you still see a Deal Sheet first. Passing
/// means it won't come up for their Ask again.
struct InterestSheet: View {
    var interest: Interest

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var picked: String?
    @State private var sending = false
    @State private var errorText: String?

    private var who: String { interest.wanterFirstName ?? "Someone in your Circles" }
    private var mine: ShelfItem { ShelfItem(dealItem: interest.item) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    Text("Someone wants your Item").sectionLabel()
                    Text("\(who) is looking for your \(mine.title)")
                        .font(Typo.title2)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)

                    row(mine, selected: false)

                    Text("\(interest.wanterFirstName ?? "They") would trade").sectionLabel()
                    VStack(spacing: Space.sm) {
                        ForEach(interest.theirOffer, id: \.id) { item in
                            Button {
                                withAnimation(Motion.bouncy) { picked = picked == item.id ? nil : item.id }
                            } label: {
                                row(ShelfItem(dealItem: item), selected: picked == item.id)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)

            Text(errorText ?? "Pick what you'd take and your GM builds the trade. You'll both see a Deal Sheet before anything happens.")
                .font(Typo.footnote)
                .foregroundStyle(errorText == nil ? Palette.inkSecondary : Palette.danger)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: Space.sm) {
                Button {
                    answer(nil)
                } label: {
                    Text("Not this one").frame(maxWidth: .infinity).frame(height: 30)
                }
                .buttonStyle(.glass)
                Button {
                    answer(picked)
                } label: {
                    Text("Trade for it").frame(maxWidth: .infinity).frame(height: 30)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .disabled(picked == nil)
            }
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .disabled(sending)
        }
        .padding(Space.xl)
    }

    private func row(_ item: ShelfItem, selected: Bool) -> some View {
        HStack(spacing: Space.md) {
            ItemArtwork(item: item, cornerRadius: 14)
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    if let grade = item.conditionGrade { GradeChip(grade: grade) }
                    if let value = item.value {
                        Text(value.label)
                            .font(Typo.caption.monospacedDigit())
                            .foregroundStyle(Palette.inkSecondary)
                    }
                }
            }
            Spacer(minLength: 0)
            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Palette.receive)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(selected ? Palette.receive : .clear, lineWidth: 2)
        }
    }

    private func answer(_ wantItemId: String?) {
        sending = true
        errorText = nil
        Task {
            do {
                try await model.answerInterest(interest, wantItemId: wantItemId)
                dismiss()
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't send your answer. Try again."
            }
            sending = false
        }
    }
}
