FROM golang:1.25-alpine AS build
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /api ./cmd/api
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /worker ./cmd/worker

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=build /api /usr/local/bin/api
COPY --from=build /worker /usr/local/bin/worker
CMD ["api"]
