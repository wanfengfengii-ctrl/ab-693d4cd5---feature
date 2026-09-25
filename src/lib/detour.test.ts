import { describe, expect, it } from "vitest";
import {
  minAngularSeparationOnShortArc,
  radecToUnitVector,
} from "./geometry";
import { applyDetourToState, planDetour } from "./detour";
import { auditPlan } from "./planner";
import type { PlannerFormState } from "./validation";

function makeState(
  keyframes: Array<[number, number, number]>, // [t, ra, deg]
  bodies: Array<[string, number, number]>,
  approved: Array<[string, number, number]>,
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
    approvedPoints: approved.map(([name, ra, dec]) => ({
      name,
      ra: String(ra),
      dec: String(dec),
    })),
  };
}

/** 已通过审核的 AuditResult（测试辅助）。 */
function audited(state: PlannerFormState) {
  const r = auditPlan(state, {
    skipKeyframeCount: state.keyframes.length > 8,
  });
  if (!r.ok) throw new Error("测试前置：审核输入不合法");
  return r;
}

describe("planDetour：审核通过的计划无需绕行", () => {
  it("0 个新增点、保持直连、角度增量为 0", () => {
    const st = makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
      ],
      [["太阳", 200, 0]],
      [["P", 45, 20]],
      15,
    );
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.insertedCount).toBe(0);
    expect(d.addedAngleDeg).toBeCloseTo(0, 9);
    expect(d.segments).toHaveLength(1);
    expect(d.segments[0].approvedIndices).toEqual([]);
    expect(d.segments[0].subArcs).toHaveLength(1);
    expect(d.segments[0].subArcs[0].to.kind).toBe("keyframe");
  });
});

describe("planDetour：单段单批准点绕行", () => {
  const baseKeyframes: Array<[number, number, number]> = [
    [0, 0, 0],
    [200, 90, 0],
  ];
  const body: Array<[string, number, number]> = [["太阳", 45, 0]];

  it("用一个批准点拆成两条安全子弧，角度与时刻正确", () => {
    const st = makeState(baseKeyframes, body, [["P北", 45, 20]], 15);
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    expect(d.insertedCount).toBe(1);
    expect(d.usedApprovedIndices).toEqual([0]);
    const seg = d.segments[0];
    expect(seg.approvedIndices).toEqual([0]);
    expect(seg.subArcs).toHaveLength(2);

    const [a1, a2] = seg.subArcs;
    expect(a1.from.kind).toBe("keyframe");
    expect(a1.to.kind).toBe("approved");
    expect(a1.to.name).toBe("P北");
    expect(a2.from.name).toBe("P北");
    expect(a2.to.kind).toBe("keyframe");
    // 45° 纬向对称：两条子弧角相等（≈48.359°），均明显大于 15° 禁入角
    expect(a1.angleDeg).toBeCloseTo(48.358857, 5);
    expect(a2.angleDeg).toBeCloseTo(48.358857, 5);
    expect(d.originalAngleDeg).toBeCloseTo(90, 9);
    expect(d.addedAngleDeg).toBeCloseTo(6.717713, 5);

    // 新增时刻严格落在原时段内，按弧长比例（等弧 ⇒ 中点 t=100）
    expect(a1.startTime).toBe(0);
    expect(a1.endTime).toBeCloseTo(100, 9);
    expect(a2.startTime).toBeCloseTo(100, 9);
    expect(a2.endTime).toBe(200);
    expect(a1.duration + a2.duration).toBeCloseTo(200, 9);
  });

  it("同角度方案按候选录入顺序稳定确定（南北对称二选一）", () => {
    const stNorthFirst = makeState(
      baseKeyframes,
      body,
      [
        ["P北", 45, 20],
        ["P南", 45, -20],
      ],
      15,
    );
    const d1 = planDetour(stNorthFirst, audited(stNorthFirst));
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    expect(d1.segments[0].approvedIndices).toEqual([0]);
    expect(d1.addedAngleDeg).toBeCloseTo(6.717713, 5);

    const stSouthFirst = makeState(
      baseKeyframes,
      body,
      [
        ["P南", 45, -20],
        ["P北", 45, 20],
      ],
      15,
    );
    const d2 = planDetour(stSouthFirst, audited(stSouthFirst));
    expect(d2.ok).toBe(true);
    if (!d2.ok) return;
    // 录入顺序调换后，同角度方案稳定地改取排在前面的「P南」
    expect(d2.segments[0].approvedIndices).toEqual([0]);
    expect(d2.segments[0].subArcs[0].to.name).toBe("P南");
    expect(d2.addedAngleDeg).toBeCloseTo(d1.addedAngleDeg, 9);
  });

  it("每条新子弧都按连续禁入判定独立校核通过（贴边放行）", () => {
    const st = makeState(baseKeyframes, body, [["P北", 45, 20]], 15);
    const d = planDetour(st, audited(st));
    if (!d.ok) throw new Error("should be ok");
    const arcEndpoints: Array<[number, number]> = [
      [0, 0],
      [45, 20],
      [90, 0],
    ];
    for (let i = 0; i + 1 < arcEndpoints.length; i++) {
      const min = toDegreesSafe(arcEndpoints[i], arcEndpoints[i + 1], [45, 0]);
      expect(min).toBeGreaterThanOrEqual(15 - 1e-9);
    }
    // 写回后重新审核必须通过
    const written = applyDetourToState(st, d);
    const re = auditPlan(written);
    expect(re.ok).toBe(true);
  });
});

