// SupportingViews.swift — onboarding, unsupported device, calibration overlay, capture sheet.

import SwiftUI

struct OnboardingView: View {
    @Environment(TryOnStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Text("Try protective styles on your own head, live.").font(.largeTitle.bold())
            VStack(alignment: .leading, spacing: 12) {
                Label("For the truest preview, pull your hair back or wear a satin bonnet or wrap.", systemImage: "sparkles")
                Label("Sizes are in centimetres and colours use braiding-hair codes, so you can show your stylist exactly what you picked.", systemImage: "ruler")
                Label("Everything happens on this phone. Video never leaves it.", systemImage: "lock.shield")
            }
            .font(.body)
            Spacer()
            Button { store.finishOnboarding() } label: { Text("Start the camera").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        .padding(24)
    }
}

struct UnsupportedDeviceView: View {
    var body: some View {
        ContentUnavailableView("This iPhone can't track faces",
                               systemImage: "faceid",
                               description: Text("Live try-on needs a front TrueDepth camera (iPhone X or later, excluding SE models)."))
    }
}

struct CalibrationOverlay: View {
    let progress: Double
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Text("Look straight at the camera").font(.headline)
            Text("Hold still for three seconds so the braids start at your hairline.").font(.footnote).multilineTextAlignment(.center)
            ProgressView(value: progress).frame(maxWidth: 220)
            Button("Cancel", action: onCancel).buttonStyle(.bordered)
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding(.bottom, 260)
    }
}

struct CaptureSheet: View {
    let look: CapturedLook
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Image(uiImage: look.image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                Text(look.caption).font(.footnote.monospaced()).padding(.top, 8)
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: Image(uiImage: look.image), subject: Text("My look"), message: Text(look.caption),
                              preview: SharePreview(look.caption, image: Image(uiImage: look.image)))
                }
            }
        }
    }
}
