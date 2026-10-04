import SwiftUI

// Native cards for the GM's UI components (docs/contracts/m2-gm-and-asks.md). The server
// fills every price, photo and status; these views only lay them out.

// MARK: - Chip

/// A big glass answer chip. Selected chips fill with iris.
struct GMChip: View {
    var label: String
    var isSelected: Bool = false
    var showsCheck: Bool = false
    var isEnabled: Bool = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if showsCheck {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 15, weight: .bold))
                        .contentTransition(.symbolEffect(.replace))
                }
                Text(label)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
            }
            .foregroundStyle(isSelected ? Color.white : Palette.ink)
            .padding(.horizontal, Space.lg)
            .frame(minHeight: 46)
        }
        .buttonStyle(.plain)
        .glassEffect(isSelected ? Glass.regular.tint(Palette.iris).interactive() : Glass.regular.interactive(), in: .capsule)
        .disabled(!isEnabled)
        .opacity(isEnabled || isSelected ? 1 : 0.45)
        .animation(Motion.snappy, value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Choices

/// `choices`: 1 tap answers. With `multiple`, chips toggle and Done sends them together.
struct ChoicesComponentView: View {
    var data: ChoicesData
    /// nil while open. Once answered, the picked options stay lit.
    var answer: [String]?
    var isEnabled: Bool
    var onAnswer: (_ optionIDs: [String], _ echo: String) -> Void

    @State private var picked: [String] = []
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if !data.prompt.isEmpty {
                Text(data.prompt)
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }
            FlowRow(spacing: Space.xs) {
                ForEach(Array(data.options.enumerated()), id: \.element.id) { index, option in
                    GMChip(
                        label: option.label,
                        isSelected: selection.contains(option.id),
                        showsCheck: data.multiple && answer == nil,
                        isEnabled: isOpen
                    ) {
                        tap(option)
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 10)
                    .animation(Motion.bouncy.delay(Double(index) * 0.06), value: appeared)
                }
            }
            if data.multiple, answer == nil {
                Button {
                    send(picked)
                } label: {
                    Text("Done")
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.canvas)
                        .padding(.horizontal, Space.xl)
                        .frame(height: 40)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .disabled(picked.isEmpty || !isEnabled)
                .transition(.opacity)
            }
        }
        .sensoryFeedback(.selection, trigger: picked)
        .onAppear { appeared = true }
    }

    private var isOpen: Bool { answer == nil && isEnabled }

    private var selection: [String] { answer ?? picked }

    private func tap(_ option: ChoiceOption) {
        guard isOpen else { return }
        if data.multiple {
            withAnimation(Motion.snappy) {
                if let index = picked.firstIndex(of: option.id) {
                    picked.remove(at: index)
                } else {
                    picked.append(option.id)
                }
            }
        } else {
            send([option.id])
        }
    }

    private func send(_ ids: [String]) {
        guard isOpen, !ids.isEmpty else { return }
        let labels = data.options.filter { ids.contains($0.id) }.map(\.label)
        onAnswer(ids, labels.formatted(.list(type: .and)))
    }
}

// MARK: - Item cards

/// `item_cards`: a row of Item cards. When selectable, a tap toggles a check and Confirm
/// sends the picked Item IDs.
struct ItemCardsComponentView: View {
    var data: ItemCardsData
    var answer: [String]?
    var isEnabled: Bool
    var onConfirm: (_ itemIDs: [String], _ echo: String) -> Void

