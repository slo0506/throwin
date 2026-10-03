import SwiftUI

/// A turn in the GM conversation. GM responses render as cards, not walls of text
/// (PRD: UI components are tools; the server fills in every price and photo).
struct GMMessage: Identifiable {
    enum Content {
        case userText(String)
        case gmText(StreamedText)
        case item(ShelfItem)
        case choices([String])
    }

    let id = UUID()
    var content: Content
}

/// Talk to your GM. In demo mode the GM follows a short script; in Milestone 2 this streams
/// from `/v1/gm/stream/{id}` (text deltas, progress lines and UI component events).
struct GMChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var messages: [GMMessage] = []
    @State private var draft = ""
    @State private var mood: OrbMood = .idle
    @State private var thinkingLine: String?
    @State private var epoch = Date()
    @State private var turn = 0
    @State private var isBusy = false
    @State private var sendCount = 0
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Space.lg) {
                        ForEach(messages) { message in
                            row(for: message)
                                .id(message.id)
                                .transition(
                                    .asymmetric(
                                        insertion: .opacity.combined(with: .scale(scale: 0.94, anchor: .bottomLeading)).combined(with: .offset(y: 12)),
                                        removal: .opacity
                                    )
                                )
                        }
                        if let thinkingLine {
                            HStack(spacing: Space.xs) {
                                LoopIndicator(people: 3, size: 20)
                                Text(thinkingLine)
                                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                                    .foregroundStyle(Palette.inkSecondary)
                                    .loopShimmer()
                            }
                            .transition(.opacity.combined(with: .offset(y: 6)))
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
            }
            composer
        }
        .background(Palette.canvas)
        .task {
            guard messages.isEmpty else { return }
            epoch = Date()
            try? await Task.sleep(for: .milliseconds(450))
            await gmSays("Hey \(model.firstName). What are you hunting for? Say it any way, like the big LEGO Batmobile.")
            appendAnimated(.choices(["The LEGO Batmobile", "A Switch game", "Something for my desk"]))
        }
    }

    /// Changes whenever content grows, so the list follows the stream.
    private var scrollSignature: Int {
        var total = messages.count * 1000
        if case let .gmText(streamed)? = messages.last?.content {
            total += streamed.chunks.count
        }
        return total + (thinkingLine == nil ? 0 : 1)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.sm) {
            GMOrbView(mood: mood, size: 44)
            VStack(alignment: .leading, spacing: 1) {
                Text("Your GM")
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                Text(statusText)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
                    .contentTransition(.opacity)
                    .animation(Motion.snappy, value: statusText)
            }
            Spacer()
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
        .padding(.horizontal, Space.gutter)
        .padding(.top, Space.xl)
        .padding(.bottom, Space.sm)
    }

    private var statusText: String {
        switch mood {
        case .idle: "Working on \(model.asks.count) Ask\(model.asks.count == 1 ? "" : "s")"
        case .thinking: "Thinking"
        case .speaking: "Typing"
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func row(for message: GMMessage) -> some View {
        switch message.content {
        case let .userText(text):
            HStack {
                Spacer(minLength: 60)
                Text(text)
                    .font(Typo.body)
                    .foregroundStyle(Palette.canvas)
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, 11)
                    .background(Palette.ink, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
        case let .gmText(streamed):
            BloomingText(streamed: streamed, epoch: epoch)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, Space.xl)
        case let .item(item):
            ChatItemCard(item: item)
        case let .choices(options):
            ChoiceChips(options: options, isEnabled: !isBusy) { choice in
                send(choice)
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        HStack(spacing: Space.xs) {
            TextField("Tell your GM what you want", text: $draft, axis: .vertical)
                .font(Typo.body)
                .lineLimit(1...4)
                .focused($composerFocused)
                .submitLabel(.send)
                .onSubmit { send(draft) }
                .padding(.leading, Space.md)
                .padding(.vertical, 12)

            Button {
                send(draft)
            } label: {
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
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.xs)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.6), trigger: sendCount)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isBusy
    }

    // MARK: Demo conversation

    private func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isBusy else { return }
        draft = ""
        sendCount += 1
        isBusy = true
        // Choice chips are answered once; remove them so the thread reads cleanly.
        withAnimation(Motion.snappy) {
            messages.removeAll { if case .choices = $0.content { return true } else { return false } }
        }
        appendAnimated(.userText(text))
        Task {
            await respond(to: text)
            isBusy = false
        }
    }

    private func respond(to text: String) async {
        defer { turn += 1 }
        switch turn {
        case 0:
            await think("Looking for it", for: 1.1)
            await gmSays("That sounds like the classic TV Batmobile, set 76188. It usually trades for about $70 to $100 used.")
            try? await Task.sleep(for: .milliseconds(250))
            appendAnimated(.item(DemoData.batmobile))
            try? await Task.sleep(for: .milliseconds(700))
            await gmSays("Your Zelda and Mario Kart cover most of that. Want me to start looking?")
            appendAnimated(.choices(["Start looking", "Use different items"]))
        case 1:
            await think("Checking 46 Shelves in 2 Circles", for: 1.4)
            await gmSays("On it. I'll ping you when I find a deal. Usually that's within a day in a Circle this size.")
        default:
            await think("Thinking", for: 0.8)
            await gmSays("Got it. The real me arrives with the GM harness in Milestone 2, so for now I'm running a short demo script.")
        }
    }

    private func think(_ line: String, for seconds: Double) async {
        withAnimation(Motion.snappy) {
            mood = .thinking
            thinkingLine = line
        }
        try? await Task.sleep(for: .seconds(seconds))
        withAnimation(Motion.snappy) { thinkingLine = nil }
    }

    private func gmSays(_ text: String) async {
        mood = .speaking
        appendAnimated(.gmText(StreamedText()))
        let index = messages.count - 1
        await streamDemoText(text, epoch: epoch) { token, arrival in
            guard messages.indices.contains(index), case var .gmText(streamed) = messages[index].content else { return }
            streamed.append(token, at: arrival)
            messages[index].content = .gmText(streamed)
        }
        mood = .idle
    }

    private func appendAnimated(_ content: GMMessage.Content) {
        withAnimation(Motion.bouncy) {
            messages.append(GMMessage(content: content))
        }
    }
}

// MARK: - Inline cards

/// An Item rendered inside the chat. Plays the appraisal scan as it lands.
struct ChatItemCard: View {
    var item: ShelfItem
    @State private var scan = 0

    var body: some View {
        HStack(spacing: Space.md) {
            ItemArtwork(item: item, cornerRadius: 18)
                .frame(width: 84, height: 84)
                .appraiseScan(trigger: scan, duration: 1.3)
                .liquidRipple(at: CGPoint(x: 42, y: 42), trigger: scan, amplitude: 5)
            VStack(alignment: .leading, spacing: 6) {
                Text(item.title)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                if let value = item.value {
                    Text(value.label)
                        .font(Typo.value)
                        .foregroundStyle(Palette.inkSecondary)
                    ValueRangeBar(range: value, tint: Palette.receive, showsLabels: false)
                }
            }
        }
        .padding(Space.sm)
        .background {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(Palette.surface)
                .shadow(color: .black.opacity(0.06), radius: 16, y: 6)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
        .padding(.trailing, Space.xxl)
        .task {
            try? await Task.sleep(for: .milliseconds(120))
            scan += 1
        }
    }
}

/// Multiple-choice answers from `present_choices`. Chips cascade in.
struct ChoiceChips: View {
    var options: [String]
    var isEnabled: Bool
    var onPick: (String) -> Void

    @State private var appeared = false

    var body: some View {
        FlowRow(spacing: Space.xs) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button {
                    onPick(option)
                } label: {
                    Text(option)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, Space.md)
                        .frame(height: 40)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .capsule)
                .disabled(!isEnabled)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 10)
                .animation(Motion.bouncy.delay(Double(index) * 0.06), value: appeared)
            }
        }
        .onAppear { appeared = true }
    }
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