function toDegreesSafe(
  a: [number, number],
  b: [number, number],
  body: [number, number],
): number {
  return (
    minAngularSeparationOnShortArc(
      radecToUnitVector(a[0], a[1]),
      radecToUnitVector(b[0], b[1]),
      radecToUnitVector(body[0], body[1]),
    ).angle *
    (180 / Math.PI)
  );
}

describe("planDetour：无可行路径", () => {
  it("唯一批准点落入禁入区 → 说明原因，且不产出方案", () => {
    const st = makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
      ],
      [["太阳", 45, 0]],
      [["坏点", 45, 0]], // 恰在禁入天体位置
      15,
    );
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toBeTruthy();
    expect(d.reason).toContain("无可行绕行路径");
  });

  it("批准点与关键帧对跖（无唯一最短弧）不可用", () => {
    const st = makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
      ],
      [["太阳", 45, 0]],
      [["对跖点", 180, 0]], // 与起点关键帧对跖
      15,
    );
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toContain("无可行绕行路径");
  });

  it("各段单独都能绕行但同一点无法跨段复用 → 冲突原因", () => {
    // 第 1 段 300°→60° 穿过 (0°,0°)；第 2 段 60°→120° 穿过 (90°,0°)。
    // X(50°,30°) 对两段各自都是安全穿法，但全计划只能用一次。
    const st = makeState(
      [
        [0, 300, 0],
        [100, 60, 0],
        [200, 120, 0],
      ],
      [
        ["B0", 0, 0],
        ["B90", 90, 0],
      ],
      [["X", 50, 30]],
      10,
    );
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toContain("最多使用一次");
  });

  it("批准点录入不合法 → 返回校验错误而非几何结论", () => {
    const st = makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
      ],
      [["太阳", 45, 0]],
      [
        ["", 45, 20],
        ["", 45, -20],
      ],
      15,
    );
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.errors).toBeDefined();
    expect(d.errors!.some((e) => e.message.includes("名称不能为空"))).toBe(
      true,
    );
  });
});

