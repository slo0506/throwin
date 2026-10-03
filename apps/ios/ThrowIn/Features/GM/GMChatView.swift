import SwiftUI

/// Talk to your GM. Replies stream in with the bloom, tool progress shows as 1 soft line, and
/// cards (Items, choices, a camera request, an Ask, the recap) render inline as native views.
/// The same view runs the intake in onboarding ("Meet your GM") and the GM sheet.
struct GMChatView: View {
    enum Presentation {
        case sheet
        case intake
    }

    var presentation: Presentation = .sheet
    /// Intake only: the skip link.
    var onSkip: () -> Void = {}
    /// Intake only: the conversation reported `mode: chat`.
    var onIntakeComplete: () -> Void = {}

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var draft = ""
    @State private var sendCount = 0
    @State private var openAsk: AskRoute?
    @State private var isCapturing = false
    @State private var shelfBeforeCapture: Set<String> = []
    @State private var shoot: ChatShootRoute?
    @FocusState private var composerFocused: Bool

    private var chat: GMChatModel { model.gm }
    private var isIntake: Bool { presentation == .intake }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                thread
                composer
            }
            .background(Palette.canvas)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $openAsk) { route in
                AskDetailView(askID: route.id, fallback: route.ask)
            }
        }
        .quietBanner()
        .task {
            await chat.load(intake: isIntake)
            guard chat.wantsComposerFocus else { return }
            chat.wantsComposerFocus = false
            try? await Task.sleep(for: .milliseconds(350))
            composerFocused = true
        }
        .onChange(of: chat.intakeDone, initial: true) { _, done in
            if isIntake, done { onIntakeComplete() }
        }
        .sheet(isPresented: $isCapturing, onDismiss: captureClosed) {
            CaptureSheet(onFinish: {})
        }
        .fullScreenCover(item: $shoot) { route in
            ShowcaseShootView(itemID: route.itemID, angles: route.angles) { sent in
                if sent { chat.send(text: "Sent the photos.") }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.sm) {
            GMOrbView(mood: orbMood, size: 44)
            VStack(alignment: .leading, spacing: 1) {
                Text(isIntake ? "Meet your GM" : "Your GM")
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                Text(statusText)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .contentTransition(.opacity)
                    .animation(Motion.snappy, value: statusText)
            }
            Spacer()
            if isIntake {
                Button("Skip for now", action: onSkip)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.inkSecondary)
                    .buttonStyle(.plain)
            } else {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Palette.ink)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Close")
            }
        }
        .padding(.horizontal, Space.gutter)
        .padding(.top, isIntake ? Space.sm : Space.xl)
        .padding(.bottom, Space.sm)
    }

    private var orbMood: OrbMood {
        switch chat.phase {
        case .idle: .idle
        case .waiting: .thinking
        case .streaming: .speaking
        }
    }

    private var statusText: String {
        switch chat.phase {
        case .waiting: return "Thinking"
        case .streaming: return "Typing"
        case .idle:
            if isIntake { return "A few quick questions" }
            let count = model.asks.count
            return "Working on \(count) Ask\(count == 1 ? "" : "s")"
        }
    }

    // MARK: Thread

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.lg) {
                    ForEach(chat.rows) { row in
                        rowView(row)
                            .id(row.id)
                            .transition(
                                .asymmetric(
                                    insertion: .opacity.combined(with: .scale(scale: 0.94, anchor: .bottomLeading)).combined(with: .offset(y: 12)),
                                    removal: .opacity
                                )
                            )
                    }
                    activity
                    if chat.failed != nil, !chat.isBusy {
                        retryRow
                            .transition(.opacity.combined(with: .offset(y: 6)))
                    }
                    if chat.loadFailed, chat.rows.isEmpty {
                        loadFailedView
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, Space.gutter)
                .padding(.vertical, Space.md)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: scrollSignature) { _, _ in
                withAnimation(Motion.soft) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    /// Changes whenever the thread grows, so the list follows the stream.
    private var scrollSignature: Int {
        var total = chat.rows.count * 1000
        if case let .gm(text)? = chat.rows.last?.kind {
            total += text.chunks.count
        }
        if chat.progress != nil || chat.phase == .waiting { total += 1 }
        if chat.failed != nil { total += 2 }
        return total
    }

    @ViewBuilder
    private func rowView(_ row: GMRow) -> some View {
        switch row.kind {
        case let .user(text):
            HStack {
                Spacer(minLength: 60)
                Text(text)
                    .font(Typo.body)
                    .foregroundStyle(Palette.canvas)
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, 11)
                    .background(Palette.ink, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
        case let .gm(text):
            BloomingText(streamed: text, epoch: chat.epoch)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, Space.xl)
        case let .component(component):
            componentView(component)
        }
    }

    @ViewBuilder
    private func componentView(_ component: GMComponent) -> some View {
        let answer = chat.answers[component.id]
        let canAct = !chat.isBusy
        switch component.body {
        case let .itemCards(data):
            ItemCardsComponentView(data: data, answer: answer, isEnabled: canAct) { ids, echo in
                chat.choose(component, optionIDs: ids, echo: echo)
            }
        case let .choices(data):
            ChoicesComponentView(data: data, answer: answer, isEnabled: canAct) { ids, echo in
                chat.choose(component, optionIDs: ids, echo: echo)
            }
        case let .cameraRequest(data):
            CameraRequestCard(data: data, isEnabled: canAct) {
                openCamera(for: data)
            }
            .padding(.trailing, Space.xxl)
        case let .askCard(ask):
            AskChatCard(ask: model.asks.first(where: { $0.id == ask.id }) ?? ask) {
                openAsk = AskRoute(ask: ask)
            }
            .padding(.trailing, Space.xxl)
        case let .recap(data):
            RecapCard(data: data, answer: answer, isEnabled: canAct) { optionID, echo in
                chat.choose(component, optionIDs: [optionID], echo: echo)
            }
        case .unknown:
            EmptyView()
        }
    }

    /// The orb thinking until the first token, then the latest progress line, which
    /// cross-fades as the labels change.
    @ViewBuilder
    private var activity: some View {
        if let progress = chat.progress {
            HStack(spacing: Space.xs) {
                LoopIndicator(people: 3, size: 20)
                ZStack(alignment: .leading) {
                    Text(progress)
                        .id(progress)
                        .transition(.opacity)
                }
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.inkSecondary)
                .loopShimmer()
                .animation(Motion.soft, value: progress)
            }
            .transition(.opacity.combined(with: .offset(y: 6)))
            .accessibilityElement(children: .combine)
        } else if chat.phase == .waiting {
            GMOrbView(mood: .thinking, size: 30, showsGlow: false)
                .transition(.opacity.combined(with: .scale(scale: 0.6, anchor: .leading)))
                .accessibilityLabel("Your GM is thinking")
        }
    }

    private var retryRow: some View {
        HStack(spacing: Space.sm) {
            Text("That didn't go through.")
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
            GMChip(label: "Try again") { chat.retry() }
        }
    }

    private var loadFailedView: some View {
        VStack(spacing: Space.md) {
            Text("Couldn't reach your GM.")
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
            GMChip(label: "Try again") {
                Task { await chat.reload(intake: isIntake) }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Space.huge)
    }

    // MARK: Composer

    private var composer: some View {
        HStack(spacing: Space.xs) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(Typo.body)
                .lineLimit(1...4)
                .focused($composerFocused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.leading, Space.md)
                .padding(.vertical, 12)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(canSend ? Palette.canvas : Palette.inkTertiary)
                    .frame(width: 38, height: 38)
                    .background(canSend ? Palette.ink : Palette.ink.opacity(0.08), in: Circle())
                    .symbolEffect(.bounce.up, value: sendCount)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .padding(.trailing, 6)
            .animation(Motion.snappy, value: canSend)
            .accessibilityLabel("Send")
        }
        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .opacity(chat.isBusy ? 0.7 : 1)
        .animation(Motion.snappy, value: chat.isBusy)
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.xs)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.6), trigger: sendCount)
    }

    private var placeholder: String {
        if chat.isBusy { return "Your GM is replying" }
        if chat.screen == "new_ask" { return "What do you want? Say it any way" }
        return isIntake ? "Answer your GM" : "Tell your GM what you want"
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !chat.isBusy && chat.hasLoaded
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        draft = ""
        sendCount += 1
        chat.send(text: text)
    }

    // MARK: Camera

    private func openCamera(for request: CameraRequestData) {
        if let itemID = request.itemId, let item = model.shelf.first(where: { $0.id == itemID }) {
            shoot = ChatShootRoute(itemID: itemID, angles: item.showcaseAngles)
            return
        }
        guard model.isLive else {
            // Demo: the sample capture lands on the Shelf right away.
            model.loadDemoShelf()
            chat.send(text: "I snapped 3 things.")
            return
        }
        shelfBeforeCapture = Set(model.shelf.map(\.id))
        isCapturing = true
    }

    /// Tells the GM what the capture added, so it can carry on.
    private func captureClosed() {
        let before = shelfBeforeCapture
        Task {
            await model.refreshShelf()
            let added = model.shelf.filter { !before.contains($0.id) }.count
            guard added > 0 else { return }
            chat.send(text: added == 1 ? "I added 1 thing to my Shelf." : "I added \(added) things to my Shelf.")
        }
    }
}

struct ChatShootRoute: Identifiable, Hashable {
    var itemID: String
    var angles: [String]

    var id: String { itemID }
}

/// Wraps children onto new lines when they run out of room.
struct FlowRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

#Preview {
    GMChatView()
        .environment(AppModel())
}
