/**
 * 转向计划审核引擎。
 *
 * 对每个相邻关键帧构成的短弧段，沿短弧「连续」求解相对每个禁入天体的
 * 真实最小角距（解析极值，见 geometry.ts），并按
 *   时间（段顺序）→ 段内天体输入顺序
 * 报告首个越界见证。
 */

import {
  angularSeparation,
  minAngularSeparationOnShortArc,
  radecToUnitVector,
  toDegrees,
  type Vec3,
} from "./geometry";
import {
  validateForm,
  type PlannerFormState,
  type ValidationError,
} from "./validation";

export interface SegmentBodyResult {
  /** 天体在表单中的序号（从 0 起） */
  bodyIndex: number;
  bodyName: string;
  /** 沿该段短弧相对此天体的真实最小角距（度） */
  minAngleDeg: number;
  /** 取得最小角距的短弧参数 t∈[0,1] */
  t: number;
  /** 取得最小角距的计划时刻（在相邻关键帧时刻之间线性插值，秒） */
  time: number;
  /** 取得最小角距处的视轴指向（单位向量） */
  pointAtMin: Vec3;
  violated: boolean;
}

export interface SegmentResult {
  /** 段序号（从 0 起，即关键帧 index → index+1） */
  index: number;
  fromKeyframe: number;
  toKeyframe: number;
  startTime: number;
  endTime: number;
  /** 段长（秒） */
  duration: number;
  /** 对每个天体的结果，按天体输入顺序排列 */
  perBody: SegmentBodyResult[];
  /** 该段全部天体中的最小角距（度） */
  minAngleDeg: number;
  violated: boolean;
}

export interface Violation {
  segmentIndex: number;
  bodyIndex: number;
  bodyName: string;
  /** 越界见证：该段上首次（也是唯一极小值点）触及最小角距的时刻 */
  time: number;
  t: number;
  /** 实测最小角距（度）——严格小于禁入角即为越界 */
  minAngleDeg: number;
  exclusionAngleDeg: number;
}

export interface AuditResult {
  ok: true;
  segments: SegmentResult[];
  exclusionAngleDeg: number;
  /** 整个计划中的全局最小角距（度） */
  globalMinAngleDeg: number;
  /** 等号成立（角距恰等于禁入角）的接触点列表（不算违规，供操作员复核） */
  contacts: Array<{
    segmentIndex: number;
    bodyIndex: number;
    bodyName: string;
    time: number;
  }>;
}

export interface AuditFailure {
  ok: false;
  errors: ValidationError[];
}

export type AuditOutcome = AuditResult | AuditFailure;

/** 短弧上 t∈[0,1] 处的视轴单位向量（SLERP）。 */
function slerp(p: Vec3, q: Vec3, t: number): Vec3 {
  const theta = angularSeparation(p, q); // 调用方已保证 θ∈(0,π)
  const sinTheta = Math.sin(theta);
  const a = Math.sin((1 - t) * theta) / sinTheta;
  const b = Math.sin(t * theta) / sinTheta;
  return {
    x: a * p.x + b * q.x,
    y: a * p.y + b * q.y,
    z: a * p.z + b * q.z,
  };
}

/**
 * 执行一次审核。输入不合法时返回全部校验错误；
 * 合法时逐段解析最小角距并给出计划结论。
 */
export function auditPlan(state: PlannerFormState): AuditOutcome {
  const errors = validateForm(state);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const exclusionAngleDeg = Number(state.exclusionAngle);

  const keyframes = state.keyframes.map((kf) => ({
    time: Number(kf.time),
    point: radecToUnitVector(Number(kf.ra), Number(kf.dec)),
  }));
  const bodies = state.bodies.map((b, i) => ({
    index: i,
    name: b.name.trim(),
    point: radecToUnitVector(Number(b.ra), Number(b.dec)),
  }));

  const segments: SegmentResult[] = [];
  let globalMinAngleDeg = Infinity;
  const contacts: AuditResult["contacts"] = [];

  for (let i = 0; i + 1 < keyframes.length; i++) {
    const from = keyframes[i];
    const to = keyframes[i + 1];
    const duration = to.time - from.time;

    const perBody: SegmentBodyResult[] = bodies.map((body) => {
      const { angle, t } = minAngularSeparationOnShortArc(
        from.point,
        to.point,
        body.point,
      );
      const minAngleDeg = toDegrees(angle);
      const time = from.time + t * duration;
      return {
        bodyIndex: body.index,
        bodyName: body.name,
        minAngleDeg,
        t,
        time,
        pointAtMin: slerp(from.point, to.point, t),
        // 比较留出极小的舍入余量由 minAngleDeg 的钳制负责；
        // 等于禁入角不算违规（禁入区边界允许贴边），仅登记为接触点。
        violated: minAngleDeg < exclusionAngleDeg,
      };
    });

    const segMin = perBody.reduce(
      (m, r) => Math.min(m, r.minAngleDeg),
      Infinity,
    );
    globalMinAngleDeg = Math.min(globalMinAngleDeg, segMin);

    for (const r of perBody) {
      if (Math.abs(r.minAngleDeg - exclusionAngleDeg) <= ANGLE_EQ_EPS_DEG) {
        contacts.push({
          segmentIndex: i,
          bodyIndex: r.bodyIndex,
          bodyName: r.bodyName,
          time: r.time,
        });
      }
    }

    segments.push({
      index: i,
      fromKeyframe: i,
      toKeyframe: i + 1,
      startTime: from.time,
      endTime: to.time,
      duration,
      perBody,
      minAngleDeg: segMin,
      violated: perBody.some((r) => r.violated),
    });
  }

  return {
    ok: true,
    segments,
    exclusionAngleDeg,
    globalMinAngleDeg,
    contacts,
  };
}

/**
 * 按「时间（段顺序）→ 段内天体输入顺序」找出首个越界见证。
 */
export function firstViolation(result: AuditResult): Violation | null {
  for (const seg of result.segments) {
    for (const bodyResult of seg.perBody) {
      if (bodyResult.violated) {
        return {
          segmentIndex: seg.index,
          bodyIndex: bodyResult.bodyIndex,
          bodyName: bodyResult.bodyName,
          time: bodyResult.time,
          t: bodyResult.t,
          minAngleDeg: bodyResult.minAngleDeg,
          exclusionAngleDeg: result.exclusionAngleDeg,
        };
      }
    }
  }
  return null;
}

/** 角度相等判定余量（度）：1e-9 度，仅用于把「恰贴边界」登记为接触点。 */
const ANGLE_EQ_EPS_DEG = 1e-9;
