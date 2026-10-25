import AegisKit
import SwiftUI

struct SessionView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String

    @State private var rendered = SessionModel.empty
    /// The inputs `rendered` was built from. Rendering is async, so anything placed next
    /// to it (pending bubbles, the copy button) must follow these, not the newest data.
    @State private var shown = RenderKey(history: "", live: nil, running: false, status: "")
    /// The committed messages `rendered` was built from.
    @State private var shownMessages: [RemoteMessage] = []
    private static let bottomID = "session-bottom"
    @State private var scroller = ScrollHandle()
    @State private var atBottom = true
    @State private var copied = false
    @State private var loadingOlder = false
    /// The last automatic load failed; a button retries instead of looping on it.
    @State private var olderFailed = false
    /// The older-page cursor `rendered` was built with, so the loading row and the rows
    /// it pages in change in the same pass.
    @State private var shownBefore: Double?
    @State private var scrollPhase = ScrollPhase.idle
    /// Rendered rows kept out of the stack above the shown ones. Laying out a whole
    /// page of rows at once stalled opening a long task and paging in older history,
    /// so they go in a few at a time as the top comes near.
    @State private var hiddenRows = 0
    private static let firstRows = 30
    private static let moreRows = 20

    private var session: RemoteSession? { model.sessions.first { $0.id == sessionId } }
    private var history: SessionHistory? { model.client.messagesBySession[sessionId] }
    private var messages: [RemoteMessage] { history?.messages ?? [] }
    /// Names `messages`: comparing it is cheap, unlike comparing the messages.
    private var historyKey: String { sessionId + ":" + String(history?.version ?? 0) }
    private var running: Bool { session?.isRunning ?? false }
    private var permissions: [RemotePermission] { model.permissions.filter { $0.sessionId == sessionId } }

    private struct RenderKey: Equatable {
        let history: String
        /// Streamed text not yet committed.
        let live: String?
        let running: Bool
        let status: String
    }

    /// Sends not yet in the loaded history, shown with their delivery state. A delivered
    /// one stays until the next snapshot brings it in, so the bubble never blinks out.
    private var pendingSends: [(id: String, prompt: String, result: CommandResult)] {
        let now = Date().timeIntervalSince1970 * 1000
        return model.client.operations.compactMap { id, op in
            // A follow-up to this task, or the message that started it.
            let ours = op.method == "send" ? op.sessionId == sessionId : op.method == "create" && op.result.sessionId == sessionId
            guard ours, let prompt = op.prompt else { return nil }
            let sentAt = op.sentAt ?? 0
            let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            // Only a matching message recorded after this send counts: an earlier "OK" is not this one.
            let recorded = shownMessages.contains {
                $0.role == "user" && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == text && ($0.at ?? .infinity) >= sentAt - 5000
            }
            if recorded { return nil }
            // Bounded, so a delivered send outside the loaded page can't linger.
            if op.result.state == .completed, now - sentAt > 120_000 { return nil }
            return (id, prompt, op.result)
        }
        .sorted { (model.client.operations[$0.id]?.sentAt ?? 0) < (model.client.operations[$1.id]?.sentAt ?? 0) }
    }

    /// Until the task list catches up, a new task is titled by its first message.
    private var startingTitle: String? {
        model.client.operations.values.first { $0.method == "create" && $0.result.sessionId == sessionId }?.prompt
            .map { String($0.prefix(60)) }
    }

    var body: some View {
        // A reader, not a ScrollPosition binding: the binding keeps saying "bottom" after
        // the user scrolls, so asking for the bottom again changed nothing and never scrolled.
        ScrollViewReader { proxy in
        ScrollView {
            // A plain stack on purpose: LazyVStack re-estimates off-screen row
            // heights, and with bottom anchoring and rows whose height changes
            // (markdown, traces, async diff previews) the estimates never settled,
            // freezing the app at 100% CPU. History is paged, so rows are few.
            VStack(alignment: .leading, spacing: 18) {
                // Older pages load on their own as the top comes near; the button is
                // only the retry after a failed load.
                if hiddenRows > 0 || shownBefore != nil {
                    Group {
                        if hiddenRows == 0 && olderFailed && !loadingOlder {
                            Button("Load earlier messages") { loadOlder(retry: true) }
                                .font(.app(13)).foregroundStyle(Color.text2)
                        } else {
                            ProgressView().controlSize(.small)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 24)
                }
                let pending = pendingSends
                // A new task already shows its message; no loading line under it.
                if messages.isEmpty && history?.live == nil && pending.isEmpty {
                    Text(model.ready ? "Loading messages…" : "Messages update when your Mac is back.")
                        .font(.app(14)).foregroundStyle(Color.text2)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                ForEach(rendered.items.dropFirst(hiddenRows)) { item in
                    ItemView(item: item, sessionId: sessionId).equatable()
                }
                ForEach(pending, id: \.id) { send in
                    VStack(alignment: .trailing, spacing: 6) {
                        UserBubble(prompt: send.prompt)
                        // Quiet while the Mac is answering; a stalled send says so.
                        if !model.client.isInFlight(send.id) { OpStatus(result: send.result) }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                // The Mac took it and the turn is starting; the next snapshot brings the real row.
                if !shown.running, pending.contains(where: { [.completed, .accepted].contains($0.result.state) || model.client.isInFlight($0.id) }) {
                    Text("Working").font(.app(14)).shimmer()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(permissions) { permission in
                    ApprovalCard(permission: permission)
                }
                if !shown.running, pending.isEmpty, session?.isFailed == true {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Turn failed", systemImage: "exclamationmark.circle").font(.app(14, weight: .semibold)).foregroundStyle(Color.danger)
                        Text("Details are in Aegis on your Mac.").font(.app(14))
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.dangerBg, in: .rect(cornerRadius: 20))
                }
                if !shown.running, pending.isEmpty, session?.isFailed != true, let answer = rendered.lastAnswerText, !answer.isEmpty,
                   !shownMessages.isEmpty, !isUserLast {
                    Button {
                        UIPasteboard.general.string = answer
                        copied = true
                        Haptics.tap()
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            copied = false
                        }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "square.on.square")
                            .font(.app(15))
                            .foregroundStyle(Color.text2)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(copied ? "Copied" : "Copy response")
                    .padding(.top, -10)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 16)
            Color.clear.frame(height: 1).id(Self.bottomID)
                .background(ScrollViewProbe(handle: scroller))
        }
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .scrollDismissesKeyboard(.interactively)
        // Tapping the conversation puts the composer away, like a drag does.
        .simultaneousGesture(TapGesture().onEnded {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        })
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            geo.contentSize.height - geo.visibleRect.maxY
        } action: { _, distance in
            // Hysteresis: a boundary value must not flip the state back and forth.
            if atBottom, distance > 140 { atBottom = false }
            else if !atBottom, distance < 80 { atBottom = true }
        }
        .onScrollPhaseChange { _, phase in scrollPhase = phase }
        .onScrollGeometryChange(for: TopRoom.self) { geo in
            TopRoom(offset: geo.visibleRect.minY, content: geo.contentSize.height, viewport: geo.containerSize.height)
        } action: { _, room in
            // Only while the user scrolls, or when the page doesn't fill the screen: right
            // after opening, the list sits at the top for a moment before it moves to the end.
            let userScrolling = scrollPhase == .interacting || scrollPhase == .decelerating
            let fits = room.content <= room.viewport
            if room.offset < room.viewport, userScrolling || fits { loadOlder() }
        }
        .task(id: RenderKey(history: historyKey, live: history?.live, running: running, status: session?.status ?? "")) {
            let key = RenderKey(history: historyKey, live: history?.live, running: running, status: session?.status ?? "")
            let committed = messages
            let before = history?.before
            let next = await model.core.renderSession(history: key.history, messages: committed, live: key.live, running: key.running, status: key.status)
            await Task.detached(priority: .userInitiated) { MarkdownBlocks.warm(next.items) }.value
            guard !Task.isCancelled else { return }
            // An older page goes in above what's on screen.
            let prepended = shownMessages.first.map { first in
                committed.first?.id != first.id && committed.contains { $0.id == first.id }
            } ?? false
            let follow = atBottom
            if prepended {
                // The page stays above the shown rows; scrolling up brings it in.
                hiddenRows += max(0, next.items.count - rendered.items.count)
                // The row at the seam can still grow (a turn that began on the older page).
                if !follow { scroller.keepPosition() }
            } else if shownMessages.first?.id != committed.first?.id {
                // Opening the task, or a different history: start from the latest rows.
                hiddenRows = max(0, next.items.count - Self.firstRows)
            }
            rendered = next
            shown = key
            shownMessages = committed
            shownBefore = before
            if follow { scrollToBottom(proxy, animated: false) }
            // The reader waited at the top for this page.
            else if prepended, scroller.nearTop { loadOlder() }
        }
        .onChange(of: model.sendTick) {
            scrollToBottom(proxy, animated: true)
        }
        // Over the conversation, inside the composer's inset so it sits just above it.
        // It used to hang off the composer with an offset, outside its own frame, so
        // taps fell through to the list. An overlay also leaves the scroll geometry
        // that decides whether it shows untouched (changing that looped forever).
        .overlay(alignment: .bottom) {
            Group {
                if !atBottom && !rendered.items.isEmpty {
                    Button {
                        Haptics.tap()
                        scroller.scrollToBottom(animated: true)
                    } label: {
                        Image(systemName: "arrow.down").font(.app(17, weight: .semibold)).foregroundStyle(Color.ink)
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    // Plain glass like the other round buttons; the system .glass style adds a gray fill.
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("Jump to latest")
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
            .padding(.bottom, 12)
            .animation(.smooth(duration: 0.2), value: atBottom)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                if running && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Draft saved · send it after this turn").font(.app(12.5)).foregroundStyle(Color.text2)
                }
                if let session {
                    Composer(
                        catalog: model.catalog(session.provider),
                        settings: model.settings(forSession: sessionId),
                        onSettings: { model.setSettings($0, forSession: sessionId) },
                        placeholder: permissions.first.map {
                            $0.kind == .question ? "Answer the question to continue"
                                : $0.kind == .plan ? "Review the plan to continue" : "Resolve this approval request to continue"
                        } ??
                            (running ? "Ask for follow-up changes" : "message to agent"),
                        running: running,
                        canStop: model.ready && !model.busy && session.runId != nil
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { SidebarButton() }
            // Title sits next to the sidebar button, without a glass background. In the
            // principal slot: a leading item's (hidden) glass morphed into the next
            // page's back button as a rectangle during the push.
            ToolbarItem(placement: .principal) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(session?.title ?? startingTitle ?? "Task").font(.app(16, weight: .semibold)).lineLimit(1)
                    HStack(spacing: 5) {
                        Text(model.projects.first { $0.id == session?.projectId }?.name ?? "Project")
                        Text("·").foregroundStyle(Color.text3)
                        let connecting = [.connecting, .confirming].contains(model.client.connection)
                        if connecting || (model.client.connection == .connected && model.client.freshness != .current) {
                            ProgressView().controlSize(.mini)
                        } else {
                            StatusDot(online: model.ready)
                        }
                        Text(model.macName + (model.client.connection == .offline ? " offline" : ""))
                    }
                    .font(.app(12))
                    .foregroundStyle(Color.text2)
                    .lineLimit(1)
                }
                // The whole room between the sidebar button and the trailing capsule.
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 8)
            }
            // Grouped into one glass capsule, like the system toolbars.
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("New task in this project", systemImage: "square.and.pencil") {
                    model.newTask(in: session?.projectId)
                }
                Menu {
                    if let projectId = session?.projectId {
                        Button("Open project", systemImage: "folder") { model.push(.project(projectId)) }
                    }
                    if let answer = rendered.lastAnswerText, !answer.isEmpty {
                        Button("Copy last response", systemImage: "square.on.square") {
                            UIPasteboard.general.string = answer
                            Haptics.tap()
                        }
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.client.refresh() } }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
            }
        }
        }
    }

    /// SwiftUI's scroll-to-id after content changes, then the scroll view itself on the next
    /// pass: on some iOS releases the SwiftUI call alone silently did nothing.
    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated { withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) } } else { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
        DispatchQueue.main.async { scroller.scrollToBottom(animated: animated) }
    }

    private struct TopRoom: Equatable {
        /// How far the visible top is below the start of the content.
        let offset: CGFloat
        let content: CGFloat
        let viewport: CGFloat
    }

    private func loadOlder(retry: Bool = false) {
        if hiddenRows > 0 {
            // Already here: a few more rows go in above, and the reader stays put.
            scroller.keepPosition()
            hiddenRows = max(0, hiddenRows - Self.moreRows)
            return
        }
        // Waits for the page in hand to render, so one page is asked for at a time.
        // After a failure only the button tries again; scrolling would keep hammering it.
        guard !loadingOlder, retry || !olderFailed, !rendered.items.isEmpty, shown.history == historyKey,
              let before = history?.before, before == shownBefore else { return }
        loadingOlder = true
        olderFailed = false
        Task {
            do { try await model.client.older() } catch { olderFailed = true }
            loadingOlder = false
        }
    }

    private var isUserLast: Bool {
        if case .user = rendered.items.last { return true }
        return false
    }
}

