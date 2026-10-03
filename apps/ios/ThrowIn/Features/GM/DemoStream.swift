import Foundation

/// Splits text into token-sized chunks (roughly how a model streams): words with their
/// trailing space, long words split in 2.
nonisolated func demoTokens(_ text: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    for character in text {
        current.append(character)
        if character == " " || character == "," || character == "." {
            tokens.append(current)
            current = ""
        } else if current.count >= 7 {
            tokens.append(current)
            current = ""
        }
    }
    if !current.isEmpty {
        tokens.append(current)
    }
    return tokens
}

/// Streams `text` into `streamed`, token by token, with model-like jitter (15 to 45 ms).
func streamDemoText(
    _ text: String,
    epoch: Date,
    into update: (String, TimeInterval) -> Void
) async {
    for token in demoTokens(text) {
        let delay = Int.random(in: 15...45)
        try? await Task.sleep(for: .milliseconds(delay))
        if Task.isCancelled { return }
        update(token, Date().timeIntervalSince(epoch))
    }
}
