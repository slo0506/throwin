import Foundation
import Security

/// A signed-in session. In live mode the tokens are a Supabase session issued by our API.
nonisolated struct AuthSession: Codable, Equatable, Sendable {
    var userID: String
    var firstName: String
    var email: String?
    var accessToken: String?
    var refreshToken: String?
    /// Unix seconds when `accessToken` expires.
    var expiresAt: TimeInterval?
    var aiConsentAt: Date?

    /// True when the access token is missing or expires within a minute.
    var needsRefresh: Bool {
        guard accessToken != nil, let expiresAt else { return accessToken == nil }
        return Date().timeIntervalSince1970 > expiresAt - 60
    }
}

/// Sign-in provider. v1 ships Sign in with Apple through Supabase's native ID-token flow.
/// Until the Apple Developer account exists, the dev services stand in behind the same API.
protocol AuthService {
    func signIn(firstName: String, email: String?) async throws -> AuthSession
    func refresh(_ session: AuthSession) async throws -> AuthSession
    func signOut() async
}

/// Device-only sign-in for demo mode. No backend involved.
final class DemoAuthService: AuthService {
    func signIn(firstName: String, email: String?) async throws -> AuthSession {
        try? await Task.sleep(for: .milliseconds(450))
        return AuthSession(userID: UUID().uuidString, firstName: firstName, email: email)
    }

    func refresh(_ session: AuthSession) async throws -> AuthSession { session }

    func signOut() async {}
}

/// Email sign-in against `/auth/dev-session`, gated by a shared dev code. Creates real
/// Supabase users, so everything downstream (RLS, the API, the GM) behaves as in production.
final class DevEmailAuthService: AuthService {
    private let baseURL: URL
    private let code: String

    init(baseURL: URL, code: String) {
        self.baseURL = baseURL
        self.code = code
    }

    private nonisolated struct TokenResponse: Decodable, Sendable {
        var accessToken: String
        var refreshToken: String
        var expiresAt: TimeInterval
        var userId: String
    }

    func signIn(firstName: String, email: String?) async throws -> AuthSession {
        guard let email, !email.isEmpty else {
            throw APIError(status: 400, code: "email_required", message: "Add your email to continue.")
        }
        let tokens: TokenResponse = try await post(
            "auth/dev-session",
            ["email": email, "first_name": firstName, "code": code]
        )
        return AuthSession(
            userID: tokens.userId,
            firstName: firstName,
            email: email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt
        )
    }

    func refresh(_ session: AuthSession) async throws -> AuthSession {
        guard let refreshToken = session.refreshToken else {
            throw APIError(status: 401, code: "refresh_failed", message: "Session expired. Sign in again.")
        }
        let tokens: TokenResponse = try await post("auth/refresh", ["refresh_token": refreshToken])
        var updated = session
        updated.accessToken = tokens.accessToken
        updated.refreshToken = tokens.refreshToken
        updated.expiresAt = tokens.expiresAt
        return updated
    }

    func signOut() async {}

    private func post<Response: Decodable>(_ path: String, _ body: [String: String]) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard (200..<300).contains(status) else {
            if let envelope = try? decoder.decode(ErrorEnvelope.self, from: data) {
                throw APIError(status: status, code: envelope.error.code, message: envelope.error.message)
            }
            throw APIError(status: status, code: "http_\(status)", message: "Couldn't sign in. Try again.")
        }
        return try decoder.decode(Response.self, from: data)
    }
}

// TODO(apple-developer): Sign in with Apple, once the paid account and the capability exist.
//
// 1. Add the "Sign in with Apple" capability to the ThrowIn target.
// 2. In Onboarding, replace the dev name and email fields with:
//
//    SignInWithAppleButton(.continue) { request in
//        request.requestedScopes = [.fullName]
//        request.nonce = sha256(nonce)
//    } onCompletion: { result in
//        // Exchange credential.identityToken with Supabase:
//        // POST {SUPABASE_URL}/auth/v1/token?grant_type=id_token { provider: "apple", id_token, nonce }
//    }
//    .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
//    .frame(height: 54)
//    .clipShape(Capsule())
//
// 3. Implement `AppleAuthService: AuthService` and return it from `AppModel.makeAuthService()`.

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
