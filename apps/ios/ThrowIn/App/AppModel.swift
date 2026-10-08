import Observation
import SwiftUI
import UserNotifications

enum AppTab: String, CaseIterable, Identifiable {
    case home, shelf, circles, you

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .shelf: "Shelf"
        case .circles: "Circles"
        case .you: "You"
        }
    }

    var symbol: String {
        switch self {
        case .home: "house"
        case .shelf: "square.grid.2x2"
        case .circles: "circle.hexagongrid"
        case .you: "person.crop.circle"
        }
    }
}

/// Root state for the app. Owns the session and, in demo mode, all sample content.
@Observable
final class AppModel {
    enum Phase: Equatable {
        case onboarding
        case main
    }

    private static let sessionAccount = "current"

    let backend: BackendMode = AppConfig.backend
    private let auth: any AuthService
    private(set) var api: APIClient?

    var phase: Phase
    var session: AuthSession?

    // Navigation
    var tab: AppTab = .home
    var isGMPresented = false
    var presentedDeal: DealSheet?

    /// The GM conversation. Lives here so a turn keeps streaming when the sheet closes, and
    /// so intake and the GM sheet share 1 thread.
    let gm = GMChatModel()

    // Content. Demo mode fills these with sample data.
    var shelf: [ShelfItem] = []
    var asks: [Ask] = []
    var dealsWaiting: [DealSheet] = []
    /// The Liaison's open questions: would an Item close to what you asked for work?
    var inquiries: [Inquiry] = []
    var circles: [TradeCircle] = []
    var tasteFacts: [TasteFact] = []
    /// Which deals the GM brings you, for every Ask. Lives on the profile, not on each Ask.
    private(set) var autonomy: AutonomyLevel = .everyDeal
    var notificationsOn = true
    var approvedDealIDs: Set<String> = []
    /// Home's "Next up", from the server.
    private(set) var nextUp: [NextUpItem] = []

    init() {
        let backend = AppConfig.backend
        auth = Self.makeAuthService(for: backend)
        var stored = KeychainStore.load(AuthSession.self, account: Self.sessionAccount)
        // A demo session can't talk to the live API, and the reverse. Start over on a switch.
        if let current = stored, (current.accessToken == nil) != (backend == .demo) {
            KeychainStore.delete(account: Self.sessionAccount)
            stored = nil
        }
        session = stored
        phase = stored?.aiConsentAt == nil ? .onboarding : .main
        if case let .live(url) = backend {
            api = APIClient(baseURL: url) { [weak self] force in
                try await self?.validAccessToken(force: force)
            }
        }
        gm.attach(self)
        if phase == .main {
            loadContent()
        }
    }

    private static func makeAuthService(for backend: BackendMode) -> any AuthService {
        switch backend {
        case .demo: DemoAuthService()
        case let .live(url): DevEmailAuthService(baseURL: url, code: AppConfig.devAuthCode)
        }
    }

    var isLive: Bool { backend != .demo }

    /// Returns an access token, refreshing it first when it is about to expire.
    func validAccessToken(force: Bool) async throws -> String? {
        guard let current = session, current.accessToken != nil else { return nil }
        guard force || current.needsRefresh else { return current.accessToken }
        do {
            let refreshed = try await auth.refresh(current)
            session = refreshed
            KeychainStore.save(refreshed, account: Self.sessionAccount)
            return refreshed.accessToken
        } catch let error as APIError where error.status == 401 {
            signOutLocally()
            throw error
        }
    }

    var firstName: String { session?.firstName ?? "there" }

    // MARK: Session

    func signIn(firstName: String, email: String?) async throws {
        let trimmed = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanEmail = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let newSession = try await auth.signIn(firstName: trimmed, email: cleanEmail)
        session = newSession
        KeychainStore.save(newSession, account: Self.sessionAccount)
    }

    func recordAIConsent() {
        guard var current = session else { return }
        current.aiConsentAt = Date()
        session = current
        KeychainStore.save(current, account: Self.sessionAccount)
    }

    func finishOnboarding() {
        loadContent()
        withAnimation(Motion.soft) {
            phase = .main
            tab = .home
        }
    }

