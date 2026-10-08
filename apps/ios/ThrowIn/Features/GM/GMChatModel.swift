import Observation
import SwiftUI

/// 1 line in the GM thread: something you said, GM text, or a GM card.
struct GMRow: Identifiable {
    enum Kind {
        case user(String)
        case gm(StreamedText)
        case component(GMComponent)
    }

    let id: String
    var kind: Kind
}

/// The GM conversation: history, the turn that is streaming, and which cards were answered.
/// Live mode talks to `/v1/gm`; demo mode plays `DemoGM` through the same event handling.
@Observable
final class GMChatModel {
    enum Phase: Equatable {
        case idle
        /// Sent, nothing back yet. The orb thinks.
        case waiting
        case streaming
    }

    private(set) var rows: [GMRow] = []
    private(set) var mode: GMMode = .chat
    private(set) var phase: Phase = .idle
    /// The latest plain-words progress line. Replaced by the next 1, cleared by text.
    private(set) var progress: String?
    /// Option IDs picked for each answered card. Empty when it was answered in an earlier session.
    private(set) var answers: [String: [String]] = [:]
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var loadFailed = false
    /// The turn that didn't go through, for Try again.
    private(set) var failed: GMSendRequest?
    /// Where the GM was opened from, sent with the next message.
    private(set) var screen: String?
    /// Set when the GM opens for a new Ask, so the composer takes focus.
    var wantsComposerFocus = false
    /// Bumped by everything the user does in the thread (send, a card answer, a retry), so the
    /// view can bring them to where the reply will land.
    private(set) var userActions = 0
    /// The conversation on screen. Nil until loaded: the server opens the 1 used last.
    private(set) var conversationID: String?
    /// Its title (the user's first words in it). Nil for a new 1.
    private(set) var title: String?
    /// The first conversation, where the intake happened: pinned as "Your GM".
    private(set) var isMain = true
    /// Every conversation, most recently used first, for the list.
    private(set) var conversations: [GMConversationSummary] = []

    /// The reference date for the bloom. History is stamped far before it, so it reads settled.
    let epoch = Date()

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var demo = DemoGM()
    @ObservationIgnored private var lastDemoInput: DemoGM.Input?
    @ObservationIgnored private var turnTask: Task<Void, Never>?
    /// The text row the current turn is appending to. A card ends it.
    @ObservationIgnored private var openTextRowID: String?

    var isBusy: Bool { phase != .idle }
    var isDemo: Bool { app?.api == nil }

    /// True once the conversation says intake is over.
    var intakeDone: Bool { hasLoaded && mode == .chat }

    func attach(_ app: AppModel) {
        self.app = app
    }

    /// Words to start the composer with, taken once by the chat view.
    var composerSeed: String?

    func prepare(screen: String?, seed: String? = nil) {
        self.screen = screen
        composerSeed = seed
        wantsComposerFocus = screen != nil || seed != nil
    }

    func reset() {
        clearThread()
        conversationID = nil
        title = nil
        isMain = true
        conversations = []
        demo = DemoGM()
        lastDemoInput = nil
    }

    /// Empties the thread on screen, ready to load another conversation.
    private func clearThread() {
        turnTask?.cancel()
        turnTask = nil
        rows = []
        mode = .chat
        phase = .idle
        progress = nil
        answers = [:]
        hasLoaded = false
        isLoading = false
        loadFailed = false
        failed = nil
        screen = nil
        wantsComposerFocus = false
        openTextRowID = nil
    }

    // MARK: Conversations

    func loadConversations() async {
        guard let api = app?.api, let list = try? await api.gmConversations() else { return }
        withAnimation(Motion.snappy) { conversations = list }
    }

    /// Opens another conversation. Waits for a reply that's still streaming to finish first.
    func open(_ id: String) async {
        guard id != conversationID, !isBusy, app?.api != nil else { return }
        clearThread()
        conversationID = id
        await load(intake: false)
    }

    /// Starts an empty conversation. The GM knows you the same in every 1.
    func startNew() async {
        guard !isBusy, let api = app?.api else { return }
        do {
            let fresh = try await api.createGMConversation()
            clearThread()
            apply(fresh)
            hasLoaded = true
            await loadConversations()
        } catch {
            app?.shelfError = "Couldn't start a new chat. Try again."
        }
    }

    // MARK: Loading

    /// Loads the conversation once. `intake` picks the demo script; live mode asks the server.
    func load(intake: Bool) async {
        guard !hasLoaded, !isLoading, !isBusy else { return }
        if isDemo {
            mode = intake ? .intake : .chat
            hasLoaded = true
            let beats = demo.opening(intake: intake, firstName: app?.firstName ?? "there")
            mode = demo.mode
            phase = .waiting
            turnTask = Task {
                try? await Task.sleep(for: .milliseconds(450))
                await play(beats)
                finishDemoTurn()
            }
            return
        }
        guard let api = app?.api else { return }
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        do {
            let conversation = try await api.gmConversation(id: conversationID)
            apply(conversation)
            if rows.isEmpty, mode == .intake {
                rows = [greeting()]
            }
            hasLoaded = true
        } catch {
            loadFailed = true
            app?.shelfError = "Couldn't reach your GM. Try again."
        }
    }

