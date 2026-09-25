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
