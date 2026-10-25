import Foundation

// Mirrors src/shared/remote/protocol.ts (aegis.remote.v1). Keep in sync.

public let remoteProtocol = "aegis.remote.v1"
/// Upload chunks stay well under the relay's 256 KB message cap.
public let attachmentChunkBytes = 96 * 1024

public enum RemoteEnvironment: String, Codable, Sendable {
    case development, production, fixture

    public var label: String {
        switch self {
        case .development: return "Aegis Dev"
        case .production: return "Aegis"
        case .fixture: return "Fixture"
        }
    }

    /// The environment this build talks to; a pairing code can't change it.
    public static var native: RemoteEnvironment {
        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }
}

public struct RemoteTaskSettings: Codable, Equatable, Hashable, Sendable {
    public var model: String?
    public var effort: String?
    public var fast: Bool?
    public var permissionMode: String?
    public var plan: Bool?

    public init(model: String? = nil, effort: String? = nil,
                fast: Bool? = nil, permissionMode: String? = nil, plan: Bool? = nil) {
        self.model = model
        self.effort = effort
        self.fast = fast
        self.permissionMode = permissionMode
        self.plan = plan
    }
}

public struct RemoteProject: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    /// Git repository: the hero says "build" instead of "work on".
    public let isRepo: Bool?
}

public struct RemoteSession: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let provider: String
    public let status: String
    public let updatedAt: Double
    public let runId: String?
    public let handoffSourceProvider: String?
    public let settings: RemoteTaskSettings?
    /// Pinned in the desktop sidebar.
    public let pinned: Bool?

    public var isPinned: Bool { pinned == true }
    public var isRunning: Bool { runId != nil || status == "running" || status == "stopping" }
    public var isFailed: Bool { status == "error" || status == "failed" }
}

public struct RemoteMessage: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let streaming: Bool?
    public let at: Double?
    /// Size-bounded copy of the desktop stream message.
    public let raw: JSONValue?
}

public struct RemotePermission: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let requestId: String
    public let sessionId: String
    public let runId: String
    public let toolName: String
    public let detail: String
    /// Allow needs nothing else. False for questions and plans, which carry their own fields.
    public let canApprove: Bool
    /// The agent is asking (newer Macs). Answered with allow plus `answers`.
    public let questions: [RemoteQuestion]?
    /// A plan to approve (allow) or keep planning on (deny), from newer Macs.
    public let plan: RemotePlan?
    public var id: String { requestId }

    public init(
        requestId: String, sessionId: String, runId: String, toolName: String, detail: String, canApprove: Bool,
        questions: [RemoteQuestion]? = nil, plan: RemotePlan? = nil
    ) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.runId = runId
        self.toolName = toolName
        self.detail = detail
        self.canApprove = canApprove
        self.questions = questions
        self.plan = plan
    }

    public enum Kind: Sendable { case approval, question, plan, desktop }
    public var kind: Kind {
        if let questions, !questions.isEmpty { return .question }
        if plan != nil { return .plan }
        return canApprove ? .approval : .desktop
    }
}

/// A question as the desktop's question card shows it. Every question also takes free "Other" text.
public struct RemoteQuestion: Codable, Equatable, Hashable, Sendable {
    public struct Option: Codable, Equatable, Hashable, Sendable {
        public let label: String
        public let description: String?
        public init(label: String, description: String? = nil) {
            self.label = label
            self.description = description
        }
    }
    public let question: String
    public let header: String?
    public let options: [Option]
    public let multiSelect: Bool?
    public var allowsMany: Bool { multiSelect == true }

    public init(question: String, header: String? = nil, options: [Option], multiSelect: Bool? = nil) {
        self.question = question
        self.header = header
        self.options = options
        self.multiSelect = multiSelect
    }
}

public struct RemotePlan: Codable, Equatable, Hashable, Sendable {
    /// Markdown; empty when the Mac didn't see the plan itself (it is in the task above).
    public let markdown: String
    /// Cut off for the phone: approve it on the Mac.
    public let truncated: Bool?
    public init(markdown: String, truncated: Bool? = nil) {
        self.markdown = markdown
        self.truncated = truncated
    }
}

/// One question's answer: option labels as listed, in the order picked, plus "Other" text.
public struct QuestionAnswer: Equatable, Hashable, Sendable {
    public var selected: [String]
    public var other: String

