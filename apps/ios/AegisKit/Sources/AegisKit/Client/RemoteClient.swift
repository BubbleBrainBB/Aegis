import CryptoKit
import Foundation
import Network
import Observation

/// The phone side of aegis.remote.v1: pairing, the encrypted connection to the
/// Mac (directly on the same network, otherwise through the relay), snapshots and
/// pushed events, history pages, journaled mutations and uploads.
@MainActor
@Observable
public final class RemoteClient {
    public enum Connection: String, Sendable { case unpaired, connecting, confirming, connected, offline }
    public enum Freshness: String, Sendable { case cached, catchingUp, current }
    /// How the connection reaches the Mac.
    public enum Transport: String, Sendable { case relay, direct }

    public private(set) var connection: Connection = .unpaired
    public private(set) var freshness: Freshness = .cached
    public private(set) var transport: Transport?
    /// The session list; a session's messages are in `messagesBySession`.
    public private(set) var snapshot: RemoteSnapshot?
    /// Agent catalog from the Mac (models, efforts, fast mode); forwarded to the shared JS logic.
    public private(set) var agentOptions: JSONValue?
    public private(set) var messagesBySession: [String: SessionHistory] = [:]
    public private(set) var pairing: Pairing?
    public var error = ""
    public private(set) var peerId = ""
    public private(set) var selectedSession: String?
    public private(set) var operations: [String: RemoteOperation] = [:]

    public let environment: RemoteEnvironment
    private let secrets: SecretStore
    public let files: FileStore
    private let deviceName: String
    private let openWire: @Sendable (URL, TimeInterval) async throws -> WireConnection

    /// The connection in use.
    @ObservationIgnored private var link: Link?
    /// A direct connection being set up while the relay one serves; it takes over once authenticated.
    @ObservationIgnored private var upgradeLink: Link?
    /// The connection generation an upgrade attempt belongs to.
    @ObservationIgnored private var upgrading: Int?
    @ObservationIgnored private var linkIds = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var reconnectAttempt = 0
    @ObservationIgnored private var refreshTimer: Task<Void, Never>?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var pending: [String: Pending] = [:]
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var serverOffset: Double = 0
    /// When the Mac last said anything; pings answer every few seconds, so silence means a stalled path.
    @ObservationIgnored private var lastHeard: Double = 0
    /// Sessions whose loaded history must be replaced, not extended, on the next snapshot.
    @ObservationIgnored private var untrusted = Set<String>()
    /// Where the Mac listens on its own networks (from its last authentication).
    @ObservationIgnored private var lan: RemoteLan?
    /// A direct attempt failed at this time; the relay alone is used for a while.
    @ObservationIgnored private var directFailedAt: Double = 0
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    @ObservationIgnored private var pathKey: String?
    /// On Wi-Fi or Ethernet, where the Mac's private addresses may be reachable.
    @ObservationIgnored private var onLocalNetwork = false
    /// Through a VPN (Tailscale and the like), where its 100.64/10 address may be.
    @ObservationIgnored private var onVPN = false
    @ObservationIgnored private var cacheTask: Task<Void, Never>?
    /// Commands awaiting the Mac's answer right now.
    private var inFlight = Set<String>()

    /// Unconfirmed commands no request is waiting on: the Mac didn't answer in time,
    /// or the connection dropped. reconcile() delivers them; the app shows these.
    public var stalledCount: Int {
        operations.filter { $0.value.result.unresolved && !inFlight.contains($0.key) }.count
    }

    /// A request for this command is waiting on the Mac's answer right now.
    public func isInFlight(_ commandId: String) -> Bool { inFlight.contains(commandId) }
    @ObservationIgnored private var reconciling = false
    /// The first snapshot on each connection to an older Mac is fetched in full (it may have restarted).
    @ObservationIgnored private var fullRefresh = true
    /// Set while the app is in the background: no polls, no reconnects (the Keychain is
    /// locked with the phone), and the Mac keeps sending push notifications.
    @ObservationIgnored private var backgroundSince: Double?

    private struct Pending {
        let continuation: CheckedContinuation<Data, Error>
        let timer: Task<Void, Never>
        let link: Int
    }

    /// One encrypted connection to the Mac.
    private final class Link {
        let id: Int
        let transport: Transport
        let wire: WireConnection
        let channel: SecureChannel
        /// The Mac pushes events here (it answered auth with a snapshot); older Macs say `changed`.
        var events = false
        var lastSeq = 0
        /// An event went missing: later ones are held until a snapshot catches up.
        var resyncing = false
        /// Snapshot requests sent on this link and not yet settled. The Mac bases later events
        /// on each one, and its reply (decoded off the main thread) can land after them.
        var snapshotsInFlight = 0
        /// Events held while a snapshot is in flight or missing; applied on top of it once it lands.
        var log: [RemoteEvent] = []

        init(id: Int, transport: Transport, wire: WireConnection, channel: SecureChannel) {
            self.id = id
            self.transport = transport
            self.wire = wire
            self.channel = channel
        }

        func close() {
            wire.close()
            let channel = self.channel
            Task { await channel.close() }
        }
    }

    public init(
        environment: RemoteEnvironment = .native,
        secrets: SecretStore = KeychainStore(),
        files: FileStore = FileStore(),
        deviceName: String = "iPhone",
        openWire: @escaping @Sendable (URL, TimeInterval) async throws -> WireConnection = { url, timeout in
            let socket = RelaySocket(url: url)
            do { try await socket.waitOpen(timeout: timeout) } catch {
                socket.close()
                throw error
            }
            return socket
        }
    ) {
        self.environment = environment
        self.secrets = secrets
        self.files = files
        self.deviceName = deviceName
        self.openWire = openWire
    }

    private static var now: Double { Date().timeIntervalSince1970 * 1000 }
    private static let journalFile = "operations.json"
    /// Cache and address files are written here, in order, off the main thread.
    private static let fileQueue = DispatchQueue(label: "ai.aegis.client-files", qos: .utility)
    private static var versions = 0
    /// A process-wide counter, so a version names one exact list of messages.
    private static func nextVersion() -> Int {
        versions += 1
        return versions
    }
    private func cacheName(_ host: String) -> String { "cache-" + host + ".json" }
    private func lanName(_ host: String) -> String { "lan-" + host + ".json" }
    public func draftName(_ key: String) -> String { "draft-" + (pairing?.hostPeerId ?? "") + "-" + key }

    // MARK: Lifecycle