    private func apply(_ conversation: GMConversation) {
        mode = conversation.mode
        conversationID = conversation.conversationId
        title = conversation.title
        isMain = conversation.isMain
        let rebuilt = Self.rows(from: conversation.messages)
        var answered = Self.answered(in: rebuilt)
        for (id, picked) in answers where answered[id] != nil {
            answered[id] = picked
        }
        withAnimation(Motion.soft) {
            rows = rebuilt
            answers = answered
        }
        openTextRowID = nil
    }

    /// The intake opener when the server has no messages yet. Shown, not sent.
    private func greeting() -> GMRow {
        var text = StreamedText()
        text.append(
            "Hi \(app?.firstName ?? "there"). I'm your GM. Tell me a bit about what you're into, and I'll take it from there.",
            at: Date().timeIntervalSince(epoch)
        )
        return GMRow(id: "greeting", kind: .gm(text))
    }

    static func rows(from messages: [GMHistoryMessage]) -> [GMRow] {
        var rows: [GMRow] = []
        for message in messages {
            switch message.role {
            case .user:
                let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    rows.append(GMRow(id: message.id, kind: .user(text)))
                }
            case .assistant:
                if !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    var text = StreamedText()
                    text.append(message.text, at: -10_000)
                    rows.append(GMRow(id: message.id, kind: .gm(text)))
                }
                for component in message.components where component.isKnown {
                    rows.append(GMRow(id: "\(message.id)-\(component.id)", kind: .component(component)))
                }
            }
        }
        return rows
    }

    /// Cards the user answers count as answered once anything was said after them.
    static func answered(in rows: [GMRow]) -> [String: [String]] {
        var result: [String: [String]] = [:]
        var userSpokeAfter = false
        for row in rows.reversed() {
            switch row.kind {
            case .user:
                userSpokeAfter = true
            case let .component(component):
                if userSpokeAfter, component.isAnswerable {
                    result[component.id] = []
                }
            case .gm:
                break
            }
        }
        return result
    }

    // MARK: Sending

    func send(text raw: String, addedItemIDs: [String] = []) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isBusy else { return }
        appendUser(text)
        start(
            GMSendRequest(text: text, addedItemIds: addedItemIDs.isEmpty ? nil : addedItemIDs, screen: takeScreen()),
            demoInput: .text(text)
        )
    }

    /// Sends once the GM is free, for news that arrives on its own, like photos landing on
    /// the Shelf while a reply is still streaming. Gives up after a minute.
    func sendWhenIdle(text: String, addedItemIDs: [String] = []) {
        Task {
            let deadline = Date.now.addingTimeInterval(60)
            while isBusy || !hasLoaded, Date.now < deadline {
                try? await Task.sleep(for: .milliseconds(400))
            }
            send(text: text, addedItemIDs: addedItemIDs)
        }
    }

    /// Answers a card. `echo` is what shows on your side of the thread.
    func choose(_ component: GMComponent, optionIDs: [String], echo: String) {
        guard !isBusy, answers[component.id] == nil, !optionIDs.isEmpty else { return }
        answers[component.id] = optionIDs
        appendUser(echo)
        start(
            GMSendRequest(choice: GMChoice(componentId: component.id, optionIds: optionIDs), screen: takeScreen()),
            demoInput: .choice(componentID: component.id, optionIDs: optionIDs)
        )
    }

    /// Answers a card with words instead of a pick, like "None of these".
    func answerInWords(_ component: GMComponent, text: String) {
        guard !isBusy, answers[component.id] == nil else { return }
        answers[component.id] = []
        send(text: text)
    }

    func retry() {
        guard let request = failed, !isBusy else { return }
        userActions += 1
        start(request, demoInput: lastDemoInput ?? .text(request.text ?? ""))
    }

    /// Reloads after a failed first load.
    func reload(intake: Bool) async {
        loadFailed = false
        await load(intake: intake)
    }

    func isAnswered(_ component: GMComponent) -> Bool {
        answers[component.id] != nil
    }

    private func takeScreen() -> String? {
        defer { screen = nil }
        return screen
    }

    private func appendUser(_ text: String) {
        openTextRowID = nil
        userActions += 1
        withAnimation(Motion.bouncy) {
            rows.append(GMRow(id: UUID().uuidString, kind: .user(text)))
        }
    }

    private func start(_ request: GMSendRequest, demoInput: DemoGM.Input) {
        var request = request
        request.conversationId = conversationID
        failed = nil
        lastDemoInput = demoInput
        openTextRowID = nil
        withAnimation(Motion.snappy) { phase = .waiting }
        turnTask = Task { await run(request, demoInput: demoInput) }
    }

    private func run(_ request: GMSendRequest, demoInput: DemoGM.Input) async {
        guard let api = app?.api else {
            try? await Task.sleep(for: .milliseconds(250))
            await play(demo.respond(to: demoInput))
            finishDemoTurn()
            return
        }

        let events: AsyncThrowingStream<GMEvent, any Error>
        do {
            let started = try await api.sendGM(request)
            events = api.gmStream(started.streamId)
        } catch {
            fail(request, message: Self.message(for: error))
            return
        }

        do {
            for try await event in events {
                switch event {
                case let .error(_, message):
                    fail(request, message: message)
                    return
                case .done:
                    await finishLiveTurn(api)
                    return
                default:
                    handle(event)
                }
            }
        } catch is CancellationError {
            settle()
            return
        } catch {
            await recover(request, api: api, error: error)
            return
        }
        // Ended without `done`: the reader already tried to reconnect.
        await recover(request, api: api, error: nil)
    }

    // MARK: Events

    private func handle(_ event: GMEvent) {
        switch event {
        case let .text(delta):
            guard !delta.isEmpty else { return }
            if progress != nil {
                withAnimation(Motion.soft) { progress = nil }
            }
            phase = .streaming
            let arrival = Date().timeIntervalSince(epoch)
            if let openID = openTextRowID,
               let index = rows.firstIndex(where: { $0.id == openID }),
               case var .gm(text) = rows[index].kind {
                text.append(delta, at: arrival)
                rows[index].kind = .gm(text)
            } else {
                var text = StreamedText()
                text.append(delta, at: arrival)
                let row = GMRow(id: UUID().uuidString, kind: .gm(text))
                openTextRowID = row.id
                withAnimation(Motion.bouncy) { rows.append(row) }
            }
        case let .progress(label):
            withAnimation(Motion.soft) { progress = label }
        case let .component(component):
            guard component.isKnown else { return }
            openTextRowID = nil
            withAnimation(Motion.soft) { progress = nil }
            withAnimation(Motion.bouncy) {
                rows.append(GMRow(id: UUID().uuidString, kind: .component(component)))
            }
            if case let .askCard(ask) = component.body {
                app?.upsertAsk(ask)
            }
            if component.touchesContent {
                Task { await app?.refreshAfterGMTurn() }
            }
        case .done, .error:
            break
        }
    }

    private func finishLiveTurn(_ api: APIClient) async {
        settle()
        if mode == .intake || title == nil, let conversation = try? await api.gmConversation(id: conversationID) {
            mode = conversation.mode
            title = conversation.title
        }
        await loadConversations()
        await app?.refreshAfterGMTurn()
    }

    private func finishDemoTurn() {
        settle()
        mode = demo.mode
    }

    private func settle() {
        openTextRowID = nil
        withAnimation(Motion.snappy) {
            progress = nil
            phase = .idle
        }
    }

    private func fail(_ request: GMSendRequest, message: String) {
        settle()
        failed = request
        app?.shelfError = message
    }

    /// The stream broke after the message was sent. The reply may still have finished on the
    /// server, so reload the thread before offering Try again.
    private func recover(_ request: GMSendRequest, api: APIClient, error: (any Error)?) async {
        if let conversation = try? await api.gmConversation(id: conversationID),
           conversation.messages.last?.role == .assistant {
            settle()
            apply(conversation)
            await app?.refreshAfterGMTurn()
            return
        }
        fail(request, message: error.map(Self.message(for:)) ?? "Lost the connection to your GM. Try again.")
    }

    private static func message(for error: any Error) -> String {
        if let apiError = error as? APIError, apiError.status != 0, apiError.status < 500 {
            return apiError.message
        }
        return "Couldn't reach your GM. Try again."
    }

    // MARK: Demo

    private func play(_ beats: [DemoGM.Beat]) async {
        for beat in beats {
            if Task.isCancelled { return }
            switch beat {
            case let .think(label, seconds):
                handle(.progress(label))
                try? await Task.sleep(for: .seconds(seconds))
            case let .say(text):
                for token in demoTokens(text) {
                    try? await Task.sleep(for: .milliseconds(Int.random(in: 15...45)))
                    if Task.isCancelled { return }
                    handle(.text(token))
                }
                openTextRowID = nil
                try? await Task.sleep(for: .milliseconds(200))
            case let .show(component):
                try? await Task.sleep(for: .milliseconds(250))
                handle(.component(component))
            case let .effect(effect):
                switch effect {
                case .loadShelf:
                    if app?.shelf.isEmpty == true { app?.loadDemoShelf() }
                case let .upsertAsk(ask):
                    app?.upsertAsk(ask)
                }
            }
        }
    }
}
