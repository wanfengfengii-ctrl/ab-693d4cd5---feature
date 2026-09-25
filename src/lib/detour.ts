/**
 * 绕行建议求解器。
 *
 * 审核发现某段短弧扫入禁入区后，操作员可录入 1–8 个「批准转折指向」。
 * 本求解器在保留全部原关键帧（顺序、指向、时刻）的前提下，在任意相邻
 * 关键帧之间插入这些批准点，把原段拆成若干新短弧，并要求：
 *
 *   - 每条新短弧都沿用既有「连续禁入判定」（解析短弧最小角距，见
 *     geometry.minAngularSeparationOnShortArc）安全通过，贴边放行；
 *   - 同一批准点在整条计划中最多使用一次（跨段全局互斥，不能逐段贪心）；
 *   - 优化目标：先最少化新增转折点数，再最少化相对原计划增加的总转向角；
 *     两者均相同时，按批准点录入顺序做稳定（字典序）裁决。
 *
 * 实现：对每个原段枚举其内部全部可行的「批准点排列」通道（每段至多
 * ∑P(8,k)≈1.1e5 条），按所用点集合保留该集合下的最优通道；再以
 * 「已用点集合」为状态跨段做全局 DP（2^8=256 个状态），从而在
 * 全局互斥约束下求得整条计划的最优解，而非各段各自贪心。
 */

import {
  angularSeparation,
  minAngularSeparationOnShortArc,
  radecToUnitVector,
  toDegrees,
  toRadians,
  type Vec3,
} from "./geometry";
import type { AuditResult } from "./planner";
import {
  validateForm,
  validateWaypoints,
  type KeyframeInput,
  type PlannerFormState,
  type WaypointInput,
} from "./validation";

/** 角度相等裁决余量（度），与审核结论的贴边判定余量同量级。 */
const ANGLE_TIE_EPS_DEG = 1e-9;
/** 退化短弧（相同/对跖端点）的圆心角余量（弧度），约 1e-6 度。 */
const DEGEN_EPS = toRadians(1e-6);

export type NodeKind = "keyframe" | "waypoint";

export interface DetourNodeRef {
  kind: NodeKind;
  /** keyframe：原关键帧序号；waypoint：批准点录入序号（从 0 起） */
  index: number;
  name: string;
}

export interface DetourSubArc {
  from: DetourNodeRef;
  to: DetourNodeRef;
  /** 该子短弧的转向角（度） */
  angleDeg: number;
}

export interface DetourInsertedPoint extends DetourNodeRef {
  raDeg: number;
  decDeg: number;
  /** 按子弧长度比例分配到的计划时刻（严格位于原段两端时刻之间，秒） */
  time: number;
  /** 在新轨迹总弧长中所处的累计比例（0,1)，用于核对时刻分配 */
  arcFraction: number;
}

export interface DetourSegmentPlan {
  /** 原段序号（从 0 起，即关键帧 index → index+1） */
  segmentIndex: number;
  startTime: number;
  endTime: number;
  /** 原段短弧转向角（度） */
  originalAngleDeg: number;
  /** 绕行后该段各子弧转向角之和（度） */
  newAngleDeg: number;
  /** 该段新增转向角（度）= newAngleDeg − originalAngleDeg（球面三角不等式下 ≥0） */
  addedAngleDeg: number;
  /** 该段经过的批准点（按经过顺序，无插入时为空） */
  inserted: DetourInsertedPoint[];
  /** 拆分后的全部新短弧（无插入时就是原短弧本身），按经过顺序 */
  subArcs: DetourSubArc[];
}

export interface DetourSuccess {
  feasible: true;
  /** 全部录入批准点（按录入顺序） */
  waypoints: Array<{
    index: number;
    name: string;
    raDeg: number;
    decDeg: number;
    /** 是否被最优建议采用 */
    used: boolean;
  }>;
  segments: DetourSegmentPlan[];
  totalInserted: number;
  totalOriginalAngleDeg: number;
  totalNewAngleDeg: number;
  /** 相对原计划增加的总转向角（度） */
  totalAddedAngleDeg: number;
}

