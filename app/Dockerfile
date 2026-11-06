FROM node:22-alpine

RUN apk add --no-cache curl unzip ca-certificates

WORKDIR /app
COPY . /app

ENV PORT=8080
ENV DATA_DIR=/data
ENV EXCEL_PATH=/data/library.xlsx

EXPOSE 8080

CMD ["node", "/app/server.mjs"]
