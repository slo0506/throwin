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
        auth = DevAuthService()
        let stored = KeychainStore.load(AuthSession.self, account: Self.sessionAccount)
        session = stored
        phase = stored?.aiConsentAt == nil ? .onboarding : .main
        if case let .live(url) = backend {
            api = APIClient(baseURL: url) { [weak self] in self?.session?.accessToken }
        }
        if phase == .main {
            loadContent()
        }
    }

    var firstName: String { session?.firstName ?? "there" }

    // MARK: Session

    func signIn(firstName: String) async throws {
        let trimmed = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let newSession = try await auth.signIn(firstName: trimmed)
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
            shelf = items
        }
    }

    /// Demo only: fills the Shelf as if a capture had just been appraised.
    func loadDemoShelf() {
        withAnimation(Motion.bouncy) {
            shelf = DemoData.shelf
        }
    }

    func setWillingness(_ willingness: Willingness, for itemID: String) {
        guard let index = shelf.firstIndex(where: { $0.id == itemID }) else { return }
        shelf[index].willingness = willingness
    }

    func removeItem(_ itemID: String) {
        withAnimation(Motion.snappy) {
            shelf.removeAll { $0.id == itemID }
        }
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