    public init(selected: [String] = [], other: String = "") {
        self.selected = selected
        self.other = other
    }

    public var trimmedOther: String { other.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isAnswered: Bool { !selected.isEmpty || !trimmedOther.isEmpty }

    /// Picks an option: toggles it for multi-select, else replaces the answer (and any "Other" text).
    public mutating func pick(_ label: String, many: Bool) {
        if many {
            if let index = selected.firstIndex(of: label) { selected.remove(at: index) } else { selected.append(label) }
        } else {
            selected = selected == [label] ? [] : [label]
            other = ""
        }
    }

    /// Types "Other" text; for single-select it replaces the picked option.
    public mutating func type(_ text: String, many: Bool) {
        other = text
        if !many, !trimmedOther.isEmpty { selected = [] }
    }

    public var json: JSONValue {
        var object: [String: JSONValue] = ["selected": .array(selected.map { .string($0) })]
        if !trimmedOther.isEmpty { object["other"] = .string(trimmedOther) }
        return .object(object)
    }
}

extension RemotePermission {
    /// The `permission` command for a decision; answers go with an allow on a question.
    public func command(_ decision: String, answers: [String: QuestionAnswer]? = nil) -> [String: JSONValue] {
        var request: [String: JSONValue] = [
            "method": "permission", "sessionId": .string(sessionId), "runId": .string(runId),
            "requestId": .string(requestId), "decision": .string(decision),
        ]
        if let answers, decision == "allow" {
            request["answers"] = .object(answers.filter { $0.value.isAnswered }.mapValues(\.json))
        }
        return request
    }
}

public struct RemoteSnapshot: Codable, Equatable, Sendable {
    public let `protocol`: String
    public let hostBootId: String
    public let machineName: String
    public let environment: RemoteEnvironment
    public let serverTime: Double
    public var projects: [RemoteProject]
    public var sessions: [RemoteSession]
    public var permissions: [RemotePermission]
    public var sessionId: String?
    public var messages: [RemoteMessage]?
    public var before: Double?
    public var revision: String
    public var historyRevision: String?
    /// Committed messages in the session on the Mac (Macs that push events).
    public var historyCount: Int?
    /// `messages` follow the tail the phone sent, from this index.
    public var appendFrom: Int?
    /// The last event sent before this snapshot.
    public var seq: Int?
}

/// A session's loaded history on the phone.
public struct SessionHistory: Codable, Equatable, Sendable {
    /// Committed messages, oldest first. The reply being streamed is `live`.
    public var messages: [RemoteMessage]
    /// Streamed text the Mac hasn't committed yet.
    public var live: String?
    /// Cursor for the page before `messages`; nil once the start is loaded.
    public var before: Double?
    public var historyRevision: String?
    /// Committed messages on the Mac; nil from Macs that don't sync by tail.
    public var count: Int?
    public var hostBootId: String
    /// Changes whenever `messages` do, so views compare one number instead of the messages.
    public var version: Int

    public init(messages: [RemoteMessage], live: String? = nil, before: Double? = nil, historyRevision: String? = nil,
                count: Int? = nil, hostBootId: String, version: Int) {
        self.messages = messages
        self.live = live
        self.before = before
        self.historyRevision = historyRevision
        self.count = count
        self.hostBootId = hostBootId
        self.version = version
    }
}

/// Everything in a snapshot but a session's messages, as an event carries it.
public struct RemoteState: Codable, Equatable, Sendable {
    public let projects: [RemoteProject]
    public let sessions: [RemoteSession]
    public let permissions: [RemotePermission]
}

/// Where the Mac listens on its own networks.
public struct RemoteLan: Codable, Equatable, Sendable {
    public let port: Int
    public let addresses: [String]
}

/// A change the Mac pushes to phones that asked for events (src/shared/remote/protocol.ts RemoteEvent).
public struct RemoteEvent: Decodable, Sendable {
    public struct History: Decodable, Sendable {
        public let sessionId: String
        public let messages: [RemoteMessage]
        public let appendFrom: Int?
        public let before: Double?
        public let count: Int
        public let revision: String
    }
    public struct Live: Decodable, Sendable {
        public enum Change: Equatable, Sendable { case append(String), replace(String?) }
        public let sessionId: String
        public let change: Change

