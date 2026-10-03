import SwiftUI

struct AskRoute: Hashable, Identifiable {
    var ask: Ask

    var id: String { ask.id }
}

/// 1 Ask: what you want and what it usually goes for, live status, what you'd offer, the most
/// cash you'd add, which deals to bring you, and Cancel. Every change saves right away and
/// rolls back if the save fails.
struct AskDetailView: View {
    var askID: String
    /// Shown when the Ask isn't in the list yet, for example straight from a GM card.
    var fallback: Ask?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ceiling: Double = 0
    @State private var isDraggingCeiling = false
    @State private var confirmCancel = false
    @State private var toggles = 0

    static let ceilingStep = 500
    static let ceilingMax = 20_000

    private var ask: Ask? { model.asks.first { $0.id == askID } ?? fallback }
    /// Edits need the Ask in the list, and an open status.
    private var canEdit: Bool { model.asks.contains { $0.id == askID } && ask?.isOpen == true }

    private let columns = [
        GridItem(.flexible(), spacing: Space.md),
        GridItem(.flexible(), spacing: Space.md),
    ]

    var body: some View {
        ScrollView {
            if let ask {
                VStack(alignment: .leading, spacing: Space.xl) {
                    header(ask)
                    anchor(ask)
                    AskStatusRow(ask: ask)
                    offerSet(ask)
                    cashCeiling(ask)
                    autonomy(ask)
                    if ask.isOpen {
                        cancelButton
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.top, Space.xs)
                .padding(.bottom, Space.tabBarClearance)
            } else {
                Text("This Ask is gone.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Space.huge)
            }
        }
        .scrollIndicators(.hidden)
        .background(Palette.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .quietBanner()
        .sensoryFeedback(.selection, trigger: toggles)
        .onChange(of: ask?.cashCeilingCents, initial: true) { _, cents in
            guard !isDraggingCeiling, let cents else { return }
            ceiling = Double(cents)
        }
        .confirmationDialog("Cancel this Ask?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel Ask", role: .destructive) {
                model.cancelAsk(askID)
                dismiss()
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Your GM stops looking. You can always ask again.")
        }
    }

    // MARK: Sections

    private func header(_ ask: Ask) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Your Ask").sectionLabel()
            Text(ask.displayTitle)
                .font(Typo.title)
                .tracking(-0.4)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            if !ask.rawText.isEmpty, ask.rawText != ask.displayTitle {
                Text("You said \u{201C}\(ask.rawText)\u{201D}")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }
            if let constraints = ask.target?.constraints, !constraints.isEmpty {
                FlowRow(spacing: Space.xs) {
                    ForEach(constraints, id: \.self) { constraint in
                        Pill(text: constraint, tint: Palette.receive)
                    }
                }
                .padding(.top, Space.xxs)
            }
        }
    }

    private func anchor(_ ask: Ask) -> some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Usually goes for").sectionLabel()
                if let range = ask.usedRange {
                    Text(range.label)
                        .font(Typo.valueLarge)
                        .foregroundStyle(Palette.ink)
                    ValueRangeBar(range: range, tint: Palette.receive)
                    Text(ask.retailCents.map { "Used. About \(Money.dollars($0)) new." } ?? "Used, in this condition.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                } else {
                    PricingPlaceholder()
                    Text("Your GM is still pricing this.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                }
            }
        }
    }

    private func offerSet(_ ask: Ask) -> some View {
        let candidates = offerCandidates(ask)
        return VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "What you'd offer", trailing: offerValueLabel(ask))
            if candidates.isEmpty {
                PaperCard {
                    Text("Nothing on your Shelf to offer yet. Add a few things and your GM can use them.")
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(canEdit ? "Tap to include or leave out." : "What your GM is offering.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
                    .padding(.horizontal, 4)
                LazyVGrid(columns: columns, spacing: Space.md) {
                    ForEach(candidates) { item in
                        offerCard(item, isIncluded: ask.offerItemIds.contains(item.id))
                    }
                }
            }
        }
    }

    private func offerCard(_ item: ShelfItem, isIncluded: Bool) -> some View {
        Button {
            toggle(item.id)
        } label: {
            ItemCard(item: item)
                .overlay(alignment: .topTrailing) {
                    Image(systemName: isIncluded ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 24, weight: .semibold))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(isIncluded ? Color.white : Palette.inkTertiary, isIncluded ? Palette.give : Palette.surface)
                        .padding(Space.sm)
                        .contentTransition(.symbolEffect(.replace))
                }
                .overlay {
                    if isIncluded {
                        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                            .strokeBorder(Palette.give, lineWidth: 2)
                    }
                }
                .opacity(isIncluded ? 1 : 0.6)
                .animation(Motion.snappy, value: isIncluded)
        }
        .buttonStyle(.pressable)
        .disabled(!canEdit)
        .accessibilityValue(isIncluded ? "Included" : "Left out")
    }

