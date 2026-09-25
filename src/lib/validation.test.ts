import { describe, expect, it } from "vitest";
import {
  antipodalPointing,
  samePointing,
  validateForm,
  type PlannerFormState,
} from "./validation";

function baseState(): PlannerFormState {
  return {
    keyframes: [
      { time: "0", ra: "10", dec: "0" },
      { time: "100", ra: "80", dec: "20" },
    ],
    exclusionAngle: "15",
    bodies: [{ name: "太阳", ra: "200", dec: "0" }],
  };
}

function errorFields(errors: ReturnType<typeof validateForm>) {
  return errors.map((e) => `${e.scope}:${e.index}:${e.field}`);
}

describe("validateForm：合法输入", () => {
  it("最小合法计划无错误", () => {
    expect(validateForm(baseState())).toEqual([]);
  });

  it("允许 8 个关键帧、6 个天体", () => {
    const s = baseState();
    s.keyframes = Array.from({ length: 8 }, (_, i) => ({
      time: String(i * 10),
      ra: String((i * 40) % 360),
      dec: String(((i * 13) % 40) - 20),
    }));
    s.bodies = Array.from({ length: 6 }, (_, i) => ({
      name: `天体${i}`,
      ra: String((i * 60 + 30) % 360),
      dec: "0",
    }));
    expect(validateForm(s)).toEqual([]);
  });

  it("极坐标边界 RA=0 / Dec=±90 合法", () => {
    const s = baseState();
    s.keyframes = [
      { time: "0", ra: "0", dec: "90" },
      { time: "1", ra: "270", dec: "-90" },
    ];
    // 注意：北天极→南天极是对跖的，会被反向检查拒绝；
    // 这里改成北极→赤道点验证边界合法。
    s.keyframes[1] = { time: "1", ra: "0", dec: "0" };
    expect(validateForm(s)).toEqual([]);
  });
});

describe("validateForm：数值与范围", () => {
  it("禁入角必须为正数", () => {
    for (const v of ["0", "-1", "abc", "", "  "]) {
      const s = baseState();
      s.exclusionAngle = v;
      expect(errorFields(validateForm(s))).toContain("form:-1:exclusionAngle");
    }
    const ok = baseState();
    ok.exclusionAngle = "0.0001";
    expect(validateForm(ok)).toEqual([]);
  });

  it("RA 必须在 [0,360)，Dec 在 [-90,90]", () => {
    const s = baseState();
    s.keyframes[0] = { time: "0", ra: "360", dec: "91" };
    const fields = errorFields(validateForm(s));
    expect(fields).toContain("keyframe:0:ra");
    expect(fields).toContain("keyframe:0:dec");

    const s2 = baseState();
    s2.keyframes[0] = { time: "0", ra: "-0.01", dec: "-90.01" };
    const f2 = errorFields(validateForm(s2));
    expect(f2).toContain("keyframe:0:ra");
    expect(f2).toContain("keyframe:0:dec");
  });

  it("拒绝 NaN/Infinity 文本与科学计数以外的乱码", () => {
    const s = baseState();
    s.keyframes[0] = { time: "1e999", ra: "NaN", dec: "Infinity" };
    const fields = errorFields(validateForm(s));
    expect(fields).toContain("keyframe:0:time");
    expect(fields).toContain("keyframe:0:ra");
    expect(fields).toContain("keyframe:0:dec");
  });

  it("接受科学计数法", () => {
    const s = baseState();
    s.keyframes[0] = { time: "1e2", ra: "1.5e1", dec: "-2.5e0" };
    s.keyframes[1] = { time: "2e2", ra: "80", dec: "20" };
    expect(validateForm(s)).toEqual([]);
  });
});

describe("validateForm：时间严格递增", () => {
  it("相等与倒序时刻被拒，报告后者", () => {
    const eq = baseState();
    eq.keyframes[1].time = "0";
    expect(errorFields(validateForm(eq))).toContain("keyframe:1:time");

    const back = baseState();
    back.keyframes[1].time = "-5";
    expect(errorFields(validateForm(back))).toContain("keyframe:1:time");
  });

  it("3 帧场景报告首个违例对", () => {
    const s = baseState();
    s.keyframes.push({ time: "50", ra: "200", dec: "0" }); // 0,100,50
    const errs = validateForm(s).filter((e) => e.field === "time");
    expect(errs).toHaveLength(1);
    expect(errs[0].index).toBe(2);
  });
});