        private enum Keys: String, CodingKey { case sessionId, append, text }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            sessionId = try c.decode(String.self, forKey: .sessionId)
            if let append = try c.decodeIfPresent(String.self, forKey: .append) {
                change = .append(append)
            } else {
                // "text": null clears it.
                change = .replace(try c.decodeIfPresent(String.self, forKey: .text))
            }
        }
    }
    public let seq: Int
    public let state: RemoteState?
    public let history: History?
    public let live: Live?
}

public struct CommandResult: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case accepted, completed, rejected, unknown }
    public let commandId: String
    public var state: State
    public var sessionId: String?
    public var error: String?

    public var unresolved: Bool { state == .unknown || state == .accepted }
}

public struct RemoteFileEntry: Codable, Equatable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case dir, file }
    public let name: String
    /// Relative to the project root, with forward slashes.
    public let path: String
    public let kind: Kind
    public var id: String { path }
}

public struct RemoteFileContent: Codable, Equatable, Sendable {
    public let path: String
    public let size: Double
    /// Nil for binary files.
    public let text: String?
    public let truncated: Bool
}

/// APNs registration a paired Mac uses to notify this phone.
public struct PushRegistration: Equatable, Sendable {
    /// Hex APNs device token.
    public let deviceToken: String
    /// The app's bundle id.
    public let topic: String
    /// `development` (sandbox) or `production`, matching the aps-environment entitlement.
    public let environment: String

    public init(deviceToken: String, topic: String, environment: String) {
        self.deviceToken = deviceToken
        self.topic = topic
        self.environment = environment
    }
}

public struct RemoteAttachment: Codable, Equatable, Sendable {
    public let attachmentId: String
    public let name: String
    public let size: Double
    public let kind: String
    public let mimeType: String
}

/// A journaled mutation (create/send/stop/permission) and what the Mac said about it.
/// How long the Mac accepts a command after the phone made it (ms).
public let remoteCommandLifetime: Double = 300_000

public struct RemoteOperation: Codable, Equatable, Sendable {
    public var request: JSONValue
    public var result: CommandResult

    public var method: String? { request["method"]?.stringValue }
    /// When the phone made it, on the Mac's clock.
    public var sentAt: Double? { request["expiresAt"]?.numberValue.map { $0 - remoteCommandLifetime } }
    public var sessionId: String? { request["sessionId"]?.stringValue }
    public var prompt: String? { request["prompt"]?.stringValue }
}

public struct Pairing: Codable, Equatable, Sendable {
    public let version: Int
    public let environment: RemoteEnvironment
    public let relay: String
    public let room: String
    public let routeToken: String
    public let hostPeerId: String
    public var invite: String?
    public var expiresAt: Double?
    public let name: String

    /// Accepts the `aegis(-dev)://pair#<json>` link or raw JSON.
    public static func parse(_ value: String, now: Date = Date()) throws -> Pairing {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let json: String
        if raw.hasPrefix("{") {
            json = raw
        } else {
            guard let hash = raw.firstIndex(of: "#"),
                  let decoded = String(raw[raw.index(after: hash)...]).removingPercentEncoding else {
                throw AegisError.message("That isn’t an Aegis pairing link.")
            }
            json = decoded
        }
        let pairing: Pairing
        do { pairing = try JSONDecoder().decode(Pairing.self, from: Data(json.utf8)) } catch {
            throw AegisError.message("That isn’t an Aegis pairing link.")
        }
        try pairing.validate(now: now)
        return pairing
    }

    func validate(now: Date) throws {
        let invalid = AegisError.message("That isn’t an Aegis pairing link.")
        guard version == 1,
              room.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              (32...128).contains(routeToken.count),
              (20...160).contains(hostPeerId.count),
              name.count <= 100,
              let url = URL(string: relay), let scheme = url.scheme else { throw invalid }
        if let invite, !(32...128).contains(invite.count) { throw invalid }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
        guard scheme == "wss" || (scheme == "ws" && loopback) else {
            throw AegisError.message("The relay must use WSS.")
        }
        if invite != nil, (expiresAt ?? 0) < now.timeIntervalSince1970 * 1000 {
            throw AegisError.message("This pairing code expired. Generate a new one on your Mac.")
        }
    }
}
