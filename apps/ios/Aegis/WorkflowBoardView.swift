import AegisKit
import SwiftUI

// A workflow the chat started, drawn like the desktop's in-chat board: a
// header line with the run's title and status, its steps nested under it.
// Each step opens that member's session; only the plan and what needs the
// user get a box. Wording and state come from apps/ios/core/workflow.ts.

/// Like the desktop's formatDurationLabel.
func durationLabel(_ ms: Double) -> String {
    guard ms.isFinite, ms >= 0 else { return "" }
    if ms < 1000 { return "< 1s" }
    let total = Int((ms / 1000).rounded())
    if total < 60 { return "\(total)s" }
    let minutes = total / 60, seconds = total % 60
    return seconds == 0 ? "\(minutes)m" : "\(minutes)m \(seconds)s"
}

private func toneColor(_ tone: String) -> Color {
    switch tone {
    case "success": return .success
    case "warning": return .warn
    case "error": return .danger
    default: return .text3
    }
}

struct WorkflowBoardView: View {
    @Environment(AppModel.self) private var model
    let board: WorkflowBoard
    /// The chat that started it; decisions go to its Mac.
    let chatId: String
    /// Only a tap sets this; a run folds once it ends, as on the desktop.
    @State private var choice: (open: Bool, ended: Bool)?
    @State private var confirmStop = false

    private var ended: Bool { !board.open }
    private var open: Bool { choice.flatMap { $0.ended == ended ? $0.open : nil } ?? board.open }

    var body: some View {
        switch board.phase {
        case "failed":
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.app(13)).foregroundStyle(Color.danger)
                Text(board.failure ?? "Workflow could not start").font(.app(14)).foregroundStyle(Color.text2)
            }
        case "starting":
            HStack(spacing: 7) {
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.app(13))
                Text("Starting workflow…")
                ProgressView().controlSize(.mini)
            }
            .font(.app(14)).foregroundStyle(Color.text3)
        default:
            run
        }
    }

    private var run: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            let action = board.plan != nil || board.needs != nil || board.error != nil
            if open || action {
                VStack(alignment: .leading, spacing: 2) {
                    if open {
                        if let planning = board.planning {
                            StepButton(sessionId: planning.sessionId) {
                                HStack(spacing: 8) {
                                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.app(12)).foregroundStyle(Color.text3)
                                        .frame(width: 15)
                                    Text("Planning the workflow").foregroundStyle(Color.text1).shimmer()
                                    Spacer(minLength: 4)
                                    ProgressView().controlSize(.mini)
                                }
                            }
                        }
                        if !board.assumptions.isEmpty { Assumptions(items: board.assumptions) }
                        ForEach(board.steps) { step in StepRow(step: step) }
                        ForEach(board.outcome) { item in OutcomeRow(item: item) }
                    }
                    if let plan = board.plan { PlanBox(plan: plan, perform: perform) }
                    if let needs = board.needs { NeedsBox(needs: needs, perform: perform) }
                    if let error = board.error {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Image(systemName: "xmark.circle").font(.app(12)).foregroundStyle(Color.danger)
                            Text(error).font(.app(13)).foregroundStyle(Color.text1).fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 3)
                    }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Color.hair).frame(width: 1.5).padding(.leading, 6) }
                .transition(.opacity)
            }
        }
        .animation(.snappy(duration: 0.25), value: open)
        .confirmationDialog("Stop this workflow?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop workflow", role: .destructive) { perform(["type": "cancel"]) }
        } message: {
            Text("Its agents stop where they are. The chat gets what was done so far.")
        }
    }

    private var header: some View {
        HStack(spacing: 7) {
            Button {
                withAnimation(.snappy(duration: 0.25)) { choice = (!open, ended) }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.app(13)).foregroundStyle(Color.text3)
                    Text(board.title).font(.app(14, weight: .medium)).foregroundStyle(Color.text1).lineLimit(1)
                    Spacer(minLength: 6)
                    HStack(spacing: 5) {
                        if board.status.spinning { ProgressView().controlSize(.mini) }
                        Text(board.status.word).foregroundStyle(toneColor(board.status.tone))
                        if let time = board.time { Clock(span: time).foregroundStyle(Color.text3) }
                    }
                    .font(.app(12.5).monospacedDigit())
                    .lineLimit(1)
                    .fixedSize()
                    Image(systemName: "chevron.right")
                        .font(.app(11, weight: .semibold))
                        .foregroundStyle(Color.text3)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Steps shown" : "Steps hidden")
            if board.canStop {
                Button("Stop") { confirmStop = true }
                    .font(.app(12.5, weight: .medium)).foregroundStyle(Color.text2)
                    .padding(.horizontal, 9).frame(height: 24)
                    .background(Color.fill2, in: .capsule)
                    .buttonStyle(.plain)
                    .disabled(model.busy)
                    .accessibilityLabel("Stop the workflow")
            }
        }
        .padding(.vertical, 3)
    }

    private func perform(_ action: [String: JSONValue]) {
        Haptics.tap()
        Task { await model.act(on: board, in: chatId, action) }
    }
}

