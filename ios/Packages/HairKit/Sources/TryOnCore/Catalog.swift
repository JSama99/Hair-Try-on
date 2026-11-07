// Catalog.swift — styles, sizes, lengths, colours and skin tones.
// Single source of truth shared with the browser studio: Resources/catalog.json
// (web/src/tryon.js imports the same file).

import Foundation
import ProtoStyle

public struct CatalogSize: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var width: Double
    public var rows: Int?
}

public struct CatalogStyle: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var kind: StyleKind
    public var name: String
    public var blurb: String
    public var sizes: [CatalogSize]
    public var defaultSize: String
    public var defaultLength: String
}

public struct CatalogLength: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var length: Double
    public var requiresBody: Bool?
    public var isLocked: Bool { requiresBody ?? false }
}

public struct CatalogColor: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var name: String
    public var hex: String
    public var tipHex: String?
}

public struct SkinTone: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var hex: String
}

public struct HonestySettings: Codable, Hashable, Sendable {
    public var enter: Double
    public var exit: Double
    public var wrapped: Double
    public var maskThreshold: Double
}

public struct Catalog: Codable, Sendable {
    public struct Ombre: Codable, Sendable { public var start: Double; public var end: Double }
    public struct Defaults: Codable, Sendable { public var style: String; public var color: String; public var skinTone: String }

    public var version: Int
    public var styles: [CatalogStyle]
    public var lengths: [CatalogLength]
    public var lockedLengthMessage: String
    public var colors: [CatalogColor]
    public var ombre: Ombre
    public var skinTones: [SkinTone]
    public var defaults: Defaults
    public var honesty: HonestySettings

    /// The bundled catalog. A malformed bundle is a build error, so this traps rather than returning nil.
    public static let shared: Catalog = {
        guard let url = Bundle.module.url(forResource: "catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let c = try? JSONDecoder().decode(Catalog.self, from: data) else {
            fatalError("TryOnCore: Resources/catalog.json is missing or malformed")
        }
        return c
    }()

    public func style(_ id: String) -> CatalogStyle? { styles.first { $0.id == id } }
    public func length(_ id: String) -> CatalogLength? { lengths.first { $0.id == id } }
    public func color(_ id: String) -> CatalogColor? { colors.first { $0.id == id } }
    public func lockedMessage(for length: CatalogLength) -> String {
        lockedLengthMessage.replacingOccurrences(of: "{label}", with: length.label)
    }
}

/// What the person picked.
public struct Look: Hashable, Sendable, Codable {
    public var style: String
    public var size: String
    public var length: String
    public var color: String

    public init(style: String, size: String, length: String, color: String) {
        self.style = style; self.size = size; self.length = length; self.color = color
    }

    public static func `default`(_ c: Catalog = .shared) -> Look {
        let s = c.style(c.defaults.style)!
        return Look(style: s.id, size: s.defaultSize, length: s.defaultLength, color: c.defaults.color)
    }

    /// Switching style resets size and length to that style's defaults.
    public func with(style id: String, _ c: Catalog = .shared) -> Look {
        guard let s = c.style(id) else { return self }
        return Look(style: s.id, size: s.defaultSize, length: s.defaultLength, color: color)
    }
}

public enum LookResolution: Equatable, Sendable {
    case ok(StyleSpec)
    case locked(String)
    case invalid(String)
}

public extension Catalog {
    func resolve(_ look: Look, hasBodyProxy: Bool = false, seed: UInt64? = nil) -> LookResolution {
        guard let style = style(look.style) else { return .invalid("Unknown style \(look.style)") }
        let size = style.sizes.first { $0.id == look.size } ?? style.sizes.first { $0.id == style.defaultSize }!
        let len = length(look.length) ?? length(style.defaultLength)!
        if len.isLocked && !hasBodyProxy { return .locked(lockedMessage(for: len)) }
        var spec = StyleSpec(kind: style.kind, width: size.width, length: len.length, hasBodyProxy: hasBodyProxy)
        if style.kind == .cornrows, let rows = size.rows { spec.cornrowRows = rows }
        if let seed { spec.seed = seed }
        return .ok(spec)
    }

    /// The description to show a stylist (identical to web/src/tryon.js `caption`).
    func caption(_ look: Look) -> String {
        guard let style = style(look.style) else { return "" }
        let size = style.sizes.first { $0.id == look.size } ?? style.sizes.first { $0.id == style.defaultSize }!
        let len = length(look.length) ?? length(style.defaultLength)!
        let col = color(look.color) ?? color(defaults.color)!
        let cm = String(format: "%.1f", size.width * 100)
        let sizeText = style.kind == .cornrows ? "\(size.rows ?? 0) rows, \(cm) cm braids" : "\(size.label.lowercased()) (\(cm) cm parts)"
        let lenText = style.kind == .cornrows ? "\(len.label.lowercased())-length tails" : "\(len.label.lowercased()) length"
        return "\(style.name), \(sizeText), \(lenText), colour \(col.label) (\(col.name.lowercased()))"
    }
}
