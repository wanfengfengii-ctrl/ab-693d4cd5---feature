import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

async function audit() {
  await userEvent.click(screen.getByTestId("audit-button"));
}

describe("App：录入与审核流程", () => {
  it("默认安全草稿：审核后明确显示可执行与逐段最小角距", async () => {
    render(<App />);
    await audit();
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();
    expect(screen.getByText(/计划可执行/)).toBeInTheDocument();
    // 逐段明细：1 个段，天体名称渲染在明细表中
    expect(screen.getByText(/第 1 段/)).toBeInTheDocument();
    expect(screen.getByText(/1\. 太阳/)).toBeInTheDocument();
  });

  it("弧内扫过太阳：仅端点安全也判违规，并给出首个越界见证", async () => {
    render(<App />);
    // 把关键帧改为跨 RA=0° 的短弧 350°→10°，太阳放在弧上 0°
    await userEvent.clear(screen.getByLabelText("关键帧 1 时刻"));
    await userEvent.type(screen.getByLabelText("关键帧 1 时刻"), "0");
    await userEvent.clear(screen.getByLabelText("关键帧 1 赤经"));
    await userEvent.type(screen.getByLabelText("关键帧 1 赤经"), "350");
    await userEvent.clear(screen.getByLabelText("关键帧 1 赤纬"));
    await userEvent.type(screen.getByLabelText("关键帧 1 赤纬"), "0");

    await userEvent.clear(screen.getByLabelText("关键帧 2 时刻"));
    await userEvent.type(screen.getByLabelText("关键帧 2 时刻"), "200");
    await userEvent.clear(screen.getByLabelText("关键帧 2 赤经"));
    await userEvent.type(screen.getByLabelText("关键帧 2 赤经"), "10");
    await userEvent.clear(screen.getByLabelText("关键帧 2 赤纬"));
    await userEvent.type(screen.getByLabelText("关键帧 2 赤纬"), "0");

    await userEvent.clear(screen.getByLabelText("天体 1 赤经"));
    await userEvent.type(screen.getByLabelText("天体 1 赤经"), "0");
    await userEvent.clear(screen.getByLabelText("天体 1 赤纬"));
    await userEvent.type(screen.getByLabelText("天体 1 赤纬"), "0");

    await audit();
    const fail = screen.getByTestId("verdict-fail");
    expect(fail).toBeInTheDocument();
    expect(within(fail).getByText(/计划不可执行/)).toBeInTheDocument();
    // 见证中包含段、天体、越界时刻与真实最小角距 0°
    expect(within(fail).getByText(/第 1 段/)).toBeInTheDocument();
    expect(within(fail).getByText(/太阳/)).toBeInTheDocument();
    expect(within(fail).getByText(/t = 100/)).toBeInTheDocument();
    expect(within(fail).getByText(/最小角距 = 0°/)).toBeInTheDocument();
  });

  it("任何草稿改动都会立即撤下旧结论，需重新审核", async () => {
    render(<App />);
    await audit();
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();

    // 改动禁入角 → 旧结论撤下
    await userEvent.type(screen.getByTestId("exclusion-angle"), "0");
    expect(screen.queryByTestId("audit-result")).not.toBeInTheDocument();

    // 恢复为合法值并重新审核 → 结论重现
    await userEvent.clear(screen.getByTestId("exclusion-angle"));
    await userEvent.type(screen.getByTestId("exclusion-angle"), "15");
    expect(screen.queryByTestId("audit-result")).not.toBeInTheDocument();
    await audit();
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();

    // 添加关键帧同样撤下结论
    await userEvent.click(screen.getByRole("button", { name: "+ 添加关键帧" }));
    expect(screen.queryByTestId("audit-result")).not.toBeInTheDocument();
  });

  it("非法输入：审核展示校验错误而非几何结论", async () => {
    render(<App />);
    // 时刻倒序
    await userEvent.clear(screen.getByLabelText("关键帧 2 时刻"));
    await userEvent.type(screen.getByLabelText("关键帧 2 时刻"), "0");
    // 禁入角非正
    await userEvent.clear(screen.getByTestId("exclusion-angle"));
    await userEvent.type(screen.getByTestId("exclusion-angle"), "-3");

    await audit();
    const errors = screen.getByTestId("audit-errors");
    expect(errors).toBeInTheDocument();
    expect(errors.textContent).toContain("严格递增");
    expect(errors.textContent).toContain("正数");
    expect(screen.queryByTestId("audit-result")).not.toBeInTheDocument();
  });

  it("重名天体被拒绝，改名唯一后可审核通过", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "+ 添加禁入天体" }));
    await userEvent.type(screen.getByLabelText("天体 2 名称"), "太阳");
    await userEvent.type(screen.getByLabelText("天体 2 赤经"), "270");
    await userEvent.type(screen.getByLabelText("天体 2 赤纬"), "0");

    await audit();
    expect(screen.getByTestId("audit-errors").textContent).toContain("重复");

    await userEvent.clear(screen.getByLabelText("天体 2 名称"));
    await userEvent.type(screen.getByLabelText("天体 2 名称"), "月球");
    await audit();
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();
  });

  it("同段多天体均违规时，见证按天体输入顺序取第一个", async () => {
    render(<App />);
    // 关键帧：0°→90° 赤道弧
    for (const [label, value] of [
      ["关键帧 1 时刻", "0"],
      ["关键帧 1 赤经", "0"],
      ["关键帧 1 赤纬", "0"],
      ["关键帧 2 时刻", "10"],
      ["关键帧 2 赤经", "90"],
      ["关键帧 2 赤纬", "0"],
    ] as const) {
      await userEvent.clear(screen.getByLabelText(label));
      await userEvent.type(screen.getByLabelText(label), value);
    }
    // 天体 1 月球在 (30,0) 弧上；再添加太阳 (45,0)
    await userEvent.clear(screen.getByLabelText("天体 1 名称"));
    await userEvent.type(screen.getByLabelText("天体 1 名称"), "月球");
    await userEvent.clear(screen.getByLabelText("天体 1 赤经"));
    await userEvent.type(screen.getByLabelText("天体 1 赤经"), "30");
    await userEvent.clear(screen.getByLabelText("天体 1 赤纬"));
    await userEvent.type(screen.getByLabelText("天体 1 赤纬"), "0");

    await userEvent.click(screen.getByRole("button", { name: "+ 添加禁入天体" }));
    await userEvent.type(screen.getByLabelText("天体 2 名称"), "太阳");
    await userEvent.type(screen.getByLabelText("天体 2 赤经"), "45");
    await userEvent.type(screen.getByLabelText("天体 2 赤纬"), "0");

    await audit();
    const fail = screen.getByTestId("verdict-fail");
    expect(within(fail).getByText(/第 1 个天体「月球」/)).toBeInTheDocument();
  });
});