    public func start() async {
        do {
            guard let stored = try secrets.get("pairing") else { return }
            let pairing = try JSONDecoder().decode(Pairing.self, from: Data(stored.utf8))
            try checkEnvironment(pairing)
            self.pairing = pairing
            lan = files.read(lanName(pairing.hostPeerId)).flatMap { try? JSONDecoder().decode(RemoteLan.self, from: $0) }
            if let data = files.read(cacheName(pairing.hostPeerId)),
               let cache = await Self.decoded(Cache.self, from: data) {
                snapshot = cache.snapshot
                messagesBySession = cache.messages.mapValues { history in
                    var history = history
                    history.version = Self.nextVersion()
                    return history
                }
            }
            if let data = files.read(Self.journalFile) {
                operations = (try? JSONDecoder().decode([String: RemoteOperation].self, from: data)) ?? [:]
            } else if let journal = try? secrets.get("operations") {
                // Older builds kept it in the Keychain, which can't be written while the phone is locked.
                operations = (try? JSONDecoder().decode([String: RemoteOperation].self, from: Data(journal.utf8))) ?? [:]
                saveOperations()
                try? secrets.remove("operations")
            }
            await connect()
        } catch {
            self.error = "Couldn’t restore the connection. Pair again."
        }
    }

    private struct Cache: Codable, Sendable {
        var snapshot: RemoteSnapshot
        var messages: [String: SessionHistory]
    }

    private func checkEnvironment(_ pairing: Pairing) throws {
        guard pairing.environment == environment else {
            throw AegisError.message("This app only connects to \(environment.label). Use a pairing code from that desktop app.")
        }
    }

    public func pair(_ value: String) async throws {
        let offer = try Pairing.parse(value)
        try checkEnvironment(offer)
        await disconnect(forget: true)
        pairing = offer
        try secrets.set("pairing", String(decoding: try JSONEncoder.aegis.encode(offer), as: UTF8.self))
        await connect()
    }

    public func disconnect(forget: Bool = false) async {
        generation += 1
        retry?.cancel()
        refreshTimer?.cancel()
        poll?.cancel()
        closeLinks()
        upgrading = nil
        failPending(AegisError.connection("Disconnected"))
        refreshing = false
        connection = forget ? .unpaired : .offline
        freshness = .cached
        if forget {
            cacheTask?.cancel()
            cacheTask = nil
            if let host = pairing?.hostPeerId {
                let files = self.files
                let names = [cacheName(host), lanName(host)]
                // After any cache write already queued.
                Self.fileQueue.async { names.forEach(files.remove) }
                files.removeAll(prefix: "draft-" + host + "-")
            }
            try? secrets.remove("pairing")
            try? secrets.remove("operations")
            files.remove(Self.journalFile)
            pairing = nil
            lan = nil
            snapshot = nil
            messagesBySession = [:]
            untrusted = []
            operations = [:]
            selectedSession = nil
        }
    }

    private func closeLinks() {
        let links = [link, upgradeLink].compactMap { $0 }
        link = nil
        upgradeLink = nil
        transport = nil
        links.forEach { $0.close() }
    }

    /// Fails waiting requests: all of them, or those sent on one connection.
    private func failPending(_ error: Error, link: Int? = nil) {
        let failing = pending.filter { link == nil || $0.value.link == link }
        for (id, item) in failing {
            pending[id] = nil
            item.timer.cancel()
            item.continuation.resume(throwing: error)
        }
    }

    private func loadIdentity() throws -> Identity {
        if let raw = try secrets.get("identity"),
           let identity = try? JSONDecoder().decode(Identity.self, from: Data(raw.utf8)) {
            return identity
        }
        let identity = Identity.create()
        try secrets.set("identity", String(decoding: try JSONEncoder.aegis.encode(identity), as: UTF8.self))
        return identity
    }

    /// Starts (or restarts) the connection; returns once it is under way.
    public func connect() async {
        guard pairing != nil else { return }
        await disconnect()
        watchPath()
        let generation = self.generation
        connection = .connecting
        error = ""
        Task { await self.run(generation) }
    }

    /// One connection attempt: direct or relay (whichever answers first), Noise, then
    /// auth and the message loop until it closes.
    private func run(_ generation: Int) async {
        guard generation == self.generation, let offer = pairing else { return }
        let identity: Identity
        do { identity = try loadIdentity() } catch {
            self.error = error.localizedDescription
            closed(generation)
            return
        }
        peerId = identity.peerId
        var tried: Transport?
        let link: Link
        // Which network this is decides which addresses to try; the first reading comes quickly.
        for _ in 0..<15 where pathKey == nil { try? await Task.sleep(for: .milliseconds(20)) }
        guard generation == self.generation else { return }
        do {
            guard let relay = URL(string: offer.relay) else { throw AegisError.message("Invalid relay") }
            let direct = directURLs()
            // On the Mac's network the direct path answers within milliseconds; give it that head start.
            let headStart = onLocalNetwork || direct.contains { $0.host == "127.0.0.1" } ? 0.3 : 0
            let opened = try await Self.race(hello: hello(offer), directHello: directHello(offer), direct: direct, relay: relay, headStart: headStart, deadline: 20, openWire: openWire)
            tried = opened.transport
            guard generation == self.generation else { opened.wire.close(); return }
            link = try await handshake(opened, identity: identity, offer: offer)
            guard generation == self.generation else { link.close(); return }
        } catch {
            // A direct path that answered but failed is skipped next time; that retry is immediate.
            if tried == .direct { directFailedAt = Self.now }
            if generation == self.generation, !Self.isTransient(error) {
                self.error = error.localizedDescription
            }
            closed(generation, quick: tried == .direct)
            return
        }
        self.link = link
        transport = link.transport
        connection = .confirming
        await serve(link, generation, invite: offer.invite)
    }

    private func hello(_ offer: Pairing) -> String {
        let hello: JSONValue = .object(["role": "phone", "room": .string(offer.room), "token": .string(offer.routeToken)])
        return String(decoding: (try? JSONEncoder.aegis.encode(hello)) ?? Data(), as: UTF8.self)
    }

    /// Direct connections are plain ws:// on networks that may not be the Mac's, so they
    /// carry a token derived from the route token instead of the relay credential itself.
    private func directHello(_ offer: Pairing) -> String {
        let hello: JSONValue = .object(["role": "phone", "token": .string(Self.lanToken(offer.routeToken))])
        return String(decoding: (try? JSONEncoder.aegis.encode(hello)) ?? Data(), as: UTF8.self)
    }

    /// HMAC-SHA256(routeToken, "aegis.lan/1") in hex, as the desktop's lanToken().
    nonisolated static func lanToken(_ routeToken: String) -> String {
        HMAC<SHA256>.authenticationCode(for: Data("aegis.lan/1".utf8), using: SymmetricKey(data: Data(routeToken.utf8)))
            .map { String(format: "%02x", $0) }.joined()
    }

