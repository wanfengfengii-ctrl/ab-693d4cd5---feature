import { useMemo, useState } from "react";
import {
  auditPlan,
  firstViolation,
  type AuditOutcome,
  type SegmentResult,
} from "./lib/planner";
import {
  MAX_BODIES,
  MAX_KEYFRAMES,
  MIN_BODIES,
  MIN_KEYFRAMES,
  validateForm,
  type BodyInput,
  type KeyframeInput,
  type PlannerFormState,
  type ValidationError,
} from "./lib/validation";

const initialState: PlannerFormState = {
  keyframes: [
    { time: "0", ra: "10", dec: "0" },
    { time: "120", ra: "80", dec: "20" },
  ],
  exclusionAngle: "15",
  bodies: [{ name: "太阳", ra: "180", dec: "0" }],
};

/** 数字显示：去掉浮点尾差，保留至多 6 位小数。 */
function fmt(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return String(v);
  const fixed = v.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

function errorKey(e: ValidationError): string {
  return `${e.scope}:${e.index}:${e.field}`;
}

export default function App() {
  const [state, setState] = useState<PlannerFormState>(initialState);
  // 审核结论：仅在点击「审核」时生成；草稿的任何改动都会立即置空撤下。
  const [outcome, setOutcome] = useState<AuditOutcome | null>(null);

  // 实时校验只用于输入框就地提示，不代表计划结论。
  const liveErrors = useMemo(() => validateForm(state), [state]);
  const errorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of liveErrors) {
      const k = errorKey(e);
      m.set(k, m.has(k) ? `${m.get(k)}；${e.message}` : e.message);
    }
    return m;
  }, [liveErrors]);

  const formErrors = liveErrors.filter((e) => e.scope === "form");

  /** 任何草稿改动都经此入口：先撤下旧结论，再写入草稿。 */
  function mutate(producer: (draft: PlannerFormState) => void) {
    setState((prev) => {
      const draft: PlannerFormState = {
        keyframes: prev.keyframes.map((k) => ({ ...k })),
        exclusionAngle: prev.exclusionAngle,
        bodies: prev.bodies.map((b) => ({ ...b })),
      };
      producer(draft);
      return draft;
    });
    setOutcome(null);
  }

  function patchKeyframe(i: number, patch: Partial<KeyframeInput>) {
    mutate((d) => {
      d.keyframes[i] = { ...d.keyframes[i], ...patch };
    });
  }

  function patchBody(i: number, patch: Partial<BodyInput>) {
    mutate((d) => {
      d.bodies[i] = { ...d.bodies[i], ...patch };
    });
  }

  function addKeyframe() {
    if (state.keyframes.length >= MAX_KEYFRAMES) return;
    mutate((d) => d.keyframes.push({ time: "", ra: "", dec: "" }));
  }

  function removeKeyframe(i: number) {
    if (state.keyframes.length <= MIN_KEYFRAMES) return;
    mutate((d) => d.keyframes.splice(i, 1));
  }

  function addBody() {
    if (state.bodies.length >= MAX_BODIES) return;
    mutate((d) => d.bodies.push({ name: "", ra: "", dec: "" }));
  }

  function removeBody(i: number) {
    if (state.bodies.length <= MIN_BODIES) return;
    mutate((d) => d.bodies.splice(i, 1));
  }

  function runAudit() {
    setOutcome(auditPlan(state));
  }

  const fieldError = (
    scope: "form" | "keyframe" | "body",
    index: number,
    field: string,
  ) => errorMap.get(`${scope}:${index}:${field}`);

  return (
    <div className="app">
      <header className="app-header">
        <h1>星敏感器标定转向 · 禁入区审核</h1>
        <p>
          逐段沿最短大圆弧（短弧）连续求解视轴相对每个禁入天体的真实最小角距；
          赤经 0°/360° 环绕与天极指向按单位向量统一换算。仅端点间距或离散采样不作为放行依据。
        </p>
      </header>

      <section className="panel" aria-label="关键帧录入">
        <h2>
          视轴指向关键帧
          <span className="hint">
            {state.keyframes.length}/{MAX_KEYFRAMES} 帧 · 时刻严格递增 · RA
            ∈[0°,360°) · Dec∈[-90°,90°]
          </span>
        </h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 44 }}>#</th>
              <th style={{ width: 150 }}>时刻 t（秒）</th>
              <th style={{ width: 150 }}>赤经 RA（°）</th>
              <th style={{ width: 150 }}>赤纬 Dec（°）</th>
              <th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {state.keyframes.map((kf, i) => {
              const tErr = fieldError("keyframe", i, "time");
              const raErr = fieldError("keyframe", i, "ra");
              const decErr = fieldError("keyframe", i, "dec");
              return (
                <tr key={i} data-testid={`keyframe-row-${i}`}>
                  <td>{i + 1}</td>
                  <td>
                    <input
                      aria-label={`关键帧 ${i + 1} 时刻`}
                      className={tErr ? "invalid" : ""}
                      value={kf.time}
                      inputMode="decimal"
                      onChange={(e) =>
                        patchKeyframe(i, { time: e.target.value })
                      }
                    />
                    {tErr && <div className="row-error">{tErr}</div>}
                  </td>
                  <td>
                    <input
                      aria-label={`关键帧 ${i + 1} 赤经`}
                      className={raErr ? "invalid" : ""}
                      value={kf.ra}
                      inputMode="decimal"
                      onChange={(e) =>
                        patchKeyframe(i, { ra: e.target.value })
                      }
                    />
                    {raErr && <div className="row-error">{raErr}</div>}
                  </td>
                  <td>
                    <input
                      aria-label={`关键帧 ${i + 1} 赤纬`}
                      className={decErr ? "invalid" : ""}
                      value={kf.dec}
                      inputMode="decimal"
                      onChange={(e) =>
                        patchKeyframe(i, { dec: e.target.value })
                      }
                    />
                    {decErr && <div className="row-error">{decErr}</div>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-remove"
                      aria-label={`删除关键帧 ${i + 1}`}
                      disabled={state.keyframes.length <= MIN_KEYFRAMES}
                      onClick={() => removeKeyframe(i)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="toolbar">
          <button
            type="button"
            onClick={addKeyframe}
            disabled={state.keyframes.length >= MAX_KEYFRAMES}
          >
            + 添加关键帧
          </button>
        </div>
      </section>

      <section className="panel" aria-label="禁入设置">
        <h2>禁入规则</h2>
        <div className="exclusion-row">
          <label htmlFor="exclusion-angle">统一禁入角：</label>
          <input
            id="exclusion-angle"
            data-testid="exclusion-angle"
            className={fieldError("form", -1, "exclusionAngle") ? "invalid" : ""}
            value={state.exclusionAngle}
            inputMode="decimal"
            onChange={(e) =>
              mutate((d) => {
                d.exclusionAngle = e.target.value;
              })
            }
          />
          <span>°（正数；短弧上任意点角距小于此值即违规，恰等于视为贴边放行）</span>
        </div>
        {fieldError("form", -1, "exclusionAngle") && (
          <div className="row-error">
            {fieldError("form", -1, "exclusionAngle")}
          </div>
        )}

        <h2 style={{ marginTop: 18 }}>
          禁入天体
          <span className="hint">
            {state.bodies.length}/{MAX_BODIES} 个 · 名称唯一
          </span>
        </h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 44 }}>#</th>
              <th style={{ width: 180 }}>名称</th>
              <th style={{ width: 150 }}>赤经 RA（°）</th>
              <th style={{ width: 150 }}>赤纬 Dec（°）</th>
              <th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {state.bodies.map((body, i) => {
              const nErr = fieldError("body", i, "name");
              const raErr = fieldError("body", i, "ra");
              const decErr = fieldError("body", i, "dec");
              return (
                <tr key={i} data-testid={`body-row-${i}`}>
                  <td>{i + 1}</td>
                  <td>
                    <input
                      aria-label={`天体 ${i + 1} 名称`}
                      className={nErr ? "invalid" : ""}
                      value={body.name}
                      onChange={(e) =>
                        patchBody(i, { name: e.target.value })
                      }
                    />
                    {nErr && <div className="row-error">{nErr}</div>}
                  </td>
                  <td>
                    <input
                      aria-label={`天体 ${i + 1} 赤经`}
                      className={raErr ? "invalid" : ""}
                      value={body.ra}
                      inputMode="decimal"
                      onChange={(e) => patchBody(i, { ra: e.target.value })}
                    />
                    {raErr && <div className="row-error">{raErr}</div>}
                  </td>
                  <td>
                    <input
                      aria-label={`天体 ${i + 1} 赤纬`}
                      className={decErr ? "invalid" : ""}
                      value={body.dec}
                      inputMode="decimal"
                      onChange={(e) => patchBody(i, { dec: e.target.value })}
                    />
                    {decErr && <div className="row-error">{decErr}</div>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-remove"
                      aria-label={`删除天体 ${i + 1}`}
                      disabled={state.bodies.length <= MIN_BODIES}
                      onClick={() => removeBody(i)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="toolbar">
          <button
            type="button"
            onClick={addBody}
            disabled={state.bodies.length >= MAX_BODIES}
          >
            + 添加禁入天体
          </button>
        </div>
      </section>

      <section className="panel audit-bar">
        <button
          type="button"
          className="primary"
          onClick={runAudit}
          data-testid="audit-button"
        >
          审核计划
        </button>
        <span className="hint">
          审核结论仅对当前草稿有效；修改任意录入项会立即撤下旧结论，需重新审核。
        </span>
      </section>

      {outcome === null ? null : !outcome.ok ? (
        <section className="panel" data-testid="audit-errors" aria-label="输入错误">
          <h2 style={{ color: "var(--bad)" }}>输入未通过校验，无法审核</h2>
          <ul className="error-list">
            {outcome.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </section>
      ) : (
        <Conclusion outcome={outcome} />
      )}

      {formErrors.length > 0 && outcome === null && (
        <p className="hint">提示：当前草稿尚有 {formErrors.length} 项顶层问题待处理。</p>
      )}
    </div>
  );
}

function Conclusion({ outcome }: { outcome: NonNullable<AuditOutcome> }) {
  if (!outcome.ok) return null;
  const violation = firstViolation(outcome);

  return (
    <section aria-label="审核结论" data-testid="audit-result">
      {violation === null ? (
        <div className="verdict pass" data-testid="verdict-pass">
          <h3>✓ 结论：计划可执行</h3>
          <p>
            全部 {outcome.segments.length} 个相邻段沿短弧连续校核通过，任一时刻视轴与各禁入天体角距均
            ≥ {fmt(outcome.exclusionAngleDeg, 4)}°。
          </p>
          <p>
            全程最小角距为{" "}
            <strong>{fmt(outcome.globalMinAngleDeg)}°</strong>。
          </p>
          {outcome.contacts.length > 0 && (
            <div className="contact-note">
              ⚠ 有 {outcome.contacts.length}{" "}
              处恰好贴在禁入区边界（角距等于禁入角），按贴边放行，建议操作员复核：
              <ul className="error-list">
                {outcome.contacts.map((c, i) => (
                  <li key={i}>
                    第 {c.segmentIndex + 1} 段 · 天体「{c.bodyName}」· t=
                    {fmt(c.time)} 秒
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="verdict fail" data-testid="verdict-fail">
          <h3>✗ 结论：计划不可执行</h3>
          <p>
            检测到视轴最短大圆轨迹扫入禁入区。以下为按
            <strong> 时间（段顺序）→ 天体输入顺序 </strong>
            确定的首个越界见证：
          </p>
          <div className="witness">
            第 {violation.segmentIndex + 1} 段（关键帧{" "}
            {violation.segmentIndex + 1}→{violation.segmentIndex + 2}）· 第{" "}
            {violation.bodyIndex + 1} 个天体「{violation.bodyName}」
            <br />
            越界时刻 t = {fmt(violation.time)} 秒
            <br />
            该点真实最小角距 = {fmt(violation.minAngleDeg)}° &lt; 禁入角{" "}
            {fmt(violation.exclusionAngleDeg, 4)}°
          </div>
        </div>
      )}

      <h2 style={{ margin: "16px 2px 10px", fontSize: 15 }}>逐段最小角距明细</h2>
      {outcome.segments.map((seg) => (
        <SegmentCard
          key={seg.index}
          seg={seg}
          exclusionAngleDeg={outcome.exclusionAngleDeg}
        />
      ))}
    </section>
  );
}

function SegmentCard({
  seg,
  exclusionAngleDeg,
}: {
  seg: SegmentResult;
  exclusionAngleDeg: number;
}) {
  return (
    <div className={`seg-card${seg.violated ? " bad" : ""}`}>
      <div className="seg-title">
        <span>
          第 {seg.index + 1} 段 · 关键帧 {seg.fromKeyframe + 1}→
          {seg.toKeyframe + 1} · t ∈ [{fmt(seg.startTime)},{" "}
          {fmt(seg.endTime)}] 秒
        </span>
        <span className="seg-min">
          段内最小角距：{fmt(seg.minAngleDeg)}°
          {seg.violated ? "（违规）" : ""}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>禁入天体</th>
            <th className="num">真实最小角距（°）</th>
            <th className="num">达到时刻 t（秒）</th>
            <th className="num">短弧位置</th>
            <th className="num">判定</th>
          </tr>
        </thead>
        <tbody>
          {seg.perBody.map((r) => {
            const touching =
              !r.violated &&
              Math.abs(r.minAngleDeg - exclusionAngleDeg) <= 1e-9;
            return (
              <tr key={r.bodyIndex}>
                <td>
                  {r.bodyIndex + 1}. {r.bodyName}
                </td>
                <td className={`num${r.violated ? " cell-bad" : ""}`}>
                  {fmt(r.minAngleDeg)}
                </td>
                <td className="num">{fmt(r.time)}</td>
                <td className="num">
                  {r.t === 0
                    ? "段起点"
                    : r.t === 1
                      ? "段终点"
                      : `弧内 ${(r.t * 100).toFixed(2)}%`}
                </td>
                <td
                  className={`num ${
                    r.violated
                      ? "cell-bad"
                      : touching
                        ? "cell-touch"
                        : "cell-ok"
                  }`}
                >
                  {r.violated ? "越界" : touching ? "贴边" : "安全"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
