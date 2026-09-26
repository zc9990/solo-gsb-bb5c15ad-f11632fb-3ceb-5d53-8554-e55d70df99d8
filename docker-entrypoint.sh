#!/bin/sh
# 容器启动入口：
# 1. 启动时安装/校验依赖（node_modules 已在镜像中，此处为幂等快速校验，挂载卷覆盖时也可自愈）
# 2. 启动服务；首次启动数据文件不存在时，应用自动初始化本地 JSON 数据
set -e

echo "[entrypoint] 安装/校验依赖..."
npm install --omit=dev --no-audit --no-fund

echo "[entrypoint] 启动演出道具交接核验应用 (PORT=${PORT:-3000})..."
exec node server.js