    /// Starts account deletion (PRD: in-app deletion, App Store 5.1.1(v)).
    func deleteAccount() async throws {
        if let api {
            try await api.deleteMe()
        }
        await auth.signOut()
        signOutLocally()
    }

    func signOut() async {
        await auth.signOut()
        signOutLocally()
    }

    /// Clears the session and content and returns to onboarding.
    func signOutLocally() {
        KeychainStore.delete(account: Self.sessionAccount)
        session = nil
        shelf = []
        questions = []
        asks = []
        dealsWaiting = []
        nextUp = []
        circles = []
        tasteFacts = []
        approvedDealIDs = []
        captures = []
        captureDraft = nil
        askRevisions = [:]
        showsPushPrompt = false
        gm.reset()
        isGMPresented = false
        presentedDeal = nil
        withAnimation(Motion.soft) {
            phase = .onboarding
        }
    }

    // MARK: Content

    func loadContent() {
        if isLive {
            Task {
                await refreshAsks()
                await loadTasteFacts()
            }
            Task { await refreshMe() }
            Task { await refreshCircles() }
            Task { await refreshDeals() }
        } else {
            dealsWaiting = [DemoData.deal]
            circles = DemoData.circles
            // Keep the Ask the demo intake made, if there is 1.
            if asks.isEmpty { asks = [DemoData.ask] }
            if tasteFacts.isEmpty { tasteFacts = DemoData.tasteFacts }
            considerPushPrompt()
        }
        Task { await refreshShelf() }
    }

    // MARK: GM

    /// Opens the GM sheet. `screen` tells the GM where it was opened from, like `new_ask`,
    /// and focuses the composer.
    /// `seed` starts the composer with words the user can finish, like "About the Galaxy trade: ".
    func openGM(screen: String? = nil, seed: String? = nil) {
        gm.prepare(screen: screen, seed: seed)
        isGMPresented = true
    }

    /// A GM turn may have made or changed an Ask or an Item.
    func refreshAfterGMTurn() async {
        guard isLive else { return }
        await refreshAsks()
        await refreshShelf()
        await refreshNextUp()
    }

    // MARK: Asks

    /// Bumped on every local edit, so a slow response never overwrites a newer change.
    private var askRevisions: [String: Int] = [:]

    func refreshAsks() async {
        guard let api else { return }
        guard let fetched = try? await api.asks() else { return }
        withAnimation(Motion.bouncy) {
            asks = fetched.filter { $0.status != .cancelled }
        }
        considerPushPrompt()
    }

    /// Adds or replaces an Ask, newest first. A cancelled Ask leaves the list.
    func upsertAsk(_ ask: Ask) {
        withAnimation(Motion.bouncy) {
            if ask.status == .cancelled {
                asks.removeAll { $0.id == ask.id }
            } else if let index = asks.firstIndex(where: { $0.id == ask.id }) {
                asks[index] = ask
            } else {
                asks.insert(ask, at: 0)
            }
        }
        considerPushPrompt()
    }

    /// Changes an Ask right away and saves it. Rolls the change back if the save fails.
    func updateAsk(_ id: String, _ patch: AskPatch) {
        guard let index = asks.firstIndex(where: { $0.id == id }) else { return }
        let previous = asks[index]
        let revision = (askRevisions[id] ?? 0) + 1
        askRevisions[id] = revision
        withAnimation(Motion.snappy) { patch.apply(to: &asks[index]) }
        guard let api else {
            demoSettle(id)
            return
        }
        Task {
            do {
                let updated = try await api.updateAsk(id, patch)
                guard askRevisions[id] == revision else { return }
                upsertAsk(updated)
            } catch {
                shelfError = "Couldn't save that. Try again."
                guard askRevisions[id] == revision else {
                    await refreshAsks()
                    return
                }
                if let i = asks.firstIndex(where: { $0.id == id }) {
                    withAnimation(Motion.snappy) { patch.revert(&asks[i], to: previous) }
                }
            }
        }
    }