    @State private var picked: Set<String> = []
    @State private var seeded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: Space.sm) {
                    ForEach(Array(data.items.enumerated()), id: \.element.id) { index, entry in
                        card(entry, index: index)
                    }
                }
                .padding(.vertical, Space.xs)
            }
            .scrollIndicators(.hidden)
            .scrollClipDisabled()

            if data.selectable, answer == nil {
                Button(action: confirm) {
                    Text(picked.isEmpty ? "Confirm" : "Confirm \(picked.count)")
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.canvas)
                        .padding(.horizontal, Space.xl)
                        .frame(height: 40)
                        .contentTransition(.numericText())
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .disabled(picked.isEmpty || !isEnabled)
                .animation(Motion.snappy, value: picked.count)
            }
        }
        .sensoryFeedback(.selection, trigger: picked)
        .onAppear {
            guard !seeded else { return }
            seeded = true
            picked = Set(data.selectedIds)
        }
    }

    private func card(_ entry: GMItem, index: Int) -> some View {
        let isPicked = selection.contains(entry.id)
        return VStack(alignment: .leading, spacing: 6) {
            ItemCard(item: entry.item, scanTrigger: 1, scanDelay: Double(index) * 0.12)
                .overlay(alignment: .topTrailing) {
                    if data.selectable {
                        Image(systemName: isPicked ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 24, weight: .semibold))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(isPicked ? Color.white : Palette.inkTertiary, isPicked ? Palette.give : Palette.surface)
                            .background(Circle().fill(Palette.surface.opacity(isPicked ? 0 : 0.85)))
                            .padding(Space.sm)
                            .contentTransition(.symbolEffect(.replace))
                            .accessibilityHidden(true)
                    }
                }
                .overlay {
                    if data.selectable, isPicked {
                        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                            .strokeBorder(Palette.give, lineWidth: 2)
                    }
                }
                .opacity(data.selectable && !isPicked && answer != nil ? 0.45 : 1)
            if let owner = entry.ownerFirstName, !owner.isEmpty {
                Text("\(owner)'s Shelf")
                    .font(Typo.caption)
                    .foregroundStyle(Palette.inkSecondary)
                    .padding(.horizontal, Space.xs)
            }
        }
        .frame(width: 168)
        .contentShape(Rectangle())
        .onTapGesture { toggle(entry.id) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(data.selectable ? [.isButton] : [])
        .accessibilityValue(data.selectable ? (isPicked ? "Included" : "Not included") : "")
        .animation(Motion.snappy, value: isPicked)
    }

    private var selection: Set<String> {
        if let answer {
            return Set(answer.isEmpty ? data.selectedIds : answer)
        }
        return picked
    }

    private func toggle(_ id: String) {
        guard data.selectable, answer == nil, isEnabled else { return }
        if picked.contains(id) {
            picked.remove(id)
        } else {
            picked.insert(id)
        }
    }

    private func confirm() {
        let ids = data.items.map(\.id).filter { picked.contains($0) }
        guard !ids.isEmpty, isEnabled else { return }
        let titles = data.items.filter { picked.contains($0.id) }.map(\.item.title)
        onConfirm(ids, titles.formatted(.list(type: .and)))
    }
}

// MARK: - Camera request

/// `camera_request`: what the GM wants a photo of, and a button that opens the camera.
struct CameraRequestCard: View {
    var data: CameraRequestData
    var isEnabled: Bool
    var onOpen: () -> Void

    var body: some View {
        PaperCard(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .top, spacing: Space.sm) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Palette.tangerine)
                        .frame(width: 38, height: 38)
                        .background(Palette.tangerine.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Text(data.instruction)
                        .font(Typo.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button(action: onOpen) {
                    PrimaryLabel("Open the camera", symbol: "camera.viewfinder")
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .disabled(!isEnabled)
            }
        }
    }
}

// MARK: - Ask card

/// `ask_card`: a compact Ask. A tap opens the Ask detail.
struct AskChatCard: View {
    var ask: Ask
    var onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            PaperCard(padding: Space.md) {
                VStack(alignment: .leading, spacing: Space.sm) {
                    HStack {
                        Text("Your Ask").sectionLabel()
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Palette.inkTertiary)
                    }
                    HStack(alignment: .top, spacing: Space.sm) {
                        AskTargetThumb(ask: ask, size: 56)
                        Text(ask.displayTitle)
                            .font(Typo.headline)
                            .foregroundStyle(Palette.ink)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    if let range = ask.usedRange {
                        Text("Usually \(range.label) used")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkSecondary)
                        ValueRangeBar(range: range, tint: Palette.receive, showsLabels: false)
                    }
                    AskStatusRow(ask: ask)
                }
            }
        }
        .buttonStyle(.pressable)
        .accessibilityHint("Opens the Ask")
    }
}