/// "· 1m 12s": ticks each second while the run goes on.
private struct Clock: View {
    @Environment(AppModel.self) private var model
    let span: WorkflowBoard.Span

    var body: some View {
        if let end = span.end {
            Text("· " + durationLabel(end - span.start))
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Text("· " + durationLabel(model.client.serverNow - span.start))
            }
        }
    }
}

/// A line that opens a member's session when it has one.
private struct StepButton<Label: View>: View {
    @Environment(AppModel.self) private var model
    let sessionId: String?
    @ViewBuilder let label: Label

    var body: some View {
        // A plain line when there is nothing to open: a disabled button would dim it.
        if let sessionId {
            Button {
                model.openMember(sessionId)
            } label: {
                label.font(.app(14)).padding(.vertical, 4).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            label.font(.app(14)).padding(.vertical, 4)
        }
    }
}

private struct StepRow: View {
    @Environment(AppModel.self) private var model
    let step: WorkflowBoard.Step

    var body: some View {
        StepButton(sessionId: step.sessionId) {
            HStack(spacing: 8) {
                Group {
                    if let provider = step.provider { ProviderGlyph(provider: provider, size: 14) } else {
                        Image(systemName: "apple.terminal").font(.app(12)).foregroundStyle(Color.text3)
                    }
                }
                .frame(width: 15)
                (Text(step.title).foregroundStyle(step.state == "running" ? Color.text1 : Color.text2)
                    + Text(step.detail.isEmpty ? "" : "  " + step.detail).foregroundStyle(Color.text3).font(.app(12.5)))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing.font(.app(12.5).monospacedDigit()).lineLimit(1).fixedSize()
                if step.sessionId != nil {
                    Image(systemName: "chevron.right").font(.app(10, weight: .semibold)).foregroundStyle(Color.text3)
                }
            }
        }
        .opacity(step.state == "pending" ? 0.55 : 1)
        .accessibilityHint(step.sessionId == nil ? "" : "Opens this step’s session")
    }

    @ViewBuilder private var trailing: some View {
        HStack(spacing: 6) {
            // The narrow screen keeps the shield; the step's page has the request.
            if step.approvals > 0 {
                Image(systemName: "exclamationmark.shield").foregroundStyle(Color.warn).accessibilityLabel("Needs approval")
            }
            if step.state == "pending" { Text("Waiting").foregroundStyle(Color.text3) }
            if step.state == "needs_input" { Text("Needs you").foregroundStyle(Color.warn) }
            if step.state != "pending", let start = step.start {
                if step.state == "running" {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        Text(durationLabel(model.client.serverNow - start)).foregroundStyle(Color.text3)
                    }
                } else if let end = step.end {
                    Text(durationLabel(end - start)).foregroundStyle(Color.text3)
                }
            }
            if let verdict = step.verdict {
                Text(verdict.word).foregroundStyle(toneColor(verdict.tone))
            } else if step.state == "failed" {
                Text("Failed").foregroundStyle(Color.danger)
            }
            if step.state == "running" {
                ProgressView().controlSize(.mini)
            } else if step.state == "succeeded", step.verdict == nil {
                Image(systemName: "checkmark").font(.app(11, weight: .semibold)).foregroundStyle(Color.success)
            }
        }
    }
}

