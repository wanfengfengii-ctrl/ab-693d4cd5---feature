import { describe, expect, it } from "vitest";
import {
  angularSeparation,
  cross,
  dot,
  minAngularSeparationOnShortArc,
  radecToUnitVector,
  toDegrees,
  toRadians,
  type Vec3,
} from "./geometry";

const approx = (a: number, b: number, eps = 1e-9) =>
  Math.abs(a - b) <= eps;

describe("radecToUnitVector：赤经环绕与极点换算", () => {
  const expectVec = (v: { x: number; y: number; z: number }, ex: number, ey: number, ez: number) => {
    expect(v.x).toBeCloseTo(ex, 12);
    expect(v.y).toBeCloseTo(ey, 12);
    expect(v.z).toBeCloseTo(ez, 12);
  };

  it("四个分点与极点", () => {
    expectVec(radecToUnitVector(0, 0), 1, 0, 0);
    expectVec(radecToUnitVector(90, 0), 0, 1, 0);
    expectVec(radecToUnitVector(180, 0), -1, 0, 0);
    expectVec(radecToUnitVector(270, 0), 0, -1, 0);
  });

  it("RA 环绕：360° 周期、0°/360° 同指向（由三角函数自然处理）", () => {
    const a = radecToUnitVector(359.999, 45);
    const b = radecToUnitVector(-0.001, 45);
    expect(angularSeparation(a, b)).toBeLessThan(toRadians(1e-3 + 1e-6));
    // 输出向量保持单位长度
    for (const v of [a, b]) {
      expect(dot(v, v)).toBeCloseTo(1, 12);
    }
  });

  it("天极附近任意赤经都收敛到天极向量", () => {
    const n1 = radecToUnitVector(0, 90);
    const n2 = radecToUnitVector(233.3, 90);
    expect(approx(n1.x, 0) && approx(n1.y, 0) && approx(n1.z, 1)).toBe(true);
    expect(angularSeparation(n1, n2)).toBeLessThan(1e-12);

    const s = radecToUnitVector(10, -90);
    expect(approx(s.x, 0) && approx(s.y, 0) && approx(s.z, -1)).toBe(true);
  });
});

