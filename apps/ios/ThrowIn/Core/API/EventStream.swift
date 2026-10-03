import Foundation

/// 1 server-sent event: its name and its data lines joined with newlines.
nonisolated struct SSEMessage: Equatable, Sendable {
    var event: String
    var data: String
    var id: String?
}

/// Parses a `text/event-stream` line by line (WHATWG rules, the parts we use): `event:` and
/// `data:` fields build an event, a blank line dispatches it, lines starting with `:` are
/// comments (keep-alives) and are ignored.
nonisolated struct SSEParser: Sendable {
    private var event = ""
    private var data: [String] = []
    private var id: String?
    /// The last event ID the server sent, for `Last-Event-ID` on a reconnect.
    private(set) var lastEventID: String?

    /// Feeds 1 line without its line ending. Returns an event when the line completes 1.
    mutating func feed(_ line: String) -> SSEMessage? {
        if line.isEmpty {
            return dispatch()
        }
        if line.hasPrefix(":") {
            return nil
        }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        case "id" where !value.contains("\0"): id = String(value)
        default: break
        }
        return nil
    }

    /// Call when the stream ends. A final event without a trailing blank line is dropped, as
    /// the spec says, because it may be cut off.
    mutating func finish() {
        event = ""
        data = []
    }

    private mutating func dispatch() -> SSEMessage? {
        if let id { lastEventID = id }
        defer {
            event = ""
            data = []
        }
        guard !data.isEmpty else { return nil }
        return SSEMessage(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"), id: id)
    }
}

/// Splits bytes into lines on LF, CRLF or a lone CR. `AsyncBytes.lines` skips blank lines,
/// and blank lines are what end an event, so the stream needs its own splitter.
nonisolated struct LineSplitter: Sendable {
    private var buffer: [UInt8] = []
    private var lastWasCR = false

    /// Feeds 1 byte. Returns a finished line when the byte ends 1.
    mutating func feed(_ byte: UInt8) -> String? {
        switch byte {
        case 0x0A:
            if lastWasCR {
                lastWasCR = false
                return nil
            }
            return flush()
        case 0x0D:
            lastWasCR = true
            return flush()
        default:
            lastWasCR = false
            buffer.append(byte)
            return nil
        }
    }

    private mutating func flush() -> String {
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        return line
    }
}

/// Reads 1 GM turn from `GET /v1/gm/stream/{id}` off the main actor. Refreshes the token once
/// on a 401 and reconnects once on a dropped connection. On the reconnect it sends
/// `Last-Event-ID` when the server gave event IDs; without IDs it assumes the server replays
/// the turn from the start (streams are buffered per turn) and skips what it already saw.
nonisolated enum EventStreamReader {
    static let maxReconnects = 1
    /// Longer than the server's 15 second keep-alive, so a silent connection counts as dropped.
    static let idleTimeout: TimeInterval = 45

    static func pump(
        url: URL,
        session: URLSession,
        token: @Sendable (Bool) async throws -> String?,
        yield: @Sendable (GMEvent) -> Void
    ) async throws {
        var lastEventID: String?
        var delivered = 0
        var reconnects = 0
        while true {
            try Task.checkCancellation()
            let skip = reconnects > 0 && lastEventID == nil ? delivered : 0
            var skipped = 0
            var parser = SSEParser()
            do {
                let bytes = try await open(url, session: session, token: token, lastEventID: lastEventID)
                var splitter = LineSplitter()
                for try await byte in bytes {
                    guard let line = splitter.feed(byte), let message = parser.feed(line) else { continue }
                    if let id = message.id { lastEventID = id }
                    if skipped < skip {
                        skipped += 1
                        continue
                    }
                    delivered += 1
                    guard let event = decode(message) else { continue }
                    yield(event)
                    switch event {
                    case .done, .error: return
                    default: break
                    }
                }
                parser.finish()
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                guard reconnects < maxReconnects, APIClient.isRetryable(error) else { throw error }
                reconnects += 1
                try await Task.sleep(for: .milliseconds(600))
                continue
            }
            // The connection closed before `done` or `error`.
            guard reconnects < maxReconnects else {
                throw APIError(status: 0, code: "stream_dropped", message: "Lost the connection to your GM. Try again.")
            }
            reconnects += 1
            try await Task.sleep(for: .milliseconds(600))
        }
    }

    private static func open(
        _ url: URL,
        session: URLSession,
        token: @Sendable (Bool) async throws -> String?,
        lastEventID: String?
    ) async throws -> URLSession.AsyncBytes {
        var (bytes, status) = try await connect(url, session: session, token: try await token(false), lastEventID: lastEventID)
        if status == 401 {
            (bytes, status) = try await connect(url, session: session, token: try await token(true), lastEventID: lastEventID)
        }
        guard (200..<300).contains(status) else {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count >= 16_384 { break }
            }
            if let envelope = try? makeDecoder().decode(ErrorEnvelope.self, from: body) {
                throw APIError(status: status, code: envelope.error.code, message: envelope.error.message)
            }
            throw APIError(status: status, code: "http_\(status)", message: "Couldn't reach your GM. Try again.")
        }
        return bytes
    }

    private static func connect(
        _ url: URL,
        session: URLSession,
        token: String?,
        lastEventID: String?
    ) async throws -> (URLSession.AsyncBytes, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = idleTimeout
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let lastEventID {
            request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")
        }
        let (bytes, response) = try await session.bytes(for: request)
        return (bytes, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    /// Turns 1 SSE message into a typed event. Unknown event names return nil and are skipped.
    static func decode(_ message: SSEMessage) -> GMEvent? {
        let decoder = makeDecoder()
        let data = Data(message.data.utf8)
        switch message.event {
        case "text":
            return (try? decoder.decode(GMTextDelta.self, from: data)).map { .text($0.delta) }
        case "progress":
            return (try? decoder.decode(GMProgress.self, from: data)).map { .progress($0.label) }
        case "component":
            return (try? decoder.decode(GMComponent.self, from: data)).map { .component($0) }
        case "done":
            return .done(messageID: (try? decoder.decode(GMDone.self, from: data))?.messageId)
        case "error":
            let body = try? decoder.decode(GMStreamError.self, from: data)
            return .error(
                code: body?.code ?? "gm_error",
                message: body?.message ?? "Your GM hit a snag. Try again."
            )
        default:
            return nil
        }
    }
}
