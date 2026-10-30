FROM node:24-alpine
WORKDIR /app
COPY artifacts/ ./artifacts/
ENV ARTIFACTS_HOST=0.0.0.0 ARTIFACTS_DATA_DIR=/data
EXPOSE 8787
CMD ["node", "artifacts/server.mjs"]
