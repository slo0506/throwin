import SwiftUI

/// Home: Deal Sheets waiting on you, your live Asks, and 1 suggestion from the GM.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var dealNamespace

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    header

                    if model.showsPushPrompt {
                        PushPromptCard()
                            .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
                    }

                    ForEach(model.dealsWaiting) { deal in
                        let approved = model.approvedDealIDs.contains(deal.id)
                        VStack(alignment: .leading, spacing: Space.sm) {
                            SectionHeader(
                                title: deal.status == .approved ? "Approved" : approved ? "Waiting on the others" : "Waiting on you",
                                trailing: deal.status.isOpen && !approved ? "Expires in \(deal.expiresInHours)h" : nil
                            )
                            Button {
                                model.presentedDeal = deal
                            } label: {
                                DealTeaserCard(deal: deal, isApproved: approved)
                            }
                            .buttonStyle(.pressable)
                            .matchedTransitionSource(id: deal.id, in: dealNamespace)
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Your Asks", trailing: "\(model.asks.count) live")
                        ForEach(model.asks) { ask in
                            NavigationLink(value: AskRoute(ask: ask)) {
                                AskCard(ask: ask)
                            }
                            .buttonStyle(.pressable)
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        }
                        if model.asks.isEmpty {
                            Text("No Asks yet. Tell your GM 1 thing you want.")
                                .font(Typo.callout)
                                .foregroundStyle(Palette.inkSecondary)
                                .padding(.horizontal, 4)
                        }
                        newAskButton
                    }
                    .animation(Motion.bouncy, value: model.asks.map(\.id))

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "From your GM")
                        GMSuggestionCard()
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.top, Space.xs)
                .padding(.bottom, Space.tabBarClearance)
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
            .animation(Motion.bouncy, value: model.showsPushPrompt)
            .task {
                await model.refreshAsks()
                await model.refreshDeals()
            }
            .refreshable {
                await model.refreshAsks()
                await model.refreshDeals()
            }
            .navigationDestination(for: AskRoute.self) { route in
                AskDetailView(askID: route.id, fallback: route.ask)
            }
            .quietBanner()
            .fullScreenCover(item: $model.presentedDeal) { deal in
                DealSheetView(deal: deal)
                    .navigationTransition(.zoom(sourceID: deal.id, in: dealNamespace))
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).month().day()))
                    .sectionLabel()
                Text("\(greeting), \(model.firstName)")
                    .font(Typo.title)
                    .tracking(-0.4)
                    .foregroundStyle(Palette.ink)
            }
            Spacer()
            Button {
                withAnimation(Motion.bouncy) { model.tab = .you }
            } label: {
                Avatar(person: Person(id: "me", name: model.firstName, hue: 2, rating: 5, circle: ""), size: 40)
            }
            .buttonStyle(.pressable)
        }
        .padding(.top, Space.xs)
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: "Morning"
        case 12..<17: "Afternoon"
        default: "Evening"
        }
    }

    private var newAskButton: some View {
        Button {
            model.openGM(screen: "new_ask")
        } label: {
            HStack(spacing: Space.xs) {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .bold))
                Text("New Ask")
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                Text("Tell your GM what you want")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
            }
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.lg)
            .frame(height: 56)
            .background {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.ink.opacity(0.14), style: StrokeStyle(lineWidth: 1.5, dash: [5, 5]))
            }
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(.pressable)
    }
}

// MARK: - Deal teaser

struct DealTeaserCard: View {
    var deal: DealSheet
    var isApproved: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack {
                Pill(
                    text: deal.isLoop ? "\(deal.participants.count)-way Loop" : "Swap",
                    symbol: "arrow.triangle.2.circlepath",
                    tint: Palette.iris
                )
                Spacer()
                AvatarStack(people: deal.participants, size: 26)
            }

            HStack(spacing: Space.sm) {
                tileStack(deal.give, tint: Palette.give)
                Image(systemName: "arrow.right")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Palette.inkTertiary)
                tileStack(deal.receive, tint: Palette.receive)
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(deal.receive.first?.title ?? "A trade")
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                Text(fairnessLine(deal))
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }

            HStack {
                Text(isApproved ? "Waiting on Maya and Dev" : "Review the Deal Sheet")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                Spacer()
                Image(systemName: isApproved ? "checkmark.circle.fill" : "chevron.right")
                    .font(.system(size: 15, weight: .bold))
            }
            .foregroundStyle(isApproved ? Palette.mint : Palette.ink)
            .padding(.top, 2)
        }
        .padding(Space.lg)
        .background {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .fill(Palette.surface)
                .shadow(color: Palette.iris.opacity(0.18), radius: 28, y: 12)
        }
        .overlay {
            // A slow Loop-gradient rim so the 1 thing that needs you stands out.
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: isApproved)) { context in
                let angle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 6) / 6 * 360
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(
                        AngularGradient(colors: Palette.loop + [Palette.loop[0]], center: .center, angle: .degrees(angle)),
                        lineWidth: 2
                    )
                    .opacity(isApproved ? 0.25 : 0.9)
            }
        }
    }

    private func tileStack(_ items: [ShelfItem], tint: Color) -> some View {
        HStack(spacing: -18) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                ItemArtwork(item: item, cornerRadius: 16)
                    .frame(width: 64, height: 64)
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Palette.surface, lineWidth: 3)
                    }
                    .rotationEffect(.degrees(Double(index) * 6 - 3))
                    .zIndex(Double(items.count - index))
            }
        }
        .padding(4)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
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

