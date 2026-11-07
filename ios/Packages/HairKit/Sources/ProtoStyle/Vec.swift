// Vec.swift — 3-vector with the reference's exact evaluation order.
//
// Deliberately not SIMD3<Double>: `(a * b).sum()` may reduce in any order,
// while the oracle's dot is ((ax*bx) + (ay*by)) + (az*bz). Every operator
// here is written out component by component, matching reference/protostyle/vec.py.

import Foundation

public struct V3: Hashable, Sendable, Codable, CustomStringConvertible {
    public var x: Double
    public var y: Double
    public var z: Double

    @inlinable public init(_ x: Double, _ y: Double, _ z: Double) { self.x = x; self.y = y; self.z = z }

    public static let zero = V3(0, 0, 0)

    @inlinable public static func + (a: V3, b: V3) -> V3 { V3(a.x + b.x, a.y + b.y, a.z + b.z) }
    @inlinable public static func - (a: V3, b: V3) -> V3 { V3(a.x - b.x, a.y - b.y, a.z - b.z) }
    @inlinable public static func * (a: V3, s: Double) -> V3 { V3(a.x * s, a.y * s, a.z * s) }

    @inlinable public func dot(_ b: V3) -> Double { x * b.x + y * b.y + z * b.z }
    @inlinable public func cross(_ b: V3) -> V3 {
        V3(y * b.z - z * b.y, z * b.x - x * b.z, x * b.y - y * b.x)
    }
    @inlinable public var length: Double { dot(self).squareRoot() }

    /// Unit vector; the reference raises on zero length, here that is a precondition.
    @inlinable public var normalized: V3 {
        let n = length
        precondition(n >= 1e-15, "cannot normalize a zero-length vector")
        return V3(x / n, y / n, z / n)
    }

    @inlinable public static func lerp(_ a: V3, _ b: V3, _ t: Double) -> V3 {
        V3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
    }

    public var isFinite: Bool { x.isFinite && y.isFinite && z.isFinite }

    @inlinable public subscript(i: Int) -> Double { i == 0 ? x : (i == 1 ? y : z) }

    public var description: String { "(\(x), \(y), \(z))" }
}
