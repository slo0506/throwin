//  Shaders.metal
//  Throw-In's signature effects. See docs/design.md, "Shaders".
//
//  Conventions
//  - Every function is [[ stitchable ]] so SwiftUI can call it through ShaderLibrary.
//  - `bounds` is SwiftUI's `.boundingRect` argument: (x, y, width, height) in points.
//  - Colors returned to SwiftUI are premultiplied.

#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// MARK: - Palette (the Loop gradient)

constant half3 kTangerine = half3(1.000h, 0.478h, 0.184h);
constant half3 kBubblegum = half3(1.000h, 0.310h, 0.604h);
constant half3 kIris      = half3(0.478h, 0.361h, 1.000h);
constant half3 kPool      = half3(0.184h, 0.769h, 1.000h);

/// Maps t in [0, 1) around the Loop: tangerine, bubblegum, iris, pool, back to tangerine.
static half3 loopColor(float t) {
    float x = fract(t) * 4.0;
    float f = smoothstep(0.0, 1.0, fract(x));
    int i = int(floor(x));
    if (i == 0) { return mix(kTangerine, kBubblegum, half(f)); }
    if (i == 1) { return mix(kBubblegum, kIris, half(f)); }
    if (i == 2) { return mix(kIris, kPool, half(f)); }
    return mix(kPool, kTangerine, half(f));
}

// MARK: - Noise

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

static float valueNoise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + float2(1.0, 0.0));
    float c = hash21(i + float2(0.0, 1.0));
    float d = hash21(i + float2(1.0, 1.0));
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

static float fbm(float2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
        sum += amp * valueNoise(p);
        p = p * 2.03 + float2(17.1, 9.2);
        amp *= 0.5;
    }
    return sum;
}

// MARK: - GM orb
//
// The GM's face: a glass sphere full of slowly folding Loop-colored liquid.
// energy: 0 idle (slow breathing), ~0.5 thinking (faster swirl), 1 speaking (bright, quick).

[[ stitchable ]] half4 gmOrb(float2 position, half4 color, float4 bounds, float time, float energy) {
    float2 size = bounds.zw;
    float2 uv = (position - bounds.xy) / size;
    float2 p = uv * 2.0 - 1.0;

    // Gentle breathing: the sphere's radius swells slightly with energy.
    float breathe = 0.965 + 0.02 * sin(time * (1.4 + energy * 2.6)) + 0.012 * energy;
    float r = length(p) / breathe;
    float aa = 2.5 / max(size.x, 1.0);
    float mask = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    if (mask <= 0.0) {
        return half4(0.0h);
    }

    // Domain-warped flow inside the sphere.
    float speed = 0.16 + energy * 0.55;
    float t = time * speed;
    float2 q = float2(fbm(p * 1.5 + float2(0.0, t)), fbm(p * 1.5 + float2(5.2, -t * 0.8)));
    float2 w = float2(fbm(p * 1.8 + 2.2 * q + float2(1.7, 9.2) + t * 0.6),
                      fbm(p * 1.8 + 2.2 * q + float2(8.3, 2.8) - t * 0.5));
    float n = fbm(p * 1.6 + 2.2 * w);

    float hue = n * 1.35 + (p.x * 0.6 - p.y * 0.4) * 0.22 + time * 0.03;
    half3 liquid = loopColor(hue);
    // Brighter, creamier pockets where the flow folds.
    liquid = mix(liquid, half3(1.0h, 0.97h, 0.94h), half(smoothstep(0.62, 0.95, n) * 0.55));

    // Sphere lighting.
    float z = sqrt(max(0.0, 1.0 - r * r));
    float3 normal = normalize(float3(p, z));
    float3 light = normalize(float3(-0.45, -0.6, 0.66));
    float diffuse = clamp(dot(normal, light), 0.0, 1.0);
    float fresnel = pow(1.0 - z, 2.6);
    float3 h = normalize(light + float3(0.0, 0.0, 1.0));
    float spec = pow(clamp(dot(normal, h), 0.0, 1.0), 64.0);

    half3 rgb = liquid * half(0.72 + 0.38 * diffuse);
    rgb += half3(half(fresnel * (0.55 + 0.25 * energy)));      // glass rim
    rgb += half3(half(spec * 0.85));                          // specular glint
    rgb = mix(rgb, rgb * half3(0.82h, 0.80h, 0.95h), half(smoothstep(0.55, 1.0, -p.y * 0.5 + r * 0.6) * 0.25)); // underside shade
    rgb = clamp(rgb, half3(0.0h), half3(1.0h));

    half a = half(mask) * color.a;
    return half4(rgb * a, a);
}

// MARK: - Appraisal scan
//
// A holographic band sweeps top to bottom. Below the band the photo is still being
// "read": a Loop-tinted halftone. The band itself splits color channels. Above, the photo
// is clean. progress: 0 (nothing read) to 1 (fully read).