// 把默认草稿改成一条扫过太阳 (60°,0°) 的赤道弧 0°→120°，禁入角 15°。
async function setupSweepingArc() {
  render(<App />);
  for (const [label, value] of [
    ["关键帧 1 时刻", "0"],
    ["关键帧 1 赤经", "0"],
    ["关键帧 1 赤纬", "0"],
    ["关键帧 2 时刻", "200"],
    ["关键帧 2 赤经", "120"],
    ["关键帧 2 赤纬", "0"],
    ["天体 1 赤经", "60"],
    ["天体 1 赤纬", "0"],
  ] as const) {
    const el = screen.getByLabelText(label);
    await userEvent.clear(el);
    await userEvent.type(el, value);
  }
  await userEvent.click(screen.getByTestId("audit-button"));
  expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();
}

describe("App：批准点绕行建议流程", () => {
  it("录入合法批准点 → 生成建议：逐原段展示经过点、子弧角与按时长比例分配的新增时刻", async () => {
    await setupSweepingArc();

    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "北侧点");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "60");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "60");
    await userEvent.click(screen.getByTestId("detour-button"));

    const ok = screen.getByTestId("detour-ok");
    expect(ok).toBeInTheDocument();
    // 采用 1 个新增转折点
    expect(within(ok).getByText(/新增转折点 1 个/)).toBeInTheDocument();
    // 逐原段展示
    const seg = screen.getByTestId("detour-seg-0");
    expect(within(seg).getByText(/原第 1 段/)).toBeInTheDocument();
    expect(within(seg).getByText(/经过批准点：/)).toBeInTheDocument();
    expect(within(seg).getByText(/「北侧点」\(RA=60°/)).toBeInTheDocument();
    // 两条子弧，各约 75.52°；等长 → 插入时刻恰为原段中点 100 秒
    expect(within(seg).getAllByText(/75\.522/).length).toBe(2);
    expect(within(seg).getByText(/t=100/)).toBeInTheDocument();
  });

  it("一键写回关键帧并重新审核 → 原顺序保留、新增点插入、审核转为可执行", async () => {
    await setupSweepingArc();
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "北侧点");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "60");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "60");
    await userEvent.click(screen.getByTestId("detour-button"));
    await userEvent.click(screen.getByTestId("write-back-button"));

    // 写回后自动重新审核，结论转为可执行，绕行面板随之撤下。
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();
    expect(screen.queryByTestId("detour-ok")).not.toBeInTheDocument();
    // 关键帧由 2 个变为 3 个：原起点 → 插入点(时刻100) → 原终点
    expect(screen.getByTestId("keyframe-row-2")).toBeInTheDocument();
    expect(screen.getByLabelText("关键帧 2 时刻")).toHaveValue("100");
    expect(screen.getByLabelText("关键帧 2 赤经")).toHaveValue("60");
    expect(screen.getByLabelText("关键帧 2 赤纬")).toHaveValue("60");
    // 原首末关键帧坐标原样保留、顺序不变
    expect(screen.getByLabelText("关键帧 1 赤经")).toHaveValue("0");
    expect(screen.getByLabelText("关键帧 3 赤经")).toHaveValue("120");
  });

  it("批准点自身位于禁入区：无可行路径时说明原因，且原草稿与审核结论不被改写", async () => {
    await setupSweepingArc();
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "坏点");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "60");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "5"); // 距太阳仅 5°
    await userEvent.click(screen.getByTestId("detour-button"));

    const fail = screen.getByTestId("detour-fail");
    expect(fail).toBeInTheDocument();
    expect(fail.textContent).toContain("第 1 段");
    // 原审核失败结论仍在，草稿关键帧数量未变
    expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();
    expect(screen.queryByTestId("keyframe-row-2")).not.toBeInTheDocument();
  });

  it("批准点重名或为空时无法生成（就地报错且按钮禁用）", async () => {
    await setupSweepingArc();
    await userEvent.click(screen.getByRole("button", { name: "+ 添加批准点" }));
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "同点");
    await userEvent.type(screen.getByLabelText("批准点 2 名称"), "同点");
    expect(screen.getByTestId("detour-button")).toBeDisabled();
    expect(screen.getByText(/名称「同点」.*重复/)).toBeInTheDocument();

    // 改名唯一且补全坐标后可生成
    await userEvent.clear(screen.getByLabelText("批准点 2 名称"));
    await userEvent.type(screen.getByLabelText("批准点 2 名称"), "另点");
    for (const [label, ra, dec] of [
      ["批准点 1", "60", "60"],
      ["批准点 2", "60", "-60"],
    ] as const) {
      await userEvent.type(screen.getByLabelText(`${label} 赤经`), ra);
      await userEvent.type(screen.getByLabelText(`${label} 赤纬`), dec);
    }
    expect(screen.getByTestId("detour-button")).not.toBeDisabled();
  });

  it("批准点支持 1–8 个；改动批准点录入会撤下既有绕行建议", async () => {
    await setupSweepingArc();
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "北侧点");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "60");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "60");
    await userEvent.click(screen.getByTestId("detour-button"));
    expect(screen.getByTestId("detour-ok")).toBeInTheDocument();

    // 再加一个批准点 → 旧建议撤下
    await userEvent.click(screen.getByRole("button", { name: "+ 添加批准点" }));
    expect(screen.queryByTestId("detour-ok")).not.toBeInTheDocument();

    // 可一直添加到 8 个，添加按钮随后禁用
    for (let i = 0; i < 6; i++) {
      await userEvent.click(screen.getByRole("button", { name: "+ 添加批准点" }));
    }
    expect(screen.getByTestId("waypoint-table").querySelectorAll("tbody tr")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "+ 添加批准点" })).toBeDisabled();
  });

  it("审核通过时不展示绕行录入区", async () => {
    render(<App />);
    await audit();
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();
    expect(screen.queryByTestId("detour-button")).not.toBeInTheDocument();
  });
});
