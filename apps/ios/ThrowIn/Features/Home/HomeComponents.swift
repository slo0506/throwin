import SwiftUI

// The pieces of Home (docs/specs/home.md): the GM's briefing, the deck of decisions, your
// trades with their tracks, and at most 3 suggestions. Presentational only: HomeView owns
// the data and the actions.

// MARK: - Short names

/// Titles that fit on 1 line and never cut off mid-word: "Insta360 X3" for "Insta360 X3 360
/// Action Camera". Brand and model when we have them, else the title up to its first comma,
/// "with" or parenthesis, at most 4 words.
enum ShortName {
    static func of(title: String, brand: String? = nil, model: String? = nil) -> String {
        if let model = model?.trimmingCharacters(in: .whitespaces), !model.isEmpty, !looksLikePartNumber(model) {
            if let brand = brand?.trimmingCharacters(in: .whitespaces), !brand.isEmpty,
               !model.localizedCaseInsensitiveContains(brand) {
                return "\(brand) \(model)"
            }
            return model
        }
        var text = title
        for separator in [" (", ", ", " with ", " - "] {
            if let range = text.range(of: separator) { text = String(text[..<range.lowerBound]) }
        }
        let words = text.split(separator: " ")
        return words.count > 4 ? words.prefix(4).joined(separator: " ") : text
    }

    /// "CUH-1215A" or "76240" name a part, not something a person would say.
    private static func looksLikePartNumber(_ model: String) -> Bool {
        !model.contains(" ") && model.count >= 5 && model.contains(where: \.isNumber)
            && model.filter(\.isLetter).count <= 4 && model.contains(where: { $0 == "-" || $0.isNumber })
    }
}

extension ShelfItem {
    var shortName: String { ShortName.of(title: title, brand: brand, model: model) }
}

extension Ask {
    var shortName: String { ShortName.of(title: displayTitle, brand: target?.brand, model: target?.model) }
}

// MARK: - Briefing

/// The GM's 1 line under the greeting: what needs you, then what it's doing.
struct Briefing: Equatable {
    var lead: String
    var rest: String
}

struct BriefingHeader: View {
    var firstName: String
    var briefing: Briefing
    var isWorking: Bool
    var onAvatar: () -> Void
    var onGM: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Date.now.formatted(.dateTime.weekday(.wide).month().day()))
                        .sectionLabel()
                    Text("\(greeting), \(firstName)")
                        .font(Typo.title)
                        .tracking(-0.4)
                        .foregroundStyle(Palette.ink)
                }
                Spacer()
                Button(action: onAvatar) {
                    Avatar(person: Person(id: "me", name: firstName, hue: 2, rating: 5, circle: ""), size: 40)
                }
                .buttonStyle(.pressable)
                .accessibilityLabel("You")
            }

            Button(action: onGM) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    GMOrbView(mood: isWorking ? .thinking : .idle, size: 22, showsGlow: false)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
                    Text("\(Text(briefing.lead).font(Typo.bodyEmphasis).foregroundStyle(Palette.ink))\(briefing.rest.isEmpty ? "" : " ")\(Text(briefing.rest).foregroundStyle(Palette.inkSecondary))")
                        .font(Typo.body)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .animation(Motion.soft, value: briefing)
            .accessibilityHint("Talk to your GM")
        }
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: "Morning"
        case 12..<17: "Afternoon"
        default: "Evening"
        }
    }
}

// MARK: - Decision deck

/// What needs you, 1 card at a time with the next peeking, soonest to close first. The deck
/// keeps the same height at 1 decision or 20.
struct DecisionDeck<Card: View>: View {
    var items: [NextUpItem]
    @ViewBuilder var card: (NextUpItem) -> Card

    @State private var current: String?

    private var position: Int {
        (items.firstIndex { $0.id == current } ?? 0) + 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Needs you", trailing: items.count > 1 ? "\(position) of \(items.count)" : nil)
                .padding(.horizontal, Space.gutter)
                .contentTransition(.numericText())
                .animation(Motion.snappy, value: position)

            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: Space.sm) {
                    ForEach(items) { item in
                        card(item)
                            .containerRelativeFrame(.horizontal) { length, _ in
                                length - Space.gutter * 2 - (items.count > 1 ? 22 : 0)
                            }
                            .scrollTransition(axis: .horizontal) { content, phase in
                                content
                                    .scaleEffect(phase.isIdentity ? 1 : 0.95)
                                    .opacity(phase.isIdentity ? 1 : 0.75)
                            }
                            .transition(.opacity.combined(with: .scale(scale: 0.94)))
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, Space.gutter, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $current)
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
            .animation(Motion.bouncy, value: items.map(\.id))
            .sensoryFeedback(.selection, trigger: current)
        }
    }
}

