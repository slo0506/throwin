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

    func updateItem(_ id: String, _ patch: ItemPatch) async throws -> ShelfItem {
        try await send("PATCH", "v1/items/\(id)", body: patch)
    }

    func deleteItem(_ id: String) async throws {
        let _: EmptyResponse = try await send("DELETE", "v1/items/\(id)")
    }

    func item(_ id: String) async throws -> ShelfItem {
        try await send("GET", "v1/items/\(id)")
    }

    /// Reserves 1 signed upload URL per new photo for an Item (1 to 5).
    func requestItemUploads(_ id: String, count: Int) async throws -> ItemUploadResponse {
        try await send("POST", "v1/items/\(id)/media/uploads", body: ItemUploadRequest(count: count))
    }

    /// Attaches uploaded photos so the Appraiser takes another look. Returns the Item with
    /// `isAppraising` true. 409: reserved by a Deal or already appraising.
    func addItemMedia(_ id: String, _ media: [CaptureMediaInput]) async throws -> ShelfItem {
        try await send("POST", "v1/items/\(id)/media", body: ItemMediaRequest(media: media))
    }

    // MARK: Refinement

    /// Open Tune up questions, best first. Pass an Item to get only its questions.
    func questions(itemID: String? = nil) async throws -> [Question] {
        let query = itemID.map { [URLQueryItem(name: "item_id", value: $0)] } ?? []
        let response: QuestionsResponse = try await send("GET", "v1/questions", query: query)
        return response.questions
    }

    /// Answers a question. Returns the Item, usually with `isAppraising` true while the
    /// Refiner updates it.
    func answerQuestion(_ id: String, answer: String) async throws -> ShelfItem {
        let response: AnswerResponse = try await send("POST", "v1/questions/\(id)/answer", body: AnswerRequest(answer: answer))
        return response.item
    }

    func skipQuestion(_ id: String) async throws -> ShelfItem {
        let response: AnswerResponse = try await send("POST", "v1/questions/\(id)/answer", body: AnswerRequest(skip: true))
        return response.item
    }

    // MARK: Capture

    /// Reserves a capture and returns 1 signed upload URL per photo.
    func requestUploads(count: Int) async throws -> UploadResponse {
        try await send("POST", "v1/media/uploads", body: UploadRequest(count: count))
    }

    /// Waits between upload attempts. Mobile networks drop out for a moment, then come back.
    static let uploadBackoff: [Duration] = [.milliseconds(500), .seconds(2), .seconds(5)]
    static let maxConcurrentUploads = 4

    /// PUTs JPEG bytes straight to storage. The signed URL is the credential, so no bearer token.
    /// Retries up to 3 times on network errors and 5xx, waiting 0.5, 2, then 5 seconds.
    func upload(_ jpeg: Data, to url: URL) async throws {
        var attempt = 0
        while true {
            do {
                try await putOnce(jpeg, to: url)
                return
            } catch {
                guard attempt < Self.uploadBackoff.count, Self.isRetryable(error) else {
                    if error is CancellationError || error is APIError { throw error }
                    throw APIError(status: 0, code: "upload_failed", message: "A photo didn't upload. Check your connection and try again.")
                }
                try await Task.sleep(for: Self.uploadBackoff[attempt])
                attempt += 1
            }
        }
    }

    /// Uploads every photo, at most 4 at a time, and reports each 1 that lands.
    func uploadAll(_ jobs: [(jpeg: Data, url: URL)], onProgress: (_ done: Int) -> Void = { _ in }) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            var next = 0
            var done = 0
            while next < jobs.count || done < next {
                // Keep up to 4 in flight, then wait for 1 to land before starting the next.
                if next < jobs.count, next - done < Self.maxConcurrentUploads {
                    let job = jobs[next]
                    next += 1
                    group.addTask { try await self.upload(job.jpeg, to: job.url) }
                    continue
                }
                guard try await group.next() != nil else { break }
                done += 1
                onProgress(done)
            }
        }
    }

    private func putOnce(_ jpeg: Data, to url: URL) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.upload(for: request, from: jpeg)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw APIError(status: status, code: "upload_failed", message: "A photo didn't upload. Try again.")
        }
    }

    /// Network errors and server errors are worth another try. 4xx and cancellation are not.
    nonisolated static func isRetryable(_ error: any Error) -> Bool {
        if let apiError = error as? APIError { return apiError.status >= 500 || apiError.status == 0 }
        if let urlError = error as? URLError { return urlError.code != .cancelled }
        return false
    }

    func submitCapture(_ request: CaptureRequest) async throws -> Capture {
        try await send("POST", "v1/captures", body: request)
    }

    func capture(_ id: String) async throws -> Capture {
        try await send("GET", "v1/captures/\(id)")
    }

    // MARK: Transport

    private nonisolated struct EmptyResponse: Decodable {}
    private nonisolated struct NoBody: Encodable {}

    private func send<Response: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = []) async throws -> Response {
        try await send(method, path, body: Optional<NoBody>.none, query: query)
    }

    func send<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        body: Body?,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        let idempotencyKey = method == "GET" ? nil : UUID().uuidString
        let bodyData = try body.map { try Self.encoder.encode($0) }

        var (data, status) = try await perform(method, path, query, bodyData, idempotencyKey, forceRefresh: false)
        if status == 401 {
            (data, status) = try await perform(method, path, query, bodyData, idempotencyKey, forceRefresh: true)
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
        _ query: [URLQueryItem],
        _ body: Data?,
        _ idempotencyKey: String?,
        forceRefresh: Bool
    ) async throws -> (Data, Int) {
        var url = baseURL.appending(path: path)
        if !query.isEmpty {
            url.append(queryItems: query)
        }
        var request = URLRequest(url: url)
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
