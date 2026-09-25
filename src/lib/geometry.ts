/**
 * 球面几何工具：赤经/赤纬 → 单位向量，以及沿大圆弧的真实最小角距求解。
 *
 * 坐标约定（赤道直角坐标）：
 *   x 轴指向 (RA=0°,   Dec=0°)
 *   y 轴指向 (RA=90°,  Dec=0°)
 *   z 轴指向 (Dec=+90°，北天极)
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 赤经赤纬（度）换算为单位向量。
 * 赤经按三角函数自然处理 0°/360° 环绕；天极附近 cos(dec)→0，
 * 此时赤经失去几何意义（任意 RA 都收敛到天极向量），由公式本身保证。
 */
export function radecToUnitVector(raDeg: number, decDeg: number): Vec3 {
  const ra = toRadians(raDeg);
  const dec = toRadians(decDeg);
  const cosDec = Math.cos(dec);
  return {
    x: cosDec * Math.cos(ra),
    y: cosDec * Math.sin(ra),
    z: Math.sin(dec),
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** 两个单位向量之间的角距（弧度，[0, π]）；用 atan2 形式避免近 0°/180° 精度退化。 */
export function angularSeparation(a: Vec3, b: Vec3): number {
  const c = cross(a, b);
  return Math.atan2(
    Math.hypot(c.x, c.y, c.z),
    clamp(dot(a, b), -1, 1),
  );
}

export interface ArcMinResult {
  /** 沿短弧相对目标天体的真实最小角距（弧度） */
  angle: number;
  /** 取得最小值处的短弧参数 t ∈ [0,1]：0=起点，1=终点，0.5=弧中点 */
  t: number;
}

/**
 * 求单位向量 b（禁入天体）到 p→q 最短大圆弧（短弧，θ∈(0,π)）的最小角距。
 *
 * 短弧上的点以弧长角 u=tθ（u∈[0,θ]）连续参数化（SLERP）：
 *
 *   r(u) = [ p·sin(θ-u) + q·sin(u) ] / sin θ
 *
 * 角距 δ(u)=acos(r·b) 在短弧范围内关于 (r·b) 单调递减，
 * 因此「最小角距」等价于「r·b 的最大值」——连续函数在闭区间上的极值，
 * 只需比较两个端点与驻点，无需（也不能依赖）离散取样：
 *
 *   f(u) = r(u)·b = [ A·sin(θ-u) + C·sin(u) ] / sin θ
 *   其中 A = p·b，C = q·b
 *   f'(u) = 0  ⇒  C·cos u = A·cos(θ-u)
 *            ⇒  tan u = (C − A·cos θ) / (A·sin θ)
 *
 * 解出 u₀=atan2(C−A·c, A·s)，驻点每 π 重复一次，落入 (0,θ) 者纳入比较。
 *
 * 注意：p、q 相同（θ=0）或反向（θ=π）时不存在唯一最短大圆轨迹，
 * 必须由输入校验层拒绝；此处仅做防御性兜底（按起点处理）。
 */
export function minAngularSeparationOnShortArc(
  p: Vec3,
  q: Vec3,
  b: Vec3,
): ArcMinResult {
  const c = clamp(dot(p, q), -1, 1);

  // 防御性兜底：正常流程不会走到这里（校验已拒绝相同/反向相邻关键帧）。
  if (c >= 1 || c <= -1) {
    return { angle: angularSeparation(p, b), t: 0 };
  }

  const theta = Math.acos(c); // 短弧圆心角 ∈ (0, π)
  const s = Math.sqrt(Math.max(0, 1 - c * c)); // sin θ
  const A = dot(p, b);
  const C = dot(q, b);

  const f = (u: number): number =>
    (A * Math.sin(theta - u) + C * Math.sin(u)) / s;

  // 候选 1：两个端点（u=0 → p，u=θ → q，f 分别等于 A、C）。
  let bestU: number;
  let bestF: number;
  if (A >= C) {
    bestU = 0;
    bestF = A;
  } else {
    bestU = theta;
    bestF = C;
  }

  // 候选 2：内部驻点（u₀ 及其平移 π 的等价解，取落入开区间 (0,θ) 者）。
  const u0 = Math.atan2(C - A * c, A * s);
  for (const cand of [u0 - Math.PI, u0, u0 + Math.PI]) {
    if (cand > 0 && cand < theta) {
      const fv = f(cand);
      if (fv > bestF) {
        bestF = fv;
        bestU = cand;
      }
    }
  }

  // 在最优处显式求出视轴向量，用 atan2(|r×b|, r·b) 计算角距——
  // 相比直接 acos(bestF)，在角距接近 0°/180° 时不会丢精度。
  const r = evalArc(p, q, theta, bestU);
  const cr = cross(r, b);
  const crossNorm = Math.hypot(cr.x, cr.y, cr.z);
  const angle = Math.atan2(Math.max(0, crossNorm), clamp(dot(r, b), -1, 1));
  return { angle, t: bestU / theta };
}

/** 短弧 p→q（圆心角 θ）在弧长角 u∈[0,θ] 处的点（SLERP）。 */
function evalArc(p: Vec3, q: Vec3, theta: number, u: number): Vec3 {
  const sinTheta = Math.sin(theta);
  const a = Math.sin(theta - u) / sinTheta;
  const b = Math.sin(u) / sinTheta;
  return {
    x: a * p.x + b * q.x,
    y: a * p.y + b * q.y,
    z: a * p.z + b * q.z,
  };
}