[[ stitchable ]] half4 appraiseScan(float2 position, SwiftUI::Layer layer, float4 bounds, float progress, float time) {
    float2 size = bounds.zw;
    float2 uv = (position - bounds.xy) / size;
    float bandY = mix(-0.12, 1.12, progress);
    float d = uv.y - bandY;                         // > 0: not yet scanned
    float bandWidth = 0.035;

    half4 clean = layer.sample(position);

    // Chromatic split around the band.
    float split = exp(-abs(d) / 0.05) * 7.0;
    half4 shifted = half4(layer.sample(position + float2(split, 0.0)).r,
                          clean.g,
                          layer.sample(position - float2(split, 0.0)).b,
                          clean.a);

    // Halftone for the unscanned region.
    float cell = 7.0;
    float2 cellCenter = floor(position / cell) * cell + cell * 0.5;
    half4 cellColor = layer.sample(cellCenter);
    half lum = dot(cellColor.rgb, half3(0.299h, 0.587h, 0.114h));
    float dotRadius = cell * 0.5 * (0.35 + 0.65 * float(lum));
    float dotMask = 1.0 - smoothstep(dotRadius - 0.8, dotRadius + 0.8, length(position - cellCenter));
    half3 tint = loopColor(uv.x * 0.6 + uv.y * 0.3 + time * 0.08);
    half3 halftone = mix(half3(lum) * 0.35h, mix(cellColor.rgb, tint, 0.55h), half(dotMask));
    half4 digitized = half4(halftone * cellColor.a, cellColor.a);

    half4 result = d > 0.0 ? digitized : shifted;
    // Soft edge between the two states just above the band.
    float settle = smoothstep(-0.08, 0.0, d);
    if (d <= 0.0) {
        result = mix(clean, shifted, half(settle));
    }

    // The band: a bright iridescent line with a soft glow.
    float band = exp(-pow(d / bandWidth, 2.0));
    half3 bandColor = loopColor(uv.x * 0.9 + time * 0.25);
    result.rgb += bandColor * half(band * 0.85) * result.a;
    result.rgb += half3(1.0h) * half(exp(-pow(d / (bandWidth * 0.18), 2.0)) * 0.6) * result.a;

    return result;
}

// MARK: - Liquid ripple
//
// A damped radial wave from `origin`. Used on approve, Deal arrival and the GM tab tap.

[[ stitchable ]] half4 liquidRipple(float2 position, SwiftUI::Layer layer, float2 origin, float time,
                                     float amplitude, float frequency, float decay, float speed) {
    float2 delta = position - origin;
    float distance = length(delta);
    float delay = distance / speed;
    float t = max(0.0, time - delay);
    float ripple = amplitude * sin(frequency * t) * exp(-decay * t);
    float2 direction = distance > 0.001 ? delta / distance : float2(0.0);
    half4 color = layer.sample(position + ripple * direction);
    // Crests catch a little light.
    color.rgb += half3(half(0.22 * (ripple / max(amplitude, 0.001)))) * color.a;
    return color;
}

// MARK: - Paper grain
//
// About 2% animated grain so flat color feels printed, not rendered.

[[ stitchable ]] half4 paperGrain(float2 position, half4 color, float time, float strength) {
    float n = hash21(floor(position) + floor(time * 24.0) * float2(7.13, 3.71)) - 0.5;
    color.rgb += half3(half(n * strength)) * color.a;
    return color;
}

// MARK: - Loop shimmer
//
// A Loop-colored highlight sweeps across text (the GM's "thinking" status line).

[[ stitchable ]] half4 loopShimmer(float2 position, half4 color, float4 bounds, float time) {
    if (color.a <= 0.0h) {
        return color;
    }
    float x = (position.x - bounds.x) / max(bounds.z, 1.0);
    float sweep = fract(time * 0.45);
    float distance = x - (sweep * 1.6 - 0.3);
    float band = exp(-pow(distance / 0.16, 2.0));
    half3 tint = loopColor(x * 0.5 + time * 0.2);
    half3 base = color.rgb / color.a;
    half3 rgb = mix(base, tint, half(band * 0.9));
    return half4(rgb * color.a, color.a);
}

// MARK: - Ripple ring
//
// A safe-anywhere companion to liquidRipple: instead of displacing the view underneath
// (which can't sample UIKit-backed content like scroll views), it draws an expanding,
// Loop-tinted glass ring over it. Used on full screens.

[[ stitchable ]] half4 rippleRing(float2 position, half4 color, float2 origin, float time, float speed, float strength) {
    float2 delta = position - origin;
    float distance = length(delta);
    float radius = speed * time;
    float width = 26.0 + 40.0 * time;
    float fade = exp(-2.4 * time);

    float lead = exp(-pow((distance - radius) / width, 2.0));
    float trail = exp(-pow((distance - radius * 0.72) / (width * 0.6), 2.0)) * 0.45;
    float ring = (lead + trail) * fade * strength;
    if (ring < 0.002) {
        return half4(0.0h);
    }

    float2 dir = distance > 0.001 ? delta / distance : float2(0.0);
    half3 tint = loopColor(0.5 + dir.x * 0.22 - dir.y * 0.18 + time * 0.3);
    // A thin bright crest on the leading edge, like light on a wave.
    float crest = exp(-pow((distance - radius) / (width * 0.18), 2.0)) * fade;
    half3 rgb = tint * half(ring) + half3(half(crest * 0.5 * strength));
    half a = half(clamp(ring * 0.55 + crest * 0.35 * strength, 0.0, 1.0));
    return half4(rgb, a);
}
