import SwiftUI

struct AskRoute: Hashable, Identifiable {
    var ask: Ask

    var id: String { ask.id }
}

/// 1 Ask, top to bottom in the order you'd think about it: what you want (a labeled reference
/// photo, never someone's actual Item), what it usually goes for in 1 line, what your GM is
/// doing, then your terms. The terms are 1 decision with live feedback: your GM says whether
/// the offer can land as you tap Items and drag the cash, and points at a better Item when it
/// sees 1. Which deals to bring you lives in Settings, for every Ask. Every change saves right
/// away and rolls back if the save fails.
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
    @State private var openDeal: DealSheet?

    static let ceilingStep = 500
    static let ceilingMax = 20_000

    private var ask: Ask? { model.asks.first { $0.id == askID } ?? fallback }
    /// Edits need the Ask in the list, and an open status.
    private var canEdit: Bool { model.asks.contains { $0.id == askID } && ask?.isOpen == true }

    private var shelfPool: [ShelfItem] {
        model.shelf.isEmpty && !model.isLive ? DemoData.shelf : model.shelf
    }

    var body: some View {
        ScrollView {
            if let ask {
                VStack(alignment: .leading, spacing: Space.xl) {
                    VStack(alignment: .leading, spacing: Space.lg) {
                        AskTargetHero(ask: ask)
                        header(ask)
                    }
                    VStack(alignment: .leading, spacing: Space.sm) {
                        AskStatusRow(ask: ask)
                        if let deal = waitingDeal(for: ask) {
                            DealWaitingRow(deal: deal) { openDeal = deal }
                                .transition(.blurReplace)
                        }
                    }
                    terms(ask)
                    if ask.isOpen {
                        cancelButton
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.top, Space.xs)
                .padding(.bottom, Space.tabBarClearance)
                .animation(Motion.soft, value: ask.status)
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
        .fullScreenCover(item: $openDeal) { deal in
            DealSheetView(deal: deal)
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

    // MARK: What you want

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
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let constraints = ask.target?.constraints, !constraints.isEmpty {
                FlowRow(spacing: Space.xs) {
                    ForEach(constraints, id: \.self) { constraint in
                        Pill(text: constraint, tint: Palette.receive)
                    }
                }
                .padding(.top, Space.xxs)
            }
            priceLine(ask)
                .padding(.top, Space.xxs)
        }
    }

    /// What it usually goes for, in 1 quiet line. The offer card below does the comparing.
    @ViewBuilder
    private func priceLine(_ ask: Ask) -> some View {
        if let range = ask.usedRange {
            (Text("Usually ") + Text(range.label).foregroundStyle(Palette.ink).fontWeight(.semibold)
                + Text(ask.retailCents.map { " used, about \(Money.dollars($0)) new" } ?? " used"))
                .font(Typo.callout.monospacedDigit())
                .foregroundStyle(Palette.inkSecondary)
        } else {
            Text("Your GM is still pricing this.")
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
                .loopShimmer()
        }
    }

    // MARK: Your terms

    private func terms(_ ask: Ask) -> some View {
        let candidates = offerCandidates(ask)
        let offered = candidates.filter { ask.offerItemIds.contains($0.id) }
        let fit = OfferFit(
            target: ask.usedRange,
            offered: offered,
            shelf: shelfPool,
            ceilingCents: Int(ceiling)
        )
        return VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Your offer")
            OfferFitCard(fit: fit, cashCents: Int(ceiling), canEdit: canEdit) { suggestion in
                toggle(suggestion.id)
            }
            .animation(Motion.snappy, value: fit)

            if candidates.isEmpty {
                PaperCard {
                    Text("Nothing on your Shelf to offer yet. Add a few things and your GM can use them.")
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(canEdit ? "Tap what you'd give up. Any 1 of these can go in a trade." : "What your GM is offering.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
                    .padding(.horizontal, 4)
                    .padding(.top, Space.xs)
                VStack(spacing: Space.xs) {
                    ForEach(candidates) { item in
                        OfferRow(
                            item: item,
                            isIncluded: ask.offerItemIds.contains(item.id),
                            verdict: ask.usedRange.flatMap {
                                OfferFit.verdict(for: item, target: $0, ceilingCents: Int(ceiling))
                            },
                            isSuggested: fit.suggestion?.id == item.id
                        ) {
                            toggle(item.id)
                        }
                        .disabled(!canEdit)
                    }
                }
                .animation(Motion.snappy, value: ask.offerItemIds)
            }

            cashCeiling(ask)
                .padding(.top, Space.xs)
            howMany(ask)
        }
    }

    /// How many Items the Ask takes. Above 1, 1 trade can bring several from 1 person.
    private func howMany(_ ask: Ask) -> some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("How many you'd take").sectionLabel()
                        Text(ask.maxItems == 1 ? "Just 1" : "Up to \(ask.maxItems)")
                            .font(Typo.value)
                            .foregroundStyle(Palette.ink)
                            .contentTransition(.numericText())
                            .animation(Motion.snappy, value: ask.maxItems)
                    }
                    Spacer()
                    Stepper(
                        "How many you'd take",
                        value: Binding(
                            get: { ask.maxItems },
                            set: { model.updateAsk(askID, AskPatch(maxItems: $0)) }
                        ),
                        in: 1...5
                    )
                    .labelsHidden()
                    .disabled(!canEdit)
                    .accessibilityValue(ask.maxItems == 1 ? "Just 1" : "Up to \(ask.maxItems)")
                }
                Text("More than 1 lets 1 trade bring you several, like 2 games for 1 set.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sensoryFeedback(.selection, trigger: ask.maxItems)
    }

    private func cashCeiling(_ ask: Ask) -> some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Cash you'd add").sectionLabel()
                    Spacer()
                    Text(Self.ceilingLabel(Int(ceiling)))
                        .font(Typo.value)
                        .foregroundStyle(Palette.ink)
                        .contentTransition(.numericText())
                        .animation(Motion.snappy, value: ceiling)
                }
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
                .accessibilityLabel("Cash you'd add")
                .accessibilityValue(Self.ceilingLabel(Int(ceiling)))
                Text("The most your GM can add to even out a trade. Never shown to anyone.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sensoryFeedback(.selection, trigger: Int(ceiling) / Self.ceilingStep)
    }

    private var cancelButton: some View {
        Button(role: .destructive) {
            confirmCancel = true
        } label: {
            Text("Cancel Ask")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.danger)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canEdit)
    }

    // MARK: Logic

    /// "Up to $20", or "No cash" at 0.
    static func ceilingLabel(_ cents: Int) -> String {
        cents <= 0 ? "No cash" : "Up to \(Money.dollars(cents))"
    }

    /// The Deal waiting on you that would fill this Ask, if there is 1.
    private func waitingDeal(for ask: Ask) -> DealSheet? {
        model.dealsWaiting.first { $0.askID == ask.id && $0.myApproval == .pending }
    }

    /// What you could offer: Items on your Shelf that are free to trade, plus anything
    /// already in the offer. Offered Items first, then the closest in value to the target.
    private func offerCandidates(_ ask: Ask) -> [ShelfItem] {
        let pool = shelfPool
        let offered = ask.offerItemIds.compactMap { id in pool.first { $0.id == id } }
        var others = pool.filter { item in
            !ask.offerItemIds.contains(item.id)
                && item.status == .onShelf
                && !item.isReserved
                && item.willingness != .notAvailable
        }
        if let target = ask.usedRange?.midCents {
            others.sort {
                abs(($0.value?.midCents ?? 0) - target) < abs(($1.value?.midCents ?? 0) - target)
            }
        }
        return offered + others
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

// MARK: - Hero

/// What you want, big. A product photo from the web stands for the thing itself, so it's
/// labeled as a reference: the real Item's photos only ever show on a Deal Sheet.
struct AskTargetHero: View {
    var ask: Ask

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        ZStack {
            if let raw = ask.target?.imageUrl, let url = URL(string: raw) {
                Color.white
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit().padding(Space.lg)
                            .transition(.opacity)
                    } else if phase.error != nil {
                        placeholder
                    } else {
                        Color.white
                    }
                }
            } else {
                placeholder
            }
        }
        .aspectRatio(4.0 / 3.0, contentMode: .fit)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .overlay(alignment: .bottomLeading) {
            if ask.target?.imageUrl != nil {
                Text("Reference photo")
                    .font(Typo.caption)
                    .foregroundStyle(Palette.inkSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.9), in: Capsule())
                    .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                    .padding(Space.sm)
            }
        }
        .shadow(color: .black.opacity(0.06), radius: 20, y: 8)
        .accessibilityLabel(ask.target?.imageUrl != nil ? "Reference photo of \(ask.displayTitle)" : ask.displayTitle)
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [Palette.receive.opacity(0.2), Palette.receive.opacity(0.06)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            AskTargetThumb(ask: ask, size: 120)
                .opacity(0.9)
        }
    }
}