/// What the Ask is for, at a glance: a reference photo of the product when the GM found
/// one, else an icon for its category. Tinted Pool, the "get" side.
struct AskTargetThumb: View {
    var ask: Ask
    var size: CGFloat

    private var symbol: String {
        let c = (ask.target?.category ?? "").lowercased()
        if c.contains("sneaker") || c.contains("shoe") { return "shoe.fill" }
        if c.contains("card") { return "rectangle.portrait.on.rectangle.portrait.fill" }
        if c.contains("lego") || c.contains("toy") { return "puzzlepiece.fill" }
        if c.contains("game") { return "gamecontroller.fill" }
        if c.contains("bag") || c.contains("apparel") { return "handbag.fill" }
        if c.contains("book") || c.contains("media") { return "book.closed.fill" }
        if c.contains("electronic") || c.contains("console") { return "desktopcomputer" }
        return "sparkles"
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        ZStack {
            shape.fill(Palette.receive.opacity(0.12))
            if let raw = ask.target?.imageUrl, let url = URL(string: raw) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        // Product shots come on all sorts of backgrounds: fit, on white.
                        image.resizable().scaledToFit().padding(size * 0.08).background(.white)
                    } else {
                        icon
                    }
                }
            } else {
                icon
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private var icon: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(Palette.receive)
    }
}

/// The live status in plain words, with the Loop indicator while the GM is looking.
/// The line cross-fades when it changes.
struct AskStatusRow: View {
    var ask: Ask
    var line: String?

    var body: some View {
        let text = line ?? ask.displayStatusLine
        HStack(spacing: Space.sm) {
            LoopIndicator(people: 3, size: 22, isActive: ask.status.isLooking)
            ZStack(alignment: .leading) {
                Text(text)
                    .id(text)
                    .transition(.opacity.combined(with: .offset(y: 6)))
            }
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(Palette.ink)
            .animation(Motion.soft, value: text)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.sm)
        .frame(minHeight: 44)
        .background(Palette.canvas, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
    }
}

// MARK: - Recap

/// `recap`: what the GM heard in 1 paragraph, 3 sample decisions, and 2 chips to confirm or fix.
struct RecapCard: View {
    var data: RecapData
    var answer: [String]?
    var isEnabled: Bool
    var onAnswer: (_ optionID: String, _ echo: String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            PaperCard(padding: Space.lg) {
                VStack(alignment: .leading, spacing: Space.md) {
                    Text("What I heard").sectionLabel()
                    Text(data.paragraph)
                        .font(Typo.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if !data.sampleDecisions.isEmpty {
                        Divider()
                        Text("How I'd decide").sectionLabel()
                        VStack(alignment: .leading, spacing: Space.sm) {
                            ForEach(Array(data.sampleDecisions.prefix(3).enumerated()), id: \.offset) { _, decision in
                                DecisionRow(decision: decision)
                            }
                        }
                    }
                }
            }
            HStack(spacing: Space.xs) {
                GMChip(
                    label: "Looks right",
                    isSelected: answer?.contains(RecapData.looksRight) == true,
                    isEnabled: answer == nil && isEnabled
                ) {
                    onAnswer(RecapData.looksRight, "Looks right")
                }
                GMChip(
                    label: "Fix something",
                    isSelected: answer?.contains(RecapData.fixSomething) == true,
                    isEnabled: answer == nil && isEnabled
                ) {
                    onAnswer(RecapData.fixSomething, "Fix something")
                }
            }
        }
    }
}

private struct DecisionRow: View {
    var decision: SampleDecision

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: decision.isYes ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 20))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(decision.isYes ? Palette.mint : Palette.tangerine)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(decision.give) for \(decision.get)")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.ink)
                if !decision.why.isEmpty {
                    Text(decision.why)
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(decision.isYes ? "Yes" : "No"): \(decision.give) for \(decision.get). \(decision.why)")
    }
}
