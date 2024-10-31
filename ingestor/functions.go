package main

import (
	"log"
	"os"
)

func safeEnv(env string) string {
	// Lookup env variable, and panic if not present
	res, present := os.LookupEnv(env)
	if !present {
		log.Fatalf("Missing environment variable %s", env)
	}
	return res
}