private struct OutcomeRow: View {
    let item: WorkflowBoard.Outcome

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Group {
                switch item.status {
                case "met": Image(systemName: "checkmark").foregroundStyle(Color.success)
                case "unmet": Image(systemName: "xmark.circle").foregroundStyle(Color.danger)
                default: Image(systemName: "circle.dashed").foregroundStyle(Color.text3)
                }
            }
            .font(.app(11.5, weight: .semibold))
            .frame(width: 15)
            Text(item.text)
                .foregroundStyle(item.status == "open" ? Color.text2 : Color.text1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if item.status == "waived" { Text("Waived").foregroundStyle(Color.text3) }
            if item.status == "unmet" { Text("Not met").foregroundStyle(Color.danger) }
        }
        .font(.app(13))
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Assumptions don't stop the run; they stay behind one line.
private struct Assumptions: View {
    let items: [String]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.25)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").font(.app(10, weight: .semibold)).foregroundStyle(Color.text3)
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 15)
                    Text("\(items.count) \(items.count == 1 ? "assumption" : "assumptions")").foregroundStyle(Color.text2)
                }
                .font(.app(14)).padding(.vertical, 4).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(items, id: \.self) { item in
                        Text("• " + item).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.app(13)).foregroundStyle(Color.text2)
                .padding(.leading, 23).padding(.bottom, 4)
            }
        }
    }
}

/// The only boxed part of a run: something the user has to decide.
private struct ActionBox<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .font(.app(13.5))
            .foregroundStyle(Color.text2)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.hair, lineWidth: 0.5))
            .padding(.vertical, 6)
    }
}

private struct BoxButton: View {
    @Environment(AppModel.self) private var model
    let title: String
    var symbol: String? = nil
    var primary = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).font(.app(11, weight: .semibold)) }
                Text(title)
            }
            .font(.app(14, weight: .medium))
            .foregroundStyle(primary ? Color.onInk : Color.text1)
            .padding(.horizontal, 14).frame(minHeight: 34)
            .background(primary ? Color.ink : Color.fill2, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
    }
}

private struct PlanBox: View {
    let plan: WorkflowBoard.Plan
    let perform: ([String: JSONValue]) -> Void

    var body: some View {
        ActionBox {
            Text("Start this workflow?").font(.app(15, weight: .semibold)).foregroundStyle(Color.text1)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(plan.members) { member in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        ProviderGlyph(provider: member.provider, size: 14).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                        (Text(member.name).foregroundStyle(Color.text1).fontWeight(.medium)
                            + Text("  " + member.detail)
                            + Text(member.note.map { " · " + $0 } ?? "").foregroundStyle(Color.text3))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if !plan.checks.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Runs")
                    FlowChips(items: plan.checks.map { ($0.text, $0.highlight) })
                }
            }
            if !plan.unsupported.isEmpty {
                Label {
                    Text("Not covered: " + plan.unsupported.joined(separator: "; ")).foregroundStyle(Color.text1)
                } icon: {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.warn)
                }
            }
            if !plan.assumptions.isEmpty { Text("Assumes: " + plan.assumptions.joined(separator: "; ")) }
            HStack(spacing: 8) {
                BoxButton(title: "Start", symbol: "play.fill", primary: true) { perform(["type": "confirm"]) }
                BoxButton(title: "Cancel") { perform(["type": "cancel"]) }
            }
            .padding(.top, 2)
            if !plan.checks.isEmpty {
                Text("Starting approves these commands for this run.").font(.app(12)).foregroundStyle(Color.text3)
            }
        }
    }
}

/// Commands as code chips that wrap onto more lines.
private struct FlowChips: View {
    let items: [(text: String, highlight: Bool)]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Text(item.text)
                    .font(.app(12, design: .monospaced))
                    .foregroundStyle(Color.text1)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(item.highlight ? Color.dangerBg : Color.code, in: .rect(cornerRadius: 6))
            }
        }
    }
}

private struct NeedsBox: View {
    let needs: WorkflowBoard.Needs
    let perform: ([String: JSONValue]) -> Void
    @State private var text = ""

    var body: some View {
        ActionBox {
            Label {
                Text(needs.title).font(.app(15, weight: .semibold)).foregroundStyle(Color.text1)
            } icon: {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.warn)
            }
            if let question = needs.question { Text(question).foregroundStyle(Color.text1) }
            if let detail = needs.detail { Text(detail).fixedSize(horizontal: false, vertical: true) }
            if needs.freeText {
                HStack(spacing: 8) {
                    TextField("Your answer", text: $text)
                        .font(.app(14))
                        .padding(.horizontal, 12).frame(minHeight: 34)
                        .background(Color.fill2, in: .capsule)
                    BoxButton(title: "Answer", primary: true) {
                        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !answer.isEmpty { perform(["type": "answer", "text": .string(answer)]) }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(needs.options.enumerated()), id: \.element.id) { index, option in
                        BoxButton(title: option.label, primary: index == 0) {
                            perform(option.answer == "text"
                                    ? ["type": "answer", "text": .string(option.label)]
                                    : ["type": "answer", "optionId": .string(option.id)])
                        }
                    }
                }
            }
        }
    }
}
