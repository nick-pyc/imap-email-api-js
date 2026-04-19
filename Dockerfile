FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js .

RUN mkdir -p /app/data

ENV DB_PATH=/app/data/emailapi.db

EXPOSE 6060

CMD ["node", "index.js"]