export interface DetourFailure {
  feasible: false;
  /** 无可行走径的原因（面向操作员，可直接展示） */
  reasons: string[];
}

export type DetourResult = DetourSuccess | DetourFailure;

interface PreparedContext {
  keyframes: Array<{ time: number; raDeg: number; decDeg: number; point: Vec3 }>;
  bodies: Array<{ index: number; name: string; point: Vec3 }>;
  waypoints: Array<{ index: number; name: string; raDeg: number; decDeg: number; point: Vec3 }>;
  exclusionAngleDeg: number;
}

interface SegmentRoute {
  /** 该通道使用的批准点序号排列（段内经过顺序） */
  perm: number[];
  usedMask: number;
  /** 各子弧转向角（度） */
  arcAnglesDeg: number[];
  /** 新增转向角（度） */
  addedAngleDeg: number;
}

/**
 * 依据当前草稿与审核结论、录入的批准点生成绕行建议。
 * 草稿必须先通过原有校验（与直接审核同一套输入限制），批准点须通过
 * validateWaypoints；审核结论须确有违规段，否则绕行无从谈起。
 */
export function planDetour(
  state: PlannerFormState,
  audit: AuditResult,
  waypointInputs: WaypointInput[],
): DetourResult {
  const formErrors = validateForm(state);
  if (formErrors.length > 0) {
    return {
      feasible: false,
      reasons: ["原计划草稿未通过输入校验，请先修正后再生成绕行建议。"],
    };
  }
  const wpErrors = validateWaypoints(waypointInputs);
  if (wpErrors.length > 0) {
    return { feasible: false, reasons: wpErrors.map((e) => e.message) };
  }
  if (audit.segments.every((seg) => !seg.violated)) {
    return {
      feasible: false,
      reasons: ["当前审核结论已判定计划可执行，无需绕行。"],
    };
  }

  const ctx: PreparedContext = {
    keyframes: state.keyframes.map((kf) => {
      const raDeg = Number(kf.ra);
      const decDeg = Number(kf.dec);
      return {
        time: Number(kf.time),
        raDeg,
        decDeg,
        point: radecToUnitVector(raDeg, decDeg),
      };
    }),
    bodies: state.bodies.map((b, i) => ({
      index: i,
      name: b.name.trim(),
      point: radecToUnitVector(Number(b.ra), Number(b.dec)),
    })),
    waypoints: waypointInputs.map((w, i) => {
      const raDeg = Number(w.ra);
      const decDeg = Number(w.dec);
      return {
        index: i,
        name: w.name.trim(),
        raDeg,
        decDeg,
        point: radecToUnitVector(raDeg, decDeg),
      };
    }),
    exclusionAngleDeg: Number(state.exclusionAngle),
  };

  // ---- 硬性前置：原关键帧自身位于禁入区内则任何轨迹都无法放行 ----
  const hardReasons: string[] = [];
  ctx.keyframes.forEach((kf, ki) => {
    for (const body of ctx.bodies) {
      const d = toDegrees(angularSeparation(kf.point, body.point));
      if (d < ctx.exclusionAngleDeg) {
        hardReasons.push(
          `原关键帧 ${ki + 1}（RA=${kf.raDeg}°, Dec=${kf.decDeg}°）自身位于禁入天体「${body.name}」的禁入区内（角距 ${trimNum(d)}° < ${trimNum(ctx.exclusionAngleDeg)}°），绕行不改变关键帧指向，无法生成可行建议。`,
        );
      }
    }
  });
  if (hardReasons.length > 0) return { feasible: false, reasons: hardReasons };

  const segmentCount = ctx.keyframes.length - 1;

  // ---- 逐段枚举全部可行通道，并按「所用点集合」保留该集合最优者 ----
  const perSegmentRoutes: Map<number, SegmentRoute>[] = [];
  const deadSegments: number[] = [];

  for (let s = 0; s < segmentCount; s++) {
    const routes = enumerateSegmentRoutes(ctx, s);
    if (routes.length === 0) {
      deadSegments.push(s);
      perSegmentRoutes.push(new Map());
      continue;
    }
    // 同一 usedMask 下：新增角更小者胜；相等按排列的录入顺序字典序稳定裁决。
    const best = new Map<number, SegmentRoute>();
    for (const route of routes) {
      const cur = best.get(route.usedMask);
      if (!cur || compareRoute(route, cur) < 0) best.set(route.usedMask, route);
    }
    perSegmentRoutes.push(best);
  }

  if (deadSegments.length > 0) {
    return {
      feasible: false,
      reasons: deadSegments.map((s) => deadSegmentReason(ctx, s)),
    };
  }

  // ---- 跨段全局 DP：状态 = 已用批准点集合（同一批准点全程最多一次）----
  interface DpValue {
    addedAngleDeg: number;
    /** 每段选用的批准点排列（与段序号对齐） */
    perms: number[][];
  }
  let dp = new Map<number, DpValue>();
  dp.set(0, { addedAngleDeg: 0, perms: [] });

  for (let s = 0; s < segmentCount; s++) {
    const next = new Map<number, DpValue>();
    const routes = perSegmentRoutes[s];
    for (const [usedMask, val] of dp) {
      for (const [routeMask, route] of routes) {
        if (usedMask & routeMask) continue; // 批准点跨段互斥
        const newMask = usedMask | routeMask;
        const cand: DpValue = {
          addedAngleDeg: val.addedAngleDeg + route.addedAngleDeg,
          perms: [...val.perms, route.perm],
        };
        const prev = next.get(newMask);
        if (!prev || compareDpValue(cand, prev) < 0) next.set(newMask, cand);
      }
    }
    dp = next;
    if (dp.size === 0) break;
  }

  if (dp.size === 0) {
    return { feasible: false, reasons: conflictReasons(ctx, perSegmentRoutes) };
  }

  // ---- 全局最优：先最少新增点数，再最少新增总转向角，再稳定字典序 ----
  let bestMask = -1;
  let bestVal: DpValue | null = null;
  for (const [mask, val] of dp) {
    if (bestVal === null) {
      bestMask = mask;
      bestVal = val;
      continue;
    }
    const cntCmp = popCount(mask) - popCount(bestMask);
    if (cntCmp < 0) {
      bestMask = mask;
      bestVal = val;
    } else if (cntCmp === 0 && compareDpValue(val, bestVal) < 0) {
      bestMask = mask;
      bestVal = val;
    }
  }

  return buildSuccess(ctx, perSegmentRoutes, bestMask, bestVal!);
}

