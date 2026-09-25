/**
 * 操作员录入数据的类型与输入校验。
 * 校验只判断「输入是否构成一个可审核的计划」，不做任何几何结论。
 */

import { dot, radecToUnitVector, toRadians } from "./geometry";

/** 判定「相同/反向」指向时的角度容差（弧度），约 1e-6 度：足以吸收换算浮点误差。 */
const ANGLE_EPS = toRadians(1e-6);

export const MIN_KEYFRAMES = 2;
export const MAX_KEYFRAMES = 8;
export const MIN_BODIES = 1;
export const MAX_BODIES = 6;

export interface KeyframeInput {
  /** 严格递增的时刻（秒，任意有限数） */
  time: string;
  /** 赤经（度，[0, 360)） */
  ra: string;
  /** 赤纬（度，[-90, 90]） */
  dec: string;
}

export interface BodyInput {
  /** 禁入天体名称（非空、唯一） */
  name: string;
  ra: string;
  dec: string;
}

export interface PlannerFormState {
  keyframes: KeyframeInput[];
  exclusionAngle: string; // 统一禁入角（度，> 0）
  bodies: BodyInput[];
}

export interface ValidationError {
  /** 错误归属：顶层表单 / 关键帧 / 天体 */
  scope: "form" | "keyframe" | "body";
  /** 关键帧或天体的序号（从 0 起）；scope=form 时为 -1 */
  index: number;
  /** 该序号内的字段名（time/ra/dec/name/exclusionAngle），无则 "" */
  field: string;
  message: string;
}

