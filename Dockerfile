# syntax=docker/dockerfile:1

# ---- 依赖安装（利用层缓存）----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- verify 目标：一次性的测试与构建检查 ----
# 由 compose 的 verify 服务调用：运行单元测试 + 生产构建，
# 任一失败即以非零退出码结束，容器不常驻。
FROM deps AS verify
WORKDIR /app
COPY . .
# 默认即运行单元测试 + 生产构建；compose 中显式给出同一命令。
# 任一失败以非零退出码结束，容器不常驻。
CMD ["sh", "-c", "npm run test:run && npm run build"]

# ---- 生产构建 ----
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# ---- 静态服务（Nginx）----
FROM nginx:1.27-alpine AS web
# 清理默认站点配置，使用项目自带配置（含 /healthz/ 探针端点）
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz/ || exit 1
