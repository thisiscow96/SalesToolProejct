# 어느 무료 호스트에서나 같은 방식으로 실행 (Oracle Cloud Always Free VM · Koyeb · Render Docker 등)
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# 시작할 때 마이그레이션을 먼저 적용 (이미 적용된 것은 건너뜀)
CMD ["sh", "-c", "node scripts/migrate.js && node index.js"]
