// OneEuroFilter.swift — Casiez, Roussel & Vogel, "1€ Filter", CHI 2012.
// Smooths the per-frame head fit: low jitter when still, low lag when moving.

import Foundation
import ProtoStyle

public struct OneEuroFilter: Sendable {
    public var minCutoff: Double
    public var beta: Double
    public var dCutoff: Double
    private var x: Double?
    private var dx = 0.0
    private var lastTime: Double?

    public init(minCutoff: Double = 1.0, beta: Double = 0.02, dCutoff: Double = 1.0) {
        self.minCutoff = minCutoff; self.beta = beta; self.dCutoff = dCutoff
    }

    static func alpha(_ cutoff: Double, _ dt: Double) -> Double {
        let tau = 1.0 / (2.0 * Double.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)
    }

    public mutating func filter(_ value: Double, time: Double) -> Double {
        guard let prev = x, let t0 = lastTime, time > t0 else {
            x = value; lastTime = time; dx = 0
            return value
        }
        let dt = time - t0
        let rawDx = (value - prev) / dt
        dx += Self.alpha(dCutoff, dt) * (rawDx - dx)
        let cutoff = minCutoff + beta * abs(dx)
        let out = prev + Self.alpha(cutoff, dt) * (value - prev)
        x = out
        lastTime = time
        return out
    }

    public mutating func reset() { x = nil; lastTime = nil; dx = 0 }
}

/// One Euro filters over every HeadProxy shape parameter (hairline values pass through).
public struct HeadProxyFilter: Sendable {
    public static let warmupFrames = 30
    private var filters: [OneEuroFilter]
    public private(set) var frames = 0
    public private(set) var current: HeadProxy?

    public init(minCutoff: Double = 0.6, beta: Double = 0.8) {
        filters = Array(repeating: OneEuroFilter(minCutoff: minCutoff, beta: beta), count: 12)
    }

    public var isWarm: Bool { frames >= Self.warmupFrames }

    /// Shape parameters (computed: key paths are not Sendable in Swift 6.0).
    static var keys: [WritableKeyPath<HeadProxy, Double>] { [\.rx, \.ry, \.rz, \.cx, \.cy, \.cz, \.fx, \.fy, \.fz, \.frx, \.fry, \.frz] }

    public mutating func update(_ head: HeadProxy, time: Double) -> HeadProxy {
        var out = head
        for (i, k) in Self.keys.enumerated() { out[keyPath: k] = filters[i].filter(head[keyPath: k], time: time) }
        frames += 1
        current = out
        return out
    }

    public mutating func reset() {
        for i in filters.indices { filters[i].reset() }
        frames = 0
        current = nil
    }

    /// Largest shape-parameter difference between two proxies (metres).
    public static func maxChange(_ a: HeadProxy, _ b: HeadProxy) -> Double {
        keys.reduce(0) { max($0, abs(a[keyPath: $1] - b[keyPath: $1])) }
    }
}