    private func handshake(_ opened: Opened, identity: Identity, offer: Pairing) async throws -> Link {
        let channel = try await SecureChannel.open(wire: opened.wire, identity: identity, initiator: true, expectedPeer: offer.hostPeerId)
        linkIds += 1
        return Link(id: linkIds, transport: opened.transport, wire: opened.wire, channel: channel)
    }

    /// Authenticates on `link` and handles what the Mac sends until it closes.
    private func serve(_ link: Link, _ generation: Int, invite: String?) async {
        var failure: Error?
        do {
            try await link.channel.sendJSON(.object(authMessage(invite: invite)))
            for try await body in link.channel.messages {
                guard generation == self.generation else { break }
                if link === self.link { lastHeard = Self.now }
                // Parsed off the main thread; only applying the result runs here.
                guard let message = await Self.decoded(Incoming.self, from: body) else { continue }
                guard generation == self.generation else { break }
                if try await handle(message, body: body, link: link, generation: generation) { break }
            }
        } catch {
            failure = error
        }
        ended(link, generation, failure)
    }

    private func ended(_ link: Link, _ generation: Int, _ failure: Error?) {
        link.close()
        failPending(AegisError.connection("Connection lost. Checking whether it was delivered."), link: link.id)
        if link === upgradeLink {
            // The direct connection didn't make it; the relay one carries on.
            upgradeLink = nil
            directFailedAt = Self.now
        }
        guard link === self.link, generation == self.generation else { return }
        // Lost or refused connections show as "offline"; only real failures
        // (handshake, incompatible Mac, Keychain) become an error notice.
        if let failure, !Self.isTransient(failure) { error = failure.localizedDescription }
        closed(generation)
    }

    private func authMessage(invite: String?) -> [String: JSONValue] {
        var auth: [String: JSONValue] = [
            "type": "auth", "protocol": .string(remoteProtocol),
            "environment": .string(environment.rawValue), "name": .string(deviceName),
            // A Mac that knows events answers with the first snapshot and pushes changes after it.
            "features": .array(["events"]),
        ]
        if let invite { auth["invite"] = .string(invite) }
        if let sessionId = selectedSession {
            auth["sessionId"] = .string(sessionId)
            if let tail = tail(for: sessionId) { auth["tail"] = tail }
        }
        return auth
    }

    /// The loaded history of a session as the Mac can check it: its committed count and hash.
    private func tail(for sessionId: String) -> JSONValue? {
        guard !untrusted.contains(sessionId), let history = messagesBySession[sessionId],
              let count = history.count, let hash = history.historyRevision else { return nil }
        return .object(["count": .number(Double(count)), "hash": .string(hash)])
    }

    private static func isTransient(_ error: Error) -> Bool {
        if error is CancellationError || error is URLError { return true }
        if case AegisError.connection = error { return true }
        return (error as NSError).domain == NSURLErrorDomain || (error as NSError).domain == NSPOSIXErrorDomain
    }

    /// Returns true when this connection should stop.
    private func handle(_ message: Incoming, body: Data, link: Link, generation: Int) async throws -> Bool {
        switch message.type {
        case "authenticated":
            guard message.protocol == remoteProtocol else {
                guard link === self.link else { return true }
                throw AegisError.message("This Mac runs an incompatible version of Aegis.")
            }
            guard message.environment == environment.rawValue else {
                guard link === self.link else { return true }
                throw AegisError.message("Desktop environment doesn’t match.")
            }
            if link === self.link { authenticated(message, link: link, generation: generation) }
            else if link === upgradeLink { adopt(link, message, generation: generation) }
            else { return true }
        case "revoked":
            guard link === self.link else { return true }
            await disconnect(forget: true)
            error = "Your Mac removed this iPhone’s access."
            return true
        case "auth-rejected":
            // A direct connection turned away doesn't end the pairing; the relay connection decides.
            guard link === self.link, link.transport == .relay else {
                if link.transport == .direct { directFailedAt = Self.now }
                return true
            }
            await disconnect(forget: true)
            error = "This pairing is no longer valid. Pair again."
            return true
        case "changed":
            guard link === self.link, !link.events else { break }
            refreshTimer?.cancel()
            refreshTimer = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        case "event":
            guard link === self.link, link.events else { break }
            if let event = message.event { apply(event, link: link) } else { resync(link) }
        case "response":
            guard let id = message.id, let item = pending.removeValue(forKey: id) else { break }
            item.timer.cancel()
            if let code = message.error {
                item.continuation.resume(throwing: AegisError.rejected(code))
            } else {
                item.continuation.resume(returning: body)
            }
        default:
            break
        }
        return false
    }

    private func authenticated(_ message: Incoming, link: Link, generation: Int) {
        serverOffset = (message.serverTime ?? Self.now) - Self.now
        connection = .connected
        freshness = .catchingUp
        error = ""
        reconnectAttempt = 0
        if var offer = pairing, offer.invite != nil || offer.expiresAt != nil {
            offer.invite = nil
            offer.expiresAt = nil
            pairing = offer
            try? secrets.set("pairing", String(decoding: (try? JSONEncoder.aegis.encode(offer)) ?? Data(), as: UTF8.self))
        }
        lastHeard = Self.now
        remember(message.lan)
        start(link, with: message.snapshot)
        Task { await reconcile() }
        Task { await loadOptions() }
        Task { await sendPushRegistration() }
        startPoll(link)
        if link.transport == .relay { Task { await upgrade(generation) } }
    }

    /// The first snapshot came with the answer (a Mac with events), or is fetched now.
    private func start(_ link: Link, with snapshot: RemoteSnapshot?) {
        if let snapshot {
            link.events = true
            apply(snapshot, link: link)
            freshness = .current
            fullRefresh = false
            // The selection moved while connecting.
            if snapshot.sessionId != selectedSession { Task { await refresh() } }
        } else {
            fullRefresh = true
            Task { await refresh() }
        }
    }

    /// A direct connection authenticated while the relay one served: it takes over.
    private func adopt(_ link: Link, _ message: Incoming, generation: Int) {
        upgradeLink = nil
        guard let old = self.link, connection == .connected else {
            link.close()
            return
        }
        self.link = link
        transport = link.transport
        serverOffset = (message.serverTime ?? Self.now) - Self.now
        lastHeard = Self.now
        remember(message.lan)
        start(link, with: message.snapshot)
        startPoll(link)
        // Answers still due on the relay connection arrive there; close it once they have.
        Task { [weak self] in
            for _ in 0..<50 {
                guard let self, self.pending.values.contains(where: { $0.link == old.id }) else { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            old.close()
        }
    }

    private func startPoll(_ link: Link) {
        poll?.cancel()
        poll = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self else { return }
                guard self.backgroundSince == nil else { continue }
                // The socket can stay open while the path drops everything (lossy
                // cross-border links). Reconnect rather than wait for TCP to give up.
                if Self.now - self.lastHeard > Self.stallTimeout * 1000 {
                    Task { await self.connect() }
                    return
                }
                tick += 1
                if link.events {
                    // Changes arrive as events; a ping proves the path, and a rare snapshot
                    // catches anything the desktop changed without an event.
                    Task { _ = try? await self.request(["method": "ping"], timeout: 5) }
                    if tick % 6 == 0 { Task { await self.refresh() } }
                } else {
                    Task { await self.refresh() }
                }
                if self.operations.values.contains(where: \.result.unresolved) {
                    Task { await self.reconcile() }
                }
            }
        }
    }

