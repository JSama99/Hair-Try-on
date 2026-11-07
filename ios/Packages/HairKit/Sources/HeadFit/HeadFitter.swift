// HeadFitter.swift — fit the scalp proxy to a tracked face mesh (twin of web/src/headfit.js).
//
// Neither ARKit's face geometry nor MediaPipe's face mesh has a scalp, so the
// ellipsoidal HeadProxy is fitted in closed form, in the mesh's own frame
// (metres, +Y up, +Z out of the face):
//   head ellipsoid  breadth from the widest face vertices, height from the face
//                   height (ratio 0.56), placed so the front hairline point
//                   (theta = hairlineFront, phi = 0) lands on the top-of-forehead vertex.
//   face keep-out   brow to below the chin, nose tip + 2 cm back to behind the
//                   head centre, then grown just enough that every face vertex
//                   hair could reach is inside it.
// Presets differ only in where the mesh stops on the forehead.

import Foundation
import ProtoStyle

public enum FacePreset: String, Sendable, CaseIterable {
    case mediapipe, arkit
    /// Metres added above the mesh top: ARKit's face geometry stops ~1.5 cm below the hairline.
    public var topRaise: Double { self == .arkit ? 0.015 : 0.0 }
}

public enum HeadFitConstants {
    public static let heightRatio = 0.56
    public static let depthRatio = 0.97
    public static let breadthPad = 0.002
    public static let keepTopDrop = 0.06
    public static let keepChinDrop = 0.12
    public static let keepNoseGap = 0.02
    public static let keepBreadth = 0.92
    public static let containMargin = 0.98
    public static let minClearance = 0.004
    public static let keepBackFrac = 0.25
}

public enum HeadFitError: Error, Equatable { case tooFewVertices }

public enum HeadFitter {
    /// A face vertex hair could reach: outside the head inflated by the thinnest strand
    /// clearance and below the keep-out top (above it is the root zone, hair is swept back).
    static func needsKeepOut(_ head: HeadProxy, _ v: V3, keepTop: Double) -> Bool {
        if v.y > keepTop { return false }
        let c = HeadFitConstants.minClearance
        let d = v - head.center
        let a = d.x / (head.rx + c), b = d.y / (head.ry + c), e = d.z / (head.rz + c)
        return a * a + b * b + e * e >= 1.0
    }

    public static func fit(vertices: [V3], preset: FacePreset = .mediapipe,
                           hairlineFront: Double? = nil, earNotch: Double? = nil) throws -> HeadProxy {
        guard vertices.count >= 16 else { throw HeadFitError.tooFewVertices }
        var mn = V3(.infinity, .infinity, .infinity), mx = V3(-.infinity, -.infinity, -.infinity)
        var topIndex = 0
        for (i, v) in vertices.enumerated() {
            mn = V3(min(mn.x, v.x), min(mn.y, v.y), min(mn.z, v.z))
            mx = V3(max(mx.x, v.x), max(mx.y, v.y), max(mx.z, v.z))
            if v.y > vertices[topIndex].y { topIndex = i }
        }
        let C = HeadFitConstants.self
        let midX = (mn.x + mx.x) / 2
        let halfBreadth = (mx.x - mn.x) / 2
        let top = mx.y + preset.topRaise
        let chin = mn.y
        let faceH = top - chin
        let noseZ = mx.z
        let topZ = vertices[topIndex].z

        var head = HeadProxy()
        if let hairlineFront { head.hairlineFront = hairlineFront }
        if let earNotch { head.earNotch = earNotch }
        let hf = head.hairlineFront
        head.rx = halfBreadth + C.breadthPad
        head.ry = C.heightRatio * faceH
        head.rz = C.depthRatio * head.ry
        head.cx = midX
        head.cy = top - head.ry * cos(hf)
        head.cz = topZ - head.rz * sin(hf)

        let kTop = top - C.keepTopDrop * faceH
        let kBottom = chin - C.keepChinDrop * faceH
        let kFront = noseZ + C.keepNoseGap
        let kBack = head.cz - C.keepBackFrac * head.rz
        head.frx = C.keepBreadth * halfBreadth
        head.fry = (kTop - kBottom) / 2
        head.frz = (kFront - kBack) / 2
        head.fx = midX
        head.fy = (kTop + kBottom) / 2
        head.fz = (kFront + kBack) / 2

        var worst = 0.0
        for v in vertices where needsKeepOut(head, v, keepTop: kTop) { worst = max(worst, head.faceImplicit(v)) }
        if worst > C.containMargin {
            let s = (worst / C.containMargin).squareRoot()
            head.frx *= s; head.fry *= s; head.frz *= s
        }
        return head
    }

    /// Fraction of face vertices hair cannot cross. 1.0 for a valid fit.
    public static func faceCoverage(_ head: HeadProxy, vertices: [V3]) -> Double {
        let kTop = head.fy + head.fry
        let ok = vertices.filter { !needsKeepOut(head, $0, keepTop: kTop) || head.faceImplicit($0) <= 1.0 }.count
        return Double(ok) / Double(max(1, vertices.count))
    }
}
