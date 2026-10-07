import SwiftUI

/// Home: 1 list of what needs you right now ("Next up", worked out by the server across
/// Deals, the Shelf and Asks, best first), then Deals you've approved that wait on others,
/// then your live Asks. A Deal waiting on you shows as its full card, the loud moment; the
/// rest are 1-tap rows whose button goes straight to the action.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var dealNamespace
    @State private var path: [AskRoute] = []
    @State private var shoot: HomeShootRoute?
    @State private var tuneUp: TuneUpRoute?
    @State private var isCapturing = false

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    header

                    if model.showsPushPrompt {
                        PushPromptCard()
                            .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
                    }

                    if !nextUp.isEmpty {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            SectionHeader(title: "Next up")
                            ForEach(nextUp) { item in
                                nextUpView(item)
                                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                            }
                        }
                        .animation(Motion.bouncy, value: nextUp.map(\.id))
                    }

                    if !inFlight.isEmpty {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            SectionHeader(title: "Waiting on the others")
                            ForEach(inFlight) { deal in
                                Button {
                                    model.presentedDeal = deal
                                } label: {
                                    DealTeaserCard(deal: deal, isApproved: true)
                                }
                                .buttonStyle(.pressable)
                                .matchedTransitionSource(id: deal.id, in: dealNamespace)
                            }
                        }
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
                        newAskButton
                    }
                    .animation(Motion.bouncy, value: model.asks.map(\.id))
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
            .fullScreenCover(item: $shoot, onDismiss: refresh) { route in
                ShowcaseShootView(itemID: route.itemID, angles: route.angles)
            }
            .fullScreenCover(item: $tuneUp, onDismiss: refresh) { route in
                TuneUpView(itemID: route.itemID)
            }
            .sheet(isPresented: $isCapturing) {
                CaptureSheet(capture: model.draftCapture())
            }
        }
    }

    // MARK: Next up

    /// The server's list. Built on device in demo mode, or until the server's list arrives,
    /// so a Deal waiting on you never drops off Home.
    private var nextUp: [NextUpItem] {
        model.isLive && !model.nextUp.isEmpty ? model.nextUp : localNextUp
    }

    /// Deals you've approved that wait on someone else.
    private var inFlight: [DealSheet] {
        model.dealsWaiting.filter { deal in
            deal.status.isOpen && (deal.myApproval == .approved || model.approvedDealIDs.contains(deal.id))
        }
    }

    @ViewBuilder
    private func nextUpView(_ item: NextUpItem) -> some View {
        if item.kind == .approveDeal, let deal = model.dealsWaiting.first(where: { $0.id == item.dealId }) {
            Button {
                model.presentedDeal = deal
            } label: {
                DealTeaserCard(deal: deal, isApproved: false)
            }
            .buttonStyle(.pressable)
            .matchedTransitionSource(id: deal.id, in: dealNamespace)
        } else {
            NextUpRow(item: item) { act(on: item) }
        }
    }

    /// Each button goes straight to the action, not to a screen that leads to it.
    private func act(on item: NextUpItem) {
        switch item.kind {
        case .approveDeal:
            if let deal = model.dealsWaiting.first(where: { $0.id == item.dealId }) {
                model.presentedDeal = deal
            }
        case .showcasePhotos, .itemPhotos:
            if let itemID = item.itemId {
                shoot = HomeShootRoute(itemID: itemID, angles: item.angles)
            }
        case .offerForAsk, .weakOffer:
            if let ask = model.asks.first(where: { $0.id == item.askId }) {
                path.append(AskRoute(ask: ask))
            }
        case .joinCircle:
            withAnimation(Motion.bouncy) { model.tab = .circles }
        case .tuneUp:
            tuneUp = TuneUpRoute(itemID: nil)
        case .addToShelf:
            isCapturing = true
        case .newAsk:
            model.openGM(screen: "new_ask")
        }
    }

    private func refresh() {
        Task { await model.refreshNextUp() }
    }

    /// Deals waiting on you and open questions, in the server list's shape.
    private var localNextUp: [NextUpItem] {
        var items = model.dealsWaiting
            .filter { $0.status == .pendingApprovals && $0.myApproval == .pending && !model.approvedDealIDs.contains($0.id) }
            .map { deal in
                NextUpItem(
                    id: "deal:\(deal.id)", kind: .approveDeal, title: deal.receive.first?.title ?? "A trade",
                    detail: "Waiting on you.", cta: "Review", dealId: deal.id, angles: []
                )
            }
        if model.tuneUpCount > 0 {
            items.append(NextUpItem(
                id: "tune-up", kind: .tuneUp, title: "Answer \(model.tuneUpCount) quick questions",
                detail: "Pins down your Items so your GM can price them.", cta: "Tune up", angles: []
            ))
        }
        return items
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
                Text(isApproved ? waitingLine : "Review the Deal Sheet")
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

    private var waitingLine: String {
        deal.waitingOn.isEmpty
            ? "Everyone's in"
            : "Waiting on \(deal.waitingOn.formatted(.list(type: .and)))"
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
                HStack(alignment: .top, spacing: Space.sm) {
                    AskTargetThumb(ask: ask, size: 52)
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

// MARK: - Next up row

/// Which Item and angles a "Take photos" button shoots.
struct HomeShootRoute: Identifiable {
    let id = UUID()
    var itemID: String
    var angles: [String]
}

/// 1 thing that needs you: a picture (the Item, the Ask's target, or a symbol for the kind),
/// what and why in the GM's words, and a button named for the action it takes.
struct NextUpRow: View {
    var item: NextUpItem
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                picture
                    .frame(width: 52, height: 52)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(item.detail)
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: Space.xs)
                Text(item.cta)
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(Palette.canvas)
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                    .frame(height: 34)
                    .background(Palette.ink, in: Capsule())
            }
            .padding(Space.sm)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.04), radius: 10, y: 4)
        }
        .buttonStyle(.pressable)
        .accessibilityElement(children: .combine)
        .accessibilityHint(item.cta)
    }

    @ViewBuilder
    private var picture: some View {
        let style = Self.style(for: item.kind)
        ZStack {
            style.tint.opacity(0.14)
            Image(systemName: style.symbol)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(style.tint)
            if let raw = item.thumbnailUrl, let url = URL(string: raw) {
                // Ask targets are product shots on any background; Item photos fill.
                if item.kind == .offerForAsk || item.kind == .weakOffer {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit().padding(4).background(.white)
                    } placeholder: {
                        Color.clear
                    }
                } else {
                    RemoteImage(url: url)
                }
            }
        }
    }

    private static func style(for kind: NextUpItem.Kind) -> (symbol: String, tint: Color) {
        switch kind {
        case .approveDeal: ("arrow.triangle.2.circlepath", Palette.iris)
        case .showcasePhotos: ("camera.fill", Palette.give)
        case .offerForAsk: ("hand.point.up.left.fill", Palette.iris)
        case .joinCircle: ("person.3.fill", Palette.receive)
        case .weakOffer: ("scalemass.fill", Palette.gold)
        case .tuneUp: ("wand.and.stars", Palette.iris)
        case .itemPhotos: ("camera.aperture", Palette.mint)
        case .addToShelf: ("plus.viewfinder", Palette.give)
        case .newAsk: ("sparkles", Palette.bubblegum)
        }
    }
}

#Preview {
    HomeView()
        .environment(AppModel())
}