/// The frame every decision shares: a tinted kind chip and the time left, a picture that
/// makes the decision legible, 1 headline, 1 line of context, and 1 button named for what
/// it does. Tapping the picture does the same as the button.
struct DecisionCard<Visual: View, Footer: View>: View {
    var kind: String
    var symbol: String
    var tint: Color
    var timeLeft: String?
    var title: String
    var detail: String?
    /// The Loop-gradient rim: only a Deal waiting on you gets it.
    var isLoud = false
    var onTap: () -> Void
    @ViewBuilder var visual: Visual
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .bold))
                Text(kind)
                    .font(Typo.caption)
                    .tracking(0.6)
                    .textCase(.uppercase)
                Spacer(minLength: 0)
                if let timeLeft {
                    Text(timeLeft)
                        .font(Typo.footnote.monospacedDigit())
                        .foregroundStyle(Palette.inkTertiary)
                }
            }
            .foregroundStyle(tint)

            visual
                .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture(perform: onTap)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.9)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onTap)

            Spacer(minLength: 0)
            footer
        }
        .padding(Space.lg)
        .frame(minHeight: 296, alignment: .top)
        .background {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .fill(Palette.surface)
                .shadow(color: (isLoud ? Palette.iris : .black).opacity(isLoud ? 0.16 : 0.07), radius: 24, y: 10)
                .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
        }
        .overlay {
            if isLoud {
                LoopRim()
            } else {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
        }
    }
}

/// A slow-turning Loop-gradient rim: the 1 loud moment on Home is a Deal waiting on you.
struct LoopRim: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let angle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 6) / 6 * 360
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(
                    AngularGradient(colors: Palette.loop + [Palette.loop[0]], center: .center, angle: .degrees(angle)),
                    lineWidth: 2
                )
        }
        .allowsHitTesting(false)
    }
}

/// The card's 1 button, full width.
struct DecisionButton: View {
    var title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            PrimaryLabel(title)
        }
        .buttonStyle(.glassProminent)
        .tint(Palette.ink)
    }
}

// MARK: - Tiles

/// Items as tiles on their side's tint: warm for what you give, cool for what you get. A
/// bundle fans out a little so you can count it.
struct ItemTileStack: View {
    var items: [ShelfItem]
    var tint: Color
    var size: CGFloat = 76

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(Array(items.prefix(3).enumerated()), id: \.element.id) { index, item in
                ItemArtwork(item: item, cornerRadius: size * 0.24)
                    .frame(width: size, height: size)
                    .overlay {
                        RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                            .strokeBorder(Palette.surface, lineWidth: 3)
                    }
                    .rotationEffect(.degrees(items.count > 1 ? Double(index) * 6 - 3 : 0))
                    .zIndex(Double(items.count - index))
            }
            if items.count > 3 {
                Text("+\(items.count - 3)")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(tint)
                    .frame(width: size * 0.6, height: size * 0.6)
                    .background(Circle().fill(Palette.surface))
            }
        }
        .padding(5)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.24 + 5, style: .continuous))
    }
}

/// You give, you get: warm tiles, an arrow (with the cash on it when there is any), cool tiles.
struct SwapVisual: View {
    var give: [ShelfItem]
    var get: [ShelfItem]
    /// Positive: you pay. Negative: you receive.
    var throwInCents: Int = 0

    var body: some View {
        HStack(spacing: Space.sm) {
            ItemTileStack(items: give, tint: Palette.give)
            VStack(spacing: 4) {
                Image(systemName: "arrow.right")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Palette.inkTertiary)
                if throwInCents != 0 {
                    Text(throwInCents > 0 ? "+\(Money.dollars(throwInCents))" : "−\(Money.dollars(-throwInCents))")
                        .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(Palette.gold)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Palette.gold.opacity(0.14), in: Capsule())
                }
            }
            ItemTileStack(items: get, tint: Palette.receive)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Your trades

/// 1 row per open Ask: what you asked for, where it stands on the 4-step track, and 1 live
/// line in the GM's words.
struct TradeRowModel: Identifiable, Equatable {
    var ask: Ask
    /// 0 looking, 1 found, 2 agreed, 3 done.
    var stage: Int
    var line: String
    /// The GM is working on it right now.
    var isActive: Bool

