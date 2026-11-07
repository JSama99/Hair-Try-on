// DynamicMesh.swift — GPU meshes updated every frame (RealityKit LowLevelMesh, iOS 18).
//
// HairMesh layout:
//   buffer 0  position @0, normal @12, tangent @24, bitangent @36 (float3)  stride 48  (rewritten per frame)
//   buffer 1  uv0 float2                                                  stride 8   (static: plait coordinates)
//   buffer 2  uv1 float2                                                  stride 8   (static: root->tip, strand jitter)
// Splitting the static attributes out means the per-frame upload is only buffer 0.

import RealityKit
import simd
import TryOnCore

@MainActor
final class HairMesh {
    let lowLevel: LowLevelMesh
    let resource: MeshResource
    let vertexCount: Int

    init(attributes a: RenderAttributes, positions: [Float], normals: [Float]) throws {
        vertexCount = a.uv0.count
        var d = LowLevelMesh.Descriptor()
        d.vertexAttributes = [
            .init(semantic: .position, format: .float3, layoutIndex: 0, offset: 0),
            .init(semantic: .normal, format: .float3, layoutIndex: 0, offset: 12),
            .init(semantic: .tangent, format: .float3, layoutIndex: 0, offset: 24),
            .init(semantic: .bitangent, format: .float3, layoutIndex: 0, offset: 36),
            .init(semantic: .uv0, format: .float2, layoutIndex: 1, offset: 0),
            .init(semantic: .uv1, format: .float2, layoutIndex: 2, offset: 0),
        ]
        d.vertexLayouts = [
            .init(bufferIndex: 0, bufferStride: 48),
            .init(bufferIndex: 1, bufferStride: 8),
            .init(bufferIndex: 2, bufferStride: 8),
        ]
        d.vertexCapacity = vertexCount
        d.indexCapacity = a.indices.count
        d.indexType = .uint32
        lowLevel = try LowLevelMesh(descriptor: d)
        lowLevel.withUnsafeMutableBytes(bufferIndex: 1) { raw in
            let p = raw.bindMemory(to: SIMD2<Float>.self)
            for i in 0..<vertexCount { p[i] = a.uv0[i] }
        }
        lowLevel.withUnsafeMutableBytes(bufferIndex: 2) { raw in
            let p = raw.bindMemory(to: SIMD2<Float>.self)
            for i in 0..<vertexCount { p[i] = a.uv1[i] }
        }
        lowLevel.withUnsafeMutableIndices { raw in
            let p = raw.bindMemory(to: UInt32.self)
            for i in 0..<a.indices.count { p[i] = a.indices[i] }
        }
        update(positions: positions, normals: normals, indexCount: a.indices.count)
        resource = try MeshResource(from: lowLevel)
    }

    /// Rewrite buffer 0 from skinned positions/normals (head frame, Float triples).
    func update(positions: [Float], normals: [Float], indexCount: Int? = nil) {
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        let n = vertexCount
        lowLevel.replaceUnsafeMutableBytes(bufferIndex: 0) { raw in
            let f = raw.bindMemory(to: Float.self)
            for i in 0..<n {
                let p = SIMD3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2])
                let nn = SIMD3(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2])
                // Tangent: any unit vector orthogonal to the normal (the shader works in uv space).
                let ref: SIMD3<Float> = abs(nn.y) < 0.9 ? [0, 1, 0] : [1, 0, 0]
                let t = simd_normalize(simd_cross(ref, nn))
                let bt = simd_cross(nn, t)
                let o = 12 * i
                f[o] = p.x; f[o + 1] = p.y; f[o + 2] = p.z
                f[o + 3] = nn.x; f[o + 4] = nn.y; f[o + 5] = nn.z
                f[o + 6] = t.x; f[o + 7] = t.y; f[o + 8] = t.z
                f[o + 9] = bt.x; f[o + 10] = bt.y; f[o + 11] = bt.z
                lo = simd_min(lo, p); hi = simd_max(hi, p)
            }
        }
        let count = indexCount ?? lowLevel.parts.first?.indexCount ?? 0
        lowLevel.parts.replaceAll([LowLevelMesh.Part(indexCount: count, topology: .triangle, bounds: BoundingBox(min: lo, max: hi))])
    }
}

/// Face occluder from ARFaceGeometry, updated as her expression changes.
@MainActor
final class FaceOccluderMesh {
    let lowLevel: LowLevelMesh
    let resource: MeshResource
    let vertexCount: Int

    init(vertices: [SIMD3<Float>], indices: [Int16]) throws {
        vertexCount = vertices.count
        var d = LowLevelMesh.Descriptor()
        d.vertexAttributes = [.init(semantic: .position, format: .float3, layoutIndex: 0, offset: 0)]
        d.vertexLayouts = [.init(bufferIndex: 0, bufferStride: 12)]
        d.vertexCapacity = vertices.count
        d.indexCapacity = indices.count
        d.indexType = .uint16
        lowLevel = try LowLevelMesh(descriptor: d)
        lowLevel.withUnsafeMutableIndices { raw in
            let p = raw.bindMemory(to: UInt16.self)
            for i in 0..<indices.count { p[i] = UInt16(bitPattern: indices[i]) }
        }
        update(vertices: vertices, indexCount: indices.count)
        resource = try MeshResource(from: lowLevel)
    }

    func update(vertices: [SIMD3<Float>], indexCount: Int? = nil) {
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        lowLevel.replaceUnsafeMutableBytes(bufferIndex: 0) { raw in
            let f = raw.bindMemory(to: Float.self)
            for (i, v) in vertices.enumerated() {
                f[3 * i] = v.x; f[3 * i + 1] = v.y; f[3 * i + 2] = v.z
                lo = simd_min(lo, v); hi = simd_max(hi, v)
            }
        }
        let count = indexCount ?? lowLevel.parts.first?.indexCount ?? 0
        lowLevel.parts.replaceAll([LowLevelMesh.Part(indexCount: count, topology: .triangle, bounds: BoundingBox(min: lo, max: hi))])
    }
}
