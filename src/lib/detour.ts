/**
 * 绕行建议求解器。
 *
 * 审核发现某段转向扫入禁入区后，操作员可录入 1–8 个「批准转折指向」。
 * 本求解器在**全部可行插入序列**中寻找绕行方案：
 *
 * - 保留全部原关键帧的顺序；批准点只能插入在相邻关键帧之间，
 *   同一批准点在整条计划中最多使用一次；
 * - 每条新短弧（原关键帧→批准点、批准点→批准点、批准点→原关键帧）
 *   都必须沿用既有「连续禁入判定」（解析短弧最小角距）安全通过；
 * - **全局**优化：各原段使用哪些批准点相互耦合（同一点全计划最多一次），
 *   不能按原段分别贪心求解；
 * - 优化目标（字典序）：
 *     1. 新增转折点数最少；
 *     2. 相对原计划增加的总转向角（绕行后短弧角总和 − 原短弧角总和）最少；
 *     3. 同值按候选录入顺序稳定确定：按原段顺序逐段比较所经批准点的
 *        录入序号序列（空序列最小；序列内按遍历顺序字典序）。
 *
 * 算法（对 m ≤ 8 个批准点精确枚举，无采样/贪心）：
 *   1. 预计算全部节点对（原关键帧、批准点）之间短弧的可行性与圆心角；
 *   2. 段内 DP（按子集的 TSP 路径）：对每个原段 s 与批准点子集 S，求从
 *      原关键帧 s 出发、恰好经过 S（任意排列）、到达原关键帧 s+1 的
 *      最小角安全路径；空子集即原段直连；
 *   3. 跨段 DP（按全局已用掩码）：为各原段分配两两不相交的可行子集，
 *      联合优化新增点数、总转向角增量与录入顺序稳定性。
 */

import {
  angularSeparation,
  minAngularSeparationOnShortArc,
  radecToUnitVector,
  toDegrees,
  type Vec3,
} from "./geometry";
import type { AuditResult } from "./planner";
import {
  validateApprovedPoints,
  validateForm,
  type PlannerFormState,
  type ValidationError,
} from "./validation";

/** 相同/对跖判定容差（弧度），与 validation.ts 保持一致（约 1e-6 度）。 */
const COLINEAR_EPS = 1e-6 * (Math.PI / 180);

/**
 * 角度同值判定容差（弧度，约 5.7e-9 度）：不同插入序列的角和由不同边
 * 累加得到，数学相等时浮点结果可能差 ~1e-14 弧度。同值（≤此容差）时
 * 改按候选录入顺序（编号序列字典序）稳定裁决，避免浮点尾差左右结果。
 */
const ANGLE_TIE_EPS = 1e-10;

export interface ArcEndpoint {
  kind: "keyframe" | "approved";
  /** keyframe：原关键帧序号；approved：批准点录入序号（从 0 起） */
  index: number;
  name: string;
}

export interface DetourSubArc {
  /** 所属原段序号（关键帧 index → index+1） */
  segmentIndex: number;
  /** 子弧在该原段内的序号（从 0 起） */
  subIndex: number;
  from: ArcEndpoint;
  to: ArcEndpoint;
  /** 短弧圆心角（度） */
  angleDeg: number;
  /** 子弧起点时刻（秒） */
  startTime: number;
  /** 子弧终点时刻（秒，末子弧严格对齐原段结束时刻，其余严格落在原时段内） */
  endTime: number;
  /** 子弧时长（秒，按子弧短弧角长度比例分配原段时长） */
  duration: number;
}

export interface DetourSegmentPlan {
  /** 原段序号（从 0 起） */
  segmentIndex: number;
  fromKeyframe: number;
  toKeyframe: number;
  /** 本原段经过的批准点录入序号（按通过顺序）；直连段为空 */
  approvedIndices: number[];
  /** 拆分后的各子弧（角度 + 按弧长比例分配的时刻） */
  subArcs: DetourSubArc[];
}

