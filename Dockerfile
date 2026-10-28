FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
USER node
EXPOSE 3210
CMD ["node", "src/server.js"]
