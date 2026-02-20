/**
 * GPU Flow Patterns — TSL compute shader implementations
 * Stripped to only patterns used in mv-data.json (13 patterns).
 */

import {
    float, vec2, vec3, sin, cos, sqrt, floor, abs, pow, exp,
    hash, If, min, max, step, fract, ceil, mix,
    clamp, smoothstep, length
} from 'three/tsl';

// Pattern name → GPU ID mapping (renumbered 1-13)
export const GPU_PATTERN_IDS = {
    organic: 1,
    cubeWave: 2,
    rollingWave: 3,
    orbiting: 4,
    breathingSphere: 5,
    pendulumWave: 6,
    galaxySpin: 7,
    vortexDrain: 8,
    ripplePool: 9,
    flowField: 10,
    auroraCurtain: 11,
    perlinFlow3d: 12,
    flowingSilk: 13,
};

// ============================================================
// Helpers
// ============================================================

// Deterministic per-particle random [0,1]
function h(fi, seed) { return hash(vec2(fi, float(seed))); }
// Per-particle random [-0.5, 0.5]
function hn(fi, seed) { return hash(vec2(fi, float(seed))).sub(0.5); }

// Fibonacci sphere distribution (uniform on sphere surface)
function fibSphere(fi, N, r) {
    const theta = fi.mul(2.399963).fract().mul(6.2831853);
    const cosP = float(1).sub(fi.div(N).mul(2));
    const sinP = sqrt(float(1).sub(cosP.mul(cosP)));
    return vec3(sinP.mul(cos(theta)).mul(r), sinP.mul(sin(theta)).mul(r), cosP.mul(r));
}

// Random spherical point (hash-based)
function randSphere(fi, radius, seedBase) {
    const r1 = h(fi, seedBase);
    const r2 = h(fi, seedBase + 1);
    const r3 = h(fi, seedBase + 2);
    const theta = r1.mul(6.2831853);
    const cosP = r2.mul(2).sub(1);
    const sinP = sqrt(float(1).sub(cosP.mul(cosP)));
    const r = pow(r3, float(0.333333)).mul(radius);
    return vec3(sinP.mul(cos(theta)).mul(r), sinP.mul(sin(theta)).mul(r), cosP.mul(r));
}

// Random spherical surface point
function randSphereSurface(fi, radius, seedBase) {
    const r1 = h(fi, seedBase);
    const r2 = h(fi, seedBase + 1);
    const theta = r1.mul(6.2831853);
    const cosP = r2.mul(2).sub(1);
    const sinP = sqrt(float(1).sub(cosP.mul(cosP)));
    return vec3(sinP.mul(cos(theta)).mul(radius), sinP.mul(sin(theta)).mul(radius), cosP.mul(radius));
}

// ============================================================
// GPU target section — 13 patterns
// ============================================================

