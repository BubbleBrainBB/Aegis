import AegisKit
import Observation
import SwiftUI
import UserNotifications

/// A photo or file picked in the composer, uploaded to the Mac before sending.
@Observable
final class PendingAttachment: Identifiable {
    let id = UUID().uuidString
    let name: String
    let image: UIImage?
    var progress: Double = 0
    var attachmentId: String?
    var error: String?

    init(name: String, image: UIImage?) {
        self.name = name
        self.image = image
    }

    var uploading: Bool { attachmentId == nil && error == nil }
}

/// App state around the RemoteClient: navigation, preferences, drafts, sending.
@MainActor
@Observable
final class AppModel {
    /// `starting`: a new task sent but not yet created on the Mac (by command id).
    enum Screen: Hashable { case home, session(String), starting(String) }
    enum Route: Hashable {
        case projects, project(String), settings, devices
        /// A workflow's member or planner session, opened from one of its steps.
        case member(String)
    }

    /// One per paired Mac; each keeps its own connection, pairing and journal.
    private(set) var clients: [RemoteClient]
    private(set) var activeSlot: String
    /// The Mac the open page is about. Commands for a session go to the Mac that owns it.
    var client: RemoteClient { clients.first { $0.slot == activeSlot } ?? clients[0] }
    let core = CoreScript.shared

    // Navigation
    var screen: Screen = .home
    var path: [Route] = []
    var drawerOpen = false
    /// Wide layout (an unfolded iPhone Duo): the sidebar is docked beside the page.
    var wideLayout = false
    /// The docked sidebar, hidden with the sidebar button.
    var sidebarHidden = false
    var approval: RemotePermission?
    var pairOpen = false
    var pairText = ""

    // Activity
    var busy = false
    var notice = ""
    var notificationStatus: UNAuthorizationStatus = .notDetermined
    /// Increments on send; the conversation jumps to the bottom.
    var sendTick = 0
    var attachments: [PendingAttachment] = []

    /// The diff sheet, when open.
    var diffReview: DiffReview?

    // Agent catalogs from the Mac, per provider.
    var catalogs: [String: AgentCatalog] = [:]

    // Preferences
    var provider: String { didSet { defaults.set(provider, forKey: "aegis-provider") } }
    var projectId: String { didSet { defaults.set(projectId, forKey: "aegis-project") } }
    var worktree: Bool { didSet { defaults.set(worktree, forKey: "aegis-worktree") } }
    var theme: String { didSet { defaults.set(theme, forKey: "aegis-theme") } }
    private(set) var taskSettings: [String: RemoteTaskSettings]
    private(set) var sessionSettings: [String: RemoteTaskSettings]

    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private let environment: RemoteEnvironment
    @ObservationIgnored private var drafts: [String: String] = [:]
    private(set) var draftVersion = 0

    init(client: RemoteClient? = nil) {
        let environment: RemoteEnvironment = (Bundle.main.bundleIdentifier ?? "").hasSuffix(".dev") ? .development : .production
        self.environment = environment
        let slots = UserDefaults.standard.stringArray(forKey: "aegis-mac-slots") ?? [""]
        let macs = client.map { [$0] } ?? (slots.isEmpty ? [""] : slots).map { RemoteClient(environment: environment, slot: $0) }
        clients = macs
        let saved = UserDefaults.standard.string(forKey: "aegis-active-mac")
        activeSlot = macs.first { $0.slot == saved }?.slot ?? macs[0].slot
        provider = defaults.string(forKey: "aegis-provider") ?? "claude"
        projectId = defaults.string(forKey: "aegis-project") ?? ""
        worktree = defaults.bool(forKey: "aegis-worktree")
        theme = defaults.string(forKey: "aegis-theme") ?? "system"
        taskSettings = Self.load("aegis-task-settings") ?? [:]
        sessionSettings = Self.load("aegis-session-settings") ?? [:]
    }

