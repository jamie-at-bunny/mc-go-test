package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	redisURL := os.Getenv("REDIS_URL")

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello from the Go API!\n")
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "ok\n")
	})

	http.HandleFunc("/enqueue", func(w http.ResponseWriter, r *http.Request) {
		// In a real app this would push a job to Redis
		fmt.Fprintf(w, "Job enqueued (redis: %s)\n", redisURL)
	})

	log.Printf("API starting on :%s (redis: %s)", port, redisURL)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
