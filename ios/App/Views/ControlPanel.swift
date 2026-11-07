// ControlPanel.swift — style, size, length and colour pickers plus capture and calibration.
// Views send intents to the store; they compute nothing but display strings.

import SwiftUI
import TryOnCore

struct ControlPanel: View {
    @Environment(TryOnStore.self) private var store
    let engine: TryOnEngine?

    var body: some View {
        let c = store.catalog
        let style = c.style(store.look.style)
        VStack(alignment: .leading, spacing: 10) {
            ChipRow(items: c.styles.map { ($0.id, $0.name, nil, false) }, selected: store.look.style) { store.select(style: $0) }
            if let style {
                ChipRow(items: style.sizes.map { ($0.id, $0.label, String(format: "%.1f cm", $0.width * 100), false) },
                        selected: store.look.size) { store.select(size: $0) }
            }
            ChipRow(items: c.lengths.map { ($0.id, $0.label, "\(Int(($0.length * 100).rounded())) cm", $0.isLocked) },
                    selected: store.look.length) { store.select(length: $0) }
            HairColorPicker(colors: c.colors, selected: store.look.color) { store.select(color: $0) }
            HStack {
                Button {
                    Task {
                        if let img = await engine?.capture(caption: store.caption) { store.capture = CapturedLook(image: img, caption: store.caption) }
                    }
                } label: { Label("Capture look", systemImage: "camera.aperture") }
                    .buttonStyle(.borderedProminent)
                Spacer()
                Menu {
                    Button("Match my hairline") { engine?.beginCalibration() }
                        .disabled(!(engine?.segmentationProvidesSkin ?? false))
                    if store.calibration != nil { Button("Use the standard hairline", role: .destructive) { store.resetCalibration() } }
                } label: { Label("Hairline", systemImage: "scope") }
                    .buttonStyle(.bordered)
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

struct ChipRow: View {
    let items: [(id: String, label: String, sub: String?, locked: Bool)]
    let selected: String
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.id) { item in
                    Button { onSelect(item.id) } label: {
                        HStack(spacing: 4) {
                            if item.locked { Image(systemName: "lock.fill").font(.caption2) }
                            Text(item.label)
                            if let sub = item.sub { Text(sub).font(.caption2.monospaced()).opacity(0.7) }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(item.id == selected ? Color.white : Color.white.opacity(0.12), in: Capsule())
                        .foregroundStyle(item.id == selected ? Color.black : (item.locked ? Color.secondary : Color.white))
                    }
                    .accessibilityLabel(item.locked ? "\(item.label), needs a body capture" : item.label)
                    .accessibilityAddTraits(item.id == selected ? .isSelected : [])
                }
            }
        }
    }
}

/// Named to avoid clashing with SwiftUI.ColorPicker.
struct HairColorPicker: View {
    let colors: [CatalogColor]
    let selected: String
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(colors) { c in
                    Button { onSelect(c.id) } label: {
                        VStack(spacing: 3) {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(LinearGradient(colors: [Color(hex: c.hex), Color(hex: c.tipHex ?? c.hex)], startPoint: .top, endPoint: .bottom))
                                .frame(width: 34, height: 26)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(c.id == selected ? Color.white : .clear, lineWidth: 2))
                            Text(c.label).font(.caption2.monospaced())
                        }
                    }
                    .accessibilityLabel("Colour \(c.label), \(c.name)")
                    .accessibilityAddTraits(c.id == selected ? .isSelected : [])
                }
            }
        }
    }
}

extension Color {
    init(hex: String) {
        let s = LookColor.srgb(hex: hex)
        self.init(.sRGB, red: s.x, green: s.y, blue: s.z)
    }
}