describe("planDetour：全局联合优化（非逐段贪心）", () => {
  // 两段计划、两个禁入天体（第 1 段穿 (0°,0°)，第 2 段穿 (90°,0°)）。
  //   X(50°,30°)：两段都能绕，但给第 2 段带来约 44° 增量；
  //   Y(290°,-14°)：只能绕第 1 段（增量约 25.7°），无法服务第 2 段。
  // 逐段贪心会在第 1 段选 X（增量更小），导致第 2 段无点可用；
  // 全局最优是 第 1 段用 Y、第 2 段用 X（共 2 点，增量约 69.98°）。
  const st = makeState(
    [
      [0, 300, 0],
      [100, 60, 0],
      [200, 120, 0],
    ],
    [
      ["B0", 0, 0],
      ["B90", 90, 0],
    ],
    [
      ["X", 50, 30],
      ["Y", 290, -14],
    ],
    10,
  );

  it("跨段分配两个互异批准点，角度增量取全局最小", () => {
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.insertedCount).toBe(2);
    expect(d.segments[0].approvedIndices).toEqual([1]); // 第 1 段用 Y
    expect(d.segments[1].approvedIndices).toEqual([0]); // 第 2 段用 X
    expect(d.addedAngleDeg).toBeCloseTo(69.978318, 4);
    // 同一点没有被重复使用
    const flat = d.segments.flatMap((s) => s.approvedIndices);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("对照：只剩 X 时贪心式复用无解；只剩 Y 时第 2 段无法绕行", () => {
    const onlyX: PlannerFormState = {
      ...st,
      approvedPoints: st.approvedPoints.slice(0, 1),
    };
    expect(planDetour(onlyX, audited(onlyX)).ok).toBe(false);
    const onlyY: PlannerFormState = {
      ...st,
      approvedPoints: st.approvedPoints.slice(1),
    };
    expect(planDetour(onlyY, audited(onlyY)).ok).toBe(false);
  });

  it("最少化新增点数优先于角度：已安全的原段保持直连", () => {
    // 第 1 段违规；第 2 段 90°→100° 本身安全（距 45° 天体最近 45°）。
    const st2 = makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
        [200, 100, 0],
      ],
      [["太阳", 45, 0]],
      [
        ["P北", 45, 20],
        ["多余点", 95, 20],
      ],
      15,
    );
    const d = planDetour(st2, audited(st2));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.insertedCount).toBe(1);
    expect(d.segments[0].approvedIndices).toEqual([0]);
    expect(d.segments[1].approvedIndices).toEqual([]);
    expect(d.segments[1].subArcs).toHaveLength(1);
  });
});

describe("planDetour：单段需要两个批准点的链式绕行", () => {
  // 每个批准点单独使用都无法绕行；P0→P1 链式插入才全程安全。
  const st = makeState(
    [
      [0, 355.603, -73.961],
      [100, 196.678, -33.056],
    ],
    [["禁入体", 266.6, -71.58]],
    [
      ["P0", 10.135, -71.886],
      ["P1", 222.917, 74.047],
      ["P2", 259.546, 0.674],
      ["P3", 283.169, -73.156],
    ],
    22.1006,
  );

  it("新增 2 点、3 条子弧，全部安全通过", () => {
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.insertedCount).toBe(2);
    expect(d.segments[0].approvedIndices).toEqual([0, 1]);
    const arcs = d.segments[0].subArcs;
    expect(arcs).toHaveLength(3);
    expect(arcs.map((a) => a.to.name)).toEqual(["P0", "P1", "关键帧 2"]);

    // 每条子弧相对禁入体的真实最小角距 ≥ 禁入角
    const chainCoords: Array<[number, number]> = [
      [355.603, -73.961], // 关键帧 1
      [196.678, -33.056], // 关键帧 2
      [10.135, -71.886], // P0
      [222.917, 74.047], // P1
      [259.546, 0.674], // P2
      [283.169, -73.156], // P3
    ];
    const endpointVec = (e: {
      kind: string;
      index: number;
    }) => {
      const ci =
        e.kind === "keyframe" ? e.index : 2 + e.index;
      return radecToUnitVector(chainCoords[ci][0], chainCoords[ci][1]);
    };
    for (const a of arcs) {
      const p = endpointVec(a.from);
      const q = endpointVec(a.to);
      const b = radecToUnitVector(266.6, -71.58);
      const minDeg =
        (minAngularSeparationOnShortArc(p, q, b).angle * 180) / Math.PI;
      expect(minDeg).toBeGreaterThanOrEqual(22.1006 - 1e-7);
    }

    // 时刻严格递增且严格落在原时段 [0,100] 内（末弧对齐 100）
    expect(arcs[0].startTime).toBe(0);
    expect(arcs[0].endTime).toBeGreaterThan(0);
    expect(arcs[0].endTime).toBeLessThan(100);
    expect(arcs[1].endTime).toBeGreaterThan(arcs[0].endTime);
    expect(arcs[1].endTime).toBeLessThan(100);
    expect(arcs[2].endTime).toBe(100);

    // 按子弧长度（角度）比例分配：P0 时刻 ≈ 1.668 秒
    expect(arcs[0].endTime).toBeCloseTo(1.6677, 2);
    const angles = arcs.map((a) => a.angleDeg);
    const sum = angles.reduce((x, y) => x + y, 0);
    expect(arcs[0].endTime).toBeCloseTo((angles[0] / sum) * 100, 6);
    expect(arcs[0].duration + arcs[1].duration + arcs[2].duration).toBeCloseTo(
      100,
      9,
    );
  });

  it("四个点分别单独使用时均无可行路径", () => {
    for (let i = 0; i < 4; i++) {
      const one: PlannerFormState = {
        ...st,
        approvedPoints: st.approvedPoints.slice(i, i + 1),
      };
      expect(planDetour(one, audited(one)).ok).toBe(false);
    }
  });
});