    private func cashCeiling(_ ask: Ask) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Cash Throw-In")
            PaperCard {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text(Self.ceilingLabel(Int(ceiling)))
                        .font(Typo.valueLarge)
                        .foregroundStyle(Palette.ink)
                        .contentTransition(.numericText())
                        .animation(Motion.snappy, value: ceiling)
                    Slider(
                        value: $ceiling,
                        in: 0...Double(max(Self.ceilingMax, ask.cashCeilingCents)),
                        step: Double(Self.ceilingStep),
                        onEditingChanged: { editing in
                            isDraggingCeiling = editing
                            if !editing { commitCeiling() }
                        }
                    )
                    .tint(Palette.gold)
                    .disabled(!canEdit)
                    .accessibilityValue(Self.ceilingLabel(Int(ceiling)))
                    Text("The most cash your GM can add to even out a trade. It's never shown to anyone else.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .sensoryFeedback(.selection, trigger: Int(ceiling) / Self.ceilingStep)
        }
    }

    private func autonomy(_ ask: Ask) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Which deals to bring you")
            VStack(spacing: Space.xs) {
                ForEach(AutonomyLevel.allCases, id: \.self) { level in
                    AutonomyOption(level: level, isSelected: ask.autonomy == level) {
                        guard canEdit, ask.autonomy != level else { return }
                        model.updateAsk(askID, AskPatch(autonomy: level))
                    }
                    .disabled(!canEdit)
                }
            }
            Text("Your GM never approves a trade for you.")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkTertiary)
                .padding(.horizontal, 4)
        }
    }

    private var cancelButton: some View {
        Button(role: .destructive) {
            confirmCancel = true
        } label: {
            Text("Cancel Ask")
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity)
                .frame(height: 36)
        }
        .buttonStyle(.glass)
        .tint(Palette.danger)
        .disabled(!canEdit)
    }

    // MARK: Logic

    /// "Up to $20", or "No cash" at 0.
    static func ceilingLabel(_ cents: Int) -> String {
        cents <= 0 ? "No cash" : "Up to \(Money.dollars(cents))"
    }

    /// What you could offer: Items on your Shelf that are free to trade, plus anything
    /// already in the offer. Offered Items first.
    private func offerCandidates(_ ask: Ask) -> [ShelfItem] {
        var pool = model.shelf
        if pool.isEmpty, !model.isLive {
            pool = DemoData.shelf
        }
        let offered = ask.offerItemIds.compactMap { id in pool.first { $0.id == id } }
        let others = pool.filter { item in
            !ask.offerItemIds.contains(item.id)
                && item.status == .onShelf
                && !item.isReserved
                && item.willingness != .notAvailable
        }
        return offered + others
    }

    private func offerValueLabel(_ ask: Ask) -> String? {
        let pool = model.shelf.isEmpty && !model.isLive ? DemoData.shelf : model.shelf
        let values = pool.filter { ask.offerItemIds.contains($0.id) }.compactMap(\.value)
        if !values.isEmpty {
            let low = values.reduce(0) { $0 + $1.lowCents }
            let high = values.reduce(0) { $0 + $1.highCents }
            return "About \(Money.range(low: low, high: high))"
        }
        if let value = ask.offerValue, !ask.offerItemIds.isEmpty {
            return "About \(Money.range(low: value.lowCents, high: value.highCents))"
        }
        return nil
    }

    private func toggle(_ itemID: String) {
        guard canEdit, let ask else { return }
        var ids = ask.offerItemIds
        if let index = ids.firstIndex(of: itemID) {
            ids.remove(at: index)
        } else {
            ids.append(itemID)
        }
        toggles += 1
        model.updateAsk(askID, AskPatch(offerItemIds: ids))
    }

    private func commitCeiling() {
        guard canEdit, let ask else { return }
        let cents = Int(ceiling.rounded()) / Self.ceilingStep * Self.ceilingStep
        guard cents != ask.cashCeilingCents else { return }
        model.updateAsk(askID, AskPatch(cashCeilingCents: cents))
    }
}
