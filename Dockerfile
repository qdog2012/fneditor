FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build:frontend

FROM golang:1.26-alpine AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY server ./server
COPY package.json ./
RUN VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json) && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /fneditor ./server

FROM alpine:3.23
WORKDIR /app
ENV PORT=39280
ENV FNEDITOR_ROOT=/data
COPY --from=frontend /app/dist ./dist
COPY --from=backend /fneditor ./fneditor
EXPOSE 39280
CMD ["./fneditor"]
