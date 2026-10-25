import AegisKit
import SwiftUI

/// Agent, model and reasoning in one sheet (design canvas row "A · one sheet · states"):
/// every choice is one tap and applies as it's made; a swipe or a tap outside closes it.
struct AgentModelSheet: View {
    @Environment(AppModel.self) private var model
    let catalog: AgentCatalog
    let settings: RemoteTaskSettings
    let onSettings: (RemoteTaskSettings) -> Void
    /// New tasks can switch agents; a session's agent is fixed.
    var choosesAgent = false

    @State private var query = ""
    @State private var height: CGFloat = 0
    @State private var index = 0.0

    /// From this many models the list gets a search field and the sheet opens tall.
    private static let searchFrom = 8

    private var r: ResolvedSettings { catalog.resolve(settings) }
    private var long: Bool { catalog.models.count >= Self.searchFrom }
    /// A short sheet is as tall as what it holds; a long list takes the screen.
    private var detent: PresentationDetent { long ? .large : .height(max(height, 160)) }

    var body: some View {
        VStack(spacing: 14) {
            if choosesAgent { agents } else { fixedAgent }
            if catalog.models.isEmpty {
                loading
            } else {
                if long { search }
                models
                if r.efforts.count > 1 || r.fastAvailable {
                    Rectangle().fill(Color.hair).frame(height: 0.5).padding(.horizontal, 22)
                    if r.efforts.count > 1 { reasoning }
                    if r.fastAvailable { fast }
                }
            }
        }
        .padding(.top, 24)
        .padding(.bottom, 12)
        .frame(maxHeight: long ? .infinity : nil, alignment: .top)
        .fixedSize(horizontal: false, vertical: !long)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        // The selection follows the size: changing the set alone (a new agent's list)
        // dismissed the sheet instead of resizing it.
        .presentationDetents([detent], selection: Binding(get: { detent }, set: { _ in }))
        .presentationDragIndicator(.visible)
        .onChange(of: catalog.provider) { query = "" }
    }

    private func set(_ change: (inout RemoteTaskSettings) -> Void) {
        var next = settings
        change(&next)
        onSettings(next)
    }

    // MARK: Agent

