import Foundation
import Testing
@testable import AegisKit

@Suite struct PermissionModelTests {
    private func decode(_ json: String) throws -> RemotePermission {
        try JSONDecoder().decode(RemotePermission.self, from: Data(json.utf8))
    }

    @Test func olderMacsDecodeWithoutQuestionsOrPlans() throws {
        let permission = try decode(#"{"requestId":"r","sessionId":"s","runId":"u","toolName":"AskUserQuestion","detail":"{}","canApprove":false}"#)
        #expect(permission.kind == .desktop)
        #expect(try decode(#"{"requestId":"r","sessionId":"s","runId":"u","toolName":"Bash","detail":"{}","canApprove":true,"future":1}"#).kind == .approval)
    }

    @Test func decodesQuestionsAndPlans() throws {
        let question = try decode(#"""
        {"requestId":"r","sessionId":"s","runId":"u","toolName":"AskUserQuestion","detail":"{}","canApprove":false,
         "questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"First"},{"label":"B"}],"multiSelect":true}]}
        """#)
        #expect(question.kind == .question)
        #expect(question.questions?.first?.allowsMany == true)
        #expect(question.questions?.first?.options.last == RemoteQuestion.Option(label: "B"))
        let plan = try decode(#"{"requestId":"r","sessionId":"s","runId":"u","toolName":"ExitPlanMode","detail":"{}","canApprove":false,"plan":{"markdown":"- Plan","truncated":true}}"#)
        #expect(plan.kind == .plan)
        #expect(plan.plan == RemotePlan(markdown: "- Plan", truncated: true))
    }

    @Test func singleChoiceKeepsOneAnswer() {
        var answer = QuestionAnswer()
        answer.pick("A", many: false)
        answer.pick("B", many: false)
        #expect(answer.selected == ["B"])
        // Typing "Other" replaces the pick; picking again clears the text.
        answer.type("Mine", many: false)
        #expect(answer.selected.isEmpty && answer.other == "Mine")
        answer.pick("A", many: false)
        #expect(answer.selected == ["A"] && answer.other.isEmpty)
        answer.pick("A", many: false)
        #expect(!answer.isAnswered)
    }

    @Test func multiSelectTogglesInPickOrder() {
        var answer = QuestionAnswer()
        answer.pick("B", many: true)
        answer.pick("A", many: true)
        answer.type("  More  ", many: true)
        #expect(answer.selected == ["B", "A"])
        answer.pick("B", many: true)
        #expect(answer.selected == ["A"] && answer.trimmedOther == "More")
    }

    @Test func buildsThePermissionCommand() {
        let permission = RemotePermission(requestId: "r", sessionId: "s", runId: "u", toolName: "AskUserQuestion", detail: "", canApprove: false)
        let command = permission.command("allow", answers: [
            "Which?": QuestionAnswer(selected: ["A"], other: " also "),
            "Skipped?": QuestionAnswer(),
        ])
        #expect(command["method"] == "permission" && command["decision"] == "allow" && command["requestId"] == "r")
        #expect(command["answers"] == .object(["Which?": .object(["selected": .array(["A"]), "other": "also"])]))
        #expect(permission.command("deny", answers: ["Which?": QuestionAnswer(selected: ["A"])])["answers"] == nil)
    }
}
