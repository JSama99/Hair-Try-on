import Foundation
import XCTest
@testable import HairDynamics
import ProtoStyle

final class HairDynamicsTests: XCTestCase {
    static let result: StyleResult = try! generate(StyleSpec(kind: .boxBraids, width: 0.03, length: 0.25), includeLOD0: false)

    func makeSim() -> HairSimulation { HairSimulation(result: Self.result) }

    func run(_ sim: HairSimulation, seconds: Double, pose: (Double) -> HeadPose) {
        let frames = Int(seconds * 60)
        for f in 1...frames { sim.advance(to: pose(Double(f) / 60), elapsed: 1.0 / 60) }
    }

    func assertInvariants(_ sim: HairSimulation, file: StaticString = #filePath, line: UInt = #line) {
        let nodes = sim.nodesInHeadFrame()
        for ch in sim.chains {
            for i in 1..<ch.count where i >= ch.pinned {
                let d = (nodes[ch.offset + i] - nodes[ch.offset + i - 1]).length
                XCTAssertEqual(d, ch.ds, accuracy: 1e-12, "inextensible", file: file, line: line)
            }
            for i in ch.pinned..<ch.count {
                let p = nodes[ch.offset + i]
                XCTAssertTrue(p.isFinite, file: file, line: line)
                let c = sim.clearance * 0.9  // validator V04 criterion
                let d = p - sim.head.center
                let a = d.x / (sim.head.rx + c), b = d.y / (sim.head.ry + c), e = d.z / (sim.head.rz + c)
                XCTAssertGreaterThanOrEqual(a * a + b * b + e * e, 1.0, "outside head", file: file, line: line)
                XCTAssertGreaterThanOrEqual(sim.head.faceImplicit(p, clearance: c), 1.0, "outside face", file: file, line: line)
            }
        }
    }

    func testStillHeadSettlesNearTheRestPoseAndThenHoldsStill() {
        let sim = makeSim()
        sim.settle(pose: .identity)
        let settled = sim.nodesInHeadFrame()
        var drifts = settled.indices.map { (settled[$0] - sim.rest[$0]).length }
        drifts.sort()
        // The runtime solver (4 passes, live damping) sags slightly more than the 10-pass reference drape:
        // measured median 7 mm on this style.
        XCTAssertLessThan(drifts[drifts.count / 2], 0.010, "median strand node stays within 1 cm of the oracle rest pose")
        XCTAssertLessThan(drifts.last!, 0.10, "a slow slide the 220-step drape had not finished is bounded")
        run(sim, seconds: 2) { _ in .identity }
        let after = sim.nodesInHeadFrame()
        let moved = after.indices.map { (after[$0] - settled[$0]).length }.max()!
        XCTAssertLessThan(moved, 0.002, "after settle(), a still head means still hair (moved \(moved) m)")
        XCTAssertLessThan(sim.maxSpeed, 0.01)
        assertInvariants(sim)
    }

    func testTurningTheHeadSwingsTheHairThenItSettles() {
        let sim = makeSim()
        run(sim, seconds: 1) { _ in .identity }
        var peak = 0.0
        run(sim, seconds: 0.4) { t in .euler(yaw: min(1, (t - 1) / 0.4) * 0.6) }
        for _ in 0..<30 { sim.advance(to: .euler(yaw: 0.6), elapsed: 1.0 / 60); peak = max(peak, sim.maxSpeed) }
        XCTAssertGreaterThan(peak, 0.05, "hair responds to the turn")
        assertInvariants(sim)
        run(sim, seconds: 4) { _ in .euler(yaw: 0.6) }
        XCTAssertLessThan(sim.maxSpeed, 0.03, "and settles")
        assertInvariants(sim)
    }

    func testGravityIsWorldDownWhenTheHeadTilts() {
        let sim = makeSim()
        run(sim, seconds: 4) { _ in .euler(pitch: 0.5) }  // chin down
        // Tips hang along world -Y: the last node of a back strand is below its root in world space.
        let ch = sim.chains[0]
        let tipWorld = sim.positions[ch.offset + ch.count - 1]
        let rootWorld = sim.positions[ch.offset]
        XCTAssertLessThan(tipWorld.y, rootWorld.y - 0.1)
        assertInvariants(sim)
    }

    func testDeterministicForTheSamePoseSequence() {
        let a = makeSim(), b = makeSim()
        let path: (Double) -> HeadPose = { .euler(yaw: 0.4 * sin(3 * $0), pitch: 0.1 * sin(5 * $0), t: V3(0.01 * sin($0), 0, 0)) }
        run(a, seconds: 1.5, pose: path)
        run(b, seconds: 1.5, pose: path)
        XCTAssertEqual(a.positions, b.positions)
    }

    func testSkinningReproducesTheShellAtRestAndUnderRigidMotion() {
        let sim = makeSim()
        var p: [Float] = [], n: [Float] = []
        sim.skinLOD1(positions: &p, normals: &n)
        var worst = 0.0
        for (v, q) in Self.result.lod1.positions.enumerated() {
            worst = max(worst, (V3(Double(p[3 * v]), Double(p[3 * v + 1]), Double(p[3 * v + 2])) - q).length)
        }
        XCTAssertLessThan(worst, 1e-6, "rest skinning error \(worst)")
        // A reset under a rigid pose keeps the shell rigid in the head frame.
        sim.reset(pose: .euler(yaw: 0.7, pitch: -0.2, roll: 0.1, t: V3(0.1, -0.2, 0.3)))
        sim.skinLOD1(positions: &p, normals: &n)
        worst = 0
        for (v, q) in Self.result.lod1.positions.enumerated() {
            worst = max(worst, (V3(Double(p[3 * v]), Double(p[3 * v + 1]), Double(p[3 * v + 2])) - q).length)
        }
        XCTAssertLessThan(worst, 1e-6)
    }

    func testPoseAlgebra() {
        let pose = HeadPose.euler(yaw: 0.3, pitch: -0.4, roll: 0.2, t: V3(1, 2, 3))
        let p = V3(0.1, -0.2, 0.05)
        let q = pose.inverseApply(pose.apply(p))
        XCTAssertEqual((q - p).length, 0, accuracy: 1e-14)
        XCTAssertEqual(pose.c0.dot(pose.c1), 0, accuracy: 1e-14)
        XCTAssertEqual(pose.c0.cross(pose.c1).dot(pose.c2), 1, accuracy: 1e-14)
        let r = rotateMinimal(V3(0, 0, 1), from: V3(0, -1, 0), to: V3(1, 0, 0))
        XCTAssertEqual((r - V3(0, 0, 1)).length, 0, accuracy: 1e-14)
        let flip = rotateMinimal(V3(1, 0, 0), from: V3(0, 1, 0), to: V3(0, -1, 0))
        XCTAssertEqual(flip.length, 1, accuracy: 1e-14)
    }

    func testLargeFrameGapsAreCapped() {
        let sim = makeSim()
        sim.advance(to: .identity, elapsed: 5.0)  // app was backgrounded
        XCTAssertEqual(sim.stepCount, SimulationParams().maxStepsPerAdvance)
        assertInvariants(sim)
    }
}
