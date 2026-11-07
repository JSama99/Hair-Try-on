// HairSurface.metal — RealityKit CustomMaterial surface shader for LOD1 hair shells.
//
// Inputs (see DynamicMesh.swift):
//   uv0.x  around the shell (0..1)   uv0.y  along it, in plait periods
//   uv1.x  root -> tip fraction      uv1.y  per-strand jitter (-1..1)
// custom.value = (lobes, groove, fuzz, slant)   custom texture = 64x1 colour gradient, root -> tip
//
// The relief reproduces what LOD0's real strand tubes show: crossing plait lobes
// (chevrons for 3-strand braids, a helix for twists), dark grooves between them,
// fine fibre streaks, and a Kajiya-Kay-like sheen running along the strand.

#include <metal_stdlib>
#include <RealityKit/RealityKit.h>
using namespace metal;

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

[[visible]]
void hairSurface(realitykit::surface_parameters params)
{
    float2 uv0 = params.geometry().uv0();
    float2 uv1 = params.geometry().uv1();
    float4 k = params.uniforms().custom_parameter();
    float lobes = k.x, groove = k.y, fuzz = k.z, slant = k.w;

    // Plait relief: lobes tilted one way on even half-periods and the other way on odd ones.
    // phase = 2*lobes*v + dir*slant*2u, h = 0.5 + 0.5 cos(2 pi phase); the gradient is analytic in
    // uv, because set_normal() takes a TANGENT-space normal (screen-space dfdx/dfdy would swim).
    float h = 0.5, dh_du = 0.0, dh_dv = 0.0;
    if (lobes > 0.0) {
        float around = uv0.x * 2.0;                       // two lobe columns around the tube
        float half_period = floor(uv0.y * lobes * 2.0);
        float dir = (fmod(half_period, 2.0) < 1.0) ? 1.0 : -1.0;
        if (lobes < 1.5) dir = 1.0;                       // twists: a single helix
        float phase = uv0.y * lobes * 2.0 + dir * slant * around;
        h = 0.5 + 0.5 * cos(phase * M_PI_F * 2.0);
        float dh_dphase = -M_PI_F * sin(phase * M_PI_F * 2.0);
        dh_du = dh_dphase * dir * slant * 2.0;
        dh_dv = dh_dphase * lobes * 2.0;
    }
    float streak = hash21(float2(floor(uv0.x * 96.0), floor(uv0.y * 3.0) + uv1.y * 17.0));
    h = mix(h, h * (0.75 + 0.5 * streak), fuzz);

    // Tangent-space normal from the height field (relief strength 0.08 per unit of uv).
    float3 n = normalize(float3(-dh_du * 0.08, -dh_dv * 0.08, 1.0));
    params.surface().set_normal(n);

    // Colour: gradient along the strand, lightness jitter per strand, grooves darkened.
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    half3 base = params.textures().custom().sample(s, float2(clamp(uv1.x, 0.0, 1.0), 0.5)).rgb;
    float occl = mix(1.0, 0.35 + 0.65 * h, groove);
    float jitter = 1.0 + 0.07 * uv1.y;
    params.surface().set_base_color(base * half(occl * jitter));
    params.surface().set_ambient_occlusion(half(occl));

    // Sheen along the strand: a soft, broad highlight on crowns of lobes.
    params.surface().set_roughness(half(mix(0.62, 0.38, h)));
    params.surface().set_specular(half(0.35 + 0.25 * h));
    params.surface().set_metallic(0.0h);
}