export interface DetourSuccess {
  ok: true;
  segments: DetourSegmentPlan[];
  /** 新增转折点数（使用的批准点个数，全计划去重后） */
  insertedCount: number;
  /** 使用的批准点录入序号（按在计划中首次出现的顺序） */
  usedApprovedIndices: number[];
  /** 绕行后全部子弧的短弧角总和（度） */
  totalAngleDeg: number;
  /** 原计划全部段短弧角总和（度） */
  originalAngleDeg: number;
  /** 相对原计划增加的总转向角（度） */
  addedAngleDeg: number;
  exclusionAngleDeg: number;
}

export interface DetourFailure {
  ok: false;
  /** 表单/批准点录入校验错误（此时不产生几何结论） */
  errors?: ValidationError[];
  /** 无可行插入序列时的原因说明 */
  reason?: string;
}

export type DetourOutcome = DetourSuccess | DetourFailure;

/** 段内（或跨段）某一批准点子集的最优排列。 */
interface SeqChoice {
  /** 短弧角总和（弧度） */
  angleRad: number;
  /** 批准点录入序号的遍历顺序 */
  seq: number[];
}

/** 字典序比较编号序列：空序列（前缀）最小；返回负数表示 a 更优先。 */
function compareSeq(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 同一子集的候选择优：先角度，角度相同（含浮点尾差）取编号序列字典序更小者。 */
function pickBetter(a: SeqChoice, b: SeqChoice): SeqChoice {
  if (b.angleRad < a.angleRad - ANGLE_TIE_EPS) return b;
  if (b.angleRad > a.angleRad + ANGLE_TIE_EPS) return a;
  return compareSeq(b.seq, a.seq) < 0 ? b : a;
}

/**
 * 基于当前草稿与一次已完成的审核结论，求解最优绕行建议。
 * 调用方须保证审核结论对当前草稿有效（审核后草稿未被修改）。
 *
 * options.skipKeyframeCount：一键写回后的计划关键帧数可超过手工录入上限
 * （最多 MAX_KEYFRAMES + MAX_APPROVED），此时跳过数量上限校验。
 */
export function planDetour(
  state: PlannerFormState,
  audit: AuditResult,
  options?: { skipKeyframeCount?: boolean },
): DetourOutcome {
  // 直接审核所依赖的录入仍须合法（沿用原有限制，保持兼容）。
  const formErrors = validateForm(state, {
    skipKeyframeCount: options?.skipKeyframeCount === true,
  });
  if (formErrors.length > 0) {
    return { ok: false, errors: formErrors };
  }
  const pointErrors = validateApprovedPoints(state.approvedPoints);
  if (pointErrors.length > 0) {
    return { ok: false, errors: pointErrors };
  }

  const n = state.keyframes.length;
  const m = state.approvedPoints.length;
  const segCount = n - 1;

  const keyframeVec: Vec3[] = state.keyframes.map((kf) =>
    radecToUnitVector(Number(kf.ra), Number(kf.dec)),
  );
  const approvedPoints = state.approvedPoints.map((p) => ({
    name: p.name.trim(),
    vec: radecToUnitVector(Number(p.ra), Number(p.dec)),
  }));
  const bodyVec: Vec3[] = state.bodies.map((b) =>
    radecToUnitVector(Number(b.ra), Number(b.dec)),
  );
  const exclusionRad = (audit.exclusionAngleDeg * Math.PI) / 180;

  // ---- 全部节点对短弧的可行性与圆心角 ----
  // 节点编号：0..n−1 原关键帧；n..n+m−1 批准点。
  const vecOf = (node: number): Vec3 =>
    node < n ? keyframeVec[node] : approvedPoints[node - n].vec;
  const cache = new Map<string, { ok: boolean; angleRad: number }>();

  const edge = (u: number, v: number) => {
    const key = `${u}>${v}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const a = vecOf(u);
    const b = vecOf(v);
    const theta = angularSeparation(a, b);
    let ok: boolean;
    // 相同指向（θ≈0，退化为点，不构成转折）或对跖（θ≈π，无唯一最短弧）
    // 都不能作为新短弧。
    if (theta <= COLINEAR_EPS || theta >= Math.PI - COLINEAR_EPS) {
      ok = false;
    } else {
      ok = true;
      for (const bp of bodyVec) {
        const { angle } = minAngularSeparationOnShortArc(a, b, bp);
        // 沿用既有连续判定：严格小于禁入角为越界，恰等于贴边放行。
        if (angle < exclusionRad) {
          ok = false;
          break;
        }
      }
    }
    const rec = { ok, angleRad: theta };
    cache.set(key, rec);
    return rec;
  };

  const safe = (u: number, v: number): boolean => edge(u, v).ok;
  const ang = (u: number, v: number): number => edge(u, v).angleRad;
  const kf = (i: number): number => i;
  const ap = (j: number): number => n + j;

  // 原计划总转向角。
  let originalAngleRad = 0;
  for (let s = 0; s < segCount; s++) originalAngleRad += ang(kf(s), kf(s + 1));

  // ---- 段内 DP：segBest[s][S] = 段 s 恰好经过子集 S 的最优安全路径 ----
  const full = 1 << m;
  const segBest: (SeqChoice | null)[][] = [];

  for (let s = 0; s < segCount; s++) {
    const start = kf(s);
    const end = kf(s + 1);
    const bySubset: (SeqChoice | null)[] = new Array(full).fill(null);

    // 空子集：原段直连。
    if (safe(start, end)) {
      bySubset[0] = { angleRad: ang(start, end), seq: [] };
    }

    // dp[S][j]：从 start 恰好经过子集 S、最后停在批准点 j 的最优路径。
    // 用扁平数组 dp[S*m + j]。
    const dp: (SeqChoice | null)[] = new Array(full * m).fill(null);
    for (let j = 0; j < m; j++) {
      if (safe(start, ap(j))) {
        dp[(1 << j) * m + j] = { angleRad: ang(start, ap(j)), seq: [j] };
      }
    }
    for (let S = 1; S < full; S++) {
      for (let j = 0; j < m; j++) {
        if (!(S & (1 << j)) || S === 1 << j) continue;
        const prevS = S ^ (1 << j);
        let best: SeqChoice | null = null;
        for (let i = 0; i < m; i++) {
          if (!(prevS & (1 << i))) continue;
          const prev = dp[prevS * m + i];
          if (prev === null || !safe(ap(i), ap(j))) continue;
          const cand: SeqChoice = {
            angleRad: prev.angleRad + ang(ap(i), ap(j)),
            seq: [...prev.seq, j],
          };
          best = best === null ? cand : pickBetter(best, cand);
        }
        dp[S * m + j] = best;
      }
    }

    // 从最后一个批准点闭合到原段终点，登记为该子集的可行方案。
    for (let S = 1; S < full; S++) {
      let best: SeqChoice | null = null;
      for (let j = 0; j < m; j++) {
        if (!(S & (1 << j))) continue;
        const prev = dp[S * m + j];
        if (prev === null || !safe(ap(j), end)) continue;
        const cand: SeqChoice = {
          angleRad: prev.angleRad + ang(ap(j), end),
          seq: prev.seq,
        };
        best = best === null ? cand : pickBetter(best, cand);
      }
      bySubset[S] = best;
    }

    segBest.push(bySubset);
  }

  // ---- 无可行路径时的原因诊断（不改动任何草稿/结论，仅说明） ----
  const deadSegments: number[] = [];
  for (let s = 0; s < segCount; s++) {
    if (!segBest[s].some((choice) => choice !== null)) deadSegments.push(s);
  }

  // ---- 跨段 DP：为各段分配两两不相交的可行子集 ----
  // 状态：处理完若干段后，全局已用批准点掩码 → 最优方案。
  // 同一掩码之下剩余自由度完全相同，故按
  //   点数 → 角和 → 逐段编号序列字典序
  // 保留唯一最优前驱即可。
  interface GlobalState {
    count: number;
    angleRad: number;
    /** 每个已处理段的编号序列（按段顺序） */
    choices: number[][];
  }

  const compareState = (a: GlobalState, b: GlobalState): number => {
    if (a.count !== b.count) return a.count - b.count;
    if (a.angleRad < b.angleRad - ANGLE_TIE_EPS) return -1;
    if (a.angleRad > b.angleRad + ANGLE_TIE_EPS) return 1;
    for (let i = 0; i < Math.max(a.choices.length, b.choices.length); i++) {
      const c = compareSeq(a.choices[i] ?? [], b.choices[i] ?? []);
      if (c !== 0) return c;
    }
    return 0;
  };

  let dpGlobal: (GlobalState | null)[] = new Array(full).fill(null);
  dpGlobal[0] = { count: 0, angleRad: 0, choices: [] };

  for (let s = 0; s < segCount; s++) {
    const next: (GlobalState | null)[] = new Array(full).fill(null);
    for (let mask = 0; mask < full; mask++) {
      const cur = dpGlobal[mask];
      if (cur === null) continue;
      const remain = full - 1 - mask;
      // 枚举 remain 的所有子集 S（本段使用的批准点）。
      for (let S = remain; ; S = (S - 1) & remain) {
        const choice = segBest[s][S];
        if (choice !== null) {
          const cand: GlobalState = {
            count: cur.count + popcount(S),
            angleRad: cur.angleRad + choice.angleRad,
            choices: [...cur.choices, choice.seq],
          };
          const newMask = mask | S;
          const old = next[newMask];
          if (old === null || compareState(cand, old) < 0) next[newMask] = cand;
        }
        if (S === 0) break;
      }
    }
    dpGlobal = next;
  }

  let winner: GlobalState | null = null;
  for (const st of dpGlobal) {
    if (st !== null && (winner === null || compareState(st, winner) < 0)) {
      winner = st;
    }
  }

  if (winner === null) {
    let reason: string;
    if (deadSegments.length > 0) {
      const names = deadSegments.map((s) => `第 ${s + 1} 段`).join("、");
      reason =
        `无可行绕行路径：即便允许 ${m} 个批准转折指向以任意顺序全部插入，` +
        `${names}仍不存在一条从段起点到段终点、每条新短弧都安全通过禁入区的路径` +
        `（可能原因：批准点本身落入禁入区、批准点与相邻指向对跖无唯一最短弧、` +
        `或禁入区过宽导致没有安全通道）。请增补或调整批准指向；原草稿与审核结论保持不变。`;
    } else {
      reason =
        `无可行绕行路径：各原段虽分别存在安全穿法，但任一安全穿法所必需的批准点 ` +
        `在段间相互冲突，无法满足「同一批准点在整条计划中最多使用一次」` +
        `（全部 ${m} 个批准点、跨 ${segCount} 个原段的不相交子集分配均不可行）。` +
        `请增补更多批准指向；原草稿与审核结论保持不变。`;
    }
    return { ok: false, reason };
  }

  // ---- 展开最优方案：逐段生成子弧，并按短弧长度比例分配时刻 ----
  const segPlans: DetourSegmentPlan[] = [];
  const usedOrder: number[] = [];
  let totalAngleRad = 0;

  const endpointOf = (node: number): ArcEndpoint => {
    if (node < n) {
      return { kind: "keyframe", index: node, name: `关键帧 ${node + 1}` };
    }
    const j = node - n;
    return { kind: "approved", index: j, name: approvedPoints[j].name };
  };

  winner.choices.forEach((seq, s) => {
    const nodes = [kf(s), ...seq.map(ap), kf(s + 1)];
    const t0 = Number(state.keyframes[s].time);
    const t1 = Number(state.keyframes[s + 1].time);
    const segDuration = t1 - t0;

    const anglesRad: number[] = [];
    for (let q = 0; q + 1 < nodes.length; q++) {
      const a = ang(nodes[q], nodes[q + 1]);
      anglesRad.push(a);
      totalAngleRad += a;
    }
    const arcSum = anglesRad.reduce((x, y) => x + y, 0);

    // 先算出各子弧边界的原始分配时刻（末边界对齐 t1）。
    const boundaries: number[] = [t0];
    let cumAngle = 0;
    for (let q = 0; q < anglesRad.length; q++) {
      cumAngle += anglesRad[q];
      boundaries.push(
        q + 1 === anglesRad.length
          ? t1
          : t0 + (cumAngle / arcSum) * segDuration,
      );
    }
    // 显示精度规整：12 位有效数字（吸收 99.99999999999999 一类的累加尾差，
    // 使正中点恰为 100）；若规整会破坏严格递增/严格落在段内，则退回全精度。
    const rounded = boundaries.map((t) =>
      t === t0 || t === t1 ? t : parseFloat(t.toPrecision(12)),
    );
    let strict = true;
    for (let q = 1; q < rounded.length; q++) {
      if (!(rounded[q] > rounded[q - 1])) strict = false;
    }
    if (!(rounded[0] >= t0 && rounded[rounded.length - 1] <= t1)) strict = false;
    const finalBoundaries = strict ? rounded : boundaries;

    const subArcs: DetourSubArc[] = [];
    for (let q = 0; q + 1 < nodes.length; q++) {
      const startTime = finalBoundaries[q];
      const endTime = finalBoundaries[q + 1];
      subArcs.push({
        segmentIndex: s,
        subIndex: q,
        from: endpointOf(nodes[q]),
        to: endpointOf(nodes[q + 1]),
        angleDeg: toDegrees(anglesRad[q]),
        startTime,
        endTime,
        duration: endTime - startTime,
      });
      if (nodes[q + 1] >= n) {
        const j = nodes[q + 1] - n;
        if (!usedOrder.includes(j)) usedOrder.push(j);
      }
    }

    segPlans.push({
      segmentIndex: s,
      fromKeyframe: s,
      toKeyframe: s + 1,
      approvedIndices: seq.slice(),
      subArcs,
    });
  });

  const totalAngleDeg = toDegrees(totalAngleRad);
  const originalAngleDeg = toDegrees(originalAngleRad);

  return {
    ok: true,
    segments: segPlans,
    insertedCount: winner.count,
    usedApprovedIndices: usedOrder,
    totalAngleDeg,
    originalAngleDeg,
    addedAngleDeg: totalAngleDeg - originalAngleDeg,
    exclusionAngleDeg: audit.exclusionAngleDeg,
  };
}

function popcount(S: number): number {
  let v = S;
  let c = 0;
  while (v > 0) {
    v &= v - 1;
    c++;
  }
  return c;
}

/**
 * 把成功的绕行建议一键写回为新的关键帧草稿：原关键帧的顺序、坐标与
 * 时刻保持不变，批准点按插入位置与按弧长比例分配的时刻成为新关键帧。
 * 返回新的 PlannerFormState，不就地修改入参；写回后旧审核结论自动失效，
 * 操作员需对新草稿重新审核。
 */
export function applyDetourToState(
  state: PlannerFormState,
  detour: DetourSuccess,
): PlannerFormState {
  const newKeyframes: PlannerFormState["keyframes"] = [];

  for (let s = 0; s < detour.segments.length; s++) {
    const plan = detour.segments[s];
    newKeyframes.push({ ...state.keyframes[s] });
    // 段内终点为批准点的子弧：插入时刻取该子弧的 endTime。
    for (const sub of plan.subArcs) {
      if (sub.to.kind === "approved") {
        const point = state.approvedPoints[sub.to.index];
        newKeyframes.push({
          time: formatTime(sub.endTime),
          ra: point.ra,
          dec: point.dec,
        });
      }
    }
  }
  newKeyframes.push({ ...state.keyframes[state.keyframes.length - 1] });

  return {
    keyframes: newKeyframes,
    exclusionAngle: state.exclusionAngle,
    bodies: state.bodies.map((b) => ({ ...b })),
    // 写回后批准点已成为关键帧；清空批准点录入，等待下一次绕行流程。
    approvedPoints: [],
  };
}

/**
 * 分配时刻格式化为输入框字符串。用 Number 的最短往返表示（至多约 17 位
 * 有效数字），既去掉二进制尾差，又在子弧时长极短时保留足够精度，
 * 使相邻插入时刻经字符串往返后仍严格递增。
 */
function formatTime(t: number): string {
  return String(t);
}
