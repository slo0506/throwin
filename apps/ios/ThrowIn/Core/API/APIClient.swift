import Foundation

/// Where the app talks to. Demo mode runs entirely on device with sample data.
nonisolated enum BackendMode: Sendable, Equatable {
    case demo
    case live(apiBaseURL: URL)
}

nonisolated enum AppConfig {
    /// Set `THROWIN_API_BASE_URL` in the scheme's environment (or Info.plist later) to go live.
    static var backend: BackendMode {
        if let raw = ProcessInfo.processInfo.environment["THROWIN_API_BASE_URL"],
           let url = URL(string: raw) {
            return .live(apiBaseURL: url)
        }
        return .demo
    }

    static let inviteHost = "throwin.app"
}

nonisolated struct APIError: Error, LocalizedError, Sendable {
    var status: Int
    var code: String
    var message: String

    var errorDescription: String? { message }
}

private nonisolated struct ErrorEnvelope: Decodable, Sendable {
    nonisolated struct Body: Decodable, Sendable {
        var code: String
        var message: String
    }
    var error: Body
}

/// Minimal client for the public `/v1` API. Adds the bearer token and an Idempotency-Key on
/// every state-changing request, since mobile networks retry.
final class APIClient {
    private let baseURL: URL
    private let tokenProvider: () -> String?
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared, tokenProvider: @escaping () -> String?) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    func me() async throws -> Me {
        try await send("GET", "v1/me")
    }

    func updateMe(_ patch: PatchMe) async throws -> Me {
        try await send("PATCH", "v1/me", body: patch)
    }

    func deleteMe() async throws {
        let _: EmptyResponse = try await send("DELETE", "v1/me")
    }

    func shelf() async throws -> [ShelfItem] {
        let response: ShelfResponse = try await send("GET", "v1/items")
        return response.items
    }

    private nonisolated struct EmptyResponse: Decodable {}
    private nonisolated struct NoBody: Encodable {}

    private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        try await send(method, path, body: Optional<NoBody>.none)
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        body: Body?
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if method != "GET" {
            request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
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
}