    private static func load<T: Decodable>(_ key: String) -> T? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private func save<T: Encodable>(_ value: T, _ key: String) {
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: key) }
    }

    // MARK: Derived state

    var snapshot: RemoteSnapshot? { client.snapshot }
    /// Every Mac's sessions and approvals: what's waiting shows wherever it is.
    var sessions: [RemoteSession] { pairedClients.flatMap { $0.snapshot?.sessions ?? [] } }
    var permissions: [RemotePermission] { pairedClients.flatMap { $0.snapshot?.permissions ?? [] } }
    /// The open Mac's own lists; two Macs can have a project at the same path.
    var activeSessions: [RemoteSession] { snapshot?.sessions ?? [] }
    var projects: [RemoteProject] { snapshot?.projects ?? [] }
    var pairedClients: [RemoteClient] { clients.filter { $0.pairing != nil } }
    var severalMacs: Bool { pairedClients.count > 1 }
    var ready: Bool { client.connection == .connected }
    private func established(_ client: RemoteClient) -> Bool {
        client.pairing != nil && !(client.connection == .confirming && client.snapshot == nil)
    }
    var paired: Bool { clients.contains(where: established) }
    /// The open Mac is asking for approval of a new pairing.
    var confirming: Bool { client.pairing != nil && !established(client) }
    func macName(of client: RemoteClient) -> String {
        let name = client.snapshot?.machineName ?? client.pairing?.name ?? "Your Mac"
        return name.hasSuffix(".local") ? String(name.dropLast(6)) : name
    }
    var macName: String { macName(of: client) }
    func owner(ofSession id: String) -> RemoteClient? {
        pairedClients.first { $0.snapshot?.session(id) != nil }
    }
    /// A listed session, or a workflow's member session (which the lists leave out).
    func session(_ id: String) -> RemoteSession? {
        sessions.first { $0.id == id } ?? pairedClients.lazy.compactMap { $0.snapshot?.session(id) }.first
    }
    /// Run by a workflow: it has no composer, as on the desktop.
    func isWorkflowMember(_ id: String) -> Bool { owner(ofSession: id)?.snapshot?.isMember(id) == true }
    /// "Mac mini · coworker" where sessions from several Macs mix; the project alone with one Mac.
    func placeLabel(of session: RemoteSession) -> String? {
        let owner = owner(ofSession: session.id)
        let project = owner?.snapshot?.projects.first { $0.id == session.projectId }?.name
        guard severalMacs, let owner else { return project }
        return [macName(of: owner), project].compactMap { $0 }.joined(separator: " · ")
    }
    func connectionText(of client: RemoteClient) -> String {
        switch client.connection {
        case .connected: return client.freshness == .current ? "Synced" : "Updating…"
        case .offline: return "Offline"
        default: return "Connecting…"
        }
    }
    /// Shows this Mac: a new task runs there, and Settings and the project pages describe it.
    func activate(_ next: RemoteClient) {
        guard next.slot != activeSlot else { return }
        client.select(nil)
        activeSlot = next.slot
        attachments = []
        defaults.set(activeSlot, forKey: "aegis-active-mac")
    }
    private func saveSlots() { defaults.set(clients.map(\.slot), forKey: "aegis-mac-slots") }
    func startAll() async {
        await withTaskGroup(of: Void.self) { group in
            for client in clients { group.addTask { await client.start() } }
        }
    }
    func foregroundAll() async {
        await withTaskGroup(of: Void.self) { group in
            for client in clients where client.pairing != nil { group.addTask { await client.foreground() } }
        }
    }
    private func eachClient(_ action: @escaping (RemoteClient) async -> Void) async {
        for client in clients where client.pairing != nil { await action(client) }
    }
    /// A pairing that was refused or cancelled leaves the page on no Mac; go to one that's there.
    func leaveUnpairedMac() {
        if client.pairing == nil, let next = pairedClients.first { activate(next) }
    }
    var connectionText: String {
        switch client.connection {
        case .connected: return client.freshness == .current ? "Synced" : "Updating…"
        case .offline: return "Offline"
        default: return "Connecting…"
        }
    }
    var environmentLabel: String { client.pairing?.environment.label ?? client.environment.label }
    var selectedProject: RemoteProject? { projects.first { $0.id == projectId } ?? projects.first }
    var currentSessionId: String? {
        if case .session(let id) = screen { return id }
        return nil
    }
    var currentSession: RemoteSession? { currentSessionId.flatMap(session) }
    /// Sends the Mac hasn't confirmed and no request is waiting on; a normal send never counts.
    var stalledCount: Int { client.stalledCount }

    func catalog(_ provider: String) -> AgentCatalog { catalogs[provider] ?? .placeholder(provider) }

    func reloadCatalogs() async {
        for provider in agentProviders {
            catalogs[provider] = await core.catalog(provider: provider, options: client.agentOptions, extraModels: sessionModels[provider] ?? [])
        }
    }

    /// Models the Mac's sessions run on, per provider; the catalog resolves these too.
    var sessionModels: [String: [String]] {
        Dictionary(grouping: activeSessions.compactMap { s in s.settings?.model.map { (s.provider, $0) } }, by: \.0)
            .mapValues { Array(Set($0.map(\.1))).sorted() }
    }

    // MARK: Settings for the composer

    var newSettings: RemoteTaskSettings { taskSettings[provider] ?? RemoteTaskSettings() }

    func setNewSettings(_ value: RemoteTaskSettings) {
        taskSettings[provider] = value
        save(taskSettings, "aegis-task-settings")
    }

    func settings(forSession id: String) -> RemoteTaskSettings {
        sessionSettings[id] ?? sessions.first { $0.id == id }?.settings ?? RemoteTaskSettings()
    }

    func setSettings(_ value: RemoteTaskSettings, forSession id: String) {
        sessionSettings[id] = value
        save(sessionSettings, "aegis-session-settings")
    }

    // MARK: Commands and skills ("/" and "$" menus)

    /// The composer's menu is showing; Home makes room for it above the keyboard.
    var commandMenuOpen = false

    /// Lists by scope: a session's, or a new task's in a project for an agent.
    private(set) var capabilityLists: [String: JSONValue] = [:]
    @ObservationIgnored private var capabilityFetched: [String: Date] = [:]

    var capabilityScope: String {
        currentSessionId.map { "session:" + $0 } ?? "project:\(selectedProject?.id ?? ""):\(provider)"
    }

    /// Fetches the current scope's list at most every 30 s (skills change on disk).
    /// A Mac on an older Aegis answers with an error; the menu stays closed then.
    func loadCapabilities() async {
        let scope = capabilityScope
        guard ready, Date().timeIntervalSince(capabilityFetched[scope] ?? .distantPast) > 30 else { return }
        let session = currentSession
        guard session != nil || selectedProject != nil else { return }
        capabilityFetched[scope] = Date()
        if let list = try? await client.capabilities(
            provider: session?.provider ?? provider, sessionId: session?.id,
            projectId: session == nil ? selectedProject?.id : nil) {
            capabilityLists[scope] = list
        }
    }

    // MARK: Drafts (files, written on every change)

    private var draftKey: String { client.draftName(currentSessionId ?? "new") }

    var draft: String {
        get {
            _ = draftVersion
            if let cached = drafts[draftKey] { return cached }
            let stored = client.files.read(draftKey).map { String(decoding: $0, as: UTF8.self) } ?? ""
            drafts[draftKey] = stored
            return stored
        }
        set {
            drafts[draftKey] = newValue
            if newValue.isEmpty { client.files.remove(draftKey) } else { client.files.write(draftKey, Data(newValue.utf8)) }
            draftVersion += 1
        }
    }

    // MARK: Navigation

    func openHome() {
        drawerOpen = false
        path = []
        screen = .home
        attachments = []
        client.select(nil)
    }

    func open(session id: String) {
        drawerOpen = false
        path = []
        if let owner = owner(ofSession: id) { activate(owner) }
        screen = .session(id)
        attachments = []
        client.select(id)
    }

    func push(_ route: Route) {
        drawerOpen = false
        path.append(route)
    }

    /// Opens a workflow member's session over the chat, so Back returns to the board.
    func openMember(_ sessionId: String) {
        Haptics.tap()
        push(.member(sessionId))
    }

    /// A decision on a workflow's board: start or cancel its plan, answer it, or stop it.
    func act(on board: WorkflowBoard, in chatId: String, _ action: [String: JSONValue]) async {
        guard let runId = board.runId else { return }
        var action = action
        action["expectedRevision"] = .number(Double(board.revision))
        await perform {
            let client = self.owner(ofSession: chatId) ?? self.client
            let result = try await client.mutate(["method": "workflow", "workflowId": .string(runId), "action": .object(action)])
            if result.state == .rejected {
                self.notice = result.error ?? "Your Mac didn’t take that. Check the workflow there."
                Haptics.warning()
            }
        }
    }

    /// Parses an edit stage's file diffs (one file per entry, in stage order).
    func diffFiles(for stage: Stage) async -> [DiffFile] {
        var files: [DiffFile] = []
        for file in stage.files {
            guard let patch = file.patch else { continue }
            files += await core.parsePatch(patch)
        }
        return files
    }

    func openStageDiff(_ stage: Stage, file: Stage.File) async {
        let files = await diffFiles(for: stage)
        guard !files.isEmpty else { return }
        let focus = files.first { $0.path == file.path || $0.path.hasSuffix("/" + file.name) || file.path.hasSuffix($0.path) }
        diffReview = DiffReview(files: files, focus: focus?.path, projectId: currentSession?.projectId)
    }

    /// Opens a turn's changed files, scrolled to `focus` when given.
    func openTurnDiff(_ changed: [ChangedFile], focus: String?) async {
        var files: [DiffFile] = []
        for file in changed {
            guard let patch = file.patch else { continue }
            files += await core.parsePatch(patch)
        }
        guard !files.isEmpty else { return }
        let match = focus.flatMap { f in files.first { $0.path == f || f.hasSuffix("/" + $0.path) || $0.path.hasSuffix("/" + f) } }
        diffReview = DiffReview(files: files, focus: match?.path, projectId: currentSession?.projectId)
    }

    func newTask(in project: String? = nil) {
        if let project { projectId = project }
        openHome()
    }

    // MARK: Actions

    func perform(_ action: @escaping () async throws -> Void) async {
        busy = true
        notice = ""
        defer { busy = false }
        do { try await action() } catch {
            notice = error.localizedDescription
            Haptics.warning()
        }
    }

    /// Adds a Mac, or pairs again with one this phone already knows. Other Macs stay as they are.
    func pair(_ value: String) async {
        await perform {
            let offer = try Pairing.parse(value)
            let target: RemoteClient
            if let known = self.clients.first(where: { $0.pairing?.hostPeerId == offer.hostPeerId }) ?? self.clients.first(where: { $0.pairing == nil }) {
                target = known
            } else {
                target = RemoteClient(environment: self.environment, slot: UUID().uuidString.lowercased())
                target.push = self.client.push
                self.clients.append(target)
                self.saveSlots()
            }
            self.activate(target)
            self.screen = .home
            try await target.pair(value)
            self.pairOpen = false
            self.pairText = ""
        }
    }

    /// "Cancel" while the Mac is still asking.
    func cancelPairing() async {
        await client.disconnect(forget: true)
        leaveUnpairedMac()
    }

    var attachmentsReady: Bool { attachments.allSatisfy { $0.attachmentId != nil } }

    func addAttachment(name: String, data: Data, image: UIImage?) {
        let item = PendingAttachment(name: name, image: image)
        attachments.append(item)
        guard data.count <= 10 * 1024 * 1024 else {
            item.error = "Larger than 10 MB"
            return
        }
        Task {
            do {
                let result = try await client.upload(name: name, bytes: data) { item.progress = $0 }
                item.attachmentId = result.attachmentId
                item.progress = 1
            } catch {
                item.error = error.localizedDescription
            }
        }
    }

    func removeAttachment(_ id: String) { attachments.removeAll { $0.id == id } }

    var canSend: Bool {
        guard ready, !busy, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, attachmentsReady else { return false }
        return currentSessionId != nil || selectedProject != nil
    }

    func send() async {
        let prompt = draft
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let sessionId = currentSessionId
        await perform {
            let pending = self.client.operations.values.contains { op in
                op.result.unresolved && (sessionId != nil ? op.sessionId == sessionId : op.method == "create")
            }
            if pending { throw AegisError.message("Your previous message is still on its way to your Mac.") }
            if sessionId == nil, self.selectedProject == nil { throw AegisError.message("Choose a project first.") }
            if !self.attachmentsReady { throw AegisError.message("Wait for attachments to finish uploading.") }
            let ids = self.attachments.compactMap(\.attachmentId)
            self.sendTick += 1
            var request: [String: JSONValue]
            if let sessionId, let session = self.currentSession {
                request = [
                    "method": "send", "sessionId": .string(sessionId), "prompt": .string(prompt),
                    "settings": self.catalog(session.provider).requestSettings(self.settings(forSession: sessionId)),
                ]
            } else {
                request = [
                    "method": "create", "projectId": .string(self.selectedProject!.id), "provider": .string(self.provider),
                    "prompt": .string(prompt), "settings": self.catalog(self.provider).requestSettings(self.newSettings),
                ]
                if self.worktree { request["worktree"] = true }
            }
            if !ids.isEmpty { request["attachmentIds"] = .array(ids.map { .string($0) }) }
            if sessionId == nil {
                try await self.start(request, prompt: prompt)
                return
            }
            let result = try await self.client.mutate(request)
            switch result.state {
            case .completed:
                self.draft = ""
                self.attachments = []
                Haptics.success()
            case .rejected:
                self.notice = result.error == "SESSION_BUSY"
                    ? "This task is already running on your Mac. Your message is kept as a draft."
                    : (result.error ?? "Your Mac didn’t accept this.")
            default:
                // Kept in the journal and re-sent until the Mac answers; the bubble shows "Sending…".
                self.draft = ""
                self.attachments = []
            }
        }
    }

    /// A new task opens at once with its message; the page becomes the task when the
    /// Mac has created it (now, or after a re-send if it doesn't answer in time).
    private func start(_ request: [String: JSONValue], prompt: String) async throws {
        let commandId = UUID().uuidString.lowercased()
        draft = ""
        drawerOpen = false
        path = []
        screen = .starting(commandId)
        attachments = []
        let result: CommandResult
        do {
            result = try await client.mutate(request, commandId: commandId)
        } catch {
            // Not created: back to a new task with the message to send again.
            if screen == .starting(commandId) { openHome() }
            draft = prompt
            throw error
        }
        if result.state == .completed, result.sessionId != nil { Haptics.success() }
        startSettled(commandId)
    }

    /// Moves a starting page on to its task once the Mac has created it.
    func startSettled(_ commandId: String) {
        guard screen == .starting(commandId), let result = client.operations[commandId]?.result else { return }
        if result.state == .completed, let created = result.sessionId {
            open(session: created)
            if notificationStatus == .notDetermined { Task { await requestNotifications() } }
        } else if result.state == .rejected || (result.state == .completed && result.sessionId == nil) {
            openHome()
            draft = client.operations[commandId]?.prompt ?? ""
            notice = result.error.map { "Your Mac didn’t start this task: \($0)" } ?? "Your Mac didn’t start this task."
        }
    }

    func stop() async {
        guard let session = currentSession, let runId = session.runId else { return }
        await perform {
            try await self.client.mutate(["method": "stop", "sessionId": .string(session.id), "runId": .string(runId)])
        }
    }

    /// Allow or deny; on a plan, allow approves it and deny keeps planning.
    func decide(_ permission: RemotePermission, _ decision: String) async {
        await perform {
            try await (self.owner(ofSession: permission.sessionId) ?? self.client).mutate(permission.command(decision))
            self.approval = nil
        }
    }

    /// Answers the agent's questions, keyed by question text.
    func answer(_ permission: RemotePermission, _ answers: [String: QuestionAnswer]) async {
        await perform {
            try await (self.owner(ofSession: permission.sessionId) ?? self.client).mutate(permission.command("allow", answers: answers))
            self.approval = nil
        }
    }

    // MARK: Background

    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundTimer: Task<Void, Never>?

    /// Off screen (another app, or locked): keep the connection for a short grace so a
    /// quick switch back needs no reconnect, then close it cleanly before iOS suspends us.
    func beginBackground() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Aegis connection") { [weak self] in
            // iOS wants the task ended before this handler returns; the close is best effort.
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { await self.eachClient { await $0.suspend() } }
                self.endBackground()
            }
        }
        Task { await eachClient { await $0.background() } }
        backgroundTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(RemoteClient.backgroundGrace))
            guard !Task.isCancelled else { return }
            self?.finishBackground()
        }
    }

    func endBackground() {
        backgroundTimer?.cancel()
        backgroundTimer = nil
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    private func finishBackground() {
        let task = backgroundTask
        guard task != .invalid else { return }
        backgroundTimer?.cancel()
        backgroundTimer = nil
        Task {
            await eachClient { await $0.suspend() }
            if backgroundTask == task {
                UIApplication.shared.endBackgroundTask(task)
                backgroundTask = .invalid
            }
        }
    }

    // MARK: Notification titles

    @ObservationIgnored private var savedTitles: [String: NotificationTitles.Entry]?

    /// Mirrors the sidebar's titles into the App Group for the notification extension.
    func saveNotificationTitles() {
        let entries = Dictionary(
            sessions.map { ($0.id, NotificationTitles.Entry(title: $0.title.isEmpty ? "Untitled task" : $0.title, project: placeLabel(of: $0))) },
            uniquingKeysWith: { first, _ in first }
        )
        guard entries != savedTitles else { return }
        savedTitles = entries
        NotificationTitles.save(entries)
    }

    /// Forgets the open Mac; the others stay paired.
    func removeMac() async {
        let leaving = client
        await leaving.disconnect(forget: true)
        if clients.count > 1 {
            clients.removeAll { $0.slot == leaving.slot }
            saveSlots()
            activeSlot = (pairedClients.first ?? clients[0]).slot
            defaults.set(activeSlot, forKey: "aegis-active-mac")
        }
        savedTitles = nil
        saveNotificationTitles()
        drafts = [:]
        path = []
        screen = .home
    }

    func dismissNotice() {
        notice = ""
        client.clearError()
    }
}
