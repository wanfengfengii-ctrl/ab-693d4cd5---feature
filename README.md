# 星敏感器标定转向 · 禁入区审核（纯前端）

高空天文台安排星敏感器标定转向时，需确认视轴从一个指向转到下一个指向的
**整个最短大圆轨迹**都不扫过太阳、月球等禁入天体。本工具让操作员录入
2–8 个关键帧指向、一个统一禁入角和 1–6 个禁入天体，通过**一次审核**得到
逐段结论，而非仅凭关键帧端点间距放行。

## 审核方法（核心）

- 赤经/赤纬统一换算为**单位向量**，天然正确处理 RA 0°/360° 环绕与天极指向。
- 对每个相邻关键帧段，将视轴沿**最短大圆弧（短弧）**连续参数化（SLERP），
  对每个禁入天体**解析地**求解弧上角距函数的极值：

  ```
  f(u) = r(u)·b = [ A·sin(θ−u) + C·sin(u) ] / sin θ
  f'(u) = 0  ⇒  tan u = (C − A·cos θ) / (A·sin θ)
  ```

  比较两个端点与落入弧内的驻点，得到**真实最小角距**——不做离散采样，
  因此不会漏掉弧中段扫过天体的情形。
- 输入校验拒绝：重名天体、坐标越界、时刻非严格递增、相邻关键帧
  相同（轨迹退化为点）或恰好反向/对跖（无数条等长半圆弧，无唯一最短路径）。
- 违规时按 **时间（段顺序）→ 段内天体输入顺序** 给出**首个越界见证**
  （段、天体、越界时刻、真实最小角距）。
- 角距**恰等于**禁入角按贴边放行（安全），但会在结论中列出接触点供复核。
- 审核结论仅对当前草稿有效：**任何录入改动都会立即撤下旧结论**，需重新审核。

## 本地开发

```bash
npm install
npm run dev        # 开发服务器
npm run test:run   # 单元/组件测试（Vitest）
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 本地预览生产产物
```

## Docker 部署

构建并启动静态服务（Nginx），宿主机端口可用 `HOST_PORT` 配置（默认 8080）：

```bash
docker compose up -d --build
# 自定义端口：
HOST_PORT=9090 docker compose up -d --build
# 或复制 .env.example 为 .env 后修改 HOST_PORT
```

- 服务内置健康检查：`GET /healthz/` 返回 `200 ok`（Dockerfile 与 compose 均已配置）。
- 纯静态资源，无后端依赖。

### verify 一次性服务

在容器内完成**代码测试与生产构建检查**后自行退出，并以退出码报告结果
（成功 0，失败非 0），适合接入 CI 或交付前自检：

```bash
docker compose build verify
docker compose run --rm verify
echo "exit code: $?"
```

## 技术栈

React 18 + TypeScript + Vite，Vitest + Testing Library，Nginx 静态服务，
多阶段 Dockerfile（deps / verify / build / web）。