    private var agents: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(agentProviders, id: \.self) { p in
                        let selected = p == catalog.provider
                        Button {
                            guard !selected else { return }
                            Haptics.select()
                            model.provider = p
                        } label: {
                            HStack(spacing: 7) {
                                ProviderGlyph(provider: p, size: 17)
                                Text(providerLabel(p)).font(.app(14.5, weight: .medium))
                            }
                            .foregroundStyle(selected ? Color.onInk : Color.text1)
                            .padding(.leading, 10).padding(.trailing, 14)
                            .frame(height: 40)
                            .background(selected ? Color.ink : Color.text1.opacity(0.06), in: .capsule)
                            .contentShape(.capsule)
                        }
                        .buttonStyle(.plain)
                        .id(p)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            .onAppear { proxy.scrollTo(catalog.provider, anchor: .center) }
            // One picked at the edge comes fully into view.
            .onChange(of: catalog.provider) { _, p in withAnimation(.snappy) { proxy.scrollTo(p, anchor: .center) } }
        }
        .accessibilityLabel("Agent")
    }

    private var fixedAgent: some View {
        HStack(spacing: 10) {
            ProviderGlyph(provider: catalog.provider, size: 16)
                .foregroundStyle(Color.text1)
                .frame(width: 30, height: 30)
                .background(Color.fill3, in: .rect(cornerRadius: 9))
            Text(providerLabel(catalog.provider)).font(.app(16, weight: .semibold))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 22)
        .frame(height: 40)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Agent: \(providerLabel(catalog.provider))")
    }

    // MARK: Model

    private var search: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Color.text3)
            TextField("Search models", text: $query).font(.app(15.5))
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(Color.text1.opacity(0.06), in: .rect(cornerRadius: 12))
        .padding(.horizontal, 16)
    }

    private var shownModels: [AgentCatalog.Model] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return catalog.models }
        return catalog.models.filter { $0.label.lowercased().contains(q) || $0.value.lowercased().contains(q) }
    }

    @ViewBuilder private var models: some View {
        let rows = VStack(spacing: 2) {
            ForEach(shownModels, id: \.self) { item in modelRow(item) }
            if shownModels.isEmpty {
                Text("No matching models.").font(.app(14)).foregroundStyle(Color.text3).padding(.vertical, 16)
            }
        }
        .padding(.horizontal, 8)
        if long {
            ScrollView { rows }
                .scrollDismissesKeyboard(.immediately)
                .mask(LinearGradient(stops: [.init(color: .black, location: 0.88), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
        } else {
            rows
        }
    }

    private func modelRow(_ item: AgentCatalog.Model) -> some View {
        let selected = item.value == r.model
        return Button {
            guard !selected else { return }
            Haptics.select()
            set {
                $0.model = item.value
                $0.effort = nil
            }
        } label: {
            HStack(spacing: 10) {
                HStack(spacing: 5) {
                    Text(item.label).font(.app(15.5)).foregroundStyle(Color.text1).lineLimit(1)
                    // A model already named "Default" needs no tag saying so.
                    if item.value == catalog.defaultModel, !item.label.localizedCaseInsensitiveContains("default") {
                        Text("Default").font(.app(12.5)).foregroundStyle(Color.text3)
                    }
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").font(.app(15, weight: .semibold)) }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(selected ? Color.fill2 : .clear, in: .rect(cornerRadius: 16))
            .contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var loading: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach([132, 96, 112], id: \.self) { width in
                Capsule().fill(Color.text1.opacity(0.09))
                    .frame(width: CGFloat(width), height: 12)
                    .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
                    .padding(.horizontal, 14)
            }
        }
        .padding(.horizontal, 8)
        .phaseAnimator([1, 0.4]) { view, opacity in view.opacity(opacity) } animation: { _ in .easeInOut(duration: 0.7) }
        .accessibilityLabel("Loading models from your Mac")
    }

    // MARK: Reasoning and Fast

    /// The original reasoning control: drag along the stops, or tap a level's name.
    private var reasoning: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reasoning").font(.app(15.5))
            StepSlider(index: $index, count: r.efforts.count, valueLabel: r.effortLabel ?? "Default")
                // No effort chosen and no model default: the Mac decides.
                .opacity(r.shownEffort == nil ? 0.45 : 1)
                .accessibilityLabel("Reasoning")
                .onChange(of: index) { _, value in
                    let effort = r.efforts[min(r.efforts.count - 1, max(0, Int(value.rounded())))]
                    if effort.value != r.shownEffort { set { $0.effort = effort.value } }
                }
            HStack(spacing: 0) {
                ForEach(Array(r.efforts.enumerated()), id: \.element.value) { offset, effort in
                    if offset > 0 { Spacer(minLength: 2) }
                    Button(effort.label) { set { $0.effort = effort.value } }
                        .buttonStyle(.plain)
                        .font(.app(11.5, weight: effort.value == r.shownEffort ? .semibold : .regular))
                        .foregroundStyle(effort.value == r.shownEffort ? Color.accent : Color.text3)
                }
            }
        }
        .padding(.horizontal, 22)
        .onAppear { index = position }
        // Another model or agent can put the same level at another stop.
        .onChange(of: position) { index = position }
    }

    private var position: Double { Double(r.efforts.firstIndex { $0.value == r.shownEffort } ?? 0) }

    private var fast: some View {
        Toggle(isOn: Binding(get: { r.fast }, set: { on in set { $0.fast = on } })) {
            HStack(spacing: 10) {
                Image(systemName: r.fast ? "bolt.fill" : "bolt")
                    .foregroundStyle(r.fast ? Color.accent : Color.text3)
                    .frame(width: 18)
                Text("Fast").font(.app(15.5))
            }
        }
        .padding(.leading, 22).padding(.trailing, 16)
        .frame(minHeight: 44)
        .accessibilityHint("Increased usage")
    }
}