    var id: String { ask.id }
}

struct TradesCard: View {
    var rows: [TradeRowModel]
    var onOpen: (Ask) -> Void
    var onNewAsk: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Your trades", trailing: rows.isEmpty ? nil : "\(rows.count) live")
                .contentTransition(.numericText())
            VStack(spacing: 0) {
                ForEach(rows) { row in
                    Button { onOpen(row.ask) } label: {
                        TradeRow(row: row)
                    }
                    .buttonStyle(.pressable)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    Divider().overlay(Palette.hairline).padding(.leading, 74)
                }
                Button(action: onNewAsk) {
                    HStack(spacing: Space.sm) {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(Palette.iris)
                            .frame(width: 46, height: 46)
                            .background(Palette.iris.opacity(0.1), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("New Ask")
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .foregroundStyle(Palette.ink)
                            Text("Tell your GM what you want")
                                .font(Typo.footnote)
                                .foregroundStyle(Palette.inkSecondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
            }
            .background {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .fill(Palette.surface)
                    .shadow(color: .black.opacity(0.06), radius: 20, y: 8)
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
            .animation(Motion.bouncy, value: rows.map(\.id))
        }
    }
}

struct TradeRow: View {
    var row: TradeRowModel

    var body: some View {
        HStack(spacing: Space.sm) {
            AskTargetThumb(ask: row.ask, size: 46)
            VStack(alignment: .leading, spacing: 6) {
                Text(row.ask.shortName)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                HStack(spacing: Space.xs) {
                    StageTrack(stage: row.stage, isActive: row.isActive)
                    Text(row.line)
                        .id(row.line)
                        .font(Typo.footnote)
                        .foregroundStyle(row.stage == 1 ? Palette.ink : Palette.inkSecondary)
                        .lineLimit(1)
                        .transition(.opacity.combined(with: .offset(y: 4)))
                }
                .animation(Motion.soft, value: row.line)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Palette.inkTertiary)
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Looking, Found, Agreed, Done, as 4 short bars. The current step breathes while the GM is
/// working on it; a finished trade turns mint.
struct StageTrack: View {
    var stage: Int
    var isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<4, id: \.self) { index in
                Capsule()
                    .fill(color(index))
                    .frame(width: index == stage ? 18 : 10, height: 5)
                    .opacity(index == stage && isActive && !reduceMotion ? 1 : 1)
                    .overlay {
                        if index == stage, isActive, !reduceMotion {
                            Capsule()
                                .fill(Palette.iris)
                                .phaseAnimator([0.35, 1.0]) { content, phase in
                                    content.opacity(phase)
                                } animation: { _ in .easeInOut(duration: 0.9) }
                        }
                    }
            }
        }
        .animation(Motion.bouncy, value: stage)
        .accessibilityLabel(["Looking", "Found", "Agreed", "Done"][max(0, min(3, stage))])
    }

    private func color(_ index: Int) -> Color {
        if stage >= 3 { return Palette.mint }
        if index < stage { return Palette.iris }
        if index == stage { return Palette.iris.opacity(isActive ? 0.25 : 1) }
        return Palette.ink.opacity(0.1)
    }
}

// MARK: - From your GM

/// At most 3 things that would get you more trades, each 1 row with a chevron.
struct SuggestionsCard: View {
    var items: [NextUpItem]
    /// Swaps full titles for short names.
    var shorten: (String, NextUpItem) -> String = { text, _ in text }
    var onTap: (NextUpItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "From your GM")
            VStack(spacing: 0) {
                ForEach(Array(items.prefix(3).enumerated()), id: \.element.id) { index, item in
                    Button { onTap(item) } label: {
                        SuggestionRow(item: item, title: shorten(item.title, item), detail: shorten(item.detail, item))
                    }
                    .buttonStyle(.pressable)
                    if index < min(items.count, 3) - 1 {
                        Divider().overlay(Palette.hairline).padding(.leading, 62)
                    }
                }
            }
            .background {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .fill(Palette.surface)
                    .shadow(color: .black.opacity(0.05), radius: 16, y: 6)
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
            .animation(Motion.bouncy, value: items.map(\.id))
        }
    }
}

struct SuggestionRow: View {
    var item: NextUpItem
    var title: String
    var detail: String

    var body: some View {
        let style = NextUpStyle.of(item.kind)
        HStack(spacing: Space.sm) {
            Image(systemName: style.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(style.tint)
                .frame(width: 34, height: 34)
                .background(style.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(detail)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Palette.inkTertiary)
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(item.cta)
    }
}

/// A symbol and tint per Next up kind, shared by every place that shows 1.
enum NextUpStyle {
    static func of(_ kind: NextUpItem.Kind) -> (symbol: String, tint: Color) {
        switch kind {
        case .answerCounter: ("arrow.left.arrow.right", Palette.gold)
        case .approveDeal: ("arrow.triangle.2.circlepath", Palette.iris)
        case .showcasePhotos: ("camera.fill", Palette.give)
        case .pinDownItem: ("checklist", Palette.give)
        case .answerInquiry: ("questionmark.bubble.fill", Palette.iris)
        case .someoneWants: ("hand.wave.fill", Palette.receive)
        case .offerForAsk: ("hand.point.up.left.fill", Palette.iris)
        case .joinCircle: ("person.3.fill", Palette.receive)
        case .weakOffer: ("scalemass.fill", Palette.gold)
        case .inDemand: ("flame.fill", Palette.give)
        case .tuneUp: ("wand.and.stars", Palette.iris)
        case .itemPhotos: ("camera.aperture", Palette.mint)
        case .addToShelf: ("plus.viewfinder", Palette.give)
        case .newAsk: ("sparkles", Palette.bubblegum)
        }
    }
}

// MARK: - Get started

/// For someone new, in place of the deck: the 3 steps to a first trade, each 1 tap.
struct GetStartedCard: View {
    var hasShelf: Bool
    var hasAsk: Bool
    var hasCircle: Bool
    var onShelf: () -> Void
    var onAsk: () -> Void
    var onCircle: () -> Void

    private var done: Int { [hasShelf, hasAsk, hasCircle].filter { $0 }.count }

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack {
                    Text("3 steps to your first trade")
                        .font(Typo.headline)
                        .foregroundStyle(Palette.ink)
                    Spacer()
                    Text("\(done) of 3")
                        .font(Typo.footnote.monospacedDigit())
                        .foregroundStyle(Palette.inkTertiary)
                        .contentTransition(.numericText())
                }
                step("Add a few things you'd trade", detail: "Snap them. Your GM names and prices each 1.", isDone: hasShelf, action: onShelf)
                step("Tell your GM 1 thing you want", detail: "Any way you'd say it.", isDone: hasAsk, action: onAsk)
                step("Join a Circle", detail: "Your GM only trades with people you know.", isDone: hasCircle, action: onCircle)
            }
        }
    }

    private func step(_ title: String, detail: String, isDone: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(isDone ? Palette.mint : Palette.inkTertiary)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(isDone ? Palette.inkSecondary : Palette.ink)
                        .strikethrough(isDone, color: Palette.inkTertiary)
                    Text(detail)
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                }
                Spacer(minLength: 0)
                if !isDone {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Palette.inkTertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(isDone)
    }
}

// MARK: - Placeholders

/// First launch, before the server answers: the shape of Home, not an empty screen.
struct HomePlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title: "Your trades")
            VStack(spacing: 0) {
                ForEach(0..<3, id: \.self) { _ in
                    HStack(spacing: Space.sm) {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(Palette.ink.opacity(0.06))
                            .frame(width: 46, height: 46)
                        VStack(alignment: .leading, spacing: 8) {
                            Capsule().fill(Palette.ink.opacity(0.08)).frame(width: 140, height: 12)
                            Capsule().fill(Palette.ink.opacity(0.05)).frame(width: 200, height: 9)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, 14)
                }
            }
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .phaseAnimator([0.55, 1.0]) { content, phase in
                content.opacity(phase)
            } animation: { _ in .easeInOut(duration: 1.0) }
        }
        .accessibilityLabel("Loading")
    }
}