const NUM = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 解析数值字段；空串、非法数字、NaN/Infinity 一律视为无效输入。 */
function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (s === "" || !NUM.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * 全面校验表单，返回所有可定位的错误（UI 可按 scope/index/field 就地标注）。
 * 错误顺序遵循「先时间、再段输入顺序、再天体输入顺序」的报告习惯。
 */
export function validateForm(state: PlannerFormState): ValidationError[] {
  const errors: ValidationError[] = [];

  // ---- 禁入角 ----
  const exclusion = parseNumber(state.exclusionAngle);
  if (exclusion === null) {
    errors.push({
      scope: "form",
      index: -1,
      field: "exclusionAngle",
      message: "统一禁入角必须是数字",
    });
  } else if (!(exclusion > 0)) {
    errors.push({
      scope: "form",
      index: -1,
      field: "exclusionAngle",
      message: "统一禁入角必须为正数",
    });
  }

  // ---- 关键帧数量 ----
  if (state.keyframes.length < MIN_KEYFRAMES) {
    errors.push({
      scope: "form",
      index: -1,
      field: "keyframes",
      message: `至少需要 ${MIN_KEYFRAMES} 个关键帧`,
    });
  }
  if (state.keyframes.length > MAX_KEYFRAMES) {
    errors.push({
      scope: "form",
      index: -1,
      field: "keyframes",
      message: `关键帧不得超过 ${MAX_KEYFRAMES} 个`,
    });
  }

  // ---- 逐帧解析与范围检查 ----
  const times: number[] = new Array(state.keyframes.length).fill(NaN);
  const raOk: boolean[] = [];
  const decOk: boolean[] = [];

  state.keyframes.forEach((kf, i) => {
    const t = parseNumber(kf.time);
    if (t === null) {
      errors.push({
        scope: "keyframe",
        index: i,
        field: "time",
        message: `关键帧 ${i + 1}：时刻必须是有效数字`,
      });
    } else {
      times[i] = t;
    }

    const ra = parseNumber(kf.ra);
    if (ra === null) {
      errors.push({
        scope: "keyframe",
        index: i,
        field: "ra",
        message: `关键帧 ${i + 1}：赤经必须是有效数字`,
      });
      raOk.push(false);
    } else if (ra < 0 || ra >= 360) {
      errors.push({
        scope: "keyframe",
        index: i,
        field: "ra",
        message: `关键帧 ${i + 1}：赤经须在 [0°, 360°) 内（360° 与 0° 同指向，请填 0°）`,
      });
      raOk.push(false);
    } else {
      raOk.push(true);
    }

    const dec = parseNumber(kf.dec);
    if (dec === null) {
      errors.push({
        scope: "keyframe",
        index: i,
        field: "dec",
        message: `关键帧 ${i + 1}：赤纬必须是有效数字`,
      });
      decOk.push(false);
    } else if (dec < -90 || dec > 90) {
      errors.push({
        scope: "keyframe",
        index: i,
        field: "dec",
        message: `关键帧 ${i + 1}：赤纬须在 [-90°, 90°] 内`,
      });
      decOk.push(false);
    } else {
      decOk.push(true);
    }
  });

  // ---- 时刻严格递增（按时间顺序逐对检查，报告首个违例对） ----
  for (let i = 1; i < state.keyframes.length; i++) {
    if (Number.isFinite(times[i - 1]) && Number.isFinite(times[i])) {
      if (times[i] <= times[i - 1]) {
        errors.push({
          scope: "keyframe",
          index: i,
          field: "time",
          message: `关键帧 ${i + 1}：时刻必须严格递增（须晚于关键帧 ${i} 的 ${times[i - 1]}）`,
        });
      }
    }
  }

  // ---- 相邻关键帧：相同指向 / 反向指向 → 无唯一最短大圆弧 ----
  // 「段输入顺序」即相邻对顺序，因此逐对报告。
  for (let i = 0; i + 1 < state.keyframes.length; i++) {
    if (!raOk[i] || !decOk[i] || !raOk[i + 1] || !decOk[i + 1]) continue;
    const a = {
      ra: Number(state.keyframes[i].ra),
      dec: Number(state.keyframes[i].dec),
    };
    const b = {
      ra: Number(state.keyframes[i + 1].ra),
      dec: Number(state.keyframes[i + 1].dec),
    };

    if (samePointing(a, b)) {
      errors.push({
        scope: "keyframe",
        index: i + 1,
        field: "ra",
        message: `第 ${i + 1} 段（关键帧 ${i + 1}→${i + 2}）：相邻指向相同，最短大圆轨迹不唯一（退化为点）`,
      });
    } else if (antipodalPointing(a, b)) {
      errors.push({
        scope: "keyframe",
        index: i + 1,
        field: "ra",
        message: `第 ${i + 1} 段（关键帧 ${i + 1}→${i + 2}）：相邻指向恰好反向（对跖），存在无数条等长半圆弧，最短路径不唯一`,
      });
    }
  }

  // ---- 天体数量 ----
  if (state.bodies.length < MIN_BODIES) {
    errors.push({
      scope: "form",
      index: -1,
      field: "bodies",
      message: `至少需要 ${MIN_BODIES} 个禁入天体`,
    });
  }
  if (state.bodies.length > MAX_BODIES) {
    errors.push({
      scope: "form",
      index: -1,
      field: "bodies",
      message: `禁入天体不得超过 ${MAX_BODIES} 个`,
    });
  }

  // ---- 天体：重名与坐标范围 ----
  const seen = new Map<string, number>();
  state.bodies.forEach((body, i) => {
    const name = body.name.trim();
    if (name === "") {
      errors.push({
        scope: "body",
        index: i,
        field: "name",
        message: `天体 ${i + 1}：名称不能为空`,
      });
    } else if (seen.has(name)) {
      errors.push({
        scope: "body",
        index: i,
        field: "name",
        message: `天体 ${i + 1}：名称「${name}」与天体 ${seen.get(name)! + 1} 重复`,
      });
    } else {
      seen.set(name, i);
    }

    const ra = parseNumber(body.ra);
    if (ra === null) {
      errors.push({
        scope: "body",
        index: i,
        field: "ra",
        message: `天体「${name || i + 1}」：赤经必须是有效数字`,
      });
    } else if (ra < 0 || ra >= 360) {
      errors.push({
        scope: "body",
        index: i,
        field: "ra",
        message: `天体「${name || i + 1}」：赤经须在 [0°, 360°) 内`,
      });
    }

    const dec = parseNumber(body.dec);
    if (dec === null) {
      errors.push({
        scope: "body",
        index: i,
        field: "dec",
        message: `天体「${name || i + 1}」：赤纬必须是有效数字`,
      });
    } else if (dec < -90 || dec > 90) {
      errors.push({
        scope: "body",
        index: i,
        field: "dec",
        message: `天体「${name || i + 1}」：赤纬须在 [-90°, 90°] 内`,
      });
    }
  });

  return errors;
}

/** 两个 (ra, dec) 是否为同一指向（统一换算为单位向量，天然处理极点与 RA 环绕）。 */
export function samePointing(
  a: { ra: number; dec: number },
  b: { ra: number; dec: number },
): boolean {
  const va = radecToUnitVector(a.ra, a.dec);
  const vb = radecToUnitVector(b.ra, b.dec);
  // 角距小于约 2.4e-8 度视为相同。
  return dot(va, vb) >= Math.cos(ANGLE_EPS);
}

/** 两个指向是否对跖（p = -q），即短弧圆心角恰为 180°。 */
export function antipodalPointing(
  a: { ra: number; dec: number },
  b: { ra: number; dec: number },
): boolean {
  const va = radecToUnitVector(a.ra, a.dec);
  const vb = radecToUnitVector(b.ra, b.dec);
  // 与 180° 的偏差小于约 2.4e-8 度视为对跖（北天极↔南天极等退化情形自然成立）。
  return dot(va, vb) <= -Math.cos(ANGLE_EPS);
}
