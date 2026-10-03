import SwiftUI

/// Item detail: the photo (scanned once on arrival), what the GM thinks it is, a value range,
/// and the willingness control. Never shows raw confidence scores.
struct ItemDetailView: View {
    var itemID: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var scan = 0
    @State private var confirmRemove = false

    private var item: ShelfItem? { model.shelf.first { $0.id == itemID } }

    var body: some View {
        ScrollView {
            if let item {
                VStack(alignment: .leading, spacing: Space.xl) {
                    ItemArtwork(item: item, cornerRadius: 32, symbolScale: 0.34)
                        .aspectRatio(1, contentMode: .fit)
                        .appraiseScan(trigger: scan, duration: 1.8)
                        .shadow(color: .black.opacity(0.08), radius: 24, y: 12)

                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(item.brand ?? "").sectionLabel()
                        Text(item.title)
                            .font(Typo.title)
                            .tracking(-0.4)
                            .foregroundStyle(Palette.ink)
                        HStack(spacing: Space.xs) {
                            if let grade = item.conditionGrade {
                                GradeChip(grade: grade)
                            }
                            Pill(text: item.confidenceLabel, symbol: "sparkles", tint: Palette.iris)
                        }
                    }

                    if let value = item.value {
                        PaperCard {
                            VStack(alignment: .leading, spacing: Space.md) {
                                Text("Worth about").sectionLabel()
                                Text(value.label)
                                    .font(Typo.valueLarge)
                                    .foregroundStyle(Palette.ink)
                                ValueRangeBar(range: value, tint: ArtworkStyle(category: item.category).tint)
                                Text("Based on 3 similar listings and 2 recent trades. Ranges, not prices: the final number is whatever you both agree on.")
                                    .font(Typo.footnote)
                                    .foregroundStyle(Palette.inkSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Would you trade it?")
                        WillingnessPicker(selection: willingnessBinding(for: item))
                    }

                    Button(role: .destructive) {
                        confirmRemove = true
                    } label: {
                        Text("Remove from Shelf")
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .frame(height: 36)
                    }
                    .buttonStyle(.glass)
                    .tint(Palette.danger)
                    .confirmationDialog("Remove \(item.title)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                        Button("Remove", role: .destructive) {
                            dismiss()
                            Task {
                                try? await Task.sleep(for: .milliseconds(350))
                                model.removeItem(item.id)
                            }
                        }
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.tabBarClearance)
            }
        }
        .scrollIndicators(.hidden)
        .background(Palette.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            try? await Task.sleep(for: .milliseconds(280))
            scan += 1
        }
    }

    private func willingnessBinding(for item: ShelfItem) -> Binding<Willingness> {
        Binding(
            get: { model.shelf.first { $0.id == item.id }?.willingness ?? item.willingness },
            set: { model.setWillingness($0, for: item.id) }
        )
    }
}

/// 3-way segmented control with a sliding glass thumb.
struct WillingnessPicker: View {
    @Binding var selection: Willingness
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Willingness.allCases, id: \.self) { option in
                let isSelected = option == selection
                Button {
                    withAnimation(Motion.bouncy) { selection = option }
                } label: {
                    HStack(spacing: 6) {
                        WillingnessDot(willingness: option)
                        Text(option.label)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(isSelected ? Palette.ink : Palette.inkSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .background {
                        if isSelected {
                            Capsule()
                                .fill(Palette.surface)
                                .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Palette.ink.opacity(0.06), in: Capsule())
        .sensoryFeedback(.selection, trigger: selection)
    }
}
