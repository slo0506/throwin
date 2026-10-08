import SwiftUI

/// Home (docs/specs/home.md): your GM's briefing. What needs you, as a deck of decisions;
/// your trades, each on a 4-step track; and at most 3 suggestions. It refreshes itself while
/// you look at it, and it ends.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var dealNamespace
    @State private var path: [AskRoute] = []
    @State private var shoot: HomeShootRoute?
    @State private var tuneUp: TuneUpRoute?
    @State private var inquiry: Inquiry?
    @State private var interest: Interest?
    @State private var isCapturing = false
    /// Quick questions answered right on the card, hidden while the answer is on its way.
    @State private var answered: Set<String> = []
    @State private var answeredTick = 0

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    BriefingHeader(
                        firstName: model.firstName,
                        briefing: briefing,
                        isWorking: model.isGMWorking,
                        onAvatar: { withAnimation(Motion.bouncy) { model.tab = .you } },
                        onGM: { model.openGM(screen: "home") }
                    )
                    .padding(.horizontal, Space.gutter)

                    if model.showsPushPrompt {
                        PushPromptCard()
                            .padding(.horizontal, Space.gutter)
                            .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
                    }

                    if !decisions.isEmpty {
                        DecisionDeck(items: decisions) { item in
                            decisionCard(item)
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    } else if showsGetStarted {
                        GetStartedCard(
                            hasShelf: !model.shelf.isEmpty,
                            hasAsk: !model.asks.isEmpty,
                            hasCircle: !model.circles.isEmpty,
                            onShelf: { isCapturing = true },
                            onAsk: { model.openGM(screen: "new_ask") },
                            onCircle: { withAnimation(Motion.bouncy) { model.tab = .circles } }
                        )
                        .padding(.horizontal, Space.gutter)
                    }

                    if showsPlaceholder {
                        HomePlaceholder()
                            .padding(.horizontal, Space.gutter)
                    } else {
                        TradesCard(
                            rows: tradeRows,
                            onOpen: { ask in path.append(AskRoute(ask: ask)) },
                            onNewAsk: { model.openGM(screen: "new_ask") }
                        )
                        .padding(.horizontal, Space.gutter)
                    }

                    if !suggestions.isEmpty {
                        SuggestionsCard(items: suggestions, shorten: shortened) { act(on: $0) }
                            .padding(.horizontal, Space.gutter)
                            .transition(.opacity)
                    }
                }
                .padding(.top, Space.xs)
                .padding(.bottom, Space.tabBarClearance)
                .animation(Motion.bouncy, value: decisions.map(\.id))
                .animation(Motion.bouncy, value: model.showsPushPrompt)
                .animation(Motion.soft, value: showsPlaceholder)
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
            .task { await model.refreshHome() }
            .refreshable { await model.refreshHome() }
            .navigationDestination(for: AskRoute.self) { route in
                AskDetailView(askID: route.id, fallback: route.ask)
            }
            .quietBanner()
            .fullScreenCover(item: $model.presentedDeal, onDismiss: refresh) { deal in
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
            .sheet(item: $inquiry, onDismiss: refresh) { inquiry in
                InquirySheet(inquiry: inquiry)
                    .presentationDetents([.medium])
                    .presentationCornerRadius(32)
            }
            .sheet(item: $interest, onDismiss: refresh) { interest in
                InterestSheet(interest: interest)
                    .presentationDetents([.large])
                    .presentationCornerRadius(32)
            }
            .sensoryFeedback(.success, trigger: answeredTick)
        }
    }

    // MARK: What Home shows

    /// What needs a decision from you, in the server's order (soonest to close first).
    private static let decisionKinds: Set<NextUpItem.Kind> = [
        .approveDeal, .answerCounter, .someoneWants, .answerInquiry, .pinDownItem, .showcasePhotos,
    ]

    /// The server's list. Built on device in demo mode, or until the server's list arrives,
    /// so a Deal waiting on you never drops off Home.
    private var nextUp: [NextUpItem] {
        model.isLive && !model.nextUp.isEmpty ? model.nextUp : localNextUp
    }

    private var decisions: [NextUpItem] {
        nextUp.filter { Self.decisionKinds.contains($0.kind) && !answered.contains($0.id) }
    }

    /// The 3 setup steps, shown until they're done, unless something needs a decision.
    private var showsGetStarted: Bool {
        guard !showsPlaceholder else { return false }
        return model.shelf.isEmpty || model.asks.isEmpty || (model.isLive && model.circles.isEmpty)
    }

    private var suggestions: [NextUpItem] {
        let setup: Set<NextUpItem.Kind> = [.addToShelf, .newAsk, .joinCircle]
        return nextUp.filter {
            !Self.decisionKinds.contains($0.kind) && !(showsGetStarted && decisions.isEmpty && setup.contains($0.kind))
        }
    }

    /// First launch, before the server answers.
    private var showsPlaceholder: Bool {
        model.isLive && !model.hasLoadedHome && model.asks.isEmpty
    }

    /// What needs you first, then what the GM is working on.
    private var briefing: Briefing {
        let looking = model.asks
            .filter { $0.status == .prospecting && !$0.offerItemIds.isEmpty }
            .map(\.shortName)
        let lookingLine = switch looking.count {
        case 0: ""
        case 1: "I'm looking for your \(looking[0])."
        case 2: "I'm looking for your \(looking[0]) and \(looking[1])."
        default: "I'm looking for your \(looking[0]) and \(looking.count - 1) more."
        }
        let count = decisions.count
        if count > 0 {
            return Briefing(lead: count == 1 ? "1 thing needs you." : "\(count) things need you.", rest: lookingLine)
        }
        if model.asks.isEmpty {
            return Briefing(lead: "Tell me 1 thing you want.", rest: "I'll look through your Circles for it.")
        }
        if model.isLive && model.circles.isEmpty {
            return Briefing(lead: "All caught up.", rest: "Join a Circle so I can start looking.")
        }
        return Briefing(lead: "All caught up.", rest: lookingLine)
    }

    // MARK: Your trades

    private var tradeRows: [TradeRowModel] {
        let order: [AskStatus: Int] = [.proposed: 0, .accepted: 1, .prospecting: 2, .offering: 3, .drafting: 4]
        return model.asks
            .filter { order[$0.status] != nil }
            .sorted { (order[$0.status] ?? 9) < (order[$1.status] ?? 9) }
            .map(tradeRow)
    }

    /// Where an Ask stands, in 1 line: the stage it's on and what it waits on.
    private func tradeRow(_ ask: Ask) -> TradeRowModel {
        switch ask.status {
        case .drafting:
            return TradeRowModel(ask: ask, stage: 0, line: "Pinning down what you want", isActive: false)
        case .offering:
            return TradeRowModel(ask: ask, stage: 0, line: "Pick what you'd offer", isActive: false)
        case .prospecting:
            if ask.offerItemIds.isEmpty {
                return TradeRowModel(ask: ask, stage: 0, line: "Pick what you'd offer and I'll look", isActive: false)
            }
            if model.isLive && model.circles.isEmpty {
                return TradeRowModel(ask: ask, stage: 0, line: "Join a Circle so I can look", isActive: false)
            }
            let circles = max(1, model.circles.count)
            return TradeRowModel(ask: ask, stage: 0, line: "Looking in \(circles) Circle\(circles == 1 ? "" : "s")", isActive: true)
        case .proposed:
            if let deal = model.dealsWaiting.first(where: { $0.askID == ask.id && $0.status.isOpen }) {
                if deal.myApproval == .approved || model.approvedDealIDs.contains(deal.id) {
                    let others = deal.waitingOn
                    let line = others.isEmpty ? "Everyone's in" : "Waiting on \(others.formatted(.list(type: .and)))"
                    return TradeRowModel(ask: ask, stage: 1, line: line, isActive: false)
                }
                let line = deal.counter != nil ? "A counter is waiting on you" : "Deal ready for you"
                return TradeRowModel(ask: ask, stage: 1, line: line, isActive: false)
            }
            let yourStep = decisions.contains { $0.kind == .pinDownItem || $0.kind == .showcasePhotos }
            let line = yourStep ? "Deal found. Your move" : "Deal found. Their move"
            return TradeRowModel(ask: ask, stage: 1, line: line, isActive: !yourStep)
        case .accepted:
            return TradeRowModel(ask: ask, stage: 2, line: "Everyone's in. Handoff next", isActive: false)
        case .fulfilled:
            return TradeRowModel(ask: ask, stage: 3, line: "Done. It's yours", isActive: false)
        case .expired, .cancelled:
            return TradeRowModel(ask: ask, stage: 0, line: ask.displayStatusLine, isActive: false)
        }
    }

    // MARK: Decision cards

    @ViewBuilder
    private func decisionCard(_ item: NextUpItem) -> some View {
        let style = NextUpStyle.of(item.kind)
        switch item.kind {
        case .approveDeal, .answerCounter:
            if let deal = model.dealsWaiting.first(where: { $0.id == item.dealId }) {
                DecisionCard(
                    kind: item.kind == .answerCounter ? "Counter" : "Deal ready",
                    symbol: style.symbol,
                    tint: style.tint,
                    timeLeft: timeLeft(until: deal.expiresAt),
                    title: dealTitle(deal),
                    detail: item.kind == .answerCounter ? item.title : cashLine(deal),
                    isLoud: item.kind == .approveDeal,
                    onTap: { model.presentedDeal = deal }
                ) {
                    SwapVisual(give: deal.give, get: deal.receive, throwInCents: deal.throwInCents)
                } footer: {
                    DecisionButton(title: "Review") { model.presentedDeal = deal }
                }
                .matchedTransitionSource(id: deal.id, in: dealNamespace)
            } else {
                stepCard(item, style: style)
            }
        case .someoneWants:
            let found = model.interests.first { "interest:\($0.id)" == item.id }
            DecisionCard(
                kind: "Someone wants your Item",
                symbol: style.symbol,
                tint: style.tint,
                timeLeft: timeLeft(until: item.expiresAt),
                title: found.map { "\($0.wanterFirstName ?? "Someone") is looking for your \(ShelfItem(dealItem: $0.item).shortName)" } ?? shortened(item.title, for: item),
                detail: found.map { offerLine($0) } ?? item.detail,
                onTap: { act(on: item) }
            ) {
                if let found {
                    SwapVisual(give: [ShelfItem(dealItem: found.item)], get: found.theirOffer.prefix(3).map { ShelfItem(dealItem: $0) })
                } else {
                    thumbnailTile(item.thumbnailUrl, tint: Palette.give)
                }
            } footer: {
                DecisionButton(title: "See trade") { act(on: item) }
            }
        case .answerInquiry:
            let found = model.inquiries.first { "inquiry:\($0.id)" == item.id }
            DecisionCard(
                kind: "Quick question",
                symbol: style.symbol,
                tint: style.tint,
                timeLeft: timeLeft(until: item.expiresAt),
                title: shortened(item.title, for: item),
                detail: "Someone in your Circles has it. You'd still see the Deal Sheet first.",
                onTap: { act(on: item) }
            ) {
                if let found {
                    ItemTileStack(items: [ShelfItem(dealItem: found.item)], tint: Palette.receive)
                } else {
                    thumbnailTile(item.thumbnailUrl, tint: Palette.receive)
                }
            } footer: {
                HStack(spacing: Space.sm) {
                    Button { answer(item, inquiry: found, yes: false) } label: {
                        Text("No thanks").frame(maxWidth: .infinity).frame(height: 32)
                    }
                    .buttonStyle(.glass)
                    Button { answer(item, inquiry: found, yes: true) } label: {
                        Text("Yes, it works").frame(maxWidth: .infinity).frame(height: 32)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.ink)
                }
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .disabled(found == nil)
            }
        default:
            stepCard(item, style: style)
        }
    }

    /// 1 step stands between you and a Deal, or anything else that needs a tap.
    private func stepCard(_ item: NextUpItem, style: (symbol: String, tint: Color)) -> some View {
        DecisionCard(
            kind: item.kind == .pinDownItem || item.kind == .showcasePhotos ? "1 step to a deal" : "Needs you",
            symbol: style.symbol,
            tint: style.tint,
            timeLeft: timeLeft(until: item.expiresAt),
            title: shortened(item.title, for: item),
            detail: shortened(item.detail, for: item),
            onTap: { act(on: item) }
        ) {
            thumbnailTile(item.thumbnailUrl, tint: Palette.give)
        } footer: {
            DecisionButton(title: item.cta) { act(on: item) }
        }
    }

    private func thumbnailTile(_ raw: String?, tint: Color) -> some View {
        ZStack {
            tint.opacity(0.12)
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(tint)
            if let raw, let url = URL(string: raw) {
                RemoteImage(url: url)
            }
        }
        .frame(width: 76, height: 76)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(5)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 23, style: .continuous))
    }

    /// The server names Items and Asks by their full titles (up to the first comma); Home swaps
    /// in the short name when it has the Item or Ask, so nothing is cut off mid-word.
    private func shortened(_ text: String, for item: NextUpItem) -> String {
        let serverShort = { (title: String) in
            (title.split(separator: ",").first.map(String.init) ?? title).trimmingCharacters(in: .whitespaces)
        }
        var result = text
        if let id = item.itemId, let shelfItem = model.shelf.first(where: { $0.id == id }) {
            result = result.replacingOccurrences(of: serverShort(shelfItem.title), with: shelfItem.shortName)
        }
        if let id = item.askId, let ask = model.asks.first(where: { $0.id == id }) {
            result = result.replacingOccurrences(of: serverShort(ask.displayTitle), with: ask.shortName)
        }
        return result
    }

    /// "Anto's PS4 for your Insta360 X3", short names so it fits.
    private func dealTitle(_ deal: DealSheet) -> String {
        let get = deal.receive.first?.shortName ?? "theirs"
        let give = deal.give.first?.shortName ?? "yours"
        let getPart = deal.receive.count > 1 ? "\(get) and \(deal.receive.count - 1) more" : get
        let givePart = deal.give.count > 1 ? "\(give) and \(deal.give.count - 1) more" : give
        if let name = deal.getFromName, !deal.isLoop {
            return "\(name)'s \(getPart) for your \(givePart)"
        }
        return "\(getPart) for your \(givePart)"
    }

    /// The cash in plain words, or the value line when there's none.
    private func cashLine(_ deal: DealSheet) -> String {
        if deal.throwInCents > 0 { return "You add \(Money.dollars(deal.throwInCents)) to even it out." }
        if deal.throwInCents < 0 { return "You get \(Money.dollars(-deal.throwInCents)) back to even it out." }
        return "About even: \(Money.dollars(deal.giveValue)) for \(Money.dollars(deal.getValue))."
    }

    private func offerLine(_ interest: Interest) -> String {
        let count = interest.theirOffer.count
        let who = interest.wanterFirstName ?? "They"
        return count == 1 ? "\(who) would trade 1 thing for it. See if you'd take it." : "\(who) would trade any of \(count) things for it. Pick 1."
    }

    // MARK: Actions

    /// Each button goes straight to the action, not to a screen that leads to it.
    private func act(on item: NextUpItem) {
        switch item.kind {
        case .approveDeal, .answerCounter:
            if let deal = model.dealsWaiting.first(where: { $0.id == item.dealId }) {
                model.presentedDeal = deal
            }
        case .showcasePhotos, .itemPhotos:
            if let itemID = item.itemId {
                shoot = HomeShootRoute(itemID: itemID, angles: item.angles)
            }
        case .pinDownItem:
            tuneUp = TuneUpRoute(itemID: item.itemId)
        case .offerForAsk, .weakOffer:
            if let ask = model.asks.first(where: { $0.id == item.askId }) {
                path.append(AskRoute(ask: ask))
            }
        case .joinCircle:
            withAnimation(Motion.bouncy) { model.tab = .circles }
        case .answerInquiry:
            let id = item.id.replacingOccurrences(of: "inquiry:", with: "")
            if let found = model.inquiries.first(where: { $0.id == id }) {
                inquiry = found
            } else {
                Task {
                    await model.refreshNextUp()
                    inquiry = model.inquiries.first(where: { $0.id == id })
                }
            }
        case .someoneWants:
            let id = item.id.replacingOccurrences(of: "interest:", with: "")
            if let found = model.interests.first(where: { $0.id == id }) {
                interest = found
            } else {
                Task {
                    await model.refreshNextUp()
                    interest = model.interests.first(where: { $0.id == id })
                }
            }
        case .inDemand:
            // People want something this Item could fill: the GM turns it into an Ask.
            let title = model.shelf.first(where: { $0.id == item.itemId })?.shortName ?? "this"
            model.openGM(screen: "in_demand", seed: "People in my Circles want something like my \(title). What could I trade it for? ")
        case .tuneUp:
            tuneUp = TuneUpRoute(itemID: nil)
        case .addToShelf:
            isCapturing = true
        case .newAsk:
            model.openGM(screen: "new_ask")
        }
    }

    /// A quick question answered on its card: it leaves the deck at once, and comes back if
    /// the answer doesn't go through.
    private func answer(_ item: NextUpItem, inquiry: Inquiry?, yes: Bool) {
        guard let inquiry else { return }
        withAnimation(Motion.bouncy) { _ = answered.insert(item.id) }
        answeredTick += 1
        Task {
            do {
                try await model.answerInquiry(inquiry, yes: yes)
            } catch {
                withAnimation(Motion.bouncy) { _ = answered.remove(item.id) }
            }
        }
    }

    private func refresh() {
        Task { await model.refreshHome() }
    }

    /// Deals waiting on you and open questions, in the server list's shape.
    private var localNextUp: [NextUpItem] {
        var items = model.dealsWaiting
            .filter { $0.status == .pendingApprovals && $0.myApproval == .pending && !model.approvedDealIDs.contains($0.id) }
            .map { deal in
                NextUpItem(
                    id: "deal:\(deal.id)", kind: .approveDeal, title: deal.getTitle ?? "A trade",
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
}

#Preview {
    HomeView()
        .environment(AppModel())
}