describe("applyDetourToState：一键写回", () => {
  const st = makeState(
    [
      [0, 300, 0],
      [100, 60, 0],
      [200, 120, 0],
    ],
    [
      ["B0", 0, 0],
      ["B90", 90, 0],
    ],
    [
      ["X", 50, 30],
      ["Y", 290, -14],
    ],
    10,
  );

  it("保留全部原关键帧顺序，按插入位置与分配时刻写入新帧", () => {
    const d = planDetour(st, audited(st));
    if (!d.ok) throw new Error("should be ok");
    const next = applyDetourToState(st, d);

    expect(next.keyframes).toHaveLength(5); // 3 原帧 + 2 插入
    // 原关键帧坐标与时刻原样保留且相对顺序不变
    expect(next.keyframes[0]).toMatchObject({ time: "0", ra: "300", dec: "0" });
    expect(next.keyframes[2]).toMatchObject({ time: "100", ra: "60", dec: "0" });
    expect(next.keyframes[4]).toMatchObject({ time: "200", ra: "120", dec: "0" });
    // 第 1 段插入 Y（分配时刻 ≈ 11.77），第 2 段插入 X（≈ 130.19）
    expect(next.keyframes[1]).toMatchObject({ ra: "290", dec: "-14" });
    expect(Number(next.keyframes[1].time)).toBeCloseTo(11.7656, 3);
    expect(next.keyframes[3]).toMatchObject({ ra: "50", dec: "30" });
    expect(Number(next.keyframes[3].time)).toBeCloseTo(130.193, 2);

    // 时刻整体严格递增
    for (let i = 1; i < next.keyframes.length; i++) {
      expect(Number(next.keyframes[i].time)).toBeGreaterThan(
        Number(next.keyframes[i - 1].time),
      );
    }
    // 禁入规则保留；批准点清空（已成为关键帧）
    expect(next.bodies).toHaveLength(2);
    expect(next.exclusionAngle).toBe("10");
    expect(next.approvedPoints).toEqual([]);

    // 写回后立即重新审核通过（允许 >8 帧的写回计划走扩展数量上限）
    const re = auditPlan(next, {
      skipKeyframeCount: next.keyframes.length > 8,
    });
    expect(re.ok).toBe(true);
  });

  it("不就地修改原草稿", () => {
    const d = planDetour(st, audited(st));
    if (!d.ok) throw new Error("should be ok");
    const before = JSON.stringify(st);
    applyDetourToState(st, d);
    expect(JSON.stringify(st)).toBe(before);
  });
});

describe("planDetour：几何退化防御", () => {
  it("批准点与关键帧重合（θ≈0）不构成可行转折，跳过该点", () => {
    const st = makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
      ],
      [["太阳", 45, 0]],
      [
        ["重合点", 0, 0], // 与起点重合
        ["P北", 45, 20],
      ],
      15,
    );
    const d = planDetour(st, audited(st));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.segments[0].approvedIndices).toEqual([1]);
  });
});