/**
 * 枚举一个原段内全部可行通道：从原段起点出发，经过至多 wpCount 个
 * 互不相同的批准点的任意排列，最后到达原段终点；要求每条子短弧
 * （含直连）都通过连续禁入判定。
 */
function enumerateSegmentRoutes(
  ctx: PreparedContext,
  segmentIndex: number,
): SegmentRoute[] {
  const start = ctx.keyframes[segmentIndex];
  const end = ctx.keyframes[segmentIndex + 1];
  const originalAngleDeg = toDegrees(
    angularSeparation(start.point, end.point),
  );

  // 节点：0=段起点，1=段终点，2+i=批准点 i
  const nodes: Vec3[] = [start.point, end.point, ...ctx.waypoints.map((w) => w.point)];
  const wOffset = 2;
  const nWp = ctx.waypoints.length;

  // 边安全矩阵：退化（相同/对跖）短弧不可通行；否则逐天体解析校核。
  const edgeSafe = (a: number, b: number): boolean => {
    const sep = angularSeparation(nodes[a], nodes[b]);
    if (sep <= DEGEN_EPS || sep >= Math.PI - DEGEN_EPS) return false;
    for (const body of ctx.bodies) {
      const { angle } = minAngularSeparationOnShortArc(
        nodes[a],
        nodes[b],
        body.point,
      );
      // 与审核完全一致：严格小于禁入角为越界，恰等于贴边放行。
      if (toDegrees(angle) < ctx.exclusionAngleDeg) return false;
    }
    return true;
  };

  const edgeOk: boolean[][] = nodes.map((_, i) =>
    nodes.map((__, j) => i !== j && edgeSafe(i, j)),
  );
  const edgeAngleDeg = (a: number, b: number): number =>
    toDegrees(angularSeparation(nodes[a], nodes[b]));

  const routes: SegmentRoute[] = [];

  const record = (perm: number[], arcAnglesDeg: number[]) => {
    const newAngleDeg = arcAnglesDeg.reduce((s, a) => s + a, 0);
    routes.push({
      perm,
      usedMask: perm.reduce((m, i) => m | (1 << i), 0),
      arcAnglesDeg,
      addedAngleDeg: newAngleDeg - originalAngleDeg,
    });
  };

  /** DFS：当前位于 nodeIdx，已用批准点集合 usedMask，沿途排列与子弧角。 */
  const dfs = (
    nodeIdx: number,
    usedMask: number,
    perm: number[],
    angles: number[],
  ) => {
    // 选择一：直接收尾到段终点（要求末条子弧安全）。
    if (edgeOk[nodeIdx][1]) {
      record(perm, [...angles, edgeAngleDeg(nodeIdx, 1)]);
    }
    // 选择二：走向尚未使用的批准点（按录入顺序展开，便于稳定裁决）。
    for (let i = 0; i < nWp; i++) {
      const bit = 1 << i;
      if (usedMask & bit) continue;
      const ni = wOffset + i;
      if (!edgeOk[nodeIdx][ni]) continue;
      dfs(
        ni,
        usedMask | bit,
        [...perm, i],
        [...angles, edgeAngleDeg(nodeIdx, ni)],
      );
    }
  };

  // 段起点的直连通道（无插入）与绕行走法统一枚举。
  dfs(0, 0, [], []);
  return routes;
}

