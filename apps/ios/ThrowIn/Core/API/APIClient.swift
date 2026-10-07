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

    // MARK: Asks

    /// Newest first, without cancelled Asks.
    func asks() async throws -> [Ask] {
        let response: AsksResponse = try await send("GET", "v1/asks")
        return response.asks
    }

    func ask(_ id: String) async throws -> Ask {
        try await send("GET", "v1/asks/\(id)")
    }

    func createAsk(_ request: NewAskRequest) async throws -> Ask {
        try await send("POST", "v1/asks", body: request)
    }

    /// Sends only the fields set on the patch. A non-empty offer set starts prospecting.
    func updateAsk(_ id: String, _ patch: AskPatch) async throws -> Ask {
        try await send("PATCH", "v1/asks/\(id)", body: patch)
    }

    // MARK: Circles

    /// Oldest membership first.
    func circles() async throws -> [APICircle] {
        let response: CirclesResponse = try await send("GET", "v1/circles")
        return response.circles
    }

    func circle(_ id: String) async throws -> APICircleDetail {
        try await send("GET", "v1/circles/\(id)")
    }

    func createCircle(name: String) async throws -> APICircle {
        try await send("POST", "v1/circles", body: NewCircleRequest(name: name))
    }

    /// A fresh code with the defaults (25 uses, 14 days). Any member can make one.
    func createInvite(circleID: String) async throws -> APIInvite {
        try await send("POST", "v1/circles/\(circleID)/invites", body: EmptyBody())
    }

    func invitePreview(_ code: String) async throws -> InvitePreview {
        try await send("GET", "v1/invites/\(code)")
    }

    /// Joins, or returns the Circle if already in it.
    func acceptInvite(_ code: String) async throws -> APICircleDetail {
        try await send("POST", "v1/invites/\(code)/accept", body: EmptyBody())
    }

    // MARK: Deals

    /// Deals waiting on approvals or approved, newest first.
    func deals() async throws -> [APIDealSheet] {
        let response: DealSheetsResponse = try await send("GET", "v1/deals")
        return response.deals
    }

    func approveDeal(_ id: String) async throws -> APIDealSheet {
        try await send("POST", "v1/deals/\(id)/approve", body: EmptyBody())
    }

    func declineDeal(_ id: String, reason: String?) async throws -> APIDealSheet {
        try await send("POST", "v1/deals/\(id)/decline", body: DeclineRequest(reason: reason))
    }

    /// Asks to change a Deal's Items. Everyone else whose side changes answers it.
    func proposeCounter(_ dealID: String, changes: [CounterChange]) async throws -> APIDealSheet {
        try await send("POST", "v1/deals/\(dealID)/counters", body: CounterRequest(changes: changes))
    }

    /// The Deal to show next: a new version once everyone accepted, else the same Deal.
    func answerCounter(_ dealID: String, counterID: String, accept: Bool) async throws -> APIDealSheet {
        try await send(
            "POST",
            "v1/deals/\(dealID)/counters/\(counterID)/\(accept ? "accept" : "decline")",
            body: EmptyBody()
        )
    }

    func withdrawCounter(_ dealID: String, counterID: String) async throws -> APIDealSheet {
        try await send("POST", "v1/deals/\(dealID)/counters/\(counterID)/withdraw", body: EmptyBody())
    }

    // MARK: Next up

    /// The Liaison's open questions to the user.
    func inquiries() async throws -> [Inquiry] {
        let response: InquiriesResponse = try await send("GET", "v1/inquiries")
        return response.inquiries
    }

    func answerInquiry(_ id: String, yes: Bool) async throws {
        let _: InquiryAnswerResult = try await send(
            "POST", "v1/inquiries/\(id)/answer", body: InquiryAnswerRequest(answer: yes ? "yes" : "no")
        )
    }

    /// What needs the user, best first.
    func nextUp() async throws -> [NextUpItem] {
        let response: NextUpResponse = try await send("GET", "v1/next-up")
        return response.items
    }

    // MARK: Taste facts

    func tasteFacts() async throws -> [TasteFact] {
        let response: TasteFactsResponse = try await send("GET", "v1/me/taste-facts")
        return response.facts
    }

    /// The GM never uses a deleted fact again.
    func deleteTasteFact(_ id: String) async throws {
        let _: EmptyResponse = try await send("DELETE", "v1/me/taste-facts/\(id)")
    }

    // MARK: GM

    /// 1 conversation by ID, or the 1 used last (created on the very first call).
    func gmConversation(id: String? = nil) async throws -> GMConversation {
        try await send("GET", "v1/gm/conversation", query: id.map { [URLQueryItem(name: "id", value: $0)] } ?? [])
    }

    /// The user's conversations, most recently used first.
    func gmConversations() async throws -> [GMConversationSummary] {
        let list: GMConversationList = try await send("GET", "v1/gm/conversations")
        return list.conversations
    }

    /// A new, empty conversation.
    func createGMConversation() async throws -> GMConversation {
        try await send("POST", "v1/gm/conversations", body: EmptyBody())
    }

    /// Starts a GM turn. Stream the reply with `gmStream(_:)`.
    func sendGM(_ request: GMSendRequest) async throws -> GMSendResponse {
        try await send("POST", "v1/gm/messages", body: request)
    }

    /// Streams 1 GM turn as typed events. Ends after `done` or `error`. Cancelling the
    /// consuming task closes the connection.
    func gmStream(_ streamID: String) -> AsyncThrowingStream<GMEvent, any Error> {
        let url = baseURL.appending(path: "v1/gm/stream/\(streamID)")
        let urlSession = self.session
        let token: @Sendable (Bool) async throws -> String? = { [weak self] force in
            guard let self else { return nil }
            return try await self.accessToken(force: force)
        }
        return AsyncThrowingStream { continuation in
            let task = Task.detached {
                do {
                    try await EventStreamReader.pump(url: url, session: urlSession, token: token) { event in
                        _ = continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func accessToken(force: Bool) async throws -> String? {
        try await tokenProvider(force)
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