    /// Cancels an Ask. It leaves the list right away and comes back if the save fails.
    func cancelAsk(_ id: String) {
        guard let index = asks.firstIndex(where: { $0.id == id }) else { return }
        let removed = asks[index]
        withAnimation(Motion.snappy) { _ = asks.remove(at: index) }
        guard let api else { return }
        Task {
            do {
                _ = try await api.updateAsk(id, AskPatch(status: .cancelled))
            } catch {
                withAnimation(Motion.snappy) {
                    if !asks.contains(where: { $0.id == id }) {
                        asks.insert(removed, at: min(index, asks.count))
                    }
                }
                shelfError = "Couldn't cancel that. Try again."
            }
        }
    }

    /// Demo only: what the server does after an edit. A non-empty offer set starts the search.
    private func demoSettle(_ id: String) {
        guard let index = asks.firstIndex(where: { $0.id == id }) else { return }
        var ask = asks[index]
        let offered = (shelf + DemoData.shelf).filter { ask.offerItemIds.contains($0.id) }
        let unique = Dictionary(offered.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }).values
        let values = unique.compactMap(\.value)
        ask.offerValue = values.isEmpty ? nil : CentsRange(
            lowCents: values.reduce(0) { $0 + $1.lowCents },
            highCents: values.reduce(0) { $0 + $1.highCents }
        )
        if ask.offerItemIds.isEmpty {
            if ask.status == .prospecting {
                ask.status = .offering
                ask.statusLine = AskStatus.offering.fallbackLine
            }
        } else if ask.status == .drafting || ask.status == .offering {
            ask.status = .prospecting
            ask.statusLine = DemoData.prospectingLines[0]
        }
        withAnimation(Motion.snappy) { asks[index] = ask }
    }

    // MARK: Push permission (PRD first-time experience, step 7)

    /// Shown once the first Ask exists: "I'll ping you when I find a deal."
    var showsPushPrompt = false
    private static let pushAskedKey = "throwin.pushPermissionAsked"

    func considerPushPrompt() {
        guard !asks.isEmpty, !showsPushPrompt, !UserDefaults.standard.bool(forKey: Self.pushAskedKey) else { return }
        Task {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            guard status == .notDetermined else {
                UserDefaults.standard.set(true, forKey: Self.pushAskedKey)
                return
            }
            guard !asks.isEmpty, session != nil else { return }
            withAnimation(Motion.bouncy) { showsPushPrompt = true }
        }
    }

    /// Asks iOS for permission only when the user says yes here. Either way, never asks again.
    func answerPushPrompt(allow: Bool) {
        UserDefaults.standard.set(true, forKey: Self.pushAskedKey)
        withAnimation(Motion.snappy) { showsPushPrompt = false }
        guard allow else { return }
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        }
    }

    // MARK: Taste facts

    func loadTasteFacts() async {
        guard let api, let facts = try? await api.tasteFacts() else { return }
        withAnimation(Motion.snappy) { tasteFacts = facts }
    }

    func refreshShelf() async {
        guard let api else { return }
        if let items = try? await api.shelf() {
            withAnimation(Motion.bouncy) { shelf = items }
            followShelfAppraisals()
        }
    }

    private var followingShelf = false

    // MARK: Captures

    /// Photos sent to the Appraiser, newest first. The app follows them here rather than in
    /// the capture sheet, so closing the sheet never stops anything: progress shows on the
    /// Shelf, and in the chat when the GM asked for the photo.
    private(set) var captures: [CaptureModel] = []

    /// Photos in the capture tray that haven't been sent. Kept when the sheet closes, so a
    /// swipe down never loses them; the next capture sheet picks up where this 1 left off.
    @ObservationIgnored private var captureDraft: CaptureModel?

    /// The tray for the capture sheet: the unsent draft, or a fresh 1. Safe to call while a
    /// view is being drawn: it changes nothing anything observes.
    func draftCapture() -> CaptureModel {
        if let captureDraft, captureDraft.phase == .collecting {
            return captureDraft
        }
        let fresh = CaptureModel()
        captureDraft = fresh
        return fresh
    }

    /// Sends a capture and follows it to the end. `onLanded` gets the new Items once, on
    /// success, so the GM can carry on with exactly those.
    func submitCapture(_ capture: CaptureModel, onLanded: (([ShelfItem]) -> Void)? = nil) {
        guard let api else { return }
        if captureDraft === capture { captureDraft = nil }
        if !captures.contains(where: { $0 === capture }) {
            withAnimation(Motion.bouncy) { captures.insert(capture, at: 0) }
        }
        Task {
            await capture.submit(using: api)
            await refreshShelf()
            guard case let .finished(items, _) = capture.phase else { return }
            await loadQuestions()
            await refreshNextUp()
            onLanded?(items)
            // Items landed: stay long enough to see it and tap Tune up, then clear. "Nothing
            // to trade in these" stays until dismissed, so the advice isn't missed.
            guard !items.isEmpty else { return }
            try? await Task.sleep(for: .seconds(8))
            dismissCapture(capture)
        }
    }

    /// Takes the card off the Shelf. A capture still sending or being read can't be dismissed.
    func dismissCapture(_ capture: CaptureModel) {
        guard !capture.phase.isBusy else { return }
        withAnimation(Motion.soft) { captures.removeAll { $0 === capture } }
    }

    /// Sends the same photos again after a failure.
    func retryCapture(_ capture: CaptureModel) {
        capture.retry()
        submitCapture(capture)
    }

    /// While anything on the Shelf is being priced or re-read, keeps the Shelf fresh (every
    /// 3 seconds, for up to 3 minutes) so each card's scan stops when the GM is done with it.
    private func followShelfAppraisals() {
        guard !followingShelf, shelf.contains(where: \.isAppraising) else { return }
        followingShelf = true
        Task {
            defer { followingShelf = false }
            let deadline = Date.now.addingTimeInterval(180)
            while Date.now < deadline {
                try? await Task.sleep(for: .seconds(3))
                guard let api, let items = try? await api.shelf() else { continue }
                withAnimation(Motion.bouncy) { shelf = items }
                if !items.contains(where: \.isAppraising) { return }
            }
        }
    }

    // MARK: Profile

    func refreshMe() async {
        guard let api, let me = try? await api.me() else { return }
        autonomy = me.profile.autonomyLevel
    }

    /// Saves which deals the GM brings you. Rolls back if the server says no.
    func setAutonomy(_ level: AutonomyLevel) {
        guard level != autonomy else { return }
        let previous = autonomy
        withAnimation(Motion.bouncy) { autonomy = level }
        guard let api else { return }
        Task {
            do {
                let me = try await api.updateMe(PatchMe(autonomyLevel: level))
                autonomy = me.profile.autonomyLevel
                await refreshAsks()
            } catch {
                withAnimation(Motion.snappy) { autonomy = previous }
                shelfError = "Couldn't save that. Try again."
            }
        }
    }

    /// Demo only: fills the Shelf as if a capture had just been appraised, with a few Tune up
    /// questions waiting.
    func loadDemoShelf() {
        withAnimation(Motion.bouncy) {
            shelf = DemoData.shelf
            questions = DemoData.questions
        }
    }

    /// Last write error, shown as a quiet banner. Optimistic changes roll back on failure.
    var shelfError: String?

    func setWillingness(_ willingness: Willingness, for itemID: String) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        let previous = shelf[index].willingness
        shelf[index].willingness = willingness
        guard let api else { return }
        Task {
            do {
                replace(try await api.updateItem(itemID, ItemPatch(willingness: willingness)))
            } catch {
                if let i = shelf.firstIndex(where: { $0.id == itemID }) { shelf[i].willingness = previous }
                shelfError = "Couldn't save that. Try again."
            }
        }
    }

    /// Fixes the GM's read of an Item. Shows the change right away and rolls it back if the
    /// save fails, like `setWillingness`.
    func editItem(_ itemID: String, title: String, conditionGrade: ConditionGrade?) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        let previous = shelf[index]
        var patch = ItemPatch()
        let cleanTitle = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxTitleLength))
        if !cleanTitle.isEmpty, cleanTitle != previous.title {
            patch.title = cleanTitle
        }
        if let conditionGrade, conditionGrade != previous.conditionGrade {
            patch.conditionGrade = conditionGrade
        }
        guard patch.title != nil || patch.conditionGrade != nil else { return }

        withAnimation(Motion.snappy) {
            if let title = patch.title { shelf[index].title = title }
            if let grade = patch.conditionGrade { shelf[index].conditionGrade = grade }
        }
        guard let api else { return }
        Task {
            do {
                replace(try await api.updateItem(itemID, patch))
            } catch {
                if let i = shelf.firstIndex(where: { $0.id == itemID }) {
                    withAnimation(Motion.snappy) {
                        if patch.title != nil { shelf[i].title = previous.title }
                        if patch.conditionGrade != nil { shelf[i].conditionGrade = previous.conditionGrade }
                    }
                }
                shelfError = "Couldn't save that. Try again."
            }
        }
    }

    static let maxTitleLength = 120

    /// Items whose re-read is being followed right now, so 2 screens don't poll the same 1.
    private var followingAppraisal: Set<String> = []

    /// Uploads 1 to 5 photos and attaches them to the Item, so the Appraiser takes another
    /// look. The Item comes back with `isAppraising` true; call `followAppraisal` to follow it.
    /// Returns false (and shows the quiet banner) if sending failed.
    func sendPhotos(_ frames: [PreparedFrame], to itemID: String) async -> Bool {
        let frames = Array(frames.prefix(Self.maxItemPhotos))
        guard let api, !frames.isEmpty else { return false }
        do {
            let slots = try await api.requestItemUploads(itemID, count: frames.count)
            guard slots.uploads.count == frames.count else {
                throw APIError(status: 0, code: "upload_mismatch", message: "Couldn't send that photo. Try again.")
            }
            try await api.uploadAll(zip(frames, slots.uploads).map { (jpeg: $0.jpeg, url: $1.uploadUrl) })
            let media = zip(frames, slots.uploads).map { frame, slot in
                CaptureMediaInput(path: slot.path, width: frame.width, height: frame.height, sharpness: frame.sharpness)
            }
            let updated = try await api.addItemMedia(itemID, media)
            withAnimation(Motion.soft) { replace(updated) }
        } catch is CancellationError {
            return false
        } catch {
            shelfError = (error as? APIError)?.status == 409
                ? "Your GM is already looking at this, or it's part of a deal."
                : "Couldn't send that photo. Try again."
            return false
        }
        return true
    }

    static let maxItemPhotos = 5

    /// Sends the Showcase shoot. In demo mode the GM "looks" for a moment and the Item
    /// becomes Ready to show.
    func sendShowcase(_ frames: [PreparedFrame], to itemID: String) async -> Bool {
        guard api != nil else {
            demoShowcase(itemID)
            return true
        }
        let sent = await sendPhotos(frames, to: itemID)
        if sent {
            // The shoot answers any open photo question for this Item.
            withAnimation(Motion.snappy) {
                let photoQuestions = questions.filter { $0.itemId == itemID && $0.kind == .photo }
                questions.removeAll { $0.itemId == itemID && $0.kind == .photo }
                adjustOpenQuestions(itemID, by: -photoQuestions.count)
            }
        }
        return sent
    }

    // MARK: Tune up

    /// Open Refiner questions across the Shelf, best first.
    var questions: [Question] = []

    /// Every open question on the Shelf, for the Tune up badge.
    var tuneUpCount: Int { shelf.reduce(0) { $0 + max(0, $1.openQuestions) } }

    /// Fetches open questions, for the whole Shelf or 1 Item. Keeps what we have on failure.
    func loadQuestions(for itemID: String? = nil) async {
        guard let api, let fetched = try? await api.questions(itemID: itemID) else { return }
        withAnimation(Motion.snappy) {
            guard let itemID else {
                questions = fetched
                return
            }
            let position = questions.firstIndex { $0.itemId == itemID } ?? questions.count
            questions.removeAll { $0.itemId == itemID }
            questions.insert(contentsOf: fetched, at: min(position, questions.count))
        }
    }

    func topQuestion(for itemID: String) -> Question? {
        questions.first { $0.itemId == itemID }
    }

    /// Answers (or, with nil, skips) a question. It leaves the list right away; if the save
    /// fails it comes back, the quiet banner shows, and this returns false.
    @discardableResult
    func answer(_ question: Question, with answer: String?) async -> Bool {
        let index = questions.firstIndex { $0.id == question.id }
        withAnimation(Motion.snappy) {
            if let index { questions.remove(at: index) }
            adjustOpenQuestions(question.itemId, by: -1)
        }
        guard let api else {
            if answer != nil { demoRefine(question.itemId) }
            return true
        }
        do {
            let item: ShelfItem
            if let answer {
                item = try await api.answerQuestion(question.id, answer: answer)
            } else {
                item = try await api.skipQuestion(question.id)
            }
            withAnimation(Motion.bouncy) { replace(item) }
            if item.isAppraising {
                Task { await followAppraisal(item.id) }
            }
            return true
        } catch {
            withAnimation(Motion.snappy) {
                if !questions.contains(where: { $0.id == question.id }) {
                    questions.insert(question, at: min(index ?? 0, questions.count))
                }
                adjustOpenQuestions(question.itemId, by: 1)
            }
            shelfError = "Couldn't save that answer. Try again."
            return false
        }
    }

    private func adjustOpenQuestions(_ itemID: String, by delta: Int) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        shelf[index].openQuestions = max(0, shelf[index].openQuestions + delta)
    }

    /// Demo only: the Refiner takes a moment, then, once an Item has no questions left,
    /// confirms it and narrows its range.
    private func demoRefine(_ itemID: String) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        shelf[index].isAppraising = true
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            guard let i = shelf.firstIndex(where: { $0.id == itemID }) else { return }
            withAnimation(Motion.bouncy) {
                shelf[i].isAppraising = false
                guard topQuestion(for: itemID) == nil, shelf[i].readiness == .logged else { return }
                shelf[i].readiness = .identified
                if let value = shelf[i].value {
                    let mid = value.midCents
                    shelf[i].value = ValueRange(
                        lowCents: mid - (mid - value.lowCents) / 2,
                        midCents: mid,
                        highCents: mid + (value.highCents - mid) / 2
                    )
                }
            }
        }
    }

    /// Demo only: the showcase photos land and the Item is Ready to show.
    private func demoShowcase(_ itemID: String) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        withAnimation(Motion.snappy) {
            shelf[index].isAppraising = true
            let photoQuestions = questions.filter { $0.itemId == itemID && $0.kind == .photo }
            questions.removeAll { $0.itemId == itemID && $0.kind == .photo }
            adjustOpenQuestions(itemID, by: -photoQuestions.count)
        }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            guard let i = shelf.firstIndex(where: { $0.id == itemID }) else { return }
            withAnimation(Motion.bouncy) {
                shelf[i].isAppraising = false
                shelf[i].photoScore = 84
                shelf[i].photoIssues = []
                shelf[i].missingAngles = []
                shelf[i].studioAllowed = true
                if topQuestion(for: itemID) == nil {
                    shelf[i].readiness = .showcase
                }
            }
        }
    }

    /// Polls the Item every 2 seconds while the Appraiser re-reads it, for up to 3 minutes,
    /// keeping the Shelf in step. Rides out a few dropped requests.
    func followAppraisal(_ itemID: String) async {
        guard let api, !followingAppraisal.contains(itemID) else { return }
        followingAppraisal.insert(itemID)
        defer { followingAppraisal.remove(itemID) }

        let deadline = Date.now.addingTimeInterval(180)
        var misses = 0
        while Date.now < deadline {
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
            do {
                let item = try await api.item(itemID)
                misses = 0
                withAnimation(Motion.bouncy) { replace(item) }
                if !item.isAppraising {
                    // The Refiner may have new questions, or none, now.
                    await loadQuestions(for: itemID)
                    return
                }
            } catch let error as APIError where error.status == 404 {
                withAnimation(Motion.snappy) { shelf.removeAll { $0.id == itemID } }
                return
            } catch {
                misses += 1
                if misses >= 4 {
                    shelfError = "Couldn't check on that. Pull to refresh in a bit."
                    return
                }
            }
        }
        shelfError = "This is taking a while. It'll update on your Shelf when it's ready."
    }

    func removeItem(_ itemID: String) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        let removed = shelf[index]
        withAnimation(Motion.snappy) {
            _ = shelf.remove(at: index)
            questions.removeAll { $0.itemId == itemID }
        }
        guard let api else { return }
        Task {
            do {
                try await api.deleteItem(itemID)
            } catch {
                withAnimation(Motion.snappy) { shelf.insert(removed, at: min(index, shelf.count)) }
                shelfError = (error as? APIError)?.status == 409
                    ? "That's part of a deal right now, so it has to stay."
                    : "Couldn't remove that. Try again."
            }
        }
    }

    private func replace(_ item: ShelfItem) {
        if let index = shelf.firstIndex(where: { $0.id == item.id }) { shelf[index] = item }
    }

    /// Forgets a fact right away. It comes back, with the quiet banner, if the delete fails.
    func deleteTasteFact(_ id: String) {
        guard let index = tasteFacts.firstIndex(where: { $0.id == id }) else { return }
        let removed = tasteFacts[index]
        withAnimation(Motion.snappy) { _ = tasteFacts.remove(at: index) }
        guard let api else { return }
        Task {
            do {
                try await api.deleteTasteFact(id)
            } catch let error as APIError where error.status == 404 {
                // Already gone.
            } catch {
                withAnimation(Motion.snappy) {
                    if !tasteFacts.contains(where: { $0.id == id }) {
                        tasteFacts.insert(removed, at: min(index, tasteFacts.count))
                    }
                }
                shelfError = "Couldn't forget that. Try again."
            }
        }
    }

    // MARK: Circles

    /// The user's Circles with their rosters. A Circle whose roster fails to load still shows,
    /// with just its member count.
    func refreshCircles() async {
        guard let api else { return }
        guard let listed = try? await api.circles() else { return }
        var loaded: [TradeCircle] = []
        for circle in listed {
            if let detail = try? await api.circle(circle.id) {
                loaded.append(TradeCircle(detail))
            } else {
                loaded.append(TradeCircle(circle))
            }
        }
        withAnimation(Motion.bouncy) { circles = loaded }
    }

    /// Starts a Circle with the user as its owner.
    func createCircle(named name: String) async throws {
        guard let api else {
            let circle = TradeCircle(
                id: UUID().uuidString,
                name: name,
                members: [Person(id: "me", name: firstName, hue: 2)],
                memberCount: 1,
                isOwner: true,
                inviteURL: URL(string: "https://\(AppConfig.inviteHost)/i/DEMO")
            )
            withAnimation(Motion.bouncy) { circles.append(circle) }
            return
        }
        _ = try await api.createCircle(name: name)
        await refreshCircles()
    }

    /// A link to share. Live Circles get a fresh code each time, so old links can expire
    /// without stranding anyone.
    func inviteLink(for circle: TradeCircle) async throws -> URL {
        guard let api else {
            return circle.inviteURL ?? URL(string: "https://\(AppConfig.inviteHost)")!
        }
        let invite = try await api.createInvite(circleID: circle.id)
        return Self.inviteURL(code: invite.code)
    }

    nonisolated static func inviteURL(code: String) -> URL {
        URL(string: "https://\(AppConfig.inviteHost)/i/\(code)")!
    }

    /// Accepts a pasted link or a bare code.
    nonisolated static func inviteCode(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let code = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        guard (6...32).contains(code.count), code.unicodeScalars.allSatisfy(allowed.contains) else {
            return nil
        }
        return code
    }

    func previewInvite(_ code: String) async throws -> InvitePreview {
        guard let api else {
            return InvitePreview(code: code, circleName: "Thursday Lego Circle", inviterFirstName: "Jordan", memberCount: 5, status: .open)
        }
        return try await api.invitePreview(code)
    }

    func joinCircle(code: String) async throws {
        guard let api else { return }
        _ = try await api.acceptInvite(code)
        await refreshCircles()
        // A new Circle means new Shelves to match against.
        await refreshDeals()
    }

    // MARK: Deals

    func refreshDeals() async {
        guard let api else { return }
        guard let fetched = try? await api.deals() else { return }
        withAnimation(Motion.bouncy) {
            dealsWaiting = fetched.map(DealSheet.init)
            approvedDealIDs = Set(dealsWaiting.filter { $0.myApproval == .approved }.map(\.id))
        }
        await refreshNextUp()
    }

    /// Re-reads Home's "Next up". Called after anything that can change it.
    func refreshNextUp() async {
        guard let api, let items = try? await api.nextUp() else { return }
        withAnimation(Motion.bouncy) { nextUp = items }
        if items.contains(where: { $0.kind == .answerInquiry }) {
            inquiries = (try? await api.inquiries()) ?? inquiries
        }
    }

    /// Yes makes the guess a want and your GM looks again; no keeps it away from that Ask.
    func answerInquiry(_ inquiry: Inquiry, yes: Bool) async throws {
        guard let api else { return }
        try await api.answerInquiry(inquiry.id, yes: yes)
        withAnimation(Motion.bouncy) { inquiries.removeAll { $0.id == inquiry.id } }
        await refreshNextUp()
    }

    /// Call only after the device confirmation (Face ID or passcode) succeeded.
    func approve(_ deal: DealSheet) async throws {
        guard let api else {
            markApproved(deal)
            return
        }
        let updated = DealSheet(try await api.approveDeal(deal.id))
        replaceDeal(updated)
        approvedDealIDs.insert(updated.id)
        if updated.status == .approved { await refreshAsks() }
    }

    /// Cancels the Deal for everyone. The GM keeps looking, and won't offer this Item again.
    func decline(_ deal: DealSheet, reason: String?) async throws {
        if let api {
            _ = try await api.declineDeal(deal.id, reason: reason)
        }
        withAnimation(Motion.bouncy) { dealsWaiting.removeAll { $0.id == deal.id } }
        if isLive { await refreshAsks() }
    }

    /// Sends a counter the GM staged. Everyone else whose side changes answers it on their
    /// Deal Sheet; until then nobody can approve.
    @discardableResult
    func sendCounter(dealID: String, changes: [CounterChange]) async throws -> DealSheet? {
        guard let api else { return nil }
        let updated = DealSheet(try await api.proposeCounter(dealID, changes: changes))
        replaceDeal(updated)
        await refreshNextUp()
        return updated
    }

    /// Accepting the last open answer makes a new version that everyone approves again, so
    /// the Deal on screen moves to it. Declining leaves the Deal as it was.
    func answerCounter(_ deal: DealSheet, accept: Bool) async throws {
        guard let api, let counter = deal.counter else { return }
        let next = DealSheet(try await api.answerCounter(deal.id, counterID: counter.id, accept: accept))
        if next.id != deal.id {
            withAnimation(Motion.bouncy) {
                dealsWaiting.removeAll { $0.id == deal.id }
                dealsWaiting.insert(next, at: 0)
            }
            if presentedDeal?.id == deal.id { presentedDeal = next }
        } else {
            replaceDeal(next)
        }
        await refreshDeals()
    }

    func withdrawCounter(_ deal: DealSheet) async throws {
        guard let api, let counter = deal.counter else { return }
        replaceDeal(DealSheet(try await api.withdrawCounter(deal.id, counterID: counter.id)))
        await refreshNextUp()
    }

    private func replaceDeal(_ deal: DealSheet) {
        if let index = dealsWaiting.firstIndex(where: { $0.id == deal.id }) {
            dealsWaiting[index] = deal
        }
        if presentedDeal?.id == deal.id { presentedDeal = deal }
    }

    func markApproved(_ deal: DealSheet) {
        approvedDealIDs.insert(deal.id)
        if let index = asks.firstIndex(where: { $0.id == DemoData.ask.id }) {
            asks[index].status = .accepted
        }
    }
}