struct UserBubble: View {
    let prompt: String
    var attachments: [Attachment] = []

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !attachments.isEmpty {
                HStack(spacing: 6) {
                    ForEach(attachments) { a in
                        Label(a.name, systemImage: a.image ? "photo" : "doc")
                            .font(.app(12.5)).foregroundStyle(Color.text2).lineLimit(1)
                            .padding(.horizontal, 10).frame(height: 28)
                            .overlay(Capsule().strokeBorder(Color.hair, lineWidth: 0.5))
                    }
                }
            }
            Text(prompt)
                .font(.app(15))
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Color.fill2, in: .rect(cornerRadius: 22))
        }
        .frame(maxWidth: 320, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// Equatable so a re-render that only adds rows (a new page, a new reply) skips the
/// bodies of the rows that didn't change.
private struct ItemView: View, Equatable {
    @Environment(AppModel.self) private var model
    let item: SessionItem
    let sessionId: String

    static func == (a: ItemView, b: ItemView) -> Bool { a.item == b.item && a.sessionId == b.sessionId }

    var body: some View {
        switch item {
        case .user(_, let prompt, let attachments):
            UserBubble(prompt: prompt, attachments: attachments)
        case .answer(_, let markdown, let streaming):
            MarkdownView(text: markdown, streaming: streaming)
        case .plan(_, let markdown):
            VStack(alignment: .leading, spacing: 8) {
                Text("Proposed plan").font(.app(13, weight: .semibold)).foregroundStyle(Color.text2)
                MarkdownView(text: markdown)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hair, lineWidth: 0.5))
        case .changes(_, let files):
            ChangesCard(files: files) { path in Task { await model.openTurnDiff(files, focus: path) } }
        case .work(_, let work):
            WorkBlockView(work: work)
        case .activity(_, let steps):
            LegacyActivity(steps: steps)
        case .working(_, let label):
            Text(label).font(.app(14)).shimmer()
        }
    }
}