describe("minAngularSeparationOnShortArc：短弧真实最小角距", () => {
  it("最小值在端点（天体位于起点）", () => {
    const p = radecToUnitVector(0, 0);
    const q = radecToUnitVector(90, 0);
    const b = radecToUnitVector(0, 0);
    const r = minAngularSeparationOnShortArc(p, q, b);
    expect(r.angle).toBeLessThan(1e-12);
    expect(r.t).toBe(0);
  });

  it("最小值在另一端点", () => {
    const p = radecToUnitVector(0, 0);
    const q = radecToUnitVector(90, 0);
    const b = radecToUnitVector(90, 0);
    const r = minAngularSeparationOnShortArc(p, q, b);
    expect(r.angle).toBeLessThan(1e-12);
    expect(r.t).toBe(1);
  });

  it("弧内最近点：赤道短弧，天体在弧中点正北方 10°", () => {
    const p = radecToUnitVector(0, 0);
    const q = radecToUnitVector(90, 0);
    const b = radecToUnitVector(45, 10);
    const r = minAngularSeparationOnShortArc(p, q, b);
    expect(toDegrees(r.angle)).toBeCloseTo(10, 9);
    expect(r.t).toBeCloseTo(0.5, 9);
  });

  it("最近点落在弧外时取端点：弧为 0°→90°，天体在 180°", () => {
    const p = radecToUnitVector(0, 0);
    const q = radecToUnitVector(90, 0);
    const b = radecToUnitVector(180, 0);
    const r = minAngularSeparationOnShortArc(p, q, b);
    expect(toDegrees(r.angle)).toBeCloseTo(90, 9);
    expect(r.t).toBe(1);
  });

  it("跨越 RA=0° 环绕的短弧（350°→10° 走 20° 短弧，而非 340° 长弧）", () => {
    const p = radecToUnitVector(350, 0);
    const q = radecToUnitVector(10, 0);
    // 弧中点为 RA=0°
    const b = radecToUnitVector(0, 5);
    const r = minAngularSeparationOnShortArc(p, q, b);
    expect(toDegrees(r.angle)).toBeCloseTo(5, 9);
    expect(r.t).toBeCloseTo(0.5, 9);
  });

  it("高纬短弧跨天极一侧：北天极在弧中点处最近", () => {
    // 两点 RA 相差 90°、Dec=80°，短弧中点在 RA=0 经圈上最靠北
    const p = radecToUnitVector(45, 80);
    const q = radecToUnitVector(315, 80);
    const pole: Vec3 = { x: 0, y: 0, z: 1 };
    const r = minAngularSeparationOnShortArc(p, q, pole);
    expect(r.t).toBeCloseTo(0.5, 9);
    // 与 100 万点稠密采样交叉核对
    const sampled = denseSampleMin(p, q, pole, 1_000_000);
    expect(toDegrees(r.angle)).toBeLessThanOrEqual(
      toDegrees(sampled) + 1e-7,
    );
  });

  it("随机短弧×随机天体：解析解不劣于百万点稠密采样（连续极值 vs 离散取样）", () => {
    // 固定种子的简易 PRNG，保证可复现。
    let seed = 20260924;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const randomUnit = (): Vec3 => {
      const z = rand() * 2 - 1;
      const phi = rand() * 2 * Math.PI;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
    };

    for (let trial = 0; trial < 200; trial++) {
      const p = randomUnit();
      let q = randomUnit();
      // 避开相同/反向（这两类输入在校验层拒绝）：|p·q|≈1 即共线
      let d = dot(p, q);
      let guard = 0;
      while (Math.abs(d) > 1 - 1e-4 && guard++ < 10) {
        q = randomUnit();
        d = dot(p, q);
      }
      const b = randomUnit();
      const r = minAngularSeparationOnShortArc(p, q, b);
      expect(r.t).toBeGreaterThanOrEqual(0);
      expect(r.t).toBeLessThanOrEqual(1);

      const sampled = denseSampleMin(p, q, b, 200_000);
      // 真实最小角距必须 ≤ 任何离散采样值（允许极小舍入误差）
      expect(r.angle).toBeLessThanOrEqual(sampled + 1e-9);

      // 反向核对：解析最优点重新评估，角度必须自洽
      const point = slerpEval(p, q, r.t);
      const recheck = Math.acos(
        Math.min(1, Math.max(-1, dot(point, b))),
      );
      expect(Math.abs(recheck - r.angle)).toBeLessThan(1e-9);
    }
  });

  it("短弧方向唯一：p、q 不共线时弧平面法线非零", () => {
    const p = radecToUnitVector(12, -34);
    const q = radecToUnitVector(200, 55);
    const n = cross(p, q);
    expect(Math.hypot(n.x, n.y, n.z)).toBeGreaterThan(1e-6);
  });
});

/** 稠密（离散）采样求最小角距——仅作为测试对照，证明解析解严格不劣于取样法。 */
function denseSampleMin(p: Vec3, q: Vec3, b: Vec3, n: number): number {
  let min = Math.PI;
  for (let i = 0; i <= n; i++) {
    const r = slerpEval(p, q, i / n);
    const c = Math.min(1, Math.max(-1, dot(r, b)));
    const a = Math.acos(c);
    if (a < min) min = a;
  }
  return min;
}

function slerpEval(p: Vec3, q: Vec3, t: number): Vec3 {
  const theta = Math.acos(Math.min(1, Math.max(-1, dot(p, q))));
  const s = Math.sin(theta);
  const a = Math.sin((1 - t) * theta) / s;
  const bb = Math.sin(t * theta) / s;
  return {
    x: a * p.x + bb * q.x,
    y: a * p.y + bb * q.y,
    z: a * p.z + bb * q.z,
  };
}
