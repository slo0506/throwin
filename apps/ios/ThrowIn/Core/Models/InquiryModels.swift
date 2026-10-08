import Foundation

/// The Liaison's question: would an Item close to what you asked for work? Someone in your
/// Circles has it; who isn't said until there's a Deal Sheet.
nonisolated struct Inquiry: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var askId: String
    var askTitle: String
    var item: APIDealItem
    var expiresAt: String
}

nonisolated struct InquiriesResponse: Decodable, Sendable {
    var inquiries: [Inquiry]
}

nonisolated struct InquiryAnswerRequest: Encodable, Sendable {
    var answer: String
}

nonisolated struct InquiryAnswerResult: Decodable, Sendable {
    var result: String
}