// MARK: - Offer fit

/// The GM's read on the offer: 1 or 2 sentences, the 2 ranges on 1 scale, and a better Item
/// to add when it sees 1.
struct OfferFitCard: View {
    var fit: OfferFit
    var cashCents: Int
    var canEdit: Bool
    var onAdd: (ShelfItem) -> Void

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .top, spacing: Space.sm) {
                    GMOrbView(mood: .idle, size: 26, showsGlow: false)
                    Text(fit.line)
                        .font(Typo.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .id(fit.line)
                        .transition(.opacity)
                }
                if let target = fit.target {
                    FitBars(target: target, best: fit.best?.value, cashCents: cashCents, mood: fit.mood)
                }
                if let suggestion = fit.suggestion, canEdit {
                    Button {
                        onAdd(suggestion)
                    } label: {
                        HStack(spacing: Space.xs) {
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .bold))
                            Text("Offer your \(OfferFit.shortName(suggestion.title))")
                                .lineLimit(1)
                            if let value = suggestion.value {
                                Text(value.label)
                                    .foregroundStyle(Palette.inkSecondary)
                                    .monospacedDigit()
                            }
                        }
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, Space.md)
                        .frame(height: 40)
                    }
                    .buttonStyle(.glass)
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }
        }
    }
}

/// What it goes for (cool) against your best Item (warm), plus how far your cash stretches
/// it (gold), on 1 scale.
struct FitBars: View {
    var target: ValueRange
    var best: ValueRange?
    var cashCents: Int
    var mood: OfferFit.Mood

