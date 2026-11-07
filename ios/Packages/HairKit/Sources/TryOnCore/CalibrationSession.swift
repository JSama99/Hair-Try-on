// CalibrationSession.swift — the 3-second hairline calibration (docs/ARCHITECTURE.md §4.2).
//
// Each frame, HairlineObserver reports where the hair -> skin transition is on
// each meridian it can see. Observations are pooled per meridian (median, so a
// few bad frames cannot drag it) and fitted once enough of the hairline has
// been seen: at least a quarter of the meridians, including five front ones.

import Foundation
import ProtoStyle
import HeadFit

public final class CalibrationSession {
    public let targetFrames: Int
    public var observer = HairlineObserver()
    public private(set) var frames = 0
    public private(set) var perMeridian: [Double: [Double]] = [:]

    public init(targetFrames: Int = 30) { self.targetFrames = targetFrames }

    public var progress: Double { min(1, Double(frames) / Double(targetFrames)) }
    public var isComplete: Bool { frames >= targetFrames }

    /// One camera frame. `project` maps head-frame points to normalised image coordinates.
    public func add(head: HeadProxy, project: (V3) -> SIMD2<Double>?, hair: ProbabilityMap, skin: ProbabilityMap?) {
        let obs = observer.observe(head: head, project: project, hair: { hair.sample($0) }, skin: skin.map { s in { s.sample($0) } })
        for (phi, theta) in obs { perMeridian[phi, default: []].append(theta) }
        frames += 1
    }

    /// Pooled per-meridian hairline (median of what each meridian saw).
    public var pooled: [Double: Double] {
        perMeridian.compactMapValues { v in
            guard !v.isEmpty else { return nil }
            let s = v.sorted()
            return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
        }
    }

    /// nil until a quarter of the meridians (and five front ones) have been seen.
    public func fit(head: HeadProxy) -> HairlineFit? {
        let p = pooled
        guard Double(p.count) >= Double(observer.phis.count) / 4 else { return nil }
        return HairlineCalibrator.fit(head: head, observations: p)
    }

    public func reset() { frames = 0; perMeridian = [:] }
}
