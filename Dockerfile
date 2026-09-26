# 演出道具交接核验 Web 应用
# Node.js 后端（Express，零前端构建）+ 原生 HTML/CSS/JavaScript 前端

FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存安装依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用源码
COPY server.js ./
COPY src ./src
COPY public ./public

# 数据目录（数据保存在本地 JSON，由 volume 持久化）
RUN mkdir -p /app/data
ENV DATA_FILE=/app/data/store.json \
    PORT=3000 \
    NODE_ENV=production

VOLUME ["/app/data"]

# 容器启动入口：启动时安装依赖，再由应用在首次启动时初始化本地 JSON 数据
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
