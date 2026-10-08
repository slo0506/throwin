import Foundation

/// Someone in your Circles is looking for an Item you offer for nothing. You see what they
/// offer for it and pick 1 thing you'd take, or pass.
nonisolated struct Interest: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var wanterFirstName: String?
    var askTitle: String
    /// Your Item.
    var item: APIDealItem
    /// What they offer for that Ask.
    var theirOffer: [APIDealItem]
    var expiresAt: String
}

nonisolated struct InterestsResponse: Decodable, Sendable {
    var interests: [Interest]
}

nonisolated struct InterestAnswerRequest: Encodable, Sendable {
    var answer: String
    var wantItemId: String?
}
