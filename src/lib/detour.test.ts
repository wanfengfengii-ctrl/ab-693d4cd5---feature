import { describe, expect, it } from "vitest";
import {
  angularSeparation,
  minAngularSeparationOnShortArc,
  radecToUnitVector,
  toDegrees,
  toRadians,
  type Vec3,
} from "./geometry";
import { auditPlan } from "./planner";
import {
  buildDetourKeyframes,
  planDetour,
  type DetourSuccess,
} from "./detour";
import { validateForm, validateWaypoints, type PlannerFormState, type WaypointInput } from "./validation";

function makeState(
  keyframes: Array<[number, number, number]>,
  bodies: Array<[string, number, number]>,
  exclusion = 15,
): PlannerFormState {
  return {
    keyframes: keyframes.map(([time, ra, dec]) => ({
      time: String(time),
      ra: String(ra),
      dec: String(dec),
    })),
    exclusionAngle: String(exclusion),
    bodies: bodies.map(([name, ra, dec]) => ({
      name,
      ra: String(ra),
      dec: String(dec),
    })),
  };
}

function makeWaypoints(wps: Array<[string, number, number]>): WaypointInput[] {
  return wps.map(([name, ra, dec]) => ({ name, ra: String(ra), dec: String(dec) }));
}

function auditOf(state: PlannerFormState) {
  const r = auditPlan(state);
  if (!r.ok) throw new Error("test fixture audit failed");
  return r;
}

function assertTimesAndGeometry(
  state: PlannerFormState,
  detour: DetourSuccess,
) {
  const excl = Number(state.exclusionAngle);
  for (const seg of detour.segments) {
    const start = Number(state.keyframes[seg.segmentIndex].time);
    const end = Number(state.keyframes[seg.segmentIndex + 1].time);
    const total = seg.subArcs.reduce((s, a) => s + a.angleDeg, 0);
    expect(total).toBeGreaterThan(0);
    // 子弧角之和与 newAngleDeg 一致
    expect(total).toBeCloseTo(seg.newAngleDeg, 9);
    // 新增角非负（球面三角不等式）
    expect(seg.addedAngleDeg).toBeGreaterThanOrEqual(-1e-9);

    let cumulative = 0;
    let k = 0;
    for (const sub of seg.subArcs) {
      cumulative += sub.angleDeg;
      // 每条子弧独立复核：逐天体解析最小角距均不得小于禁入角
      const pa = radecFromRef(state, detour, sub.from);
      const pb = radecFromRef(state, detour, sub.to);
      for (const body of state.bodies) {
        const { angle } = minAngularSeparationOnShortArc(
          radecToUnitVector(Number(pa.ra), Number(pa.dec)),
          radecToUnitVector(Number(pb.ra), Number(pb.dec)),
          radecToUnitVector(Number(body.ra), Number(body.dec)),
        );
        expect(toDegrees(angle)).toBeGreaterThanOrEqual(excl - 1e-9);
      }
      if (sub.to.kind === "waypoint") {
        const ins = seg.inserted[k];
        k += 1;
        // 新增时刻严格落在原段时段之内
        expect(ins.time).toBeGreaterThan(start);
        expect(ins.time).toBeLessThan(end);
        // 时刻严格按子弧长度比例分配
        const fraction = cumulative / total;
        expect(ins.time).toBeCloseTo(start + fraction * (end - start), 9);
        expect(ins.arcFraction).toBeCloseTo(fraction, 12);
        expect(ins.arcFraction).toBeGreaterThan(0);
        expect(ins.arcFraction).toBeLessThan(1);
      }
    }
  }

  // 每个批准点全程最多使用一次
  const used = detour.segments.flatMap((s) => s.inserted.map((p) => p.index));
  expect(new Set(used).size).toBe(used.length);

  // 总新增角 = 各段新增角之和
  const sumAdded = detour.segments.reduce((s, x) => s + x.addedAngleDeg, 0);
  expect(sumAdded).toBeCloseTo(detour.totalAddedAngleDeg, 9);
  expect(detour.totalInserted).toBe(used.length);
}

/** 从节点引用解析出对应的赤经赤纬（关键帧取自草稿，批准点取自结果）。 */
function radecFromRef(
  state: PlannerFormState,
  detour: DetourSuccess,
  ref: { kind: string; index: number },
): { ra: string; dec: string } {
  if (ref.kind === "keyframe") {
    return {
      ra: state.keyframes[ref.index].ra,
      dec: state.keyframes[ref.index].dec,
    };
  }
  const w = detour.waypoints[ref.index];
  return { ra: String(w.raDeg), dec: String(w.decDeg) };
}