export function buildGPUTargetSection(i, target, time, patternId, COUNT) {
    const fi = float(i);
    const N = float(COUNT);

    const sqrtN = Math.ceil(Math.sqrt(COUNT));
    const sideF = float(sqrtN);

    // 1: organic — random sphere volume
    If(patternId.equal(1), () => {
        target.assign(randSphere(fi, float(3.5), 1));

    // 2: cubeWave — animated wave of expanding/contracting cubes
    }).ElseIf(patternId.equal(2), () => {
        const cubes = float(10);
        const cubeSize = float(0.5);
        const spacing = float(1.0);
        const cycleTime = float(3.0);
        const perCube = ceil(N.div(cubes));
        const c = floor(fi.div(perCube)).clamp(0, 9);
        const cx = c.sub(cubes.mul(0.5)).mul(spacing);
        const delay = c.mul(0.2);
        const t = time.sub(delay).mod(cycleTime);
        const scale = clamp(
            min(t.div(0.5), min(float(1.0), float(1).sub(t.sub(1.5).div(0.5)))),
            0.0, 1.0
        ).mul(step(t, float(2.0)));
        const s = cubeSize.mul(scale);
        const isSmall = step(s, float(0.01));
        target.assign(vec3(
            cx.add(mix(hn(fi, 1).mul(s), hn(fi, 4).mul(3), isSmall)),
            mix(hn(fi, 2).mul(s), hn(fi, 5).mul(3), isSmall),
            mix(hn(fi, 3).mul(s), hn(fi, 6).mul(3), isSmall)
        ));

    // 3: rollingWave — animated rolling sine wave surface
    }).ElseIf(patternId.equal(3), () => {
        const side = sideF;
        const sc = float(0.8);
        const x = fi.mod(side).sub(side.mul(0.5)).div(side).mul(8);
        const z = floor(fi.div(side)).sub(side.mul(0.5)).div(side).mul(8);
        const y = sin(x.mul(1.5).sub(time.mul(2))).mul(0.6)
            .add(sin(z.mul(1.2).sub(time.mul(1.3))).mul(0.3));
        target.assign(vec3(x.mul(sc), y.mul(sc), z.mul(sc)));

    // 4: orbiting — concentric orbiting rings with alternating direction
    }).ElseIf(patternId.equal(4), () => {
        const rings = float(8);
        const perRing = ceil(N.div(rings));
        const r = floor(fi.div(perRing)).clamp(0, 7);
        const j = fi.mod(perRing);
        const radius = float(0.5).add(r.mul(0.3));
        const speed = float(1.0).add(r.mul(0.3)).mul(mix(float(1), float(-1), r.mod(float(2))));
        const tilt = r.div(rings).mul(3.14159 * 0.5);
        const angle = j.div(perRing).mul(6.2831853).add(time.mul(speed));
        const x = cos(angle).mul(radius);
        const y0 = sin(angle).mul(radius);
        target.assign(vec3(x, y0.mul(cos(tilt)), y0.mul(sin(tilt))));

    // 5: breathingSphere — pulsating sphere
    }).ElseIf(patternId.equal(5), () => {
        const r = float(1.5).add(sin(time.mul(1.5)).mul(0.8));
        target.assign(fibSphere(fi, N, r));

    // 6: pendulumWave — animated pendulum strings with bobbing spheres
    }).ElseIf(patternId.equal(6), () => {
        const pendulums = float(20);
        const perP = ceil(N.div(pendulums));
        const p = floor(fi.div(perP)).clamp(0, 19);
        const j = fi.mod(perP);
        const freq = float(0.8).add(p.mul(0.08));
        const angle = sin(time.mul(freq)).mul(1.2);
        const len = float(2.0);
        const px = p.sub(pendulums.mul(0.5)).mul(0.3);
        const bobX = px.add(sin(angle).mul(len));
        const bobY = cos(angle).negate().mul(len);
        const t = j.div(perP);
        const isString = step(t, float(0.3));
        const st = t.div(0.3);
        const strX = px.add(bobX.sub(px).mul(st)).add(hn(fi, 1).mul(0.02));
        const strY = float(1.5).add(bobY.sub(1.5).mul(st));
        const strZ = hn(fi, 2).mul(0.02);
        const bobSp = randSphereSurface(fi, float(0.12), 3);
        target.assign(vec3(
            mix(bobX.add(bobSp.x), strX, isString),
            mix(bobY.add(bobSp.y), strY, isString),
            mix(bobSp.z, strZ, isString)
        ));

    // 7: galaxySpin — animated 3-armed rotating galaxy
    }).ElseIf(patternId.equal(7), () => {
        const arms = float(3); const sc = float(1.6);
        const arm = fi.mod(arms);
        const t = fi.div(N).mul(8);
        const angle = t.add(arm.div(arms).mul(6.2831853)).add(time.mul(0.15));
        const r = sqrt(t).mul(0.45);
        const jx = hn(fi, 1).mul(0.06).mul(sqrt(r.add(0.1)));
        const jy = hn(fi, 2).mul(0.06).mul(sqrt(r.add(0.1)));
        target.assign(vec3(
            cos(angle).mul(r).add(jx).mul(sc),
            hn(fi, 3).mul(0.1),
            sin(angle).mul(r).add(jy).mul(sc)
        ));

    // 8: vortexDrain — spiraling drain vortex
    }).ElseIf(patternId.equal(8), () => {
        const t = fi.div(N);
        const baseR = float(0.3).add(t.mul(2.5));
        const speed = float(2.0).div(baseR.add(0.3));
        const angle = t.mul(37.699).add(time.mul(speed));
        const y = t.negate().mul(2).add(1).add(sin(time.mul(0.5)).mul(0.3));
        target.assign(vec3(cos(angle).mul(baseR), y, sin(angle).mul(baseR)));

    // 9: ripplePool — animated multi-source ripple interference
    }).ElseIf(patternId.equal(9), () => {
        const side = sideF;
        const x = fi.mod(side).sub(side.mul(0.5)).div(side).mul(6);
        const z = floor(fi.div(side)).sub(side.mul(0.5)).div(side).mul(6);
        const s1x = sin(time.mul(0.3)).mul(1.5);
        const s1z = cos(time.mul(0.4)).mul(1.5);
        const s2x = cos(time.mul(0.5)).mul(1.5);
        const s2z = sin(time.mul(0.6)).mul(1.5);
        const d1 = sqrt(x.sub(s1x).mul(x.sub(s1x)).add(z.sub(s1z).mul(z.sub(s1z))));
        const d2 = sqrt(x.sub(s2x).mul(x.sub(s2x)).add(z.sub(s2z).mul(z.sub(s2z))));
        const d3 = sqrt(x.mul(x).add(z.mul(z)));
        const y = sin(d1.mul(3).sub(time.mul(4))).mul(0.2).div(d1.add(0.5))
            .add(sin(d2.mul(3).sub(time.mul(4))).mul(0.2).div(d2.add(0.5)))
            .add(sin(d3.mul(3).sub(time.mul(4))).mul(0.2).div(d3.add(0.5)));
        target.assign(vec3(x, y, z));

    // 10: flowField — animated 3D sine flow field
    }).ElseIf(patternId.equal(10), () => {
        const a = fi.mul(0.001).add(17);
        const startX = sin(a).mul(2.5);
        const startY = sin(a.mul(1.3).add(14)).mul(2.5);
        const startZ = sin(a.mul(1.7).add(30)).mul(1.5);
        const flowT = fi.div(N).add(time.mul(0.1)).mod(float(1.0));
        target.assign(vec3(
            startX.add(sin(startY.mul(2).add(time.mul(0.5))).mul(flowT).mul(2)),
            startY.add(sin(startX.mul(2).add(time.mul(0.3)).add(1.5708)).mul(flowT).mul(1.5)),
            startZ.add(sin(time.mul(0.4).add(startX)).mul(flowT))
        ));

    // 11: auroraCurtain — animated aurora borealis curtain
    }).ElseIf(patternId.equal(11), () => {
        const t = fi.div(N);
        const curtainX = t.mul(6).sub(3);
        const waveY = sin(curtainX.mul(1.5).add(time.mul(0.4))).mul(0.3);
        const curtainH = h(fi, 1).mul(2.5).add(0.5);
        const sway = sin(time.mul(0.6).add(curtainX.mul(0.8))).mul(0.3);
        const fold = sin(curtainX.mul(3).sub(time.mul(0.7))).mul(0.2);
        const shimmer = sin(time.mul(3).add(fi.mul(0.01))).mul(0.03);
        const py = curtainH.add(waveY).add(shimmer);
        const pz = fold.add(sway).add(sin(curtainH.mul(2).sub(time)).mul(0.1));
        target.assign(vec3(curtainX.mul(0.5), py, pz));

    // 12: perlinFlow3d — animated 3D Perlin-like noise flow field
    }).ElseIf(patternId.equal(12), () => {
        const baseP = randSphere(fi, float(2.5), 1);
        const freq = float(1.5);
        const flowX = sin(baseP.y.mul(freq).add(time.mul(0.5))).mul(cos(baseP.z.mul(freq).sub(time.mul(0.3))));
        const flowY = sin(baseP.z.mul(freq).add(time.mul(0.4))).mul(cos(baseP.x.mul(freq).sub(time.mul(0.2))));
        const flowZ = sin(baseP.x.mul(freq).add(time.mul(0.3))).mul(cos(baseP.y.mul(freq).sub(time.mul(0.4))));
        const amplitude = float(0.6);
        target.assign(vec3(
            baseP.x.add(flowX.mul(amplitude)),
            baseP.y.add(flowY.mul(amplitude)),
            baseP.z.add(flowZ.mul(amplitude))
        ));

    // 13: flowingSilk — static flowing silk fabric drape
    }).ElseIf(patternId.equal(13), () => {
        const side = sideF;
        const ix = fi.mod(side).div(side).sub(0.5).mul(5);
        const iz = floor(fi.div(side)).div(side).sub(0.5).mul(4);
        const drape1 = sin(ix.mul(1.5)).mul(0.4);
        const drape2 = cos(iz.mul(2)).mul(0.2);
        const fold = sin(ix.mul(4).add(iz.mul(3))).mul(0.1);
        target.assign(vec3(ix.mul(0.4), drape1.add(drape2).add(fold), iz.mul(0.5)));
    });
}