    private func closed(_ generation: Int, quick: Bool = false) {
        guard generation == self.generation else { return }
        connection = pairing == nil ? .unpaired : .offline
        freshness = .cached
        closeLinks()
        poll?.cancel()
        failPending(AegisError.connection("Connection lost. Checking whether it was delivered."))
        guard pairing != nil else { return }
        guard backgroundSince == nil else { return } // foreground() reconnects
        let delay = quick ? 0.1 : reconnectDelay()
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, self?.backgroundSince == nil else { return }
            await self?.connect()
        }
    }

    /// Most drops are a network that moved, so the first retry is at once; then it backs off to 5 s.
    private func reconnectDelay() -> Double {
        defer { reconnectAttempt += 1 }
        if reconnectAttempt == 0 { return 0.25 }
        return min(5, 0.5 * pow(2, Double(reconnectAttempt))) * Double.random(in: 0.8...1.2)
    }

    // MARK: Direct connections

    /// The Mac's addresses worth trying from the network this phone is on.
    private func directURLs() -> [URL] {
        guard let lan, Self.now - directFailedAt > 60_000 else { return [] }
        return lan.addresses.compactMap { address in
            // Private addresses only on Wi-Fi or Ethernet; 100.64/10 only through a VPN (on cellular
            // that range is the carrier's own).
            let reachable = address.hasPrefix("100.") ? onVPN : onLocalNetwork
            guard address == "127.0.0.1" || reachable else { return nil }
            return URL(string: "ws://\(address):\(lan.port)/")
        }
    }

    private func remember(_ value: RemoteLan?) {
        let valid = value.flatMap { lan -> RemoteLan? in
            let addresses = lan.addresses.filter(Self.isIPv4).prefix(6)
            return (1...65535).contains(lan.port) && !addresses.isEmpty ? RemoteLan(port: lan.port, addresses: Array(addresses)) : nil
        }
        guard let host = pairing?.hostPeerId, valid != lan else { return }
        lan = valid
        let files = self.files
        let name = lanName(host)
        let data = valid.flatMap { try? JSONEncoder().encode($0) }
        Self.fileQueue.async {
            if let data { files.write(name, data) } else { files.remove(name) }
        }
    }

    private static func isIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in
            part.count <= 3 && part.allSatisfy(\.isASCII) && Int(part).map { (0...255).contains($0) } == true
        }
    }

    /// On the relay with the Mac reachable directly: move the connection there.
    private func upgrade(_ generation: Int) async {
        guard upgrading != generation, upgradeLink == nil, let current = link, current.transport == .relay,
              connection == .connected, backgroundSince == nil, let offer = pairing else { return }
        let direct = directURLs()
        guard !direct.isEmpty else { return }
        upgrading = generation
        defer { if upgrading == generation { upgrading = nil } }
        do {
            let identity = try loadIdentity()
            let opened = try await Self.race(hello: hello(offer), directHello: directHello(offer), direct: direct, relay: nil, headStart: 0, deadline: 4, openWire: openWire)
            guard generation == self.generation, self.link === current else { opened.wire.close(); return }
            let next = try await handshake(opened, identity: identity, offer: offer)
            guard generation == self.generation, self.link === current, connection == .connected else { next.close(); return }
            upgradeLink = next
            Task { await self.serve(next, generation, invite: nil) }
        } catch {
            // Not reachable from here; stay on the relay and don't keep trying.
            if generation == self.generation { directFailedAt = Self.now }
        }
    }

    private func watchPath() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let local = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            let vpn = path.usesInterfaceType(.other)
            let satisfied = path.status == .satisfied
            let key = "\(satisfied)|" + path.availableInterfaces.map { "\($0.type):\($0.name)" }.joined(separator: ",")
            Task { @MainActor [weak self] in self?.pathChanged(key: key, satisfied: satisfied, local: local, vpn: vpn) }
        }
        monitor.start(queue: DispatchQueue(label: "ai.aegis.path"))
        pathMonitor = monitor
    }

    /// The phone moved networks: reconnect now instead of waiting for a stall, and
    /// look for the Mac directly on the new one.
    private func pathChanged(key: String, satisfied: Bool, local: Bool, vpn: Bool) {
        let previous = pathKey
        pathKey = key
        onLocalNetwork = local
        onVPN = vpn
        guard let previous, previous != key, satisfied, pairing != nil, backgroundSince == nil else { return }
        directFailedAt = 0
        switch connection {
        case .offline:
            retry?.cancel()
            Task { await connect() }
        case .connected:
            if transport == .direct, !local, !vpn {
                Task { await connect() }
                return
            }
            let generation = self.generation
            Task {
                do { _ = try await request(["method": "ping"], timeout: 3) } catch {
                    if generation == self.generation { await connect() }
                    return
                }
                await upgrade(generation)
            }
        default:
            break
        }
    }

    // MARK: Requests

    static let stallTimeout: Double = 15

    public func request(_ payload: [String: JSONValue], timeout: TimeInterval = 20) async throws -> JSONValue {
        try await request(payload, as: JSONValue.self, timeout: timeout)
    }

    /// Sends a request and decodes its `result` as `T`, off the main thread.
    public func request<T: Decodable & Sendable>(_ payload: [String: JSONValue], as type: T.Type, timeout: TimeInterval = 20) async throws -> T {
        try await request(payload, as: type, timeout: timeout, on: nil)
    }

    private func request<T: Decodable & Sendable>(_ payload: [String: JSONValue], as type: T.Type, timeout: TimeInterval, on target: Link?) async throws -> T {
        let body = try await send(payload, timeout: timeout, on: target)
        return try await Self.decode(Reply<T>.self, from: body).result
    }

    private struct Reply<T: Decodable & Sendable>: Decodable, Sendable { let result: T }

    /// The raw response message, once the Mac answers.
    private func send(_ payload: [String: JSONValue], timeout: TimeInterval, on target: Link?) async throws -> Data {
        guard connection == .connected, let link = target ?? self.link else { throw AegisError.connection("Your Mac isn’t connected") }
        let id = (payload["commandId"]?.stringValue) ?? UUID().uuidString.lowercased()
        var body = payload
        body["id"] = .string(id)
        let data = try JSONEncoder.aegis.encode(JSONValue.object(body))
        let channel = link.channel
        return try await withCheckedThrowingContinuation { continuation in
            let timer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard !Task.isCancelled, let self, let item = self.pending.removeValue(forKey: id) else { return }
                item.continuation.resume(throwing: AegisError.connection("Your Mac hasn’t confirmed yet"))
            }
            pending[id] = Pending(continuation: continuation, timer: timer, link: link.id)
            Task {
                do { try await channel.send(data) } catch {
                    if let item = self.pending.removeValue(forKey: id) {
                        item.timer.cancel()
                        item.continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    nonisolated private static func decode<T: Decodable & Sendable>(_ type: T.Type, from data: Data) async throws -> T {
        try await Task.detached(priority: .userInitiated) { try JSONDecoder().decode(T.self, from: data) }.value
    }

    nonisolated private static func decoded<T: Decodable & Sendable>(_ type: T.Type, from data: Data) async -> T? {
        try? await decode(type, from: data)
    }

    public func refresh() async {
        guard connection == .connected, let link else { return }
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        let generation = self.generation
        let sessionId = selectedSession
        // Routine polls stay quiet; only the first sync on a connection shows as catching up.
        if fullRefresh { freshness = .catchingUp }
        do {
            var params: [String: JSONValue] = ["method": "snapshot"]
            if let sessionId { params["sessionId"] = .string(sessionId) }
            if link.events {
                // The Mac answers a known tail with only what follows it.
                if let sessionId, let tail = tail(for: sessionId) { params["tail"] = tail }
            } else if !fullRefresh, snapshot?.sessionId == sessionId, let known = snapshot?.revision {
                params["knownRevision"] = .string(known)
            }
            if link.events { link.snapshotsInFlight += 1 }
            defer { if link.events { link.snapshotsInFlight -= 1 } }
            let reply = try await request(params, as: SnapshotReply.self, timeout: 20, on: link)
            if generation == self.generation, link === self.link, sessionId == selectedSession {
                if let state = reply.snapshot { apply(state, link: link) }
                freshness = .current
                error = ""
                fullRefresh = false
            } else if generation == self.generation, link === self.link, link.events {
                // The selection moved: the Mac now bases events on a snapshot this phone dropped.
                link.resyncing = true
                refreshAgain = true
            }
        } catch {
            if generation == self.generation, link === self.link, link.events {
                if case AegisError.rejected = error {
                    // Refused before the Mac took it as a baseline: what was held still applies.
                    if link.snapshotsInFlight == 0, !link.resyncing { replayHeld(link) }
                } else {
                    // Lost on the way; the Mac may have based events on it.
                    link.resyncing = true
                }
            }
            if generation == self.generation, link === self.link, link.resyncing {
                // Events are held until a snapshot lands; try again shortly rather than at the next poll.
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(1))
                    guard let self, generation == self.generation, link === self.link, link.resyncing else { return }
                    await self.refresh()
                }
            }
            if generation == self.generation, link === self.link {
                freshness = .cached
                self.error = error.localizedDescription
                if case AegisError.rejected("SCOPE_DENIED") = error, let sessionId {
                    messagesBySession[sessionId] = nil
                    selectedSession = nil
                    refreshAgain = true
                }
            }
        }
        if generation == self.generation {
            refreshing = false
            if refreshAgain {
                refreshAgain = false
                await refresh()
            }
        }
    }

    // MARK: Applying snapshots and events

    private struct SnapshotReply: Decodable, Sendable {
        let snapshot: RemoteSnapshot?

        private enum Keys: String, CodingKey { case unchanged }
        init(from decoder: Decoder) throws {
            let unchanged = try decoder.container(keyedBy: Keys.self).decodeIfPresent(Bool.self, forKey: .unchanged) ?? false
            snapshot = unchanged ? nil : try RemoteSnapshot(from: decoder)
        }
    }

    private func apply(_ state: RemoteSnapshot, link: Link) {
        let seq = link.events ? state.seq : nil
        if let seq {
            link.lastSeq = seq
            link.resyncing = false
            link.log.removeAll { $0.seq <= seq }
        }
        replace(with: state, link: link)
        // Events after this snapshot that arrived before it was applied build on it.
        if seq != nil { replayHeld(link) }
    }

    /// Applies held events in order; what can't be applied yet stays held.
    private func replayHeld(_ link: Link) {
        let held = link.log
        link.log = []
        for (index, event) in held.enumerated() {
            guard !link.resyncing, event.seq == link.lastSeq + 1 else {
                link.log = Array(held[index...])
                if !link.resyncing { resync(link) }
                return
            }
            link.lastSeq = event.seq
            applyChanges(event, link: link)
        }
    }

    private func replace(with state: RemoteSnapshot, link: Link) {
        var list = state
        list.messages = nil
        list.appendFrom = nil
        // Views read the list everywhere; leave it alone when only the clock moved. Older
        // Macs compare `revision` on the next poll, so theirs is always kept current.
        if let current = snapshot, link.events, current.projects == list.projects, current.sessions == list.sessions,
           current.permissions == list.permissions, current.hostBootId == list.hostBootId,
           current.machineName == list.machineName, current.sessionId == list.sessionId {
        } else {
            snapshot = list
        }
        prune(to: state.sessions)
        if let sessionId = state.sessionId, let messages = state.messages {
            merge(messages, of: state, into: sessionId, link: link)
        }
        scheduleCacheWrite()
    }

    /// Committed messages and the streamed text, which arrives as the last message.
    private static func split(_ messages: [RemoteMessage]) -> (committed: [RemoteMessage], live: String?) {
        guard let last = messages.last, last.streaming == true, last.role == "assistant", last.raw == nil else {
            return (messages, nil)
        }
        return (Array(messages.dropLast()), last.text)
    }

    private func merge(_ messages: [RemoteMessage], of state: RemoteSnapshot, into sessionId: String, link: Link) {
        let previous = messagesBySession[sessionId]
        let (committed, live) = Self.split(messages)
        var next: SessionHistory
        if let from = state.appendFrom {
            // Only what follows the tail this phone sent.
            guard var base = previous, let count = base.count else {
                untrusted.insert(sessionId)
                resync(link)
                return
            }
            if count == from {
                base.messages += committed
                if !committed.isEmpty { base.version = Self.nextVersion() }
            } else if base.historyRevision != state.historyRevision {
                // Events moved it on meanwhile and the two don't line up: fetch it whole.
                untrusted.insert(sessionId)
                resync(link)
                return
            }
            next = base
            next.count = state.historyCount
            next.historyRevision = state.historyRevision
            next.hostBootId = state.hostBootId
            next.live = live
        } else if let previous, previous.historyRevision == state.historyRevision, previous.hostBootId == state.hostBootId
                    || (state.historyCount != nil && previous.count == state.historyCount && previous.historyRevision == state.historyRevision) {
            // Same history: keep the pages already loaded.
            next = previous
            next.hostBootId = state.hostBootId
            next.live = live
        } else {
            let unchanged = previous?.messages == committed
            next = SessionHistory(
                messages: committed, live: live, before: state.before, historyRevision: state.historyRevision,
                count: state.historyCount, hostBootId: state.hostBootId,
                version: unchanged ? previous!.version : Self.nextVersion())
            if unchanged { next.messages = previous!.messages }
        }
        untrusted.remove(sessionId)
        if next != previous { messagesBySession[sessionId] = next }
    }

    private func apply(_ event: RemoteEvent, link: Link) {
        guard event.seq > link.lastSeq else { return }
        if link.resyncing || link.snapshotsInFlight > 0 {
            // Dropping the oldest leaves a gap the replay notices, which asks again.
            link.log.append(event)
            if link.log.count > 512 { link.log.removeFirst(link.log.count - 512) }
            return
        }
        guard event.seq == link.lastSeq + 1 else { return resync(link) }
        link.lastSeq = event.seq
        applyChanges(event, link: link)
    }

    private func applyChanges(_ event: RemoteEvent, link: Link) {
        if let state = event.state, var list = snapshot {
            list.projects = state.projects
            list.sessions = state.sessions
            list.permissions = state.permissions
            snapshot = list
            prune(to: state.sessions)
            // The open session is back (unarchived) or just appeared: subscribe and load it.
            if let selected = selectedSession, messagesBySession[selected] == nil,
               state.sessions.contains(where: { $0.id == selected }) {
                Task { await refresh() }
            }
        }
        if let update = event.history {
            let previous = messagesBySession[update.sessionId]
            if let from = update.appendFrom {
                guard var next = previous, next.count == from else {
                    untrusted.insert(update.sessionId)
                    return resync(link)
                }
                next.messages += update.messages
                next.count = update.count
                next.historyRevision = update.revision
                next.version = Self.nextVersion()
                messagesBySession[update.sessionId] = next
            } else {
                messagesBySession[update.sessionId] = SessionHistory(
                    messages: update.messages, live: previous?.live, before: update.before,
                    historyRevision: update.revision, count: update.count,
                    hostBootId: snapshot?.hostBootId ?? previous?.hostBootId ?? "", version: Self.nextVersion())
            }
        }
        if let update = event.live, var next = messagesBySession[update.sessionId] {
            switch update.change {
            case .append(let text):
                guard let current = next.live else { return resync(link) }
                next.live = Self.trimmed(current + text)
            case .replace(let text):
                next.live = text.map(Self.trimmed)
            }
            messagesBySession[update.sessionId] = next
        }
        if event.state != nil || event.history != nil { scheduleCacheWrite() }
    }

    /// The Mac keeps the last 64 000 characters of a streamed reply; so does the phone.
    private static func trimmed(_ text: String) -> String {
        text.utf16.count > 64000 ? String(text.suffix(64000)) : text
    }

    /// An event didn't fit what the phone has: ignore the rest until a snapshot catches up.
    private func resync(_ link: Link) {
        guard link === self.link, !link.resyncing else { return }
        link.resyncing = true
        Task { await refresh() }
    }

    private func prune(to sessions: [RemoteSession]) {
        let allowed = Set(sessions.map(\.id))
        guard messagesBySession.keys.contains(where: { !allowed.contains($0) }) else { return }
        messagesBySession = messagesBySession.filter { allowed.contains($0.key) }
    }

    // MARK: Cache

    /// Writes the cache a couple of seconds after the last change, off the main thread.
    private func scheduleCacheWrite() {
        guard cacheTask == nil else { return }
        cacheTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            self.cacheTask = nil
            self.writeCache()
        }
    }

    private func writeCache() {
        guard let host = pairing?.hostPeerId, let snapshot else { return }
        // Streamed text is stale by the next launch.
        let cache = Cache(snapshot: snapshot, messages: messagesBySession.mapValues { history in
            var history = history
            history.live = nil
            return history
        })
        let files = self.files
        let name = cacheName(host)
        Self.fileQueue.async {
            if let data = try? JSONEncoder().encode(cache) { files.write(name, data) }
        }
    }

    private func flushCache() {
        guard cacheTask != nil else { return }
        cacheTask?.cancel()
        cacheTask = nil
        writeCache()
    }

    public func loadOptions() async {
        if let options = try? await request(["method": "options"]) { agentOptions = options }
    }

    /// Slash commands and skills for a session, or for a new task in a project.
    public func capabilities(provider: String, sessionId: String?, projectId: String?) async throws -> JSONValue {
        var params: [String: JSONValue] = ["method": "capabilities", "provider": .string(provider)]
        if let sessionId { params["sessionId"] = .string(sessionId) }
        if let projectId { params["projectId"] = .string(projectId) }
        return try await request(params)
    }

    // MARK: Notifications

    /// This app's APNs registration; the Mac gets it after every authentication.
    public var push: PushRegistration? {
        didSet {
            if push != oldValue, connection == .connected { Task { await sendPushRegistration() } }
        }
    }

    func sendPushRegistration() async {
        guard let push else { return }
        _ = try? await request([
            "method": "push.register",
            "deviceToken": .string(push.deviceToken),
            "topic": .string(push.topic),
            "environment": .string(push.environment),
        ])
    }

    // MARK: Project files (read-only)

    public func listFiles(projectId: String, path: String = "") async throws -> [RemoteFileEntry] {
        var params: [String: JSONValue] = ["method": "files.list", "projectId": .string(projectId)]
        if !path.isEmpty { params["path"] = .string(path) }
        return try await request(params, as: [RemoteFileEntry].self)
    }

    public func searchFiles(projectId: String, query: String) async throws -> [RemoteFileEntry] {
        try await request(["method": "files.search", "projectId": .string(projectId), "query": .string(query)], as: [RemoteFileEntry].self)
    }

    /// `path` is relative to the project, or absolute inside it.
    public func readFile(projectId: String, path: String) async throws -> RemoteFileContent {
        try await request(["method": "files.read", "projectId": .string(projectId), "path": .string(path)], as: RemoteFileContent.self, timeout: 30)
    }

    public func select(_ sessionId: String?) {
        guard selectedSession != sessionId else { return }
        selectedSession = sessionId
        // Also tells a Mac with events which session to send.
        Task { await refresh() }
    }

    /// Loads the page of history before the oldest loaded message.
    public func older() async throws {
        guard let sessionId = selectedSession, let previous = messagesBySession[sessionId], let before = previous.before else { return }
        let generation = self.generation
        var params: [String: JSONValue] = ["method": "snapshot", "sessionId": .string(sessionId), "before": .number(before)]
        if link?.events == true, let tail = tail(for: sessionId) {
            params["tail"] = tail
        } else if let revision = previous.historyRevision {
            params["historyRevision"] = .string(revision)
        }
        let state = try await request(params, as: RemoteSnapshot.self)
        guard generation == self.generation, selectedSession == sessionId, var next = messagesBySession[sessionId],
              next.historyRevision == previous.historyRevision, next.before == before else { return }
        var seen = Set<String>()
        var merged: [RemoteMessage] = []
        for message in Self.split(state.messages ?? []).committed + next.messages where seen.insert(message.id).inserted {
            merged.append(message)
        }
        next.messages = merged
        next.before = state.before
        next.version = Self.nextVersion()
        messagesBySession[sessionId] = next
    }

    /// Sends a file in relay-sized chunks; returns its attachment.
    public func upload(name: String, bytes: Data, progress: (@MainActor (Double) -> Void)? = nil) async throws -> RemoteAttachment {
        let uploadId = UUID().uuidString.lowercased()
        let total = max(1, Int(ceil(Double(bytes.count) / Double(attachmentChunkBytes))))
        var result: JSONValue = .null
        for index in 0..<total {
            let start = bytes.startIndex + index * attachmentChunkBytes
            let part = bytes.subdata(in: start..<min(start + attachmentChunkBytes, bytes.endIndex))
            result = try await request([
                "method": "attachment.chunk", "uploadId": .string(uploadId), "name": .string(name),
                "index": .number(Double(index)), "total": .number(Double(total)),
                "data": .string(part.base64EncodedString()),
            ], timeout: 60)
            progress?(Double(index + 1) / Double(total))
        }
        guard result["attachmentId"] != nil else { throw AegisError.message("Upload didn’t finish") }
        return try result.decode(RemoteAttachment.self)
    }

    /// Journals, then sends a create/send/stop/permission command. If no answer
    /// comes back (lossy network, reconnect), the command stays in the journal as
    /// `.unknown` and `reconcile()` re-sends it until the Mac answers.
    /// `commandId` lets the caller show the command before it is answered.
    @discardableResult
    public func mutate(_ payload: [String: JSONValue], commandId: String = UUID().uuidString.lowercased()) async throws -> CommandResult {
        var request = payload
        request["id"] = .string(commandId)
        request["commandId"] = .string(commandId)
        request["expiresAt"] = .number((Self.now + serverOffset + remoteCommandLifetime).rounded())
        operations[commandId] = RemoteOperation(request: .object(request), result: CommandResult(commandId: commandId, state: .unknown))
        saveOperations()
        inFlight.insert(commandId)
        defer { inFlight.remove(commandId) }
        do {
            let result = try await self.request(request, as: CommandResult.self, timeout: 10)
            settle(commandId, result)
            // A Mac with events sends what the command changed by itself.
            if link?.events != true { Task { await refresh() } }
            return result
        } catch AegisError.rejected(let code) where code != "TOO_MANY_REQUESTS" {
            settle(commandId, CommandResult(commandId: commandId, state: .rejected, error: code))
            throw AegisError.rejected(code)
        } catch {
            // Not lost: the journal keeps it and reconcile() delivers it.
            return operations[commandId]?.result ?? CommandResult(commandId: commandId, state: .unknown)
        }
    }

    private func settle(_ commandId: String, _ result: CommandResult) {
        guard operations[commandId]?.result.unresolved == true else { return }
        operations[commandId]?.result = result
        saveOperations()
    }

    private func saveOperations() {
        // Keep the newest 100 entries plus anything still unresolved.
        let ordered = operations.sorted { ($0.value.request["expiresAt"]?.numberValue ?? 0) < ($1.value.request["expiresAt"]?.numberValue ?? 0) }
        for (id, operation) in ordered.dropLast(100) where !operation.result.unresolved {
            operations[id] = nil
        }
        // A file readable after first unlock: commands settle while the phone is locked too.
        if let data = try? JSONEncoder.aegis.encode(operations) { files.write(Self.journalFile, data) }
    }

    /// Called when the app leaves the screen (switching apps or locking). The connection
    /// stays up while iOS lets the app run; the Mac is told so it keeps sending pushes.
    public func background() async {
        guard backgroundSince == nil else { return }
        backgroundSince = Self.now
        refreshTimer?.cancel()
        flushCache()
        guard connection == .connected else { return }
        _ = try? await request(["method": "presence", "background": true], timeout: 3)
    }

    /// iOS is about to suspend the app: close cleanly so the Mac knows nobody is watching.
    public func suspend() async {
        guard backgroundSince != nil, pairing != nil else { return }
        await disconnect()
    }

    /// Called when the app returns to the foreground.
    public func foreground() async {
        let away = backgroundSince.map { Self.now - $0 } ?? 0
        backgroundSince = nil
        lastHeard = Self.now
        guard connection == .connected else {
            if pairing != nil, connection != .connecting, connection != .confirming { await connect() }
            return
        }
        // Longer than iOS keeps a background app running: the socket is gone, so don't wait on it.
        if away > Self.backgroundGrace * 1000 {
            await connect()
            return
        }
        let generation = self.generation
        // The first direct attempt raises iOS's Local Network prompt and fails while it shows;
        // coming back from it (or from anywhere) is worth another try.
        directFailedAt = 0
        do {
            _ = try await request(["method": "presence", "background": false], timeout: 3)
            await refresh()
            await upgrade(generation)
        } catch AegisError.rejected {
            await refresh() // a Mac without presence support; the connection itself is fine
        } catch {
            await connect()
        }
    }

    /// How long the app keeps its connection after leaving the screen (seconds).
    public static let backgroundGrace: Double = 25

    /// Re-sends commands whose outcome is unknown, oldest first. Safe to repeat: the
    /// Mac runs a commandId once and answers a repeat with the first result, or with
    /// COMMAND_EXPIRED when it never arrived within its lifetime.
    public func reconcile() async {
        guard connection == .connected, !reconciling else { return }
        reconciling = true
        defer { reconciling = false }
        let waiting = operations
            .filter { $0.value.result.unresolved && !inFlight.contains($0.key) }
            .sorted { ($0.value.request["expiresAt"]?.numberValue ?? 0) < ($1.value.request["expiresAt"]?.numberValue ?? 0) }
        var delivered = false
        for (id, operation) in waiting {
            guard case .object(let request) = operation.request else { continue }
            inFlight.insert(id)
            defer { inFlight.remove(id) }
            do {
                settle(id, try await self.request(request, as: CommandResult.self, timeout: 10))
                delivered = true
            } catch AegisError.rejected(let code) where code != "TOO_MANY_REQUESTS" {
                settle(id, CommandResult(commandId: id, state: .rejected, error: code))
            } catch {
                break
            }
        }
        if delivered, link?.events != true { await refresh() }
    }

    public func clearError() { error = "" }

    // MARK: Racing connection paths

    private struct Opened: @unchecked Sendable {
        let wire: WireConnection
        let transport: Transport
    }

    private struct Control: Decodable { let type: String? }

    /// Opens every path at once (the relay after `headStart` when there are direct ones)
    /// and keeps the first that the Mac answers on; the others are closed.
    nonisolated private static func race(
        hello: String, directHello: String, direct: [URL], relay: URL?, headStart: Double, deadline: Double,
        openWire: @escaping @Sendable (URL, TimeInterval) async throws -> WireConnection
    ) async throws -> Opened {
        var attempts: [(url: URL, transport: Transport, delay: Double, timeout: TimeInterval)] =
            direct.map { ($0, .direct, 0, 1.5) }
        if let relay { attempts.append((relay, .relay, direct.isEmpty ? 0 : headStart, 15)) }
        guard !attempts.isEmpty else { throw AegisError.connection("Nowhere to connect") }
        return try await withCheckedThrowingContinuation { continuation in
            let race = Race(attempts: attempts.count, continuation: continuation)
            for attempt in attempts {
                Task.detached {
                    if attempt.delay > 0 { try? await Task.sleep(for: .seconds(attempt.delay)) }
                    guard !race.isDecided else { return race.fail(attempt.transport, CancellationError()) }
                    do {
                        let wire = try await openWire(attempt.url, attempt.timeout)
                        guard race.track(wire) else {
                            wire.close()
                            return race.fail(attempt.transport, CancellationError())
                        }
                        try await wire.send(.text(attempt.transport == .relay ? hello : directHello))
                        // The relay answers {"type":"peer"} once the Mac is in the room; the Mac itself at once.
                        guard case .text(let control) = try await wire.receive(),
                              (try? JSONDecoder().decode(Control.self, from: Data(control.utf8)))?.type == "peer" else {
                            throw AegisError.connection(attempt.transport == .relay ? "Relay rejected the connection" : "The Mac refused a direct connection")
                        }
                        race.win(Opened(wire: wire, transport: attempt.transport))
                    } catch {
                        race.fail(attempt.transport, error)
                    }
                }
            }
            race.timer = Task.detached {
                try? await Task.sleep(for: .seconds(deadline))
                if !Task.isCancelled { race.expire() }
            }
        }
    }

    /// Decides a race between connection attempts, from any thread.
    private final class Race: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Opened, Error>?
        private var wires: [WireConnection] = []
        private var remaining: Int
        private var errors: [Transport: Error] = [:]
        private var decided = false
        var timer: Task<Void, Never>? {
            get { lock.withLock { _timer } }
            set {
                let late = lock.withLock { () -> Bool in
                    _timer = newValue
                    return decided
                }
                if late { newValue?.cancel() }
            }
        }
        private var _timer: Task<Void, Never>?

        init(attempts: Int, continuation: CheckedContinuation<Opened, Error>) {
            remaining = attempts
            self.continuation = continuation
        }

        var isDecided: Bool { lock.withLock { decided } }

        /// Keeps an opened wire so a winner can close it; false once the race is over.
        func track(_ wire: WireConnection) -> Bool {
            lock.withLock {
                guard !decided else { return false }
                wires.append(wire)
                return true
            }
        }

        func win(_ opened: Opened) {
            let (continuation, losers, timer) = lock.withLock { () -> (CheckedContinuation<Opened, Error>?, [WireConnection], Task<Void, Never>?) in
                guard !decided else { return (nil, [], nil) }
                decided = true
                defer { self.continuation = nil }
                return (self.continuation, wires.filter { $0 !== opened.wire }, _timer)
            }
            guard let continuation else {
                opened.wire.close()
                return
            }
            timer?.cancel()
            losers.forEach { $0.close() }
            continuation.resume(returning: opened)
        }

        func fail(_ transport: Transport, _ error: Error) {
            let outcome = lock.withLock { () -> (CheckedContinuation<Opened, Error>, Error, Task<Void, Never>?)? in
                if !(error is CancellationError), errors[transport] == nil { errors[transport] = error }
                remaining -= 1
                guard !decided, remaining == 0, let continuation else { return nil }
                decided = true
                self.continuation = nil
                // The relay's reason is the one worth showing.
                return (continuation, errors[.relay] ?? errors[.direct] ?? error, _timer)
            }
            guard let (continuation, reason, timer) = outcome else { return }
            timer?.cancel()
            continuation.resume(throwing: reason)
        }

        func expire() {
            let (continuation, all) = lock.withLock { () -> (CheckedContinuation<Opened, Error>?, [WireConnection]) in
                guard !decided else { return (nil, []) }
                decided = true
                defer { self.continuation = nil }
                return (self.continuation, wires)
            }
            all.forEach { $0.close() }
            continuation?.resume(throwing: AegisError.connection("Connection timed out"))
        }
    }
}

/// One message from the Mac, decoded off the main thread. A response keeps only its
/// envelope here; the caller decodes `result` from the body as its own type.
private struct Incoming: Decodable, Sendable {
    let type: String?
    let id: String?
    let error: String?
    let `protocol`: String?
    let environment: String?
    let serverTime: Double?
    let lan: RemoteLan?
    let snapshot: RemoteSnapshot?
    /// Nil for an event that didn't decode; the phone then resyncs.
    let event: RemoteEvent?

    private enum Keys: String, CodingKey { case type, id, error, `protocol`, environment, serverTime, lan, snapshot }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        `protocol` = try? c.decodeIfPresent(String.self, forKey: .protocol)
        environment = try? c.decodeIfPresent(String.self, forKey: .environment)
        serverTime = try? c.decodeIfPresent(Double.self, forKey: .serverTime)
        lan = type == "authenticated" ? (try? c.decodeIfPresent(RemoteLan.self, forKey: .lan)) ?? nil : nil
        snapshot = type == "authenticated" ? (try? c.decodeIfPresent(RemoteSnapshot.self, forKey: .snapshot)) ?? nil : nil
        event = type == "event" ? try? RemoteEvent(from: decoder) : nil
    }
}