// MARK: - Push prompt

/// PRD first-time experience, step 7: asked only once the first Ask exists.
struct PushPromptCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.iris)
                .frame(width: 34, height: 34)
                .background(Palette.iris.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text("Want a ping when I find a deal? At most 3 a day.")
                .font(Typo.callout)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Not now") { model.answerPushPrompt(allow: false) }
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.inkSecondary)
            Button("Turn on") { model.answerPushPrompt(allow: true) }
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .buttonStyle(.glassProminent)
                .tint(Palette.iris)
        }
        .padding(Space.sm)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
    }
}

// MARK: - Shared

/// Which Item and angles a "Take photos" button shoots.
struct HomeShootRoute: Identifiable {
    let id = UUID()
    var itemID: String
    var angles: [String]
}

func fairnessLine(_ deal: DealSheet) -> String {
    let give = Money.dollars(deal.giveValue)
    let get = Money.dollars(deal.getValue)
    if deal.throwInCents > 0 {
        return "You give about \(give) plus \(Money.dollars(deal.throwInCents)) and get about \(get)."
    } else if deal.throwInCents < 0 {
        return "You give about \(give) and get about \(get) plus \(Money.dollars(-deal.throwInCents))."
    }
    return "You give about \(give) and get about \(get)."
}

/// "20h left", "45m left", or nil when there's no deadline.
func timeLeft(until raw: String?) -> String? {
    guard let raw, let date = WireDate.parse(raw) else { return nil }
    return timeLeft(until: date)
}

func timeLeft(until date: Date) -> String? {
    let seconds = date.timeIntervalSinceNow
    guard seconds > 0 else { return nil }
    if seconds >= 3600 { return "\(Int(seconds / 3600))h left" }
    return "\(max(1, Int(seconds / 60)))m left"
}
