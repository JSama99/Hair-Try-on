// LiveSession.swift — per-frame orchestration, free of ARKit/RealityKit so it tests on Linux.
//
//   observeFace   face mesh -> fitted, One-Euro-filtered HeadProxy. Returns a head
//                 to rebuild the style on only when the filter is warm, the head
//                 has moved more than `regenerateThreshold` since the last build,
//                 and it has settled (per-frame change < `settleThreshold`), so a
//                 still head costs exactly one build.
//   install       a generated style -> simulation (pre-settled, invisible).
//   advance       head pose + time -> simulation step.
//   skin          LOD1 positions/normals in the head frame for the renderer.
//   measureConflict  her hair mask vs the style silhouette at mask resolution.

import Foundation
import ProtoStyle
import HeadFit
import HairDynamics

public final class LiveSession {
    public var preset: FacePreset
    public var calibration: HairlineFit?
    public var regenerateThreshold = 0.002
    public var settleThreshold = 0.0001

    public private(set) var filter = HeadProxyFilter()
    public private(set) var lastBuiltHead: HeadProxy?
    public private(set) var simulation: HairSimulation?
    public private(set) var result: StyleResult?
    public private(set) var lastStyleMask: [Bool] = []
    public private(set) var conflictActive = false
    public private(set) var lastMeasure: ConflictMeasure?
    private var previousFiltered: HeadProxy?
    private var lastTime: Double?

    public init(preset: FacePreset = .arkit, calibration: HairlineFit? = nil) {
        self.preset = preset
        self.calibration = calibration
    }

    /// Feed one tracked face mesh. Returns a HeadProxy when the style should be (re)generated on it.
    public func observeFace(vertices: [V3], time: Double) -> HeadProxy? {
        guard let fitted = try? HeadFitter.fit(vertices: vertices, preset: preset,
                                               hairlineFront: calibration?.hairlineFront, earNotch: calibration?.earNotch) else { return nil }
        let smoothed = filter.update(fitted, time: time)
        defer { previousFiltered = smoothed }
        guard filter.isWarm, let prev = previousFiltered else { return nil }
        let settled = HeadProxyFilter.maxChange(prev, smoothed) < settleThreshold
        let moved = lastBuiltHead.map { HeadProxyFilter.maxChange($0, smoothed) > regenerateThreshold } ?? true
        guard settled, moved else { return nil }
        lastBuiltHead = smoothed
        return smoothed
    }

    /// Apply a hairline calibration: the next settled observation rebuilds on it.
    public func applyCalibration(_ fit: HairlineFit?) {
        calibration = fit
        lastBuiltHead = nil
    }

    /// Install a freshly generated style; the simulation is settled before it is shown.
    public func install(_ result: StyleResult, pose: HeadPose) {
        self.result = result
        let sim = HairSimulation(result: result)
        sim.settle(pose: pose)
        simulation = sim
        lastTime = nil
    }

    public func advance(pose: HeadPose, time: Double) {
        guard let sim = simulation else { return }
        let dt = lastTime.map { time - $0 } ?? 0
        lastTime = time
        sim.advance(to: pose, elapsed: dt)
    }

    /// Tracking was lost (face out of view): drop motion so hair does not whip when she returns.
    public func trackingLost() {
        lastTime = nil
        if let sim = simulation { sim.reset(pose: sim.pose) }
    }

    /// Restart after the AR session restarts: filter warms up again, next settled fit rebuilds.
    public func restart() {
        filter.reset()
        previousFiltered = nil
        lastBuiltHead = nil
        lastTime = nil
        conflictActive = false
    }

    public func skin(positions: inout [Float], normals: inout [Float]) {
        simulation?.skinLOD1(positions: &positions, normals: &normals)
    }

    /// Compare her hair (mask on the display image) with the current style silhouette.
    /// - Parameters:
    ///   - project: head-frame point -> mask pixel (x right, y down), nil if behind the camera.
    ///   - headTriangles: triangles + head-frame vertices of the head occluder, for the head area.
    public func measureConflict(hair: ProbabilityMap, project: (V3) -> SIMD2<Double>?,
                                headVertices: [V3], headTriangles: [UInt32],
                                settings: HonestySettings = Catalog.shared.honesty) -> ConflictMeasure? {
        guard let result else { return nil }
        var pos: [Float] = [], nrm: [Float] = []
        skin(positions: &pos, normals: &nrm)
        let n = pos.count / 3
        let pts: [SIMD2<Double>?] = (0..<n).map { project(V3(Double(pos[3 * $0]), Double(pos[3 * $0 + 1]), Double(pos[3 * $0 + 2]))) }
        var style: [Bool] = []
        SilhouetteRaster.fill(triangles: result.lod1.triangles, points: pts, width: hair.width, height: hair.height, into: &style)
        style = Honesty.dilate(style, width: hair.width, height: hair.height,
                               radius: Honesty.closingRadius(width: hair.width, height: hair.height))
        var head: [Bool] = []
        SilhouetteRaster.fill(triangles: headTriangles, points: headVertices.map(project), width: hair.width, height: hair.height, into: &head)
        let m = Honesty.measure(hair: hair, style: style, headArea: head.filter { $0 }.count, settings: settings)
        lastStyleMask = style
        lastMeasure = m
        conflictActive = Honesty.update(active: conflictActive, m, settings: settings)
        return m
    }
}
