import Observation
import SwiftUI

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

    // Content (demo mode until the API grows these endpoints)
    var shelf: [ShelfItem] = []
    var asks: [Ask] = []
    var dealsWaiting: [DealSheet] = []
    var circles: [TradeCircle] = []
    var tasteFacts: [TasteFact] = []
    var autonomy: AutonomyLevel = .everyDeal
    var notificationsOn = true
    var approvedDealIDs: Set<String> = []

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
        asks = []
        dealsWaiting = []
        circles = []
        tasteFacts = []
        approvedDealIDs = []
        isGMPresented = false
        presentedDeal = nil
        withAnimation(Motion.soft) {
            phase = .onboarding
        }
    }

    // MARK: Content

    func loadContent() {
        asks = [DemoData.ask]
        dealsWaiting = [DemoData.deal]
        circles = DemoData.circles
        tasteFacts = DemoData.tasteFacts
        Task { await refreshShelf() }
    }

    func refreshShelf() async {
        guard let api else { return }
        if let items = try? await api.shelf() {
            withAnimation(Motion.bouncy) { shelf = items }
        }
    }

    /// Demo only: fills the Shelf as if a capture had just been appraised.
    func loadDemoShelf() {
        withAnimation(Motion.bouncy) {
            shelf = DemoData.shelf
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

    /// The user says the GM's read is right, so a needs_photos Item goes up on the Shelf.
    func confirmItem(_ itemID: String) async {
        guard let api else { return }
        do {
            let updated = try await api.updateItem(itemID, ItemPatch(confirm: true))
            withAnimation(Motion.bouncy) { replace(updated) }
        } catch {
            shelfError = "Couldn't save that. Try again."
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

    /// Answers the GM's photo request: uploads 1 to 5 photos, attaches them to the Item, and
    /// follows the re-read. Returns false (and shows the quiet banner) if sending failed.
    @discardableResult
    func addPhotos(_ frames: [PreparedFrame], to itemID: String) async -> Bool {
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
        await followAppraisal(itemID)
        return true
    }

    static let maxItemPhotos = 5

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
                if !item.isAppraising { return }
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

    func deleteTasteFact(_ id: String) {
        withAnimation(Motion.snappy) {
            tasteFacts.removeAll { $0.id == id }
        }
    }

    func markApproved(_ deal: DealSheet) {
        approvedDealIDs.insert(deal.id)
        if let index = asks.firstIndex(where: { $0.id == DemoData.ask.id }) {
            asks[index].status = .accepted
        }
    }
}
