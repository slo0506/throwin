import Foundation
import Security

/// A signed-in session. In live mode `accessToken` is a Supabase JWT.
nonisolated struct AuthSession: Codable, Equatable, Sendable {
    var userID: String
    var firstName: String
    var accessToken: String?
    var aiConsentAt: Date?
}

/// Sign-in provider. v1 ships Sign in with Apple through Supabase's native ID-token flow;
/// until the Apple Developer account exists, `DevAuthService` stands in behind the same API.
protocol AuthService {
    func signIn(firstName: String) async throws -> AuthSession
    func signOut() async
}

/// Local, device-only sign-in for the Simulator and demo mode.
final class DevAuthService: AuthService {
    func signIn(firstName: String) async throws -> AuthSession {
        try? await Task.sleep(for: .milliseconds(450))
        return AuthSession(userID: UUID().uuidString, firstName: firstName, accessToken: nil, aiConsentAt: nil)
    }

    func signOut() async {}
}

// TODO(apple-developer): Sign in with Apple, once the paid account and the capability exist.
//
// 1. Add the "Sign in with Apple" capability to the ThrowIn target.
// 2. In Onboarding, replace the dev name field with:
//
//    SignInWithAppleButton(.continue) { request in
//        request.requestedScopes = [.fullName]
//        request.nonce = sha256(nonce)
//    } onCompletion: { result in
//        // Exchange credential.identityToken with Supabase:
//        // supabase.auth.signInWithIdToken(credentials: .init(provider: .apple, idToken: token, nonce: nonce))
//    }
//    .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
//    .frame(height: 54)
//    .clipShape(Capsule())
//
// 3. Implement `AppleAuthService: AuthService` and swap it in `AppModel.makeAuthService()`.

/// Small Keychain wrapper for the session. Tokens never go to UserDefaults.
nonisolated enum KeychainStore {
    private static let service = "app.throwin.ios.session"

    static func save<T: Encodable>(_ value: T, account: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func load<T: Decodable>(_ type: T.Type, account: String) -> T? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