describe("planDetour：单段绕行", () => {
  it("短弧扫过太阳：北侧批准点给出单点绕行，时刻按弧长比例落于原时段内", () => {
    // 赤道弧 0°→120° 穿过太阳 (60°,0°)；批准点 (60°,60°) 从北侧绕行。
    const state = makeState(
      [
        [0, 0, 0],
        [200, 120, 0],
      ],
      [["太阳", 60, 0]],
      15,
    );
    const audit = auditOf(state);
    expect(audit.segments[0].violated).toBe(true);

    const r = planDetour(state, audit, makeWaypoints([["北侧点", 60, 60]]));
    expect(r.feasible).toBe(true);
    if (!r.feasible) throw new Error(r.reasons.join(";"));
    expect(r.totalInserted).toBe(1);
    const seg = r.segments[0];
    expect(seg.inserted.map((p) => p.name)).toEqual(["北侧点"]);
    expect(seg.subArcs).toHaveLength(2);
    // 两子弧关于 (60°,60°) 对称：cos d = cos0°·cos60°·cos60° = 0.25 → d≈75.5225°
    expect(seg.subArcs[0].angleDeg).toBeCloseTo(75.5225, 3);
    expect(seg.subArcs[1].angleDeg).toBeCloseTo(75.5225, 3);
    expect(seg.originalAngleDeg).toBeCloseTo(120, 9);
    expect(seg.inserted[0].time).toBeGreaterThan(0);
    expect(seg.inserted[0].time).toBeLessThan(200);
    assertTimesAndGeometry(state, r);
  });

  it("新增角相同时按录入顺序稳定裁决（取第 1 个对称批准点）", () => {
    const state = makeState(
      [
        [0, 0, 0],
        [200, 120, 0],
      ],
      [["太阳", 60, 0]],
      15,
    );
    const audit = auditOf(state);
    // 北/南两个对称批准点，绕行角完全相同；字典序应取第 1 个。
    const r = planDetour(
      state,
      audit,
      makeWaypoints([
        ["北侧点", 60, 60],
        ["南侧点", 60, -60],
      ]),
    );
    if (!r.feasible) throw new Error(r.reasons.join(";"));
    expect(r.totalInserted).toBe(1);
    expect(r.segments[0].inserted[0].index).toBe(0);
    expect(r.waypoints.map((w) => w.used)).toEqual([true, false]);
  });

  it("批准点自身位于禁入区：无可行路径并说明原因，且不产出建议", () => {
    const state = makeState(
      [
        [0, 0, 0],
        [200, 120, 0],
      ],
      [["太阳", 60, 0]],
      15,
    );
    const r = planDetour(
      state,
      auditOf(state),
      makeWaypoints([["坏点", 60, 5]]), // 距太阳仅 5°
    );
    expect(r.feasible).toBe(false);
    if (r.feasible) throw new Error("should be infeasible");
    expect(r.reasons.join(";")).toContain("第 1 段");
  });

  it("原关键帧自身在禁入区内：明确说明且无解", () => {
    const state = makeState(
      [
        [0, 60, 2],
        [200, 120, 0],
      ],
      [["太阳", 60, 0]],
      15,
    );
    const r = planDetour(state, auditOf(state), makeWaypoints([["北侧点", 60, 60]]));
    expect(r.feasible).toBe(false);
    if (r.feasible) throw new Error("should be infeasible");
    expect(r.reasons.join(";")).toContain("关键帧 1");
  });
});

