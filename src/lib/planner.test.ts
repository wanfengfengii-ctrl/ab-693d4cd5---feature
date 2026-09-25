import { describe, expect, it } from "vitest";
import { auditPlan, firstViolation } from "./planner";
import {
  angularSeparation,
  radecToUnitVector,
  toDegrees,
  type Vec3,
} from "./geometry";
import type { PlannerFormState } from "./validation";

function makeState(
  keyframes: Array<[number, number, number]>, // [t, ra, dec]
  bodies: Array<[string, number, number]>, // [name, ra, dec]
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

describe("auditPlan：基本结论", () => {
  it("安全计划可执行，逐段给出端点/弧内最小值与时刻", () => {
    // 短弧 RA 0°→90°，天体在 RA=200°（远离），禁入角 15°
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [100, 90, 0],
      ],
      [["太阳", 200, 0]],
      15,
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(firstViolation(r)).toBeNull();
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0];
    // 距 RA=200° 最近的弧端点是 RA=90°，角距 110°
    expect(seg.minAngleDeg).toBeCloseTo(110, 9);
    expect(seg.perBody[0].t).toBe(1);
    expect(seg.perBody[0].time).toBe(100);
    expect(r.globalMinAngleDeg).toBeCloseTo(110, 9);
  });

  it("弧内扫过天体：仅端点安全不能放行", () => {
    // 弧 RA 350°→10°（跨 0°），天体在 RA=0°,Dec=0° 恰在弧上，
    // 两端点角距均为 10°，但弧中点角距为 0°。禁入角取 5°。
    const r = auditPlan(makeState(
      [
        [0, 350, 0],
        [200, 10, 0],
      ],
      [["太阳", 0, 0]],
      5,
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = firstViolation(r);
    expect(v).not.toBeNull();
    expect(v!.minAngleDeg).toBeCloseTo(0, 9);
    expect(v!.time).toBeCloseTo(100, 9); // 线性插值：弧中点时刻
    expect(v!.t).toBeCloseTo(0.5, 9);
    expect(v!.bodyName).toBe("太阳");
  });

  it("多段：违规段之前的段照常安全，违规在第 2 段", () => {
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [10, 60, 0],
        [20, 120, 0],
      ],
      [["太阳", 90, 0]], // 第 2 段 60→120 穿过天体
      5,
    ));
    if (!r.ok) throw new Error("should be ok");
    expect(r.segments[0].violated).toBe(false);
    expect(r.segments[1].violated).toBe(true);
    const v = firstViolation(r)!;
    expect(v.segmentIndex).toBe(1);
    expect(v.time).toBe(15);
  });
});

describe("auditPlan：首个越界见证的排序", () => {
  it("同一天体在更早段违规 → 报告更早段", () => {
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [10, 90, 0],
        [20, 180, 0],
      ],
      [["太阳", 45, 0]],
      5,
    ));
    if (!r.ok) throw new Error("should be ok");
    expect(firstViolation(r)!.segmentIndex).toBe(0);
  });

  it("同段多天体：按天体输入顺序报告首个", () => {
    // 弧 0°→90°，两个天体都在弧上（45° 与 30°），
    // 角距都为 0；按输入顺序应报告「月球」（第 1 个）。
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [10, 90, 0],
      ],
      [
        ["月球", 30, 0],
        ["太阳", 45, 0],
      ],
      5,
    ));
    if (!r.ok) throw new Error("should be ok");
    const v = firstViolation(r)!;
    expect(v.bodyIndex).toBe(0);
    expect(v.bodyName).toBe("月球");
  });

  it("同段内即使后一个天体角距更小，仍按输入顺序报告首个越界者", () => {
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [10, 90, 0],
      ],
      [
        ["月球", 45, 2], // 最小角距 2°
        ["太阳", 45, 0.5], // 最小角距 0.5°（更近，但排序在后）
      ],
      5,
    ));
    if (!r.ok) throw new Error("should be ok");
    const v = firstViolation(r)!;
    expect(v.bodyName).toBe("月球");
    expect(v.minAngleDeg).toBeCloseTo(2, 9);
  });
});

