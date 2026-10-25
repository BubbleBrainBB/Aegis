import AegisKit
import SwiftUI

/// The agent's questions, docked where the composer sits so the task stays readable
/// above. One question at a time: listed options (several where the question allows
/// it) or free text, as on the desktop's question card.
struct QuestionDock: View {
    @Environment(AppModel.self) private var model
    let permission: RemotePermission
    let provider: String
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var page = 0
    @State private var optionsHeight: CGFloat = 0
    @FocusState private var typing: Bool

    private var questions: [RemoteQuestion] { permission.questions ?? [] }

    var body: some View {
        let index = min(page, max(questions.count - 1, 0))
        let last = index == questions.count - 1
        let enabled = model.ready && !model.busy
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                ProviderGlyph(provider: provider, size: 14).foregroundStyle(Color.text2)
                Text("\(providerLabel(provider)) is asking").foregroundStyle(Color.text2)
                Spacer(minLength: 8)
                if questions.count > 1 {
                    // Tapping the count goes back a question; answers are kept.
                    Button("\(index + 1) of \(questions.count)") { go(to: index - 1) }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.text3)
                        .disabled(index == 0)
                        .accessibilityLabel("Question \(index + 1) of \(questions.count)")
                        .accessibilityHint(index > 0 ? "Goes back to the previous question" : "")
                }
            }
            .font(.app(13))
            .padding(.horizontal, 4)
            if questions.indices.contains(index) {
                let question = questions[index]
                Text(question.question)
                    .font(.app(18, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .id("q\(index)")
                // Long option lists scroll inside the card; the cap shrinks while typing.
                ScrollViewReader { proxy in
                    ScrollView {
                        options(question).onGeometryChange(for: CGFloat.self) { $0.size.height } action: { optionsHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(optionsHeight, typing ? 190 : 380))
                    // Keep the text field in sight above the keyboard.
                    .onChange(of: typing) { _, now in
                        if now { withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo("other", anchor: .bottom) } }
                    }
                }
            }
            HStack {
                Button("Decline") { Task { await model.decide(permission, "deny") } }
                    .font(.app(16, weight: .medium))
                    .foregroundStyle(Color.text2)
                    .padding(.horizontal, 12)
                    .frame(height: 44)
                    .buttonStyle(.plain)
                    .disabled(!enabled)
                Spacer()
                let answered = questions.indices.contains(index) && answers[questions[index].question]?.isAnswered == true
                Button {
                    Haptics.tap()
                    if last { Task { await model.answer(permission, answers) } } else { go(to: index + 1) }
                } label: {
                    Text(!last ? "Next" : questions.count == 1 ? "Send answer" : "Send answers")
                        .font(.app(16, weight: .semibold))
                        .foregroundStyle(Color.onInk)
                        .padding(.horizontal, 28)
                        .frame(height: 44)
                        .background(answered && enabled ? Color.ink : Color.inkOff, in: .capsule)
                }
                .buttonStyle(.plain)
                .disabled(!answered || !enabled)
            }
        }
        .padding(EdgeInsets(top: 16, leading: 14, bottom: 12, trailing: 14))
        .glassEffect(.regular, in: .rect(cornerRadius: 30))
        // A sideways swipe also moves between questions.
        .simultaneousGesture(DragGesture(minimumDistance: 30).onEnded { drag in
            guard abs(drag.translation.width) > abs(drag.translation.height) * 1.5 else { return }
            if drag.translation.width > 0 { go(to: index - 1) }
            else if questions.indices.contains(index), answers[questions[index].question]?.isAnswered == true, !last { go(to: index + 1) }
        })
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Question from \(providerLabel(provider))")
    }

    private func go(to target: Int) {
        guard questions.indices.contains(target) else { return }
        typing = false
        withAnimation(.smooth(duration: 0.25)) { page = target }
    }

    private func options(_ question: RemoteQuestion) -> some View {
        let key = question.question
        let many = question.allowsMany
        let answer = answers[key] ?? QuestionAnswer()
        let other = answer.other
        return VStack(spacing: 8) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                let selected = answer.selected.contains(option.label)
                Button {
                    Haptics.tap()
                    typing = false
                    answers[key, default: QuestionAnswer()].pick(option.label, many: many)
                } label: {
                    HStack(spacing: 12) {
                        mark(selected: selected, many: many)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).font(.app(15.5, weight: selected ? .semibold : .medium)).foregroundStyle(Color.text1)
                            if let description = option.description, !description.isEmpty {
                                Text(description).font(.app(13)).foregroundStyle(Color.text2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .multilineTextAlignment(.leading)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(minHeight: 54)
                    .background(selected ? Color.page : .clear, in: .rect(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(selected ? Color.ink : Color.hair, lineWidth: selected ? 1.5 : 1))
                    .contentShape(.rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            let filled = !other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            HStack(spacing: 12) {
                Image(systemName: "pencil").font(.app(17)).foregroundStyle(Color.text3).frame(width: 22)
                TextField("Something else…", text: Binding(
                    get: { answers[key]?.other ?? "" },
                    set: { answers[key, default: QuestionAnswer()].type($0, many: many) }
                ), axis: .vertical)
                .lineLimit(1...4)
                .font(.app(15.5))
                .focused($typing)
                .accessibilityLabel("Other answer")
            }
            .padding(.horizontal, 14).padding(.vertical, 14)
            .frame(minHeight: 50)
            .background(filled ? Color.page : .clear, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(filled ? Color.ink : Color.hair, lineWidth: filled ? 1.5 : 1))
            .contentShape(.rect(cornerRadius: 16))
            .onTapGesture { typing = true }
            .id("other")
        }
        .padding(1.5) // room for the selected border
    }

    @ViewBuilder private func mark(selected: Bool, many: Bool) -> some View {
        if many {
            if selected {
                Image(systemName: "checkmark").font(.app(12, weight: .bold)).foregroundStyle(Color.onInk)
                    .frame(width: 22, height: 22).background(Color.ink, in: .rect(cornerRadius: 7))
            } else {
                RoundedRectangle(cornerRadius: 7).strokeBorder(Color.text3, lineWidth: 1.5).frame(width: 22, height: 22)
            }
        } else {
            Circle().strokeBorder(selected ? Color.ink : Color.text3, lineWidth: selected ? 6.5 : 1.5).frame(width: 22, height: 22)
        }
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