describe("validateForm：相同/反向相邻关键帧", () => {
  it("相邻指向相同被拒（含 RA 环绕等价）", () => {
    const s = baseState();
    // 相差 1e-9 度（小于 1e-6 度同指向容差）：视为录入误差导致的相同指向
    s.keyframes = [
      { time: "0", ra: "359.999999999", dec: "10" },
      { time: "1", ra: "0", dec: "10" },
    ];
    expect(validateForm(s).some((e) => e.message.includes("相同"))).toBe(true);
  });

  it("天极处任意赤经视为同一点", () => {
    expect(samePointing({ ra: 0, dec: 90 }, { ra: 200, dec: 90 })).toBe(true);
    expect(samePointing({ ra: 10, dec: -90 }, { ra: 300, dec: -90 })).toBe(
      true,
    );
    const s = baseState();
    s.keyframes = [
      { time: "0", ra: "0", dec: "90" },
      { time: "1", ra: "200", dec: "90" },
    ];
    expect(validateForm(s).some((e) => e.message.includes("相同"))).toBe(true);
  });

  it("对跖（反向）指向被拒", () => {
    expect(antipodalPointing({ ra: 0, dec: 0 }, { ra: 180, dec: 0 })).toBe(
      true,
    );
    expect(antipodalPointing({ ra: 45, dec: 30 }, { ra: 225, dec: -30 })).toBe(
      true,
    );
    // 北天极 ↔ 南天极（RA 任意）
    expect(antipodalPointing({ ra: 10, dec: 90 }, { ra: 300, dec: -90 })).toBe(
      true,
    );
    expect(antipodalPointing({ ra: 0, dec: 0 }, { ra: 179, dec: 0 })).toBe(
      false,
    );

    const s = baseState();
    s.keyframes = [
      { time: "0", ra: "45", dec: "30" },
      { time: "1", ra: "225", dec: "-30" },
    ];
    expect(validateForm(s).some((e) => e.message.includes("反向"))).toBe(true);
  });

  it("近似但非严格对跖（179.99999°）不被拒", () => {
    const s = baseState();
    s.keyframes = [
      { time: "0", ra: "0", dec: "0" },
      { time: "1", ra: "179.99999", dec: "0" },
    ];
    expect(validateForm(s)).toEqual([]);
  });
});

describe("validateForm：天体", () => {
  it("重名被拒（按输入顺序报告后者），空白名被拒", () => {
    const s = baseState();
    s.bodies = [
      { name: "月球", ra: "0", dec: "0" },
      { name: "月球", ra: "90", dec: "0" },
      { name: " 月球 ", ra: "180", dec: "0" }, // trim 后仍重名
    ];
    const errs = validateForm(s).filter((e) => e.scope === "body");
    expect(errs.filter((e) => e.field === "name")).toHaveLength(2);
    expect(errs.filter((e) => e.field === "name")[0].index).toBe(1);

    const empty = baseState();
    empty.bodies[0].name = "  ";
    expect(errorFields(validateForm(empty))).toContain("body:0:name");
  });

  it("天体坐标越界被拒", () => {
    const s = baseState();
    s.bodies[0] = { name: "X", ra: "360", dec: "90.1" };
    const fields = errorFields(validateForm(s));
    expect(fields).toContain("body:0:ra");
    expect(fields).toContain("body:0:dec");
  });
});

describe("validateForm：数量限制", () => {
  it("关键帧 2~8、天体 1~6", () => {
    const one = baseState();
    one.keyframes = one.keyframes.slice(0, 1);
    expect(errorFields(validateForm(one))).toContain("form:-1:keyframes");

    const nine = baseState();
    nine.keyframes = Array.from({ length: 9 }, (_, i) => ({
      time: String(i),
      ra: "0",
      dec: "0",
    }));
    // 9 个相同指向会同时触发相同错误；数量错误仍应在
    expect(
      validateForm(nine).some((e) => e.message.includes("不得超过 8")),
    ).toBe(true);

    const zeroBody = baseState();
    zeroBody.bodies = [];
    expect(errorFields(validateForm(zeroBody))).toContain("form:-1:bodies");
  });
});