describe("auditPlan：边界与极点", () => {
  it("角距恰等于禁入角：贴边放行并登记接触点", () => {
    // 弧 0°→90°，天体 (45°, 10°)，最小角距恰为 10°
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [10, 90, 0],
      ],
      [["太阳", 45, 10]],
      10,
    ));
    if (!r.ok) throw new Error("should be ok");
    expect(firstViolation(r)).toBeNull();
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].bodyName).toBe("太阳");
    expect(r.contacts[0].time).toBeCloseTo(5, 9);
  });

  it("跨天极短弧：RA 相差 180° 的两点沿经圈过天极，天极本身位于弧上", () => {
    // 注意纬线不是大圆：(RA=0,Dec=80) → (RA=180,Dec=80) 的大圆弧
    // 恰好沿经圈经过天极，故与天极的真实最小角距为 0°（在弧中点）。
    // 若只比较两端点（各距天极 10°）就会误放行。
    const r = auditPlan(makeState(
      [
        [0, 0, 80],
        [60, 180, 80],
      ],
      [["北极星", 0, 90]],
      15,
    ));
    if (!r.ok) throw new Error("should be ok");
    const v = firstViolation(r)!;
    expect(v.minAngleDeg).toBeCloseTo(0, 9);
    expect(v.t).toBeCloseTo(0.5, 9);
  });

  it("近天极但不穿过的短弧给出非零最小角距，且与稠密采样一致", () => {
    // (45°,80°)→(315°,80°) 的短弧从天极一侧绕过，
    // 弧中点最靠近天极（理论角距约 7.12°）：非零但小于 10° 禁入角。
    const r = auditPlan(makeState(
      [
        [0, 45, 80],
        [60, 315, 80],
      ],
      [["北极星", 0, 90]],
      10,
    ));
    if (!r.ok) throw new Error("should be ok");
    expect(firstViolation(r)).not.toBeNull();
    const min = r.segments[0].perBody[0].minAngleDeg;
    expect(min).toBeCloseTo(7.12, 1);
    expect(r.segments[0].perBody[0].t).toBeCloseTo(0.5, 9);
  });

  it("远离天极的同纬弧不会误报天极（解析极值点落在弧外时取端点）", () => {
    // (RA=0,Dec=0) → (RA=90,Dec=0)，距北极恒为 90°
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [10, 90, 0],
      ],
      [["北极星", 0, 90]],
      15,
    ));
    if (!r.ok) throw new Error("should be ok");
    expect(firstViolation(r)).toBeNull();
    expect(r.segments[0].perBody[0].minAngleDeg).toBeCloseTo(90, 9);
  });
});

describe("auditPlan：时刻插值", () => {
  it("达到最小角距的计划时刻按关键帧时刻线性插值（非均匀时间间隔）", () => {
    const r = auditPlan(makeState(
      [
        [50, 0, 0],
        [250, 90, 0],
      ],
      [["太阳", 45, 0]],
      5,
    ));
    if (!r.ok) throw new Error("should be ok");
    const v = firstViolation(r)!;
    expect(v.time).toBeCloseTo(150, 9);
  });
});

describe("auditPlan：输入不合法时不产生结论", () => {
  it("对跖关键帧 + 重名天体 → 失败并返回错误列表", () => {
    const r = auditPlan(makeState(
      [
        [0, 0, 0],
        [1, 180, 0],
      ],
      [
        ["X", 10, 0],
        ["X", 20, 0],
      ],
    ));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msgs = r.errors.map((e) => e.message).join("|");
    expect(msgs).toContain("反向");
    expect(msgs).toContain("重复");
  });
});

describe("auditPlan：pointAtMin 几何自洽", () => {
  it("见证点处视轴单位向量与天体角距等于所报最小角距", () => {
    const r = auditPlan(makeState(
      [
        [0, 350, 0],
        [200, 10, 0],
      ],
      [["太阳", 0, 0]],
      5,
    ));
    if (!r.ok) throw new Error("should be ok");
    const witness: Vec3 = r.segments[0].perBody[0].pointAtMin;
    const body = radecToUnitVector(0, 0);
    expect(toDegrees(angularSeparation(witness, body))).toBeCloseTo(0, 12);
    expect(
      r.segments[0].perBody[0].minAngleDeg,
    ).toBeCloseTo(toDegrees(angularSeparation(witness, body)), 9);
  });
});
