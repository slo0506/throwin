import Foundation

/// Where the app talks to. Demo mode runs entirely on device with sample data.
nonisolated enum BackendMode: Sendable, Equatable {
    case demo
    case live(apiBaseURL: URL)
}

nonisolated enum AppConfig {
    /// The dev API on Railway.
    static let defaultAPIBaseURL = URL(string: "https://throwinapi-production.up.railway.app")!

    /// Gate for `/auth/dev-session` until Sign in with Apple ships. Not a secret: it only
    /// keeps strangers off the dev backend, and is removed with dev sign-in before launch.
    static let devAuthCode = "tw-e-Pp4-GJCid7z4hA"

    /// Live by default. Launch with `-demo` (or THROWIN_DEMO=1) for sample data, or set
    /// THROWIN_API_BASE_URL in the scheme to point at another API (for example localhost).
    static var backend: BackendMode {
        let info = ProcessInfo.processInfo
        if info.arguments.contains("-demo") || info.environment["THROWIN_DEMO"] == "1" {
            return .demo
        }
        if let raw = info.environment["THROWIN_API_BASE_URL"], let url = URL(string: raw) {
            return .live(apiBaseURL: url)
        }
        return .live(apiBaseURL: defaultAPIBaseURL)
    }

    static let inviteHost = "throwin.app"
}

nonisolated struct APIError: Error, LocalizedError, Sendable {
    var status: Int
    var code: String
    var message: String

    var errorDescription: String? { message }
}

nonisolated struct ErrorEnvelope: Decodable, Sendable {
    nonisolated struct Body: Decodable, Sendable {
        var code: String
        var message: String
    }
    var error: Body
}

/// Client for the public `/v1` API. Adds a fresh bearer token and an Idempotency-Key on every
/// state-changing request (mobile networks retry), and retries once after a 401.
final class APIClient {
    /// Returns a valid access token, refreshing first when needed. `force` skips the expiry check.
    typealias TokenProvider = (_ force: Bool) async throws -> String?

    private let baseURL: URL
    private let tokenProvider: TokenProvider
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared, tokenProvider: @escaping TokenProvider) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    // MARK: Me

    func me() async throws -> Me {
        try await send("GET", "v1/me")
    }

    func updateMe(_ patch: PatchMe) async throws -> Me {
        try await send("PATCH", "v1/me", body: patch)
    }

    func deleteMe() async throws {
        let _: EmptyResponse = try await send("DELETE", "v1/me")
    }

    // MARK: Shelf

    func shelf() async throws -> [ShelfItem] {
        let response: ShelfResponse = try await send("GET", "v1/items")
        return response.items
    }

    // MARK: Transport

    private nonisolated struct EmptyResponse: Decodable {}
    private nonisolated struct NoBody: Encodable {}

    private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        try await send(method, path, body: Optional<NoBody>.none)
    }

    func send<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        body: Body?
    ) async throws -> Response {
        let idempotencyKey = method == "GET" ? nil : UUID().uuidString
        let bodyData = try body.map { try Self.encoder.encode($0) }

        var (data, status) = try await perform(method, path, bodyData, idempotencyKey, forceRefresh: false)
        if status == 401 {
            (data, status) = try await perform(method, path, bodyData, idempotencyKey, forceRefresh: true)
        }
        guard (200..<300).contains(status) else {
            if let envelope = try? Self.decoder.decode(ErrorEnvelope.self, from: data) {
                throw APIError(status: status, code: envelope.error.code, message: envelope.error.message)
            }
            throw APIError(status: status, code: "http_\(status)", message: "Something went wrong. Try again.")
        }
        if data.isEmpty, let empty = EmptyResponse() as? Response {
            return empty
        }
        return try Self.decoder.decode(Response.self, from: data)
    }

    private func perform(
        _ method: String,
        _ path: String,
        _ body: Data?,
        _ idempotencyKey: String?,
        forceRefresh: Bool
    ) async throws -> (Data, Int) {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = try await tokenProvider(forceRefresh) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
