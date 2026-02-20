/**
 * Flow Pattern Generators — CPU-side particle target positions
 *
 * Each generator: (ta: Float32Array, N: number) => void
 *   ta = target buffer (N*3 floats, xyz interleaved)
 *
 * Patterns fall into two categories:
 *   1. CPU-only patterns (fractal/recursive algorithms that need sequential state)
 *   2. GPU fallback stubs — initial-frame snapshots for patterns that are
 *      normally computed on GPU via gpuFlowPatterns.js
 *
 * Animated patterns also have a corresponding FLOW_PATTERN_ANIMATORS entry
 * that takes an additional `time` parameter for CPU-side animation fallback.
 */

// ========================================
// CPU-only static patterns
// ========================================

export const FLOW_PATTERN_GENERATORS = {

    // Soft random sphere volume — the default "no shape" state
    organic: (ta, N) => {
        for (let i = 0; i < N; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = Math.cbrt(Math.random()) * 3.5;
            ta[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
            ta[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * r;
            ta[i * 3 + 2] = Math.cos(phi) * r;
        }
    },

    // Recursive 3D tree with branching
    branchTree: (ta, N) => {
        const sc = 1.5;
        for (let i = 0; i < N; i++) {
            const t = i / N;
            const depth = Math.floor(t * 6);
            const branch = Math.floor(Math.random() * Math.pow(2, depth));
            let angle = 0;
            let x = 0, z = 0;
            let y = -1.5;
            let len = 1.0;
            for (let d = 0; d < depth; d++) {
                const dir = ((branch >> d) & 1) * 2 - 1;
                angle += dir * 0.4 + (Math.random() - 0.5) * 0.2;
                x += Math.sin(angle) * len;
                y += len * 0.5;
                z += Math.cos(angle * 0.7) * len * 0.3;
                len *= 0.7;
            }
            const segT = t * 6 - depth;
            ta[i * 3] = (x + Math.sin(angle) * segT * len + (Math.random() - 0.5) * 0.1) * sc;
            ta[i * 3 + 1] = (y + segT * len * 0.5) * sc;
            ta[i * 3 + 2] = (z + (Math.random() - 0.5) * 0.15) * sc;
        }
    },

    // 3D fractal tree with recursive branch generation
    fractalTree: (ta, N) => {
        const sc = 1.0;
        const branches = [];
        const gen = (x, y, z, angle, angleZ, len, depth) => {
            if (depth > 7 || branches.length > 5000) return;
            const ex = x + Math.cos(angle) * Math.cos(angleZ) * len;
            const ey = y + Math.sin(angleZ) * len;
            const ez = z + Math.sin(angle) * Math.cos(angleZ) * len;
            branches.push({ x, y, z, ex, ey, ez });
            if (depth < 7) {
                const nl = len * 0.67;
                gen(ex, ey, ez, angle + 0.5, angleZ + 0.3, nl, depth + 1);
                gen(ex, ey, ez, angle - 0.5, angleZ + 0.2, nl, depth + 1);
                gen(ex, ey, ez, angle + 0.2, angleZ - 0.1, nl, depth + 1);
            }
        };
        gen(0, -2, 0, 0, Math.PI / 2, 1.0, 0);
        for (let i = 0; i < N; i++) {
            const b = branches[i % branches.length];
            const t = Math.random();
            ta[i * 3] = (b.x + (b.ex - b.x) * t + (Math.random() - 0.5) * 0.04) * sc;
            ta[i * 3 + 1] = (b.y + (b.ey - b.y) * t + (Math.random() - 0.5) * 0.04) * sc;
            ta[i * 3 + 2] = (b.z + (b.ez - b.z) * t + (Math.random() - 0.5) * 0.04) * sc;
        }
    },

    // Koch snowflake — 2D fractal curve with slight 3D depth
    kochCurve: (ta, N) => {
        const sc = 2.0;
        const points = [];
        const koch = (x1, y1, x2, y2, depth) => {
            if (depth === 0) {
                points.push([x1, y1, x2, y2]);
                return;
            }
            const dx = x2 - x1, dy = y2 - y1;
            const ax = x1 + dx / 3, ay = y1 + dy / 3;
            const bx = x1 + dx * 2 / 3, by = y1 + dy * 2 / 3;
            const px = (ax + bx) / 2 - (by - ay) * 0.866;
            const py = (ay + by) / 2 + (bx - ax) * 0.866;
            koch(x1, y1, ax, ay, depth - 1);
            koch(ax, ay, px, py, depth - 1);
            koch(px, py, bx, by, depth - 1);
            koch(bx, by, x2, y2, depth - 1);
        };
        const s = 1.0;
        koch(-s, -s * 0.577, s, -s * 0.577, 4);
        koch(s, -s * 0.577, 0, s * 1.155, 4);
        koch(0, s * 1.155, -s, -s * 0.577, 4);
        for (let i = 0; i < N; i++) {
            const seg = points[i % points.length];
            const t = Math.random();
            ta[i * 3] = (seg[0] + (seg[2] - seg[0]) * t) * sc;
            ta[i * 3 + 1] = (seg[1] + (seg[3] - seg[1]) * t) * sc;
            ta[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
        }
    },

    // Multiple independent random walks diverging from the origin
    randomWalk: (ta, N) => {
        const sc = 0.05;
        const walks = 8;
        const perWalk = Math.ceil(N / walks);
        for (let w = 0; w < walks; w++) {
            let x = 0, y = 0, z = 0;
            for (let i = 0; i < perWalk; i++) {
                const idx = w * perWalk + i;
                if (idx >= N) break;
                x += (Math.random() - 0.5) * 2;
                y += (Math.random() - 0.5) * 2;
                z += (Math.random() - 0.5) * 2;
                ta[idx * 3] = x * sc;
                ta[idx * 3 + 1] = y * sc;
                ta[idx * 3 + 2] = z * sc;
            }
        }
    },

    // ========================================
    // GPU pattern fallback stubs
    // Initial frame (time=0) for patterns normally computed on GPU
    // ========================================

    cubeWave:        (ta, N) => { FLOW_PATTERN_ANIMATORS.cubeWave(ta, N, 0); },
    rollingWave:     (ta, N) => { FLOW_PATTERN_ANIMATORS.rollingWave(ta, N, 0); },
    orbiting:        (ta, N) => { FLOW_PATTERN_ANIMATORS.orbiting(ta, N, 0); },
    breathingSphere: (ta, N) => { FLOW_PATTERN_ANIMATORS.breathingSphere(ta, N, 0); },
    pendulumWave:    (ta, N) => { FLOW_PATTERN_ANIMATORS.pendulumWave(ta, N, 0); },
    galaxySpin:      (ta, N) => { FLOW_PATTERN_ANIMATORS.galaxySpin(ta, N, 0); },
    vortexDrain:     (ta, N) => { FLOW_PATTERN_ANIMATORS.vortexDrain(ta, N, 0); },
    ripplePool:      (ta, N) => { FLOW_PATTERN_ANIMATORS.ripplePool(ta, N, 0); },
    flowField:       (ta, N) => { FLOW_PATTERN_ANIMATORS.flowField(ta, N, 0); },
};


// ========================================
// Animated Flow Patterns (CPU fallback)
// Each: (ta, N, time) => void
// Called periodically (~20fps) to update targets when GPU is unavailable
// ========================================

export const FLOW_PATTERN_ANIMATORS = {

    // Cubes pop in/out sequentially from left to right
    cubeWave: (ta, N, time) => {
        const cubes = 10;
        const cubeSize = 0.5;
        const spacing = 1.0;
        const cycleTime = 3.0;
        const perCube = Math.ceil(N / cubes);
        for (let c = 0; c < cubes; c++) {
            const cx = (c - cubes / 2) * spacing;
            const delay = c * 0.2;
            const t = ((time - delay) % cycleTime + cycleTime) % cycleTime;
            const active = t < 2.0;
            const scale = active ? (t < 0.5 ? t / 0.5 : (t < 1.5 ? 1.0 : 1.0 - (t - 1.5) / 0.5)) : 0;
            const s = cubeSize * scale;
            for (let j = 0; j < perCube; j++) {
                const idx = c * perCube + j;
                if (idx >= N) break;
                if (s < 0.01) {
                    ta[idx * 3] = cx + (Math.random() - 0.5) * 3;
                    ta[idx * 3 + 1] = (Math.random() - 0.5) * 3;
                    ta[idx * 3 + 2] = (Math.random() - 0.5) * 3;
                } else {
                    ta[idx * 3] = cx + (Math.random() - 0.5) * s;
                    ta[idx * 3 + 1] = (Math.random() - 0.5) * s;
                    ta[idx * 3 + 2] = (Math.random() - 0.5) * s;
                }
            }
        }
    },

    // Height-field surface with a sine wave rolling through
    rollingWave: (ta, N, time) => {
        const side = Math.ceil(Math.sqrt(N));
        const sc = 0.8;
        for (let i = 0; i < N; i++) {
            const x = (i % side - side / 2) / side * 8;
            const z = (Math.floor(i / side) - side / 2) / side * 8;
            const y = Math.sin(x * 1.5 - time * 2.0) * 0.6 +
                      Math.sin(z * 1.2 - time * 1.3) * 0.3;
            ta[i * 3] = x * sc;
            ta[i * 3 + 1] = y * sc;
            ta[i * 3 + 2] = z * sc;
        }
    },

    // Concentric rings rotating at different speeds with alternating direction
    orbiting: (ta, N, time) => {
        const rings = 8;
        const perRing = Math.ceil(N / rings);
        for (let r = 0; r < rings; r++) {
            const radius = 0.5 + r * 0.3;
            const speed = (1.0 + r * 0.3) * (r % 2 === 0 ? 1 : -1);
            const tilt = (r / rings) * Math.PI * 0.5;
            for (let j = 0; j < perRing; j++) {
                const idx = r * perRing + j;
                if (idx >= N) break;
                const angle = (j / perRing) * Math.PI * 2 + time * speed;
                const x = Math.cos(angle) * radius;
                const y0 = Math.sin(angle) * radius;
                ta[idx * 3] = x;
                ta[idx * 3 + 1] = y0 * Math.cos(tilt);
                ta[idx * 3 + 2] = y0 * Math.sin(tilt);
            }
        }
    },

    // Fibonacci sphere that pulses in radius over time
    breathingSphere: (ta, N, time) => {
        const baseR = 1.5;
        const amp = 0.8;
        const r = baseR + Math.sin(time * 1.5) * amp;
        const invN = 1 / N;
        for (let i = 0; i < N; i++) {
            const theta = (i * 2.399963) % 6.2831853;
            const cosTheta = 1 - 2 * i * invN;
            const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
            ta[i * 3] = sinTheta * Math.cos(theta) * r;
            ta[i * 3 + 1] = sinTheta * Math.sin(theta) * r;
            ta[i * 3 + 2] = cosTheta * r;
        }
    },

    // 20 pendulums with varying frequencies creating a wave pattern
    pendulumWave: (ta, N, time) => {
        const pendulums = 20;
        const perP = Math.ceil(N / pendulums);
        for (let p = 0; p < pendulums; p++) {
            const freq = 0.8 + p * 0.08;
            const angle = Math.sin(time * freq) * 1.2;
            const length = 2.0;
            const px = (p - pendulums / 2) * 0.3;
            const bobX = px + Math.sin(angle) * length;
            const bobY = -Math.cos(angle) * length;
            for (let j = 0; j < perP; j++) {
                const idx = p * perP + j;
                if (idx >= N) break;
                const t = j / perP;
                if (t < 0.3) {
                    // String segment
                    const st = t / 0.3;
                    ta[idx * 3] = px + (bobX - px) * st + (Math.random() - 0.5) * 0.02;
                    ta[idx * 3 + 1] = 1.5 + (bobY - 1.5) * st;
                    ta[idx * 3 + 2] = (Math.random() - 0.5) * 0.02;
                } else {
                    // Bob (sphere at tip)
                    const r = 0.12;
                    const theta = Math.random() * Math.PI * 2;
                    const phi = Math.acos(2 * Math.random() - 1);
                    ta[idx * 3] = bobX + Math.sin(phi) * Math.cos(theta) * r;
                    ta[idx * 3 + 1] = bobY + Math.sin(phi) * Math.sin(theta) * r;
                    ta[idx * 3 + 2] = Math.cos(phi) * r;
                }
            }
        }
    },

    // 3-armed rotating galaxy with jitter
    galaxySpin: (ta, N, time) => {
        const arms = 3, sc = 1.6;
        const rotSpeed = 0.15;
        for (let i = 0; i < N; i++) {
            const arm = i % arms;
            const t = (i / N) * 8;
            const angle = t + (arm / arms) * Math.PI * 2 + time * rotSpeed;
            const r = Math.sqrt(t) * 0.45;
            const jx = (Math.random() - 0.5) * 0.06 * Math.sqrt(r + 0.1);
            const jy = (Math.random() - 0.5) * 0.06 * Math.sqrt(r + 0.1);
            ta[i * 3] = (Math.cos(angle) * r + jx) * sc;
            ta[i * 3 + 1] = (Math.random() - 0.5) * 0.1;
            ta[i * 3 + 2] = (Math.sin(angle) * r + jy) * sc;
        }
    },

    // Spiraling drain vortex pulling particles downward
    vortexDrain: (ta, N, time) => {
        for (let i = 0; i < N; i++) {
            const t = i / N;
            const baseR = 0.3 + t * 2.5;
            const speed = 2.0 / (baseR + 0.3);
            const angle = t * Math.PI * 12 + time * speed;
            const r = baseR;
            const y = -t * 2 + 1 + Math.sin(time * 0.5) * 0.3;
            ta[i * 3] = Math.cos(angle) * r;
            ta[i * 3 + 1] = y;
            ta[i * 3 + 2] = Math.sin(angle) * r;
        }
    },

    // Multi-source ripple interference pattern on a water surface
    ripplePool: (ta, N, time) => {
        const sources = 3;
        const sx = [Math.sin(time * 0.3) * 1.5, Math.cos(time * 0.5) * 1.5, 0];
        const sz = [Math.cos(time * 0.4) * 1.5, Math.sin(time * 0.6) * 1.5, 0];
        const side = Math.ceil(Math.sqrt(N));
        for (let i = 0; i < N; i++) {
            const x = (i % side - side / 2) / side * 6;
            const z = (Math.floor(i / side) - side / 2) / side * 6;
            let y = 0;
            for (let s = 0; s < sources; s++) {
                const d = Math.sqrt((x - sx[s]) ** 2 + (z - sz[s]) ** 2);
                y += Math.sin(d * 3 - time * 4) * 0.2 / (d + 0.5);
            }
            ta[i * 3] = x;
            ta[i * 3 + 1] = y;
            ta[i * 3 + 2] = z;
        }
    },

    // 3D vector field streamlines with sine-based flow
    flowField: (ta, N, time) => {
        const t05 = time * 0.5, t03 = time * 0.3, t04 = time * 0.4;
        const t01 = time * 0.1;
        const invN = 1 / N;
        for (let i = 0; i < N; i++) {
            const a = i * 0.001 + 17;
            const startX = Math.sin(a) * 2.5;
            const startY = Math.sin(a * 1.3 + 14) * 2.5;
            const startZ = Math.sin(a * 1.7 + 30) * 1.5;
            const flowT = (i * invN + t01) % 1.0;
            ta[i * 3] = startX + Math.sin(startY * 2 + t05) * flowT * 2;
            ta[i * 3 + 1] = startY + Math.sin(startX * 2 + t03 + 1.5708) * flowT * 1.5;
            ta[i * 3 + 2] = startZ + Math.sin(t04 + startX) * flowT;
        }
    },
};