private struct LegacyActivity: View {
    let steps: [SessionItem.Step]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("\(steps.count) \(steps.count == 1 ? "step" : "steps")")
                    Image(systemName: "chevron.right").font(.app(11, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.app(14)).foregroundStyle(Color.text2)
            }
            .buttonStyle(.plain)
            if open {
                ForEach(steps) { step in
                    Text(step.detail).font(.app(12, design: .monospaced))
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.code, in: .rect(cornerRadius: 12))
                }
            }
        }
    }
}

/// A turn's changed files: collapsible, first three shown, the rest in the sheet.
private struct ChangesCard: View {
    let files: [ChangedFile]
    let onOpen: (String?) -> Void
    @State private var open = true
    private let shown = 3

    var body: some View {
        VStack(spacing: 0) {
            // The header sits on its own gray, so the rows below need no line under it.
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text("\(files.count) \(files.count == 1 ? "file" : "files") changed").font(.app(14, weight: .semibold))
                    DiffCounts(added: files.reduce(0) { $0 + $1.additions }, removed: files.reduce(0) { $0 + $1.deletions })
                    Spacer()
                    Image(systemName: "chevron.down").font(.app(12, weight: .semibold)).foregroundStyle(Color.text3)
                        .rotationEffect(.degrees(open ? 0 : -90))
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(Color.fill2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                // Each file opens its diff; there is no separate "review" row.
                ForEach(Array(files.prefix(shown).enumerated()), id: \.offset) { index, file in
                    if index > 0 { rule }
                    Button { onOpen(file.path) } label: {
                        HStack(spacing: 10) {
                            Text(file.path).font(.app(13)).lineLimit(1).truncationMode(.head)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            DiffCounts(added: file.additions, removed: file.deletions)
                            Image(systemName: "chevron.right").font(.app(11, weight: .semibold)).foregroundStyle(Color.text3)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if files.count > shown {
                    rule
                    Button { onOpen(nil) } label: {
                        HStack {
                            Text("View \(files.count - shown) more \(files.count - shown == 1 ? "file" : "files")")
                            Spacer()
                            Image(systemName: "chevron.right").font(.app(11, weight: .semibold)).foregroundStyle(Color.text3)
                        }
                        .font(.app(13)).foregroundStyle(Color.text2)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .background(Color.page)
        .clipShape(.rect(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.hair, lineWidth: 0.5))
    }

    /// A faint inset line between rows (the system separator read as too strong).
    private var rule: some View {
        Rectangle().fill(Color.hair).frame(height: 0.5).padding(.leading, 14)
    }
}

private struct OpStatus: View {
    @Environment(AppModel.self) private var model
    let result: CommandResult

    static func reason(_ code: String?) -> String {
        switch code {
        case "COMMAND_EXPIRED": "Couldn’t reach your Mac in time"
        case "SESSION_BUSY": "The task was already running"
        case nil: "Rejected by your Mac"
        default: code!
        }
    }

    var body: some View {
        Group {
            switch result.state {
            case .rejected:
                Label("Not sent · \(Self.reason(result.error))", systemImage: "exclamationmark.circle")
                    .foregroundStyle(Color.warn)
            case .accepted:
                HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Accepted by your Mac") }
                    .foregroundStyle(Color.text2)
            case .completed:
                EmptyView()
            default:
                // Re-sent automatically until the Mac answers.
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(model.ready ? "Sending…" : "Sends when your Mac is back")
                }
                .foregroundStyle(Color.text2)
            }
        }
        .font(.app(12.5))
    }
}

/// Inline card for a live permission request in this task.
struct ApprovalCard: View {
    @Environment(AppModel.self) private var model
    let permission: RemotePermission
    @State private var summary = ""

    var body: some View {
        Group {
            switch permission.kind {
            case .question: questionCard
            case .plan: planCard
            case .approval:
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.shield").foregroundStyle(Color.warn)
                        Text("Approval needed").fontWeight(.semibold)
                        Text("· \(permission.toolName)").foregroundStyle(Color.text2)
                    }
                    .font(.app(14))
                    Text(summary.isEmpty ? permission.toolName : summary)
                        .font(.app(13, design: .monospaced)).lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.page, in: .rect(cornerRadius: 12))
                    HStack(spacing: 8) {
                        Button("Deny") { Task { await model.decide(permission, "deny") } }
                            .buttonStyle(PillButtonStyle(kind: .secondary)).disabled(!model.ready)
                        Button("Review") { model.approval = permission }
                            .buttonStyle(PillButtonStyle(kind: .primary))
                    }
                }
                .padding(14)
                .background(Color.fill2, in: .rect(cornerRadius: 22))
            case .desktop:
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "laptopcomputer").font(.app(16))
                        .frame(width: 34, height: 34).background(Color.fill2, in: .circle)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(deskTitle).font(.app(14, weight: .semibold))
                        Text("This request can’t be answered from iPhone yet. Open Aegis on your Mac to continue.")
                            .font(.app(13.5)).foregroundStyle(Color.text2)
                        HStack(spacing: 8) {
                            Button("View request") { model.approval = permission }.buttonStyle(PillButtonStyle(kind: .secondary))
                            Button("Deny") { Task { await model.decide(permission, "deny") } }
                                .buttonStyle(PillButtonStyle(kind: .secondary)).disabled(!model.ready)
                        }
                        .padding(.top, 6)
                    }
                }
                .padding(14)
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hair, lineWidth: 0.5))
            }
        }
        .task(id: permission.detail) { summary = await model.core.describeRequest(permission.detail).summary }
    }

    private var questionCard: some View {
        let questions = permission.questions ?? []
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.circle").foregroundStyle(Color.accent)
                Text(questions.count == 1 ? "Question" : "\(questions.count) questions").fontWeight(.semibold)
            }
            .font(.app(14))
            Text(questions.first?.question ?? "")
                .font(.app(15)).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button("Decline") { Task { await model.decide(permission, "deny") } }
                    .buttonStyle(PillButtonStyle(kind: .secondary)).disabled(!model.ready)
                Button("Answer") { model.approval = permission }
                    .buttonStyle(PillButtonStyle(kind: .primary))
            }
        }
        .padding(14)
        .background(Color.fill2, in: .rect(cornerRadius: 22))
    }

    private var planCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "list.bullet.clipboard").foregroundStyle(Color.warn)
                Text("Plan ready for review").fontWeight(.semibold)
            }
            .font(.app(14))
            Text(planPreview)
                .font(.app(14)).foregroundStyle(Color.text2).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button("Keep planning") { Task { await model.decide(permission, "deny") } }
                    .buttonStyle(PillButtonStyle(kind: .secondary)).disabled(!model.ready)
                Button("Review plan") { model.approval = permission }
                    .buttonStyle(PillButtonStyle(kind: .primary))
            }
        }
        .padding(14)
        .background(Color.fill2, in: .rect(cornerRadius: 22))
    }

    /// The plan's first lines without Markdown marks.
    private var planPreview: String {
        let lines = (permission.plan?.markdown ?? "").split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "#>*-` ")) }
            .filter { !$0.isEmpty }
        return lines.isEmpty ? "Approve it to let the agent start, or keep it planning." : lines.prefix(3).joined(separator: " · ")
    }

    private var deskTitle: String {
        let tool = permission.toolName.lowercased()
        if tool.contains("question") { return "The agent has a question" }
        if tool.contains("plan") { return "Plan ready for review" }
        return "\(permission.toolName) needs your Mac"
    }
}

struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    let kind: Kind
    var height: CGFloat = 40
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.app(15, weight: .semibold))
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .foregroundStyle(kind == .primary ? Color.onInk : Color.text1)
            .background(kind == .primary ? Color.ink : Color.page, in: .capsule)
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

/// The UIScrollView behind a SwiftUI ScrollView. Jumping to the end goes through it
/// directly; SwiftUI's own scroll calls didn't move the list on some iOS versions.
@MainActor final class ScrollHandle {
    weak var scrollView: UIScrollView?

    func scrollToBottom(animated: Bool) {
        guard let scroll = scrollView else { return }
        scroll.layoutIfNeeded()
        let insets = scroll.adjustedContentInset
        let bottom = max(-insets.top, scroll.contentSize.height - scroll.bounds.height + insets.bottom)
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: bottom), animated: animated)
    }

    /// Within a screen of the top.
    var nearTop: Bool {
        guard let scroll = scrollView else { return false }
        return scroll.contentOffset.y + scroll.adjustedContentInset.top < scroll.bounds.height
    }

    private var resize: NSKeyValueObservation?

    /// Keeps the visible rows in place when content is about to be added above them:
    /// the next time the content grows, the offset moves by as much. Done as the
    /// size changes, before drawing, so the old position never shows for a frame.
    func keepPosition() {
        guard let scroll = scrollView else { return }
        let fromEnd = scroll.contentSize.height - scroll.contentOffset.y
        let height = scroll.contentSize.height
        let observation = scroll.observe(\.contentSize, options: [.new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated {
                guard scroll.contentSize.height > height else { return }
                scroll.contentOffset.y = scroll.contentSize.height - fromEnd
                self?.resize = nil
            }
        }
        resize = observation
        // Nothing grew (the page was all tool rows that fold away): let it go.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            if self?.resize === observation { self?.resize = nil }
        }
    }
}

