// HairlineCalibration.swift — braids should root where *her* hairline is.
//
// HairlineObserver walks down meridians of the head proxy in one camera frame,
// labels each sample from the segmentation (hair / skin / other / unseen) and
// confirms the hair -> skin transition only after `confirmSteps` consecutive
// samples on each side (masks are noisy right at the hairline, and partings
// show skin between hair). HairlineCalibrator turns pooled per-meridian
// transitions into `hairlineFront` and `earNotch` in closed form by inverting
// HeadProxy.hairlineTheta.

import Foundation
import ProtoStyle

public enum SampleLabel: Sendable, Equatable { case hair, skin, other, unseen }

public struct HairlineObserver: Sendable {
    public var phis: [Double]
    public var thetaStart = 0.55
    public var thetaEnd = 1.75
    public var step = 0.01
    public var confirmSteps = 6
    public var threshold = 0.5

    public init(phis: [Double] = HairlineObserver.defaultPhis) { self.phis = phis }

    /// Front (|phi| <= 0.6) and side (around ±pi/2) meridians.
    public static let defaultPhis: [Double] = stride(from: -0.6, through: 0.6001, by: 0.1).map { $0 }
        + [-1.85, -1.75, -1.65, -1.57, -1.47, -1.37, 1.37, 1.47, 1.57, 1.65, 1.75, 1.85]

    /// - Parameters:
    ///   - project: scalp point (head frame, metres) -> normalised image coordinates, or nil when off-screen / facing away.
    ///   - hair: hair probability at normalised coordinates.
    ///   - skin: face-skin probability, or nil when the model has no skin class (then "not hair" counts as skin).
    /// - Returns: per meridian, the theta where confirmed skin starts (nil if not seen).
    public func observe(head: HeadProxy, project: (V3) -> SIMD2<Double>?, hair: (SIMD2<Double>) -> Double,
                        skin: ((SIMD2<Double>) -> Double)?) -> [Double: Double] {
        var out: [Double: Double] = [:]
        for phi in phis {
            // The hairline is where hair stops for good: the end of the LAST confirmed hair run
            // followed by confirmed skin. (The first transition would stop at a part — cornrow
            // parts run front to back, along the meridians.)
            var hairRun = 0, skinRun = 0
            var inHair = false
            var skinStart: Double?
            var candidate: Double?
            var theta = thetaStart
            while theta <= thetaEnd + 1e-9 {
                defer { theta += step }
                let label = Self.label(at: head.point(theta: theta, phi: phi), project: project, hair: hair, skin: skin, threshold: threshold)
                switch label {
                case .hair:
                    hairRun += 1; skinRun = 0
                    if hairRun >= confirmSteps { inHair = true; candidate = nil }
                case .skin:
                    if skinRun == 0 { skinStart = theta }
                    skinRun += 1; hairRun = 0
                    if inHair && skinRun >= confirmSteps { candidate = skinStart; inHair = false }
                case .other, .unseen:
                    hairRun = 0; skinRun = 0
                }
            }
            if let candidate { out[phi] = candidate }
        }
        return out
    }

    static func label(at p: V3, project: (V3) -> SIMD2<Double>?, hair: (SIMD2<Double>) -> Double,
                      skin: ((SIMD2<Double>) -> Double)?, threshold: Double) -> SampleLabel {
        guard let uv = project(p), uv.x >= 0, uv.x <= 1, uv.y >= 0, uv.y <= 1 else { return .unseen }
        if hair(uv) >= threshold { return .hair }
        if let skin { return skin(uv) >= threshold ? .skin : .other }
        return .skin
    }
}

public struct HairlineFit: Sendable, Equatable, Codable {
    public var hairlineFront: Double
    public var earNotch: Double?
    public init(hairlineFront: Double, earNotch: Double? = nil) { self.hairlineFront = hairlineFront; self.earNotch = earNotch }
}

public enum HairlineCalibrator {
    public static let frontRange = 0.84...1.16
    public static let notchRange = 0.0...0.5

    /// The hairline_front implied by seeing the hairline at (theta, phi) on `head`.
    public static func frontEquivalent(_ head: HeadProxy, theta: Double, phi: Double) -> Double {
        let k = (1 - cos(phi)) * 0.5
        let q = (abs(phi) - Double.pi * 0.5) / head.earNotchWidth
        let notch = head.earNotch * exp(-(q * q))
        return (theta + notch - head.hairlineBack * k) / (1 - k)
    }

    static func median(_ v: [Double]) -> Double? {
        guard !v.isEmpty else { return nil }
        let s = v.sorted()
        return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }

    /// observations: per meridian, the pooled hairline theta.
    public static func fit(head: HeadProxy, observations: [Double: Double], minFront: Int = 5) -> HairlineFit? {
        let front = observations.filter { abs($0.key) <= 0.6 }
        guard front.count >= minFront,
              let f = median(front.map { frontEquivalent(head, theta: $0.value, phi: $0.key) }) else { return nil }
        let hf = min(frontRange.upperBound, max(frontRange.lowerBound, f))
        var h = head
        h.hairlineFront = hf
        let side = observations.filter { abs(abs($0.key) - Double.pi / 2) <= 0.3 }
        var notch: Double?
        if side.count >= 4 {
            let est = side.map { phi, theta -> Double in
                let base = hf + (h.hairlineBack - hf) * (1.0 - cos(phi)) * 0.5
                let q = (abs(phi) - Double.pi * 0.5) / h.earNotchWidth
                return (base - theta) / exp(-(q * q))
            }
            if let m = median(est) { notch = min(notchRange.upperBound, max(notchRange.lowerBound, m)) }
        }
        return HairlineFit(hairlineFront: hf, earNotch: notch)
    }
}