describe("planDetour：跨段全局互斥（不得逐段贪心）", () => {
  const state = makeState(
    [
      [0, 0, 0],
      [100, 120, 0],
      [200, 240, 0],
    ],
    [
      ["太阳", 60, 0],
      ["月球", 180, 0],
    ],
    15,
  );

  it("只有一个共用批准点时：两段都被迫使用它 → 违反全程一次约束，无解并说明", () => {
    const r = planDetour(
      state,
      auditOf(state),
      makeWaypoints([["共用点", 120, 60]]),
    );
    expect(r.feasible).toBe(false);
    if (r.feasible) throw new Error("should be infeasible");
    const text = r.reasons.join(";");
    expect(text).toContain("共用点");
    expect(text).toContain("最多使用一次");
  });

  it("补充第二个对称批准点：全局解需要 2 个新增点，两段各取其一", () => {
    const r = planDetour(
      state,
      auditOf(state),
      makeWaypoints([
        ["北侧点", 120, 60],
        ["南侧点", 120, -60],
      ]),
    );
    expect(r.feasible).toBe(true);
    if (!r.feasible) throw new Error(r.reasons.join(";"));
    expect(r.totalInserted).toBe(2);
    const usedSeg1 = r.segments[0].inserted.map((p) => p.index);
    const usedSeg2 = r.segments[1].inserted.map((p) => p.index);
    expect(usedSeg1).toHaveLength(1);
    expect(usedSeg2).toHaveLength(1);
    expect(usedSeg1[0]).not.toBe(usedSeg2[0]);
    assertTimesAndGeometry(state, r);
  });

  it("写回关键帧后保留原顺序、时刻严格递增，重新审核通过", () => {
    const r = planDetour(
      state,
      auditOf(state),
      makeWaypoints([
        ["北侧点", 120, 60],
        ["南侧点", 120, -60],
      ]),
    );
    if (!r.feasible) throw new Error(r.reasons.join(";"));
    const next = buildDetourKeyframes(state, r);
    // 原 3 个关键帧 + 2 个插入点
    expect(next).toHaveLength(5);
    // 原首末关键帧坐标原样保留
    expect(next[0]).toMatchObject({ time: "0", ra: "0", dec: "0" });
    expect(next[4]).toMatchObject({ time: "200", ra: "240", dec: "0" });
    const written: PlannerFormState = {
      keyframes: next,
      exclusionAngle: state.exclusionAngle,
      bodies: state.bodies,
    };
    expect(validateForm(written)).toHaveLength(0);
    const re = auditPlan(written);
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.segments.every((s) => !s.violated)).toBe(true);
    const times = next.map((k) => Number(k.time));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });
});

describe("planDetour：批准点输入校验", () => {
  it("重名、空名称、坐标越界均被拒绝并逐行报告", () => {
    const wps = makeWaypoints([
      ["北侧点", 60, 60],
      ["北侧点", 70, 50], // 重名
      ["", 0, 0], // 空名
      ["越界", 360, 91], // 坐标越界
    ]);
    const errs = validateWaypoints(wps);
    const text = errs.map((e) => e.message).join("|");
    expect(text).toContain("重复");
    expect(text).toContain("不能为空");
    expect(text).toContain("赤经");
    expect(text).toContain("赤纬");
    // planDetour 直接返回这些错误，不给几何结论
    const state = makeState(
      [
        [0, 0, 0],
        [100, 120, 0],
      ],
      [["太阳", 60, 0]],
    );
    const r = planDetour(state, auditOf(state), wps);
    expect(r.feasible).toBe(false);
  });

  it("0 个或 9 个批准点超出 1–8 限制", () => {
    expect(validateWaypoints([]).some((e) => e.message.includes("至少"))).toBe(true);
    const nine = makeWaypoints(
      Array.from({ length: 9 }, (_, i) => [`P${i}`, i * 10, 0] as [string, number, number]),
    );
    expect(validateWaypoints(nine).some((e) => e.message.includes("不得超过 8"))).toBe(true);
  });
});

// ---- 随机小规模场景：独立穷举全部可行插入序列，与 DP 结果交叉验证 ----

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lexPerms(a: number[][], b: number[][]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? [];
    const y = b[i] ?? [];
    const m = Math.min(x.length, y.length);
    for (let j = 0; j < m; j++) {
      if (x[j] !== y[j]) return x[j] < y[j] ? -1 : 1;
    }
    if (x.length !== y.length) return x.length - y.length;
  }
  return 0;
}

