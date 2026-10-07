import SwiftUI

/// 1 tap on a guess: would this Item work for your Ask? Yes lets your GM build a trade with
/// it; no means it won't come up for this Ask again. Every Deal still needs your approval.
struct InquirySheet: View {
    var inquiry: Inquiry

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var sending = false
    @State private var errorText: String?

    private var item: ShelfItem { ShelfItem(dealItem: inquiry.item) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("Your GM is asking").sectionLabel()
            Text("Would this work for your \(inquiry.askTitle)?")
                .font(Typo.title2)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: Space.md) {
                ItemArtwork(item: item, cornerRadius: 18)
                    .frame(width: 88, height: 88)
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.title)
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                    if let grade = item.conditionGrade { GradeChip(grade: grade) }
                    if let value = item.value {
                        Text(value.label)
                            .font(Typo.caption.monospacedDigit())
                            .foregroundStyle(Palette.inkSecondary)
                    }
                }
            }
            .padding(Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))

            Text(errorText ?? "Someone in your Circles could trade it to you. You'd still see the Deal Sheet before anything happens.")
                .font(Typo.footnote)
                .foregroundStyle(errorText == nil ? Palette.inkSecondary : Palette.danger)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: Space.sm) {
                Button {
                    answer(false)
                } label: {
                    Text("No thanks").frame(maxWidth: .infinity).frame(height: 30)
                }
                .buttonStyle(.glass)
                Button {
                    answer(true)
                } label: {
                    Text("Yes, it works").frame(maxWidth: .infinity).frame(height: 30)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
            }
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .disabled(sending)
        }
        .padding(Space.xl)
    }

    private func answer(_ yes: Bool) {
        sending = true
        errorText = nil
        Task {
            do {
                try await model.answerInquiry(inquiry, yes: yes)
                dismiss()
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't send your answer. Try again."
            }
            sending = false
        }
    }
}
