// CalibrationStore.swift — the hairline calibration, kept on device.
// Two numbers only: no images, no masks, nothing that identifies her.

import Foundation

struct SavedCalibration: Codable, Equatable {
    var hairlineFront: Double
    var earNotch: Double?
}

enum CalibrationStore {
    static let key = "hairline.calibration.v1"

    static func load() -> SavedCalibration? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(SavedCalibration.self, from: data)
    }

    static func save(_ c: SavedCalibration) {
        if let data = try? JSONEncoder().encode(c) { UserDefaults.standard.set(data, forKey: key) }
    }

    static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}
