FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
ENV INSTALL_CURL_TRANSPORT=1 DK_HTTP_TRANSPORT=curl
COPY package*.json ./
COPY requirements.txt ./
COPY scripts/install-transport.js ./scripts/install-transport.js
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
USER node
EXPOSE 3210
CMD ["node", "src/server.js"]