describe("planDetour：随机场景与独立穷举一致", () => {
  it("40 个随机 2–3 关键帧 / 3–4 批准点场景：可行性、最优点数与最优新增角一致", () => {
    const rng = mulberry32(20260925);
    let feasibleCount = 0;

    for (let trial = 0; trial < 40; trial++) {
      const kCount = 2 + Math.floor(rng() * 2);
      const ra0 = rng() * 360;
      const keyframes: [number, number, number][] = [];
      let t = 0;
      for (let i = 0; i < kCount; i++) {
        t += 10 + rng() * 90;
        keyframes.push([
          Number(t.toFixed(4)),
          (ra0 + i * (40 + rng() * 80)) % 360,
          -30 + rng() * 60,
        ]);
      }
      const bodies: [string, number, number][] = [
        ["太阳", rng() * 360, -30 + rng() * 60],
      ];
      if (rng() < 0.5) bodies.push(["月球", rng() * 360, -30 + rng() * 60]);
      const state = makeState(keyframes, bodies, 12);
      if (validateForm(state).length > 0) continue;

      const wpCount = 3 + Math.floor(rng() * 2);
      const wps = makeWaypoints(
        Array.from({ length: wpCount }, (_, i) => [
          `P${i + 1}`,
          rng() * 360,
          -70 + rng() * 140,
        ]),
      );
      if (validateWaypoints(wps).length > 0) continue;

      const audit = auditOf(state);
      // 绕行只对确有违规段的计划求解；本就安全的计划直接跳过。
      if (audit.segments.every((s) => !s.violated)) continue;
      const result = planDetour(state, audit, wps);

      // 独立穷举：逐段 DFS 全部可行排列，再做跨段不相交组合。
      const kfPts = keyframes.map(([, ra, dec]) => radecToUnitVector(ra, dec));
      const wpPts = wps.map((w) => radecToUnitVector(Number(w.ra), Number(w.dec)));
      const bodyPts = bodies.map(([, ra, dec]) => radecToUnitVector(ra, dec));
      const excl = toRadians(12);

      const safeEdge = (a: Vec3, b: Vec3): boolean => {
        const sep = angularSeparation(a, b);
        if (sep <= toRadians(1e-6) || sep >= Math.PI - toRadians(1e-6)) return false;
        return bodyPts.every(
          (bp) => minAngularSeparationOnShortArc(a, b, bp).angle >= excl - 1e-12,
        );
      };

      interface BruteRoute {
        perm: number[];
        mask: number;
        added: number;
      }
      const perSeg: BruteRoute[][] = [];
      let dead = false;
      for (let s = 0; s < kCount - 1; s++) {
        const nodes: Vec3[] = [kfPts[s], kfPts[s + 1], ...wpPts];
        const original = toDegrees(angularSeparation(nodes[0], nodes[1]));
        const found: BruteRoute[] = [];
        const dfs = (node: number, mask: number, perm: number[], ang: number[]) => {
          if (safeEdge(nodes[node], nodes[1])) {
            const allAng = [...ang, toDegrees(angularSeparation(nodes[node], nodes[1]))];
            found.push({
              perm,
              mask,
              added: allAng.reduce((x, y) => x + y, 0) - original,
            });
          }
          for (let i = 0; i < wpCount; i++) {
            if (mask & (1 << i)) continue;
            const ni = i + 2;
            if (!safeEdge(nodes[node], nodes[ni])) continue;
            dfs(ni, mask | (1 << i), [...perm, i], [
              ...ang,
              toDegrees(angularSeparation(nodes[node], nodes[ni])),
            ]);
          }
        };
        dfs(0, 0, [], []);
        if (found.length === 0) {
          dead = true;
          break;
        }
        perSeg.push(found);
      }

      if (dead) {
        expect(result.feasible).toBe(false);
        continue;
      }

      // 跨段组合，按 (点数, 新增角, 逐段排列字典序) 取全局最优。
      const all: Array<{ count: number; added: number; perms: number[][] }> = [];
      const combine = (s: number, used: number, added: number, perms: number[][]) => {
        if (s === perSeg.length) {
          all.push({
            count: perms.reduce((n, p) => n + p.length, 0),
            added,
            perms: perms.map((p) => [...p]),
          });
          return;
        }
        for (const route of perSeg[s]) {
          if (used & route.mask) continue;
          combine(s + 1, used | route.mask, added + route.added, [...perms, route.perm]);
        }
      };
      combine(0, 0, 0, []);

      if (all.length === 0) {
        expect(result.feasible).toBe(false);
        continue;
      }
      const best = all.reduce((a, b) => {
        if (b.count !== a.count) return b.count < a.count ? b : a;
        if (Math.abs(b.added - a.added) > 1e-9) return b.added < a.added ? b : a;
        return lexPerms(b.perms, a.perms) < 0 ? b : a;
      });
      expect(result.feasible).toBe(true);
      if (!result.feasible) throw new Error(result.reasons.join(";"));
      feasibleCount += 1;
      expect(result.totalInserted).toBe(best.count);
      expect(result.totalAddedAngleDeg).toBeCloseTo(best.added, 8);
      const gotPerms = result.segments.map((s) => s.inserted.map((p) => p.index));
      expect(gotPerms).toEqual(best.perms);
      assertTimesAndGeometry(state, result);
    }

    // 确保随机用例确实覆盖到了可行与不可行两类情形。
    expect(feasibleCount).toBeGreaterThan(0);
  });
});