/** 同段两条通道的优劣：新增角更小者优；相等按排列字典序（录入顺序）。 */
function compareRoute(a: SegmentRoute, b: SegmentRoute): number {
  if (a.addedAngleDeg < b.addedAngleDeg - ANGLE_TIE_EPS_DEG) return -1;
  if (a.addedAngleDeg > b.addedAngleDeg + ANGLE_TIE_EPS_DEG) return 1;
  return lexCompareArrays(a.perm, b.perm);
}

/** 全局 DP 值比较：新增总角相等时按「逐段排列拼接」的字典序稳定裁决。 */
function compareDpValue(a: { addedAngleDeg: number; perms: number[][] }, b: {
  addedAngleDeg: number;
  perms: number[][];
}): number {
  if (a.addedAngleDeg < b.addedAngleDeg - ANGLE_TIE_EPS_DEG) return -1;
  if (a.addedAngleDeg > b.addedAngleDeg + ANGLE_TIE_EPS_DEG) return 1;
  const n = Math.max(a.perms.length, b.perms.length);
  for (let i = 0; i < n; i++) {
    const c = lexCompareArrays(a.perms[i] ?? [], b.perms[i] ?? []);
    if (c !== 0) return c;
  }
  return 0;
}

/** 数字数组字典序：更短者在前（前缀情形），否则首个不同元素小者在前。 */
function lexCompareArrays(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function popCount(mask: number): number {
  let n = 0;
  while (mask) {
    n += mask & 1;
    mask >>= 1;
  }
  return n;
}

/** 构造成功结果：逐段给出经过的批准点、子弧角与按时长比例分配的时刻。 */
function buildSuccess(
  ctx: PreparedContext,
  perSegmentRoutes: Map<number, SegmentRoute>[],
  bestMask: number,
  bestVal: { addedAngleDeg: number; perms: number[][] },
): DetourSuccess {
  const segments: DetourSegmentPlan[] = [];
  let totalOriginal = 0;
  let totalNew = 0;
  const usedWaypoints = new Set<number>();

  for (let s = 0; s < ctx.keyframes.length - 1; s++) {
    const fromKf = ctx.keyframes[s];
    const toKf = ctx.keyframes[s + 1];
    const perm = bestVal.perms[s] ?? [];
    const route = perSegmentRoutes[s].get(
      perm.reduce((m, i) => m | (1 << i), 0),
    )!;
    const originalAngleDeg = toDegrees(
      angularSeparation(fromKf.point, toKf.point),
    );

    // 通道节点引用：原段起点 → 批准点排列 → 原段终点。
    const refs: DetourNodeRef[] = [
      { kind: "keyframe", index: s, name: `关键帧 ${s + 1}` },
      ...perm.map((i) => ({
        kind: "waypoint" as const,
        index: i,
        name: ctx.waypoints[i].name,
      })),
      { kind: "keyframe", index: s + 1, name: `关键帧 ${s + 2}` },
    ];

    const subArcs: DetourSubArc[] = route.arcAnglesDeg.map((angleDeg, k) => ({
      from: refs[k],
      to: refs[k + 1],
      angleDeg,
    }));

    // 新增时刻：按各子弧长度占新轨迹总弧长的比例，把原段时长严格分配
    // 在 [startTime, endTime] 之内；所有子弧角 > 0，故插入时刻严格居中。
    const totalArc = route.arcAnglesDeg.reduce((sum, a) => sum + a, 0);
    const duration = toKf.time - fromKf.time;
    const inserted: DetourInsertedPoint[] = [];
    let cumulative = 0;
    for (let k = 0; k < perm.length; k++) {
      cumulative += route.arcAnglesDeg[k];
      const fraction = cumulative / totalArc;
      const wpIndex = perm[k];
      const wp = ctx.waypoints[wpIndex];
      usedWaypoints.add(wpIndex);
      inserted.push({
        kind: "waypoint",
        index: wpIndex,
        name: wp.name,
        raDeg: wp.raDeg,
        decDeg: wp.decDeg,
        arcFraction: fraction,
        time: fromKf.time + fraction * duration,
      });
    }

    totalOriginal += originalAngleDeg;
    totalNew += route.arcAnglesDeg.reduce((sum, a) => sum + a, 0);
    segments.push({
      segmentIndex: s,
      startTime: fromKf.time,
      endTime: toKf.time,
      originalAngleDeg,
      newAngleDeg: totalArcOf(route),
      addedAngleDeg: route.addedAngleDeg,
      inserted,
      subArcs,
    });
  }

  return {
    feasible: true,
    waypoints: ctx.waypoints.map((w) => ({
      index: w.index,
      name: w.name,
      raDeg: w.raDeg,
      decDeg: w.decDeg,
      used: (bestMask & (1 << w.index)) !== 0,
    })),
    segments,
    totalInserted: popCount(bestMask),
    totalOriginalAngleDeg: totalOriginal,
    totalNewAngleDeg: totalNew,
    totalAddedAngleDeg: totalNew - totalOriginal,
  };
}

function totalArcOf(route: SegmentRoute): number {
  return route.arcAnglesDeg.reduce((s, a) => s + a, 0);
}

/** 某段即使动用全部批准点也无安全通道时的原因说明。 */
function deadSegmentReason(ctx: PreparedContext, s: number): string {
  const start = ctx.keyframes[s];
  const end = ctx.keyframes[s + 1];
  const usable = ctx.waypoints
    .filter((w) => isNodeUsable(ctx, w.point))
    .map((w) => `「${w.name}」`);
  const base =
    `第 ${s + 1} 段（关键帧 ${s + 1}→${s + 2}，RA ${trimNum(start.raDeg)}°/${trimNum(start.decDeg)}° → RA ${trimNum(end.raDeg)}°/${trimNum(end.decDeg)}°）：` +
    `即使使用全部 ${ctx.waypoints.length} 个批准点，也找不到一条全程不进入禁入区的连续短弧通道。`;
  if (usable.length === 0) {
    return `${base}（没有任何批准点自身处于全部禁入区之外可供落脚。）`;
  }
  return `${base}（可用批准点：${usable.join("、")}，但它们与该段端点拼不出安全路径，请增补更靠近越界侧的批准点。）`;
}

/** 节点（指向）自身是否处于所有禁入区之外。 */
function isNodeUsable(ctx: PreparedContext, p: Vec3): boolean {
  for (const body of ctx.bodies) {
    if (toDegrees(angularSeparation(p, body.point)) < ctx.exclusionAngleDeg) {
      return false;
    }
  }
  return true;
}

/**
 * 各段单独都有通道、但跨段「一点最多用一次」约束下无解时，
 * 给出可核对的原因：列出被迫共用同一批准点的段，以及各段可选点。
 */
function conflictReasons(
  ctx: PreparedContext,
  perSegmentRoutes: Map<number, SegmentRoute>[],
): string[] {
  const reasons: string[] = [];
  const segmentMasks: number[] = [];
  const forcedMasks: number[] = [];

  perSegmentRoutes.forEach((routes) => {
    let union = 0;
    let forced = 0;
    let first = true;
    for (const mask of routes.keys()) {
      union |= mask;
      forced = first ? mask : forced & mask;
      first = false;
    }
    segmentMasks.push(union);
    forcedMasks.push(first ? 0 : forced);
  });

  // 每一条通道都必须经过的批准点（forcedMask）在两段同时出现 → 本质冲突。
  const conflicts: string[] = [];
  for (let i = 0; i < forcedMasks.length; i++) {
    for (let j = i + 1; j < forcedMasks.length; j++) {
      const both = forcedMasks[i] & forcedMasks[j];
      if (both) {
        const names = ctx.waypoints
          .filter((w) => both & (1 << w.index))
          .map((w) => `「${w.name}」`)
          .join("、");
        conflicts.push(
          `第 ${i + 1} 段与第 ${j + 1} 段的任意安全通道都必须经过批准点 ${names}，但同一批准点全程最多使用一次。`,
        );
      }
    }
  }
  if (conflicts.length > 0) reasons.push(...conflicts);

  reasons.push(
    "各段单独绕行均有通道，但在「同一批准点整条计划最多使用一次」的约束下不存在全局可行的插入序列；请增补批准点后重试。各段可选批准点：" +
      perSegmentRoutes
        .map((_routes, s) => {
          const names = ctx.waypoints
            .filter((w) => segmentMasks[s] & (1 << w.index))
            .map((w) => `「${w.name}」`);
          return `第 ${s + 1} 段：${names.length ? names.join("、") : "（无需插入即可安全通过）"}`;
        })
        .join("；"),
  );
  return reasons;
}

/** 数字显示：去掉浮点尾差，保留至多 6 位小数。 */
export function trimNum(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return String(v);
  return v.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * 把成功的绕行建议一键写回：返回保留全部原关键帧顺序、在其间插入
 * 批准点的新关键帧录入列表。原关键帧的录入字符串原样保留；新增行
 * 使用批准点录入坐标与按弧长比例分配的时刻。
 */
export function buildDetourKeyframes(
  state: PlannerFormState,
  detour: DetourSuccess,
): KeyframeInput[] {
  const next: KeyframeInput[] = [];
  for (let s = 0; s <= state.keyframes.length - 1; s++) {
    next.push({ ...state.keyframes[s] });
    const plan = detour.segments.find((seg) => seg.segmentIndex === s);
    if (plan) {
      for (const ins of plan.inserted) {
        next.push({
          time: trimNum(ins.time),
          ra: trimNum(ins.raDeg),
          dec: trimNum(ins.decDeg),
        });
      }
    }
  }
  return next;
}
