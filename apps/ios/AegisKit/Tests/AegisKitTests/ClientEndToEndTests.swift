import Foundation
import Testing
@testable import AegisKit

/// Runs RemoteClient against scripts/remote/fixture.mjs: the desktop gateway and
/// relay with a deterministic fake runtime (needs `npm run transpile:electron`).
@Suite(.serialized) @MainActor struct ClientEndToEndTests {
    private func waitUntil(_ timeout: TimeInterval = 20, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { throw AegisError.message("timed out") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    @Test func pairsReadsAndMutatesAgainstFixtureHost() async throws {
        let port = Int.random(in: 20000...40000)
        let offerFile = FileManager.default.temporaryDirectory.appendingPathComponent("aegis-offer-\(port).txt")
        let fixture = try NodeProcess(["scripts/remote/fixture.mjs"], environment: [
            "AEGIS_FIXTURE_PORT": String(port), "AEGIS_FIXTURE_OFFER": offerFile.path,
        ])
        _ = try await fixture.line(containing: "Isolated UI fixture ready")
        let offer = try String(contentsOf: offerFile, encoding: .utf8)

        let files = FileStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("aegis-e2e-\(port)"))
        let secrets = MemoryStore()
        let client = RemoteClient(environment: .fixture, secrets: secrets, files: files)
        try await client.pair(offer)
        try await waitUntil { client.connection == .connected && client.snapshot != nil && client.agentOptions != nil }

        let snapshot = try #require(client.snapshot)
        #expect(snapshot.environment == .fixture)
        #expect(snapshot.projects.map(\.id) == ["project", "site"])
        #expect(snapshot.sessions.contains { $0.id == "stream" && $0.handoffSourceProvider == "claude" })
        #expect(client.pairing?.invite == nil) // claimed invites are dropped after auth
        #expect(try secrets.get("identity") != nil)

        // History for a session.
        client.select("design")
        try await waitUntil { client.messagesBySession["design"]?.messages.isEmpty == false }

        // Paired through the relay, the client moves to the Mac's direct listener.
        try await waitUntil { client.transport == .direct }
        #expect(client.connection == .connected)

        // A reply streams in as pushed events: live text first, then the committed message.
        client.select("stream")
        try await waitUntil { client.messagesBySession["stream"]?.messages.isEmpty == false }
        let followUp = try await client.mutate(["method": "send", "sessionId": "stream", "prompt": "One more thing"])
        #expect(followUp.state == .completed)
        var streamed: [String] = []
        try await waitUntil {
            if let live = client.messagesBySession["stream"]?.live, streamed.last != live { streamed.append(live) }
            return client.messagesBySession["stream"]?.messages.last?.text == "Got the follow-up. The test session is updated."
        }
        #expect(!streamed.isEmpty && "Got the follow-up. The test session is updated.".hasPrefix(streamed.last ?? "-"))
        try await waitUntil { client.messagesBySession["stream"]?.live == nil }
        #expect(client.messagesBySession["stream"]?.messages.map(\.text).suffix(2) == ["One more thing", "Got the follow-up. The test session is updated."])
        client.select("design")

        // Approval, as the approval sheet sends it.
        let permission = try #require(snapshot.permissions.first { $0.kind == .approval })
        let decided = try await client.mutate(permission.command("allow"))
        #expect(decided.state == .completed)
        _ = try await fixture.line(containing: "fixture permission Bash {\"behavior\":\"allow\"}")

        // A question: its options reach the phone, and the answers reach the Mac as the desktop card sends them.
        let question = try #require(snapshot.permissions.first { $0.kind == .question })
        #expect(!question.canApprove) // older phones send it to the Mac
        #expect(question.questions?.map(\.allowsMany) == [false, true])
        #expect(question.questions?.first?.options.first == RemoteQuestion.Option(label: "User-facing only", description: "Features and fixes people will notice"))
        var notes = QuestionAnswer()
        notes.pick("RELEASE_NOTES.md", many: true)
        notes.pick("GitHub release", many: true)
        notes.type(" Slack ", many: true)
        let answered = try await client.mutate(question.command("allow", answers: [
            "Which changes should the notes cover?": QuestionAnswer(selected: ["Everything merged"]),
            "Where should the notes go?": notes,
        ]))
        #expect(answered.state == .completed)
        let answer = try await fixture.line(containing: "fixture permission AskUserQuestion")
        #expect(answer.contains(#""Where should the notes go?":"RELEASE_NOTES.md,GitHub release,Slack""#))
        #expect(answer.contains(#""Where should the notes go?":{"selected":["RELEASE_NOTES.md","GitHub release"],"other":"Slack"}"#))

        // A plan, with the text of its ExitPlanMode call; approving picks the card's approve answer.
        let plan = try #require(snapshot.permissions.first { $0.kind == .plan })
        #expect(plan.plan?.markdown.hasPrefix("## Replay tests for remote commands") == true)
        #expect(plan.plan?.truncated == nil && plan.questions == nil)
        #expect(try await client.mutate(plan.command("allow")).state == .completed)
        let approved = try await fixture.line(containing: "fixture permission ExitPlanMode")
        #expect(approved.contains(#""answers":{"Approve this plan and let Claude start implementing it?":"Approve and execute"}"#))
        try await waitUntil { client.snapshot?.permissions.isEmpty == true }

        // Chunked upload (two chunks) and a new task carrying it plus settings.
        let attachment = try await client.upload(name: "notes.txt", bytes: Data(repeating: 65, count: attachmentChunkBytes + 10))
        #expect(attachment.size == Double(attachmentChunkBytes + 10))
        let created = try await client.mutate([
            "method": "create", "projectId": "project", "provider": "codex", "prompt": "Ship it",
            "settings": .object(["model": "gpt-5", "effort": "high", "permissionMode": "fullAccess", "plan": true]),
            "worktree": true, "attachmentIds": .array([.string(attachment.attachmentId)]),
        ])
        #expect(created.state == .completed)
        let started = try await fixture.line(containing: "fixture start")
        #expect(started.contains("\"effort\":\"high\"") && started.contains("notes.txt") && started.contains("\"worktree\":true"))
        let newSession = try #require(created.sessionId)
        try await waitUntil { client.snapshot?.sessions.contains { $0.id == newSession } == true }

        // Journal: a resolved command stays resolved after reconcile.
        await client.reconcile()
        #expect(client.operations.values.allSatisfy { !$0.result.unresolved })

        // Replies lost on the way: after a restart the journal re-sends what never got an
        // answer. One reached the Mac (answered from its journal, not run twice), one
        // never did (runs now), one is past its lifetime (refused).
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        func op(_ id: String, _ prompt: String, expiresAt: Double) -> RemoteOperation {
            RemoteOperation(request: .object([
                "id": .string(id), "commandId": .string(id), "expiresAt": .number(expiresAt),
                "method": "create", "projectId": "project", "provider": "claude", "prompt": .string(prompt),
            ]), result: CommandResult(commandId: id, state: .unknown))
        }
        var journal = client.operations
        let reached = try #require(journal.first { $0.value.method == "create" })
        journal[reached.key]?.result = CommandResult(commandId: reached.key, state: .unknown)
        journal["lost-1"] = op("lost-1", "Never arrived", expiresAt: now + 240_000)
        journal["late-1"] = op("late-1", "Too late", expiresAt: now - 1)
        await client.disconnect()
        // As an older build left it: in the Keychain, which start() moves into a file.
        files.remove("operations.json")
        try secrets.set("operations", String(decoding: try JSONEncoder().encode(journal), as: UTF8.self))
        await client.start()
        try await waitUntil { client.operations.values.allSatisfy { !$0.result.unresolved } }
        #expect(client.operations[reached.key]?.result.state == .completed)
        #expect(client.operations["lost-1"]?.result.state == .completed)
        #expect(client.operations["late-1"]?.result == CommandResult(commandId: "late-1", state: .rejected, error: "COMMAND_EXPIRED"))
        #expect(try secrets.get("operations") == nil && files.read("operations.json") != nil)

        // Off screen: no reconnects or polls; back within the grace, the same connection is reused.
        await client.background()
        await client.foreground()
        #expect(client.connection == .connected)
        // Suspended by iOS: closed cleanly, and coming back reconnects.
        await client.background()
        await client.suspend()
        #expect(client.connection == .offline)
        await client.foreground()
        try await waitUntil { client.connection == .connected }
        // The Mac's address was kept: the reconnect goes straight to it.
        #expect(client.transport == .direct)
        // The lost one runs now (gateway.test.mjs covers that a repeat never runs twice).
        _ = try await fixture.line(containing: "fixture start claude")

        // Polls with the current revision get a short answer and keep the snapshot.
        let before = try #require(client.snapshot)
        await client.refresh()
        #expect(client.snapshot == before && client.freshness == .current)

        // Forgetting clears the pairing and journal but keeps the identity.
        await client.disconnect(forget: true)
        #expect(client.connection == .unpaired)
        #expect(try secrets.get("pairing") == nil)
        #expect(try secrets.get("identity") != nil)
        fixture.process.terminate()
    }
}
