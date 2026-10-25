import AegisKit
import SwiftUI

/// The agent's questions, answered like the desktop's question card: listed
/// options (several where the question allows it) or free "Other" text.
struct QuestionSheet: View {
    @Environment(AppModel.self) private var model
    let permission: RemotePermission
    @State private var answers: [String: QuestionAnswer] = [:]
    @FocusState private var typing: String?

    private var questions: [RemoteQuestion] { permission.questions ?? [] }

    var body: some View {
        let live = model.permissions.contains { $0.requestId == permission.requestId }
        let enabled = model.ready && !model.busy && live
        let complete = questions.allSatisfy { answers[$0.question]?.isAnswered == true }
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PromptHeader(
                    permission: permission, icon: "questionmark", tint: Color.accent,
                    title: questions.count == 1 ? "The agent has a question" : "The agent has \(questions.count) questions"
                )
                ForEach(questions, id: \.question) { question in
                    questionView(question)
                }
                if !live {
                    Label("This question is no longer waiting. It was answered or the turn ended.", systemImage: "lock")
                        .font(.app(13)).foregroundStyle(Color.text2)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 8) {
                Button("Decline") { Task { await model.decide(permission, "deny") } }
                    .buttonStyle(PillButtonStyle(kind: .secondary, height: 52))
                    .background(Color.fill2, in: .capsule)
                    .disabled(!enabled)
                Button(questions.count == 1 ? "Send answer" : "Send answers") {
                    Haptics.tap()
                    Task { await model.answer(permission, answers) }
                }
                .buttonStyle(PillButtonStyle(kind: .primary, height: 52))
                .disabled(!enabled || !complete)
                .opacity(complete ? 1 : 0.5)
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 8)
            .background(.bar)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func questionView(_ question: RemoteQuestion) -> some View {
        let key = question.question
        let many = question.allowsMany
        let answer = answers[key] ?? QuestionAnswer()
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                if let header = question.header, !header.isEmpty {
                    Text(header.uppercased()).font(.app(11.5, weight: .semibold)).foregroundStyle(Color.text3)
                }
                Text(question.question).font(.app(17, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                if !question.options.isEmpty {
                    Text(many ? "Choose any that apply" : "Choose one").font(.app(13)).foregroundStyle(Color.text3)
                }
            }
            VStack(spacing: 0) {
                ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                    if index > 0 { Divider().padding(.leading, 48) }
                    Button {
                        Haptics.tap()
                        typing = nil
                        answers[key, default: QuestionAnswer()].pick(option.label, many: many)
                    } label: {
                        optionRow(option, selected: answer.selected.contains(option.label), many: many)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(answer.selected.contains(option.label) ? .isSelected : [])
                }
                if !question.options.isEmpty { Divider().padding(.leading, 48) }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: "square.and.pencil").font(.app(15)).foregroundStyle(Color.text3).frame(width: 22)
                    TextField(question.options.isEmpty ? "Your answer" : "Other answer", text: Binding(
                        get: { answers[key]?.other ?? "" },
                        set: { answers[key, default: QuestionAnswer()].type($0, many: many) }
                    ), axis: .vertical)
                    .lineLimit(1...5)
                    .font(.app(15))
                    .focused($typing, equals: key)
                }
                .padding(.horizontal, 14).padding(.vertical, 13)
            }
            .background(Color.code, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.hair, lineWidth: 0.5))
        }
    }

    private func optionRow(_ option: RemoteQuestion.Option, selected: Bool, many: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: selected ? (many ? "checkmark.square.fill" : "checkmark.circle.fill") : (many ? "square" : "circle"))
                .font(.app(18))
                .foregroundStyle(selected ? Color.text1 : Color.text3)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label).font(.app(15, weight: selected ? .semibold : .regular)).foregroundStyle(Color.text1)
                if let description = option.description, !description.isEmpty {
                    Text(description).font(.app(13)).foregroundStyle(Color.text2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

/// A proposed plan: approve it to let the agent start, or keep it planning.
struct PlanSheet: View {
    @Environment(AppModel.self) private var model
    let permission: RemotePermission

    var body: some View {
        let live = model.permissions.contains { $0.requestId == permission.requestId }
        let enabled = model.ready && !model.busy && live
        let plan = permission.plan ?? RemotePlan(markdown: "")
        let truncated = plan.truncated == true
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PromptHeader(permission: permission, icon: "list.bullet.clipboard", tint: Color.warn, title: "Review the plan")
                Group {
                    if plan.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("The plan is in the task’s latest reply.").font(.app(15)).foregroundStyle(Color.text2)
                    } else {
                        MarkdownView(text: plan.markdown).textSelection(.enabled)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.code, in: .rect(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.hair, lineWidth: 0.5))
                Label {
                    Text(!live ? "This plan is no longer waiting. It was handled or the turn ended."
                         : truncated ? "This plan is too long to show in full here. Approve it on your Mac."
                         : "Approving lets the agent leave plan mode and start making changes.")
                } icon: { Image(systemName: "lock") }
                    .font(.app(13)).foregroundStyle(Color.text2)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 12)
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 8) {
                Button("Keep planning") { Task { await model.decide(permission, "deny") } }
                    .buttonStyle(PillButtonStyle(kind: .secondary, height: 52))
                    .background(Color.fill2, in: .capsule)
                    .disabled(!enabled)
                Button("Approve") {
                    Haptics.tap()
                    Task { await model.decide(permission, "allow") }
                }
                .buttonStyle(PillButtonStyle(kind: .primary, height: 52))
                .disabled(!enabled || truncated)
                .opacity(truncated ? 0.5 : 1)
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 8)
            .background(.bar)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

/// Icon, title and the task a request belongs to.
private struct PromptHeader: View {
    @Environment(AppModel.self) private var model
    let permission: RemotePermission
    let icon: String
    let tint: Color
    let title: String

    var body: some View {
        let session = model.sessions.first { $0.id == permission.sessionId }
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.app(19, weight: .semibold)).foregroundStyle(tint)
                .frame(width: 44, height: 44).background(tint.opacity(0.13), in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.app(20, weight: .semibold))
                Text(session.map { "\(providerLabel($0.provider)) · \($0.title)" } ?? permission.toolName)
                    .font(.app(13)).foregroundStyle(Color.text2).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}
