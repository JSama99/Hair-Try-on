// Honesty.swift — the volume-conflict check (docs/ARCHITECTURE.md §4.8).
//
// Protective styles are often smaller than the hair under them. Each mask
// frame compares her hair mask with the rendered style's silhouette; when more
// than `enter` of her hair is left uncovered the app says so (and dims those
// pixels) instead of pretending. Hysteresis stops the warning flickering.

import Foundation

public struct ConflictMeasure: Equatable, Sendable {
    public var hairPixels: Int
    public var uncovered: Int
    public var ratio: Double
    public var hairShare: Double
    public var wrapped: Bool
}

/// Row-major probability map in 0...1 (a segmentation output).
public struct ProbabilityMap: Sendable, Equatable {
    public var width: Int
    public var height: Int
    public var values: [Float]

    public init(width: Int, height: Int, values: [Float]) {
        precondition(values.count == width * height, "ProbabilityMap size mismatch")
        self.width = width; self.height = height; self.values = values
    }

    /// Bilinear sample at normalised (u, v), clamped to the edges.
    public func sample(_ uv: SIMD2<Double>) -> Double {
        let x = min(Double(width - 1), max(0, uv.x * Double(width) - 0.5))
        let y = min(Double(height - 1), max(0, uv.y * Double(height) - 0.5))
        let x0 = Int(x), y0 = Int(y), x1 = min(width - 1, x0 + 1), y1 = min(height - 1, y0 + 1)
        let fx = x - Double(x0), fy = y - Double(y0)
        func v(_ xx: Int, _ yy: Int) -> Double { Double(values[yy * width + xx]) }
        return (v(x0, y0) * (1 - fx) + v(x1, y0) * fx) * (1 - fy) + (v(x0, y1) * (1 - fx) + v(x1, y1) * fx) * fy
    }

    public func mask(threshold: Double) -> [Bool] { values.map { Double($0) >= threshold } }
}

public enum Honesty {
    public static func measure(hair: ProbabilityMap, style: [Bool], headArea: Int, settings: HonestySettings = Catalog.shared.honesty) -> ConflictMeasure {
        precondition(style.count == hair.values.count, "masks must share a grid")
        var hairPx = 0, uncovered = 0
        for i in 0..<style.count where Double(hair.values[i]) >= settings.maskThreshold {
            hairPx += 1
            if !style[i] { uncovered += 1 }
        }
        let ratio = hairPx > 0 ? Double(uncovered) / Double(hairPx) : 0
        let share = headArea > 0 ? Double(hairPx) / Double(headArea) : 0
        return ConflictMeasure(hairPixels: hairPx, uncovered: uncovered, ratio: ratio, hairShare: share, wrapped: share < settings.wrapped)
    }

    /// Hysteresis: enter above `enter`, leave below `exit`; a wrapped head never warns.
    public static func update(active: Bool, _ m: ConflictMeasure, settings: HonestySettings = Catalog.shared.honesty) -> Bool {
        if m.wrapped { return false }
        if !active && m.ratio > settings.enter { return true }
        if active && m.ratio < settings.exit { return false }
        return active
    }

    public enum Source: Sendable { case photo, camera }

    public static func tip(_ m: ConflictMeasure, source: Source) -> String {
        let pct = Int((m.ratio * 100).rounded())
        switch source {
        case .photo:
            return "About \(pct)% of the hair in your photo falls outside this style (shown in amber). In real life that hair has to be braided in or tucked away, so the result can look different from this preview. For the truest preview, use a photo with your hair pulled back or under a wrap."
        case .camera:
            return "About \(pct)% of your own hair falls outside this style (shown dimmed). In real life that hair has to be braided in or tucked away. For the truest preview, tie your hair back or wear a wrap."
        }
    }
}

public extension Honesty {
    /// Close the gaps between strands: square dilation by `r` pixels. Segmenters label the whole
    /// hair region, gaps between braids included (twin of web/src/tryon.js `dilate`).
    static func dilate(_ mask: [Bool], width w: Int, height h: Int, radius r: Int) -> [Bool] {
        guard r > 0 else { return mask }
        var tmp = [Bool](repeating: false, count: w * h), out = tmp
        for y in 0..<h {
            var run = Int.min / 2
            for x in 0..<w { if mask[y * w + x] { run = x }; tmp[y * w + x] = x - run <= r }
            run = Int.max / 2
            for x in stride(from: w - 1, through: 0, by: -1) { if mask[y * w + x] { run = x }; if run - x <= r { tmp[y * w + x] = true } }
        }
        for x in 0..<w {
            var run = Int.min / 2
            for y in 0..<h { if tmp[y * w + x] { run = y }; out[y * w + x] = y - run <= r }
            run = Int.max / 2
            for y in stride(from: h - 1, through: 0, by: -1) { if tmp[y * w + x] { run = y }; if run - y <= r { out[y * w + x] = true } }
        }
        return out
    }

    /// 1.2% of the mask's long side (3 px at 256).
    static func closingRadius(width: Int, height: Int) -> Int { max(1, Int((0.012 * Double(max(width, height))).rounded())) }
}

/// CPU rasteriser for silhouettes at mask resolution (a few hundred pixels across, ~30k triangles at 10 Hz).
public enum SilhouetteRaster {
    /// Fill triangles given in pixel coordinates (x right, y down) into a width*height mask.
    public static func fill(triangles: [UInt32], points: [SIMD2<Double>?], width: Int, height: Int, into mask: inout [Bool]) {
        if mask.count != width * height { mask = Array(repeating: false, count: width * height) }
        var t = 0
        while t + 2 < triangles.count {
            defer { t += 3 }
            guard let a = points[Int(triangles[t])], let b = points[Int(triangles[t + 1])], let c = points[Int(triangles[t + 2])] else { continue }
            let minX = max(0, Int(min(a.x, b.x, c.x).rounded(.down))), maxX = min(width - 1, Int(max(a.x, b.x, c.x).rounded(.up)))
            let minY = max(0, Int(min(a.y, b.y, c.y).rounded(.down))), maxY = min(height - 1, Int(max(a.y, b.y, c.y).rounded(.up)))
            if minX > maxX || minY > maxY { continue }
            let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
            if abs(area) < 1e-12 { continue }
            for y in minY...maxY {
                let py = Double(y) + 0.5
                for x in minX...maxX {
                    let px = Double(x) + 0.5
                    let w0 = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)
                    let w1 = (c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)
                    let w2 = (a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)
                    if (w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0) { mask[y * width + x] = true }
                }
            }
        }
    }
}
