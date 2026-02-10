package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	redisURL := os.Getenv("REDIS_URL")
	log.Printf("Worker starting (redis: %s)", redisURL)

	// Simulate a worker loop that processes jobs from Redis
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			log.Println("Worker: checking for jobs...")
		case <-stop:
			log.Println("Worker: shutting down")
			return
		}
	}
}