/// An invisible view inside the scroll content that finds the enclosing UIScrollView.
private struct ScrollViewProbe: UIViewRepresentable {
    let handle: ScrollHandle

    func makeUIView(context: Context) -> Probe {
        let view = Probe()
        view.handle = handle
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: Probe, context: Context) {
        view.handle = handle
        view.attach()
    }

    final class Probe: UIView {
        weak var handle: ScrollHandle?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            attach()
        }

        func attach() {
            var view = superview
            while let current = view {
                if let scroll = current as? UIScrollView {
                    handle?.scrollView = scroll
                    return
                }
                view = current.superview
            }
        }
    }
}

/// A new task between send and its creation on the Mac: the message and Working
/// right away, then the task itself (AppModel.startSettled).
struct StartingView: View {
    @Environment(AppModel.self) private var model
    let commandId: String

    private var operation: RemoteOperation? { model.client.operations[commandId] }

    var body: some View {
        let prompt = operation?.prompt ?? ""
        let result = operation?.result
        // While the Mac is answering this reads as sent; only a stalled or refused
        // start shows its state.
        let stalled = result.map { $0.state == .rejected || ($0.unresolved && !model.client.isInFlight(commandId)) } ?? false
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .trailing, spacing: 6) {
                    UserBubble(prompt: prompt)
                    if stalled, let result { OpStatus(result: result) }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                if let result, result.state == .unknown, let error = result.error {
                    // The Mac took it but couldn't say whether the task started.
                    VStack(alignment: .leading, spacing: 10) {
                        Text(error).font(.app(14)).foregroundStyle(Color.text2)
                        Button("New task") { model.openHome() }.font(.app(14, weight: .semibold))
                    }
                } else if !stalled {
                    Text("Working").font(.app(14)).shimmer()
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // The composer's place, until the task exists to send to.
            HStack {
                Text("Ask for follow-up changes").font(.app(16)).foregroundStyle(Color.text3)
                Spacer()
                Circle().fill(Color.inkOff).frame(width: 34, height: 34)
            }
            .padding(.leading, 18).padding(.trailing, 7).padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
            .padding(.horizontal, 26)
            .padding(.bottom, 6)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { SidebarButton() }
            // As in SessionView: the principal slot, so no glass morphs on navigation.
            ToolbarItem(placement: .principal) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(prompt).font(.app(16, weight: .semibold)).lineLimit(1)
                    Text("Starting on \(model.macName)…").font(.app(12)).foregroundStyle(Color.text2).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 8)
            }
        }
        .task(id: result) { model.startSettled(commandId) }
        .onAppear { if operation == nil { model.openHome() } }
    }
}