// MARK: - Ask card

struct AskCard: View {
    var ask: Ask

    @Environment(AppModel.self) private var model
    @State private var lineIndex = 0

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ask.displayTitle)
                            .font(Typo.headline)
                            .foregroundStyle(Palette.ink)
                            .multilineTextAlignment(.leading)
                        Text(ask.usedRange.map { "Worth about \($0.label) used" } ?? "Your GM is pricing this")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkSecondary)
                    }
                    Spacer()
                    if ask.status == .accepted {
                        Pill(text: "Deal approved", symbol: "checkmark", tint: Palette.mint)
                    }
                }

                AskStatusRow(ask: ask, line: statusLine)

                HStack(spacing: Space.xs) {
                    Text("Offering").sectionLabel()
                    if offerItems.isEmpty {
                        Text("Nothing yet")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkTertiary)
                    }
                    ForEach(offerItems) { item in
                        ItemArtwork(item: item, cornerRadius: 9)
                            .frame(width: 30, height: 30)
                    }
                    Spacer()
                    Pill(text: AskDetailView.ceilingLabel(ask.cashCeilingCents), symbol: "dollarsign", tint: Palette.gold)
                }
            }
        }
        .task(id: ask.status) {
            // Demo only: the sample Ask cycles through what a live search sounds like.
            guard !model.isLive, ask.status == .prospecting else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2.8))
                lineIndex = (lineIndex + 1) % DemoData.prospectingLines.count
            }
        }
    }

    private var statusLine: String {
        if !model.isLive {
            switch ask.status {
            case .accepted: return "Waiting on 2 more approvals"
            case .prospecting: return DemoData.prospectingLines[lineIndex]
            default: break
            }
        }
        return ask.displayStatusLine
    }

    private var offerItems: [ShelfItem] {
        let byID = Dictionary((model.shelf + DemoData.shelf).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ask.offerItemIds.compactMap { byID[$0] }
    }
}

// MARK: - Push prompt

/// PRD first-time experience, step 7: asked only once the first Ask exists.
struct PushPromptCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .top, spacing: Space.sm) {
                    GMOrbView(mood: .idle, size: 34, showsGlow: false)
                    Text("I'll ping you when I find a deal. At most 3 a day, never promotional.")
                        .font(Typo.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: Space.xs) {
                    Button("Turn on") { model.answerPushPrompt(allow: true) }
                        .buttonStyle(.glassProminent)
                        .tint(Palette.iris)
                    Button("Not now") { model.answerPushPrompt(allow: false) }
                        .buttonStyle(.glass)
                    Spacer()
                }
                .font(.system(size: 15, weight: .semibold, design: .rounded))
            }
        }
    }
}

// MARK: - GM suggestion

struct GMSuggestionCard: View {
    @State private var answer: String?

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: Space.md) {
                HStack(alignment: .top, spacing: Space.sm) {
                    GMOrbView(mood: .idle, size: 34, showsGlow: false)
                    Text(answer ?? "Maya is looking for a Switch game you have. Want me to see what she'd trade?")
                        .font(Typo.body)
                        .foregroundStyle(Palette.ink)
                        .contentTransition(.opacity)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if answer == nil {
                    HStack(spacing: Space.xs) {
                        Button("Sure") { respond("On it. I'll ask Maya's GM and come back with options.") }
                            .buttonStyle(.glassProminent)
                            .tint(Palette.iris)
                        Button("Not that item") { respond("Got it. I'll keep Mario Kart off the table for Maya.") }
                            .buttonStyle(.glass)
                        Spacer()
                    }
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                }
            }
        }
        .sensoryFeedback(.selection, trigger: answer)
    }

    private func respond(_ text: String) {
        withAnimation(Motion.bouncy) { answer = text }
    }
}

#Preview {
    HomeView()
        .environment(AppModel())
}