    var body: some View {
        let reach = (best?.highCents ?? 0) + cashCents
        let scale = Double(max(target.highCents, reach, 1)) * 1.08
        VStack(alignment: .leading, spacing: Space.sm) {
            row(label: "It goes for", detail: target.label) { width in
                band(low: target.lowCents, high: target.highCents, scale: scale, width: width, color: Palette.receive)
            }
            row(label: "Your best", detail: bestDetail) { width in
                ZStack(alignment: .leading) {
                    if let best {
                        if cashCents > 0 {
                            band(low: best.highCents, high: best.highCents + cashCents, scale: scale, width: width, color: Palette.gold.opacity(0.55))
                        }
                        band(low: best.lowCents, high: best.highCents, scale: scale, width: width, color: Palette.give)
                    }
                }
            }
        }
        .animation(Motion.snappy, value: best)
        .animation(Motion.snappy, value: cashCents)
        .accessibilityElement(children: .combine)
    }

    private var bestDetail: String {
        guard let best else { return "Nothing yet" }
        return cashCents > 0 ? "\(best.label) + \(Money.dollars(cashCents))" : best.label
    }

    private func row<Bar: View>(label: String, detail: String, @ViewBuilder bar: @escaping (CGFloat) -> Bar) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).sectionLabel()
                Spacer()
                Text(detail)
                    .font(Typo.caption.monospacedDigit())
                    .foregroundStyle(Palette.inkSecondary)
                    .contentTransition(.numericText())
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.hairline)
                    bar(proxy.size.width)
                }
            }
            .frame(height: 8)
        }
    }

    private func band(low: Int, high: Int, scale: Double, width: CGFloat, color: Color) -> some View {
        let lowX = width * Double(low) / scale
        let highX = width * Double(high) / scale
        return Capsule()
            .fill(color)
            .frame(width: max(8, highX - lowX), height: 8)
            .offset(x: lowX)
    }
}

/// 1 thing you could give up: photo, name, value, how it does on its own, and a checkmark.
struct OfferRow: View {
    var item: ShelfItem
    var isIncluded: Bool
    var verdict: OfferFit.Verdict?
    var isSuggested: Bool
    var onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: Space.sm) {
                ItemArtwork(item: item, cornerRadius: 14, symbolScale: 0.4, studio: item.studioAllowed ? .ifReady : .off)
                    .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        if let value = item.value {
                            Text(value.label)
                                .font(Typo.footnote.monospacedDigit())
                                .foregroundStyle(Palette.inkSecondary)
                        } else if item.isPricing {
                            Text("Pricing")
                                .font(Typo.footnote)
                                .foregroundStyle(Palette.inkSecondary)
                                .loopShimmer()
                        }
                        if isSuggested {
                            Pill(text: "GM pick", symbol: "sparkles", tint: Palette.iris)
                        } else if let tag {
                            Pill(text: tag.text, tint: tag.tint)
                        }
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: isIncluded ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 26, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(isIncluded ? Color.white : Palette.inkTertiary, isIncluded ? Palette.give : Palette.surface)
                    .contentTransition(.symbolEffect(.replace))
            }
            .padding(Space.sm)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(isIncluded ? Palette.give : Palette.hairline, lineWidth: isIncluded ? 2 : 1)
            }
            .opacity(isIncluded ? 1 : 0.85)
        }
        .buttonStyle(.pressable)
        .accessibilityValue(isIncluded ? "Included" : "Left out")
    }

    private var tag: (text: String, tint: Color)? {
        switch verdict {
        case .fits: ("Covers it", Palette.mint)
        case let .fitsWithCash(cents): ("+ about \(Money.dollars(cents))", Palette.gold)
        case .worthMore: ("Worth more", Palette.receive)
        case .short: ("Too low", Palette.inkTertiary)
        case .pricing, .empty, nil: nil
        }
    }
}

/// A Deal Sheet waiting on you that fills this Ask.
struct DealWaitingRow: View {
    var deal: DealSheet
    var onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: Space.sm) {
                if let item = deal.receive.first {
                    ItemArtwork(item: item, cornerRadius: 14)
                        .frame(width: 52, height: 52)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Found 1. Your Deal Sheet is ready.")
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                    Text(deal.getTitle.map { "\($0), real photos inside" } ?? "Real photos inside")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.inkTertiary)
            }
            .padding(Space.sm)
            .background(Palette.receive.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        }
        .buttonStyle(.pressable)
    }
}
