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

describe("App：批准转折指向与绕行建议", () => {
  /** 录入一个必然违规的单段计划：0°→90° 穿过 (45°,0°) 的太阳，t∈[0,200]。 */
  async function setupViolatingPlan() {
    render(<App />);
    for (const [label, value] of [
      ["关键帧 1 时刻", "0"],
      ["关键帧 1 赤经", "0"],
      ["关键帧 1 赤纬", "0"],
      ["关键帧 2 时刻", "200"],
      ["关键帧 2 赤经", "90"],
      ["关键帧 2 赤纬", "0"],
      ["天体 1 赤经", "45"],
      ["天体 1 赤纬", "0"],
    ] as const) {
      await userEvent.clear(screen.getByLabelText(label));
      await userEvent.type(screen.getByLabelText(label), value);
    }
    await audit();
    expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();
  }

  it("未录入批准点时生成按钮禁用；录入不合法也禁用", async () => {
    await setupViolatingPlan();
    expect(screen.getByTestId("generate-detour")).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    // 名称为空、坐标为空
    expect(screen.getByTestId("generate-detour")).toBeDisabled();
  });

  it("录入批准点不撤下审核失败结论；但会撤下已生成的旧建议", async () => {
    await setupViolatingPlan();
    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "P北");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "45");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "20");
    // 审核失败结论仍在
    expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("generate-detour"));
    expect(screen.getByTestId("detour-ok")).toBeInTheDocument();

    // 改动批准点：旧建议撤下，审核结论保留
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "21");
    expect(screen.queryByTestId("detour-ok")).not.toBeInTheDocument();
    expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();
  });

  it("生成建议：逐原段展示批准点、子弧角度与按时长比例分配的时刻", async () => {
    await setupViolatingPlan();
    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "P北");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "45");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "20");
    await userEvent.click(screen.getByTestId("generate-detour"));

    const ok = screen.getByTestId("detour-ok");
    expect(ok).toBeInTheDocument();
    // 新增 1 个转折点、增量约 6.72°
    expect(ok.textContent).toContain("新增转折点 1 个");
    // 原段经过批准点 P北
    expect(ok.textContent).toContain("经过批准点：1");
    // 两条子弧（角度 ≈48.359°，时刻 0→100→200）
    expect(
      screen.getByTestId("detour-subarc-0-0").textContent,
    ).toContain("P北");
    expect(screen.getByTestId("detour-subarc-0-0").textContent).toContain(
      "48.358857",
    );
    expect(screen.getByTestId("detour-subarc-0-1").textContent).toContain(
      "关键帧 2",
    );
    // 分配时刻：等长两子弧 ⇒ 100 秒
    const row0 = screen.getByTestId("detour-subarc-0-0").textContent!;
    expect(row0).toContain("100");
  });

  it("一键写回关键帧并立即重新审核：原帧保留、新帧时间严格落在原时段内且审核通过", async () => {
    await setupViolatingPlan();
    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "P北");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "45");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "20");
    await userEvent.click(screen.getByTestId("generate-detour"));
    await userEvent.click(screen.getByTestId("apply-detour"));

    // 立即重新审核 → 可执行
    expect(screen.getByTestId("verdict-pass")).toBeInTheDocument();
    // 关键帧变为 3 行：K(0,0) → P北(45,20)@100 → K(90,0)@200
    expect(screen.getAllByTestId(/keyframe-row-/)).toHaveLength(3);
    expect(
      (screen.getByLabelText("关键帧 2 时刻") as HTMLInputElement).value,
    ).toBe("100");
    expect(
      (screen.getByLabelText("关键帧 2 赤经") as HTMLInputElement).value,
    ).toBe("45");
    expect(
      (screen.getByLabelText("关键帧 2 赤纬") as HTMLInputElement).value,
    ).toBe("20");
    expect(
      (screen.getByLabelText("关键帧 3 时刻") as HTMLInputElement).value,
    ).toBe("200");
    expect(
      (screen.getByLabelText("关键帧 3 赤经") as HTMLInputElement).value,
    ).toBe("90");
  });

  it("无可行路径：说明原因，原草稿与审核结论均不改写", async () => {
    await setupViolatingPlan();
    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    // 批准点恰在禁入天体位置（本身在禁入区内）
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "坏点");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "45");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "0");
    await userEvent.click(screen.getByTestId("generate-detour"));

    const failBox = screen.getByTestId("detour-fail");
    expect(failBox.textContent).toContain("无可行绕行路径");
    // 原审核结论仍在
    expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();
    // 原草稿未被改写：仍为 2 个关键帧
    expect(screen.getAllByTestId(/keyframe-row-/)).toHaveLength(2);
  });

  it("全局而非逐段贪心：两段各需不同批准点时给出跨段分配", async () => {
    render(<App />);
    for (const [label, value] of [
      ["关键帧 1 时刻", "0"],
      ["关键帧 1 赤经", "300"],
      ["关键帧 1 赤纬", "0"],
      ["关键帧 2 时刻", "100"],
      ["关键帧 2 赤经", "60"],
      ["关键帧 2 赤纬", "0"],
      ["天体 1 名称", "B0"],
      ["天体 1 赤经", "0"],
      ["天体 1 赤纬", "0"],
    ] as const) {
      await userEvent.clear(screen.getByLabelText(label));
      await userEvent.type(screen.getByLabelText(label), value);
    }
    await userEvent.click(screen.getByRole("button", { name: "+ 添加关键帧" }));
    for (const [label, value] of [
      ["关键帧 3 时刻", "200"],
      ["关键帧 3 赤经", "120"],
      ["关键帧 3 赤纬", "0"],
    ] as const) {
      await userEvent.clear(screen.getByLabelText(label));
      await userEvent.type(screen.getByLabelText(label), value);
    }
    await userEvent.click(screen.getByRole("button", { name: "+ 添加禁入天体" }));
    await userEvent.type(screen.getByLabelText("天体 2 名称"), "B90");
    await userEvent.type(screen.getByLabelText("天体 2 赤经"), "90");
    await userEvent.type(screen.getByLabelText("天体 2 赤纬"), "0");
    await userEvent.clear(screen.getByTestId("exclusion-angle"));
    await userEvent.type(screen.getByTestId("exclusion-angle"), "10");

    await audit();
    expect(screen.getByTestId("verdict-fail")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    await userEvent.type(screen.getByLabelText("批准点 1 名称"), "X");
    await userEvent.type(screen.getByLabelText("批准点 1 赤经"), "50");
    await userEvent.type(screen.getByLabelText("批准点 1 赤纬"), "30");
    await userEvent.click(
      screen.getByRole("button", { name: "+ 添加批准转折指向" }),
    );
    await userEvent.type(screen.getByLabelText("批准点 2 名称"), "Y");
    await userEvent.type(screen.getByLabelText("批准点 2 赤经"), "290");
    await userEvent.type(screen.getByLabelText("批准点 2 赤纬"), "-14");

    await userEvent.click(screen.getByTestId("generate-detour"));
    const ok = screen.getByTestId("detour-ok");
    expect(ok.textContent).toContain("新增转折点 2 个");
    // 第 1 段用 2 号点 Y，第 2 段用 1 号点 X
    const segCards = ok.querySelectorAll(".detour-seg");
    expect(segCards[0].textContent).toContain("经过批准点：2");
    expect(segCards[1].textContent).toContain("经过批准点：1");
  });
});
